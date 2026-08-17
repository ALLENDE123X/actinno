/**
 * ACT-006 — Gmail OAuth plumbing.
 *
 * Shared by the two entrypoints that need Google credentials:
 *
 *   · `gmail-auth-cli.ts`               — the one-time, interactive consent run
 *                                         that mints a refresh token.
 *   · `gmail-verification-listener.ts`  — the unattended poller that spends it.
 *
 * ── Why a refresh token in an env var ────────────────────────────────────────
 * The listener runs headless and must never block on a browser. Google's
 * installed-app flow is the only way to get a long-lived grant, and it needs a
 * human at a consent screen exactly once; after that the refresh token is the
 * whole credential. It lives in `.env.local` (gitignored) beside every other
 * secret in this repo — see `.env.example`.
 *
 * ── The 7-day cliff, and why this file cares about it ────────────────────────
 * This project deliberately leaves its Google Cloud OAuth app in **Testing**
 * publishing status (README: "Gmail OAuth app verification — use test-user
 * mode"). Google expires refresh tokens issued to test users 7 days after
 * consent. That is a hard platform limit, not a setting, and the failure mode
 * is nasty: the token simply starts returning `invalid_grant`, which without
 * special handling surfaces as a generic 400 from deep inside googleapis and
 * looks like a network blip. `assertUsableCredentials()` and
 * `toGmailAuthError()` exist so that failure reads as one unmistakable line
 * naming the command that fixes it, and so the listener exits instead of
 * spinning quietly for the rest of the demo.
 *
 * Scope is `gmail.readonly`, not `gmail.metadata`: the verification code and
 * the verification link live in the message *body*, and metadata scope cannot
 * read bodies. Nothing here ever writes to, labels, or deletes mail.
 */

import { OAuth2Client } from "google-auth-library";
import { google } from "googleapis";
import type { gmail_v1 } from "googleapis";

/**
 * Read-only, and deliberately the narrowest scope that can still see a message
 * body. `gmail.metadata` would be narrower but returns headers only, so the
 * code/link this ticket exists to extract would be invisible.
 */
export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"] as const;

/**
 * Loopback port the one-time consent flow listens on. Must match an entry in
 * the OAuth client's "Authorized redirect URIs" in Google Cloud Console (a
 * *Desktop app* client accepts any loopback port; a *Web application* client
 * requires the exact URI to be registered).
 */
export const DEFAULT_OAUTH_PORT = 53682;

/** How the user is told to re-run consent. Referenced in every auth error. */
export const REAUTH_COMMAND = "npm run gmail-auth   (from lib/)";

export function oauthRedirectUri(port: number): string {
  return `http://localhost:${port}/oauth/callback`;
}

/**
 * A credential problem, as opposed to a transient API problem. The listener
 * treats these as fatal and exits: retrying a revoked token forever is the
 * silent failure this ticket explicitly must not have.
 */
export class GmailAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GmailAuthError";
  }
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new GmailAuthError(
      `${name} is required but not set. See .env.example; secrets belong in .env.local.`
    );
  }
  return value;
}

/**
 * OAuth client built from the app credentials alone — no user grant attached.
 * This is what the consent CLI needs. `createGmailClient()` below adds the
 * refresh token on top.
 */
export function createOAuthClient(port: number = DEFAULT_OAUTH_PORT): OAuth2Client {
  return new OAuth2Client({
    clientId: requireEnv("GOOGLE_OAUTH_CLIENT_ID"),
    clientSecret: requireEnv("GOOGLE_OAUTH_CLIENT_SECRET"),
    redirectUri: oauthRedirectUri(port),
  });
}

/**
 * The URL a human has to open once.
 *
 * `access_type: "offline"` is what asks for a refresh token at all, and
 * `prompt: "consent"` forces Google to issue a *fresh* one even when the user
 * has already approved this app before. Without the latter, the 7-day re-auth
 * this project needs every week would silently return an authorization code
 * that exchanges into no refresh token at all — the single most common way
 * this flow "works" and yet leaves you with nothing to store.
 */
export function buildConsentUrl(client: OAuth2Client, state: string): string {
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [...GMAIL_SCOPES],
    include_granted_scopes: false,
    state,
  });
}

/**
 * The OAuth error code Google returned, if this is an OAuth error at all.
 *
 * googleapis surfaces these as a Gaxios error whose `response.data.error` is
 * the code; older/edge paths only put it in the message, hence the fallback.
 */
