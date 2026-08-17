#!/usr/bin/env node
/**
 * ACT-006 — one-time (well, weekly) Google OAuth consent.
 *
 * Run from `lib/`:
 *   npm run gmail-auth
 *   npm run gmail-auth -- --port 53682
 *
 * What happens: this starts a loopback HTTP server, prints (and tries to open)
 * a Google consent URL, waits for Google to redirect back with an
 * authorization code, exchanges that code for tokens, and prints the refresh
 * token for you to paste into `.env.local` as `GOOGLE_OAUTH_REFRESH_TOKEN`.
 *
 * ── Why you have to do this by hand ─────────────────────────────────────────
 * There is no unattended path to a first refresh token. Google's consent screen
 * is a human checkpoint on purpose; an agent cannot click it for you. Everything
 * after this step is unattended.
 *
 * ── Why you will do it again in a week ──────────────────────────────────────
 * The Google Cloud OAuth app stays in **Testing** publishing status, which is
 * what lets this project skip Google's app-verification review (README:
 * "Gmail OAuth app verification — use test-user mode, not needed at this
 * scale"). The price is that Google expires a test user's refresh token 7 days
 * after consent. When that happens the listener stops with a message naming
 * this command. Re-run it, paste the new value, carry on. Nothing else changes
 * — the client id and secret are unaffected.
 *
 * ── Secret handling ─────────────────────────────────────────────────────────
 * The freshly minted refresh token is printed exactly once, clearly labelled,
 * because handing it to you is the entire purpose of this script. It is never
 * written to a file: `.env.local` is yours to edit, and a script that rewrites
 * a secrets file is a script that eventually rewrites the wrong one. Nothing
 * else here — not the client secret, not the access token, not an error body —
 * is allowed to reach stdout or stderr unmasked.
 *
 * ── Google Cloud Console prerequisites ──────────────────────────────────────
 *   · Gmail API enabled on the project.
 *   · Your own Google account listed under OAuth consent screen > Test users.
 *   · The OAuth client is either a **Desktop app** client (any loopback port is
 *     accepted automatically) or a **Web application** client with
 *     `http://localhost:<port>/oauth/callback` added to Authorized redirect
 *     URIs. A `redirect_uri_mismatch` on the consent page means this line.
 */

import { config } from "dotenv";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildConsentUrl,
  createOAuthClient,
  DEFAULT_OAUTH_PORT,
  GMAIL_SCOPES,
  oauthRedirectUri,
} from "./gmail-client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// `.env.local` (secrets, gitignored) first, then `.env` (committed defaults).
// dotenv never overwrites an already-set variable, so first load wins and real
// process env still beats both.
const localEnv = config({ path: resolve(__dirname, "../.env.local") });
config({ path: resolve(__dirname, "../.env") });

if (localEnv.error) {
  console.warn(
    "[act-006] No readable ../.env.local — relying on the ambient environment " +
      "for GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET."
  );
}

const USAGE = "Usage: npm run gmail-auth -- [--port <number>] [--no-open]";

/** How long to wait for the human before giving up and freeing the port. */
const CONSENT_TIMEOUT_MS = 5 * 60_000;

/** Google's documented lifetime for a refresh token issued to a test user. */
const TEST_USER_TOKEN_DAYS = 7;

type Args = { port: number; open: boolean };

function parseArgs(argv: string[]): Args {
  let port = DEFAULT_OAUTH_PORT;
  let open = true;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? "";
    const eq = token.indexOf("=");
    const name = token.startsWith("--") && eq !== -1 ? token.slice(0, eq) : token;

    if (name === "--no-open") {
      if (eq !== -1) throw new Error(`--no-open does not take a value`);
      open = false;
      continue;
    }
    if (name !== "--port") {
      throw new Error(`Unknown argument: ${token}\n${USAGE}`);
    }

    const raw = eq !== -1 ? token.slice(eq + 1) : argv[++i];
    if (!raw || !/^\d+$/.test(raw)) {
      throw new Error(`--port must be a whole number, got: ${raw ?? "(nothing)"}\n${USAGE}`);
    }
    port = Number(raw);
    if (port < 1024 || port > 65535) {
      throw new Error(`--port must be between 1024 and 65535, got: ${port}`);
    }
  }
  return { port, open };
}

/**
 * Never let a credential reach stdout/stderr, even inside a wrapped error.
 * Google's own error bodies quote the client secret back on some failures.
 */
function redact(text: string): string {
  let out = text;
  for (const secret of [
    process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  ]) {
    if (secret) out = out.split(secret).join("[REDACTED]");
  }
  return out;
}

/** Best-effort browser launch. A failure is fine — the URL is printed anyway. */
function tryOpen(url: string): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(command, [url], {
      stdio: "ignore",
      detached: true,
      shell: process.platform === "win32",
    });
    child.on("error", () => {
      /* printed URL is the fallback */
    });
    child.unref();
  } catch {
    /* printed URL is the fallback */
  }
}

