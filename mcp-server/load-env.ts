/**
 * Environment loading for the MCP server, in a module of its own so it can be
 * made to happen *first*.
 *
 * This mirrors `inngest/load-env.ts` and exists for the same non-cosmetic
 * reason: `new Inngest(...)` decides at construction time whether it is talking
 * to a local dev server or to Inngest Cloud, and it decides it by reading
 * `INNGEST_DEV`. ESM evaluates every import before the importing module's own
 * body runs, so a `config()` call sitting at the top of `index.ts` is *not*
 * reliably early — the moment any imported module builds a client, it has
 * already lost. Keeping the load in its own module and importing it on the first
 * line is the only ordering that holds as the import list grows.
 *
 * Inngest v4 does not infer dev mode from `NODE_ENV`; without `INNGEST_DEV` it
 * defaults to cloud and `inngest.send()` fails on a missing event key. `.env`
 * carries `INNGEST_DEV=1` as this repo's committed local-demo default.
 *
 * Loading env here also fixes something that was previously left to luck: this
 * server calls `searchJobListings`, which reads `APIFY_API_TOKEN` from
 * `process.env`. Claude Desktop spawns the server with a bare environment, so
 * before this module that token had to be duplicated into the Desktop config.
 * Now the repo's own `.env.local` is the single source for it.
 */

import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));

// `.env.local` (secrets, gitignored) first, then `.env` (committed defaults).
// dotenv never overwrites an already-set variable, so first load wins and real
// process env still beats both. Same order as `inngest/load-env.ts` and the
// CLIs in `lib/`.
//
// `quiet` is passed explicitly rather than left to the default. This process
// speaks MCP over **stdout**; one stray banner line on that stream is a protocol
// parse error in Claude Desktop, not a cosmetic annoyance. dotenv 16.6 happens
// to default to quiet, dotenv 17 does not, and this file should not be the thing
// that breaks on a routine dependency bump.
const localEnv = config({ path: resolve(__dirname, "../.env.local"), quiet: true });
config({ path: resolve(__dirname, "../.env"), quiet: true });

/**
 * ACT-013: a third location, `~/.actinno-mcp/.env.local`, checked last.
 *
 * The two paths above are relative to *this file*, and in the deployment that
 * matters this file is `~/.actinno-mcp/server.mjs` — so they resolve to
 * `~/.env.local` and `~/.env`, which do not exist. Until ACT-013 that only cost
 * a warning, because the one variable the server needed (`APIFY_API_TOKEN`) was
 * being passed in the Claude Desktop config's `env` block. Intake and the
 * email-to-candidate lookup need `SUPABASE_URL` and
 * `SUPABASE_SERVICE_ROLE_KEY` too, and a service-role key is not something to
 * paste into a JSON config as the only option on offer.
 *
 * `~/.actinno-mcp/` is the directory the sandbox demonstrably reads — the bundle
 * is loaded from it — so `cp .env.local ~/.actinno-mcp/.env.local` makes the
 * whole repo environment available to the bundled server with nothing
 * duplicated by hand. It is loaded *after* the repo's own files so that a
 * developer running `npm start` from the checkout still gets the live
 * `.env.local` rather than whatever was last copied out; dotenv never
 * overwrites, so first readable file wins and the real process environment
 * (Claude Desktop's `env` block) beats all three.
 */
const bundleEnv = config({ path: join(homedir(), ".actinno-mcp", ".env.local"), quiet: true });

if (localEnv.error && bundleEnv.error) {
  // stderr on purpose — see the note on stdout above.
  console.warn(
    "[act-010] No readable ../.env.local or ~/.actinno-mcp/.env.local — relying on the " +
      "ambient environment for APIFY_API_TOKEN, INNGEST_DEV, SUPABASE_URL and " +
      "SUPABASE_SERVICE_ROLE_KEY."
  );
}
