#!/usr/bin/env node
/**
 * ACT-006 — runner for the Gmail verification listener.
 *
 * Run from `lib/`:
 *   npm run verification-listener
 *   npm run verification-listener -- --interval 10 --dry-run
 *   npm run verification-listener -- --once
 *
 * This is a long-running foreground process, deliberately: it is the demo's
 * verification loop, and you want to watch it. Ctrl-C stops it cleanly.
 *
 * Prerequisites, in order:
 *   1. `npm run gmail-auth` at least once (and again every 7 days — see
 *      `gmail-auth-cli.ts`), with `GOOGLE_OAUTH_REFRESH_TOKEN` pasted into
 *      `.env.local`.
 *   2. An Inngest endpoint to send to. With the Inngest dev server running
 *      locally, set `INNGEST_DEV=1` in `.env.local` and no event key is needed.
 *      Against Inngest Cloud, set `INNGEST_EVENT_KEY` instead.
 *   3. At least one `job_applications` row sitting at `awaiting_verification`,
 *      i.e. a real `npm run create-account` run against a board that gates.
 *
 * ── --dry-run is the acceptance test ────────────────────────────────────────
 * ACT-006's acceptance criterion is "confirm it does NOT fire on unrelated
 * emails arriving in the same window". `--dry-run` performs every match,
 * rejection and attribution decision exactly as the real thing and prints them,
 * but sends nothing to Inngest — so you can mail yourself a plausible-looking
 * fake confirmation mid-window and watch it get rejected by name, without a
 * live pipeline run riding on the outcome.
 */

import { config } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GmailAuthError, REAUTH_COMMAND } from "./gmail-client.js";
import {
  DEFAULT_POLL_INTERVAL_MS,
  runVerificationListener,
} from "./gmail-verification-listener.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// `.env.local` (secrets, gitignored) first, then `.env` (committed defaults).
// dotenv never overwrites an already-set variable, so first load wins and real
// process env still beats both.
const localEnv = config({ path: resolve(__dirname, "../.env.local") });
config({ path: resolve(__dirname, "../.env") });

if (localEnv.error) {
  console.warn(
    "[act-006] No readable ../.env.local — relying on the ambient environment for " +
      "GOOGLE_OAUTH_* / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY."
  );
}

const USAGE =
  "Usage: npm run verification-listener -- [--interval <seconds>] [--once] [--dry-run]\n" +
  "  --interval <seconds>  poll period (default " +
  `${DEFAULT_POLL_INTERVAL_MS / 1000}, minimum 5)\n` +
  "  --once                run a single poll cycle and exit\n" +
  "  --dry-run             log the event that would be sent; send nothing";

/** Below this, polling is just Gmail quota burn — the mail is not that urgent. */
const MIN_INTERVAL_SECONDS = 5;

type Args = { intervalMs: number; once: boolean; dryRun: boolean };

function parseArgs(argv: string[]): Args {
  let intervalMs = DEFAULT_POLL_INTERVAL_MS;
  let once = false;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? "";
    const eq = token.indexOf("=");
    const name = token.startsWith("--") && eq !== -1 ? token.slice(0, eq) : token;

    if (name === "--once" || name === "--dry-run") {
      if (eq !== -1) throw new Error(`${name} does not take a value`);
      if (name === "--once") once = true;
      else dryRun = true;
      continue;
    }
    if (name !== "--interval") {
      throw new Error(`Unknown argument: ${token}\n${USAGE}`);
    }

    const raw = eq !== -1 ? token.slice(eq + 1) : argv[++i];
    if (!raw || !/^\d+$/.test(raw)) {
      throw new Error(`--interval must be whole seconds, got: ${raw ?? "(nothing)"}\n${USAGE}`);
    }
    const seconds = Number(raw);
    if (seconds < MIN_INTERVAL_SECONDS) {
      throw new Error(`--interval must be at least ${MIN_INTERVAL_SECONDS} seconds`);
    }
    intervalMs = seconds * 1000;
  }
  return { intervalMs, once, dryRun };
}

/** Never let a credential reach stdout/stderr, even inside a wrapped error. */
function redact(text: string): string {
  let out = text;
  for (const secret of [
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
    process.env.INNGEST_EVENT_KEY,
  ]) {
    if (secret) out = out.split(secret).join("[REDACTED]");
  }
  return out;
}

async function main(): Promise<void> {
  const { intervalMs, once, dryRun } = parseArgs(process.argv.slice(2));

  if (!process.env.GOOGLE_OAUTH_REFRESH_TOKEN?.trim()) {
    throw new Error(
      "GOOGLE_OAUTH_REFRESH_TOKEN is not set. Nothing has completed Google's consent " +
        `screen yet (or the value was not pasted in). Run  ${REAUTH_COMMAND}  first, ` +
        "then put the printed token into .env.local."
    );
  }

  // Ctrl-C stops after the in-flight cycle instead of tearing a poll in half.
  const stopSignal = new Promise<void>((resolveStop) => {
    const stop = (): void => {
      console.log("\n[act-006] stopping after this cycle…");
      resolveStop();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });

  await runVerificationListener({ intervalMs, once, dryRun, stopSignal });
  console.log("[act-006] stopped.");
}

main().catch((err: unknown) => {
  // A credential failure gets its own banner: it is the one failure that will
  // recur weekly by design (7-day test-user refresh tokens), and the one that
  // must never look like a transient blip.
  if (err instanceof GmailAuthError) {
    console.error(
      `\n[act-006] ══ GMAIL CREDENTIALS REJECTED ═════════════════════════════\n` +
        `[act-006] ${redact(err.message)}\n` +
        `[act-006] ════════════════════════════════════════════════════════════\n`
    );
    process.exit(1);
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[act-006] ${redact(message)}`);
  process.exit(1);
});