function page(title: string, body: string): string {
  return (
    `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
    `<body style="font:16px system-ui;margin:4rem auto;max-width:34rem">` +
    `<h1 style="font-size:1.2rem">${title}</h1><p>${body}</p></body>`
  );
}

type CallbackResult = { code: string };

/**
 * Serves the loopback redirect URI until Google sends the authorization code
 * back, then resolves. Rejects on a Google-side error, a state mismatch, or the
 * timeout.
 */
function awaitAuthorizationCode(port: number, state: string): Promise<CallbackResult> {
  return new Promise<CallbackResult>((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close(() => fn());
      // `close()`'s callback only fires once every open connection is closed,
      // but the browser has no reason to close its end of a keep-alive
      // connection just because we sent our one response — observed hanging
      // here indefinitely in practice: the success page rendered fine, and
      // the process never got past this point to exchange the code. Force
      // every open connection closed immediately so the callback above
      // actually fires instead of waiting on the browser's keep-alive.
      server.closeAllConnections();
    };

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);
      if (url.pathname !== "/oauth/callback") {
        res.writeHead(404, { "content-type": "text/plain" }).end("not found");
        return;
      }

      const error = url.searchParams.get("error");
      if (error) {
        res
          .writeHead(400, { "content-type": "text/html" })
          .end(page("Consent was refused", "You can close this tab and re-run the command."));
        finish(() => rejectPromise(new Error(`Google returned "${error}" at the consent screen`)));
        return;
      }

      // CSRF: only a redirect carrying the state this process generated is ours.
      // Without it, anything on this machine could POST a code of its choosing
      // at the loopback port and have it exchanged with our client secret.
      if (url.searchParams.get("state") !== state) {
        res
          .writeHead(400, { "content-type": "text/html" })
          .end(page("Unexpected request", "State parameter did not match. Nothing was exchanged."));
        finish(() =>
          rejectPromise(new Error("OAuth state mismatch — ignoring the callback and exiting"))
        );
        return;
      }

      const code = url.searchParams.get("code");
      if (!code) {
        res
          .writeHead(400, { "content-type": "text/html" })
          .end(page("No authorization code", "You can close this tab and re-run the command."));
        finish(() => rejectPromise(new Error("Callback carried no authorization code")));
        return;
      }

      res
        .writeHead(200, { "content-type": "text/html" })
        .end(
          page(
            "Actinno is authorized",
            "You can close this tab — the refresh token is printed in your terminal."
          )
        );
      finish(() => resolvePromise({ code }));
    });

    const timer = setTimeout(() => {
      finish(() =>
        rejectPromise(
          new Error(
            `Timed out after ${CONSENT_TIMEOUT_MS / 60_000} minutes waiting for the ` +
              `consent redirect. Nothing was changed; re-run the command when ready.`
          )
        )
      );
    }, CONSENT_TIMEOUT_MS);

    server.on("error", (err: NodeJS.ErrnoException) => {
      finish(() =>
        rejectPromise(
          err.code === "EADDRINUSE"
            ? new Error(
                `Port ${port} is already in use. Close whatever is holding it, or pass ` +
                  `--port <other> (and add the matching redirect URI in Google Cloud Console).`
              )
            : err
        )
      );
    });

    server.listen(port, "127.0.0.1");
  });
}

async function main(): Promise<void> {
  const { port, open } = parseArgs(process.argv.slice(2));
  const client = createOAuthClient(port);
  const state = randomBytes(16).toString("hex");
  const url = buildConsentUrl(client, state);

  console.log(
    `\n[act-006] Listening on ${oauthRedirectUri(port)}\n` +
      `[act-006] Scope requested: ${GMAIL_SCOPES.join(" ")} (read-only)\n\n` +
      `Open this URL and approve access as the mailbox owner:\n\n${url}\n\n` +
      `Google will warn that the app is unverified — that is expected in Testing\n` +
      `publishing status. Choose "Advanced" > "Go to ... (unsafe)" to continue.\n`
  );
  if (open) tryOpen(url);

  const { code } = await awaitAuthorizationCode(port, state);
  const { tokens } = await client.getToken(code);

  if (!tokens.refresh_token) {
    throw new Error(
      "Google returned no refresh token. This happens when the account has already " +
        "granted this app and Google reuses the existing grant. Remove Actinno at " +
        "https://myaccount.google.com/permissions and run this command again."
    );
  }

  const expiresOn = new Date(Date.now() + TEST_USER_TOKEN_DAYS * 24 * 60 * 60_000);

  console.log(
    `\n──────────────────────────────────────────────────────────────────────\n` +
      `SENSITIVE — paste this into .env.local, then do not print it again.\n` +
      `Treat it like a password: it grants read access to the mailbox.\n` +
      `──────────────────────────────────────────────────────────────────────\n\n` +
      `GOOGLE_OAUTH_REFRESH_TOKEN=${tokens.refresh_token}\n\n` +
      `──────────────────────────────────────────────────────────────────────\n` +
      `Granted scope: ${tokens.scope ?? GMAIL_SCOPES.join(" ")}\n` +
      `Expires around ${expiresOn.toISOString().slice(0, 10)} — Google expires\n` +
      `refresh tokens issued to test users after ${TEST_USER_TOKEN_DAYS} days while the OAuth\n` +
      `app stays in Testing publishing status. Re-run this command then; the\n` +
      `listener will tell you when it is time.\n` +
      `\nNext: npm run verification-listener\n`
  );
}

main().catch((err: unknown) => {
  // Message only, redacted — printing the raw error object risks dumping the
  // OAuth request body (which contains the client secret) into the terminal.
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[act-006] ${redact(message)}`);
  process.exit(1);
});