function oauthErrorCode(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  const candidate = err as { response?: { data?: unknown }; message?: unknown };

  const data = candidate.response?.data;
  if (typeof data === "object" && data !== null) {
    const code = (data as { error?: unknown }).error;
    if (typeof code === "string" && code) return code;
  }

  const message = typeof candidate.message === "string" ? candidate.message : "";
  const match = /\b(invalid_grant|invalid_client|unauthorized_client|invalid_scope)\b/.exec(
    message
  );
  return match?.[1] ?? null;
}

/**
 * Translates a credential failure into a `GmailAuthError` that says what to do,
 * or returns `null` if this was not a credential failure (a 5xx, a timeout, a
 * quota error — all of which the caller should treat as transient).
 */
export function toGmailAuthError(err: unknown): GmailAuthError | null {
  const code = oauthErrorCode(err);
  if (code === null) return null;

  switch (code) {
    case "invalid_grant":
      return new GmailAuthError(
        "Google rejected GOOGLE_OAUTH_REFRESH_TOKEN (invalid_grant). In OAuth " +
          '"Testing" publishing status Google expires a test user\'s refresh token ' +
          "7 DAYS after consent, so this is the expected weekly failure, not a bug — " +
          "it also fires if the grant was revoked or the token was mistyped. " +
          `Fix: re-run  ${REAUTH_COMMAND}  and paste the new refresh token into .env.local.`
      );
    case "invalid_client":
      return new GmailAuthError(
        "Google rejected the OAuth app credentials (invalid_client): " +
          "GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET do not match a live " +
          "OAuth client. Check .env.local against Google Cloud Console > APIs & " +
          "Services > Credentials."
      );
    case "unauthorized_client":
      return new GmailAuthError(
        "Google rejected this OAuth client for the refresh grant " +
          "(unauthorized_client). The client type or its authorized redirect URI " +
          `probably changed since consent. Re-run  ${REAUTH_COMMAND}  after fixing it.`
      );
    case "invalid_scope":
      return new GmailAuthError(
        `The stored grant does not cover ${GMAIL_SCOPES.join(" ")} (invalid_scope). ` +
          `Re-run  ${REAUTH_COMMAND}  to consent again with the right scope.`
      );
    default:
      return new GmailAuthError(
        `Google returned OAuth error "${code}". If this persists, re-run  ${REAUTH_COMMAND}.`
      );
  }
}

/**
 * Rethrows as a `GmailAuthError` when the cause is credentials, otherwise
 * rethrows the original untouched.
 */
export function rethrowAsAuthError(err: unknown): never {
  const authError = toGmailAuthError(err);
  throw authError ?? err;
}

/**
 * A Gmail client bound to the stored refresh token.
 *
 * Note this does **not** contact Google — an OAuth2Client with a refresh token
 * mints an access token lazily on the first API call. Call
 * `assertUsableCredentials()` right after this if you want the credential
 * failure to happen at startup rather than 15 seconds into the poll loop, which
 * is exactly what the listener wants.
 */
export function createGmailClient(): { gmail: gmail_v1.Gmail; auth: OAuth2Client } {
  const auth = new OAuth2Client({
    clientId: requireEnv("GOOGLE_OAUTH_CLIENT_ID"),
    clientSecret: requireEnv("GOOGLE_OAUTH_CLIENT_SECRET"),
  });
  auth.setCredentials({ refresh_token: requireEnv("GOOGLE_OAUTH_REFRESH_TOKEN") });

  return { gmail: google.gmail({ version: "v1", auth }), auth };
}

/**
 * Forces a token refresh so an expired grant fails loudly, once, at startup.
 *
 * Returns the Gmail address the grant belongs to, purely so the operator can
 * see at a glance that the listener is watching the mailbox they think it is —
 * pointing it at the wrong inbox is a silent no-match otherwise.
 */
export async function assertUsableCredentials(
  gmail: gmail_v1.Gmail,
  auth: OAuth2Client
): Promise<string> {
  try {
    await auth.getAccessToken();
    const profile = await gmail.users.getProfile({ userId: "me" });
    return profile.data.emailAddress ?? "(address not returned)";
  } catch (err) {
    rethrowAsAuthError(err);
  }
}
