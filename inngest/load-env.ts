/**
 * Environment loading, in a module of its own so it can be made to happen
 * *first*.
 *
 * This is not decoration. `new Inngest(...)` decides at construction time
 * whether it is talking to a local dev server or to Inngest Cloud, and it
 * decides it by reading `INNGEST_DEV` — which means the variable has to be in
 * `process.env` before `job-application-pipeline.ts` is evaluated. ESM executes
 * imports before the importing module's own body, so a `config()` call sitting
 * at the top of `serve.ts` runs *after* the pipeline module it imports, and the
 * client is already built and pointed at the cloud by then. The symptom is a
 * server that starts cleanly, syncs nothing, and answers every request with
 * `{"code":"internal_server_error"}` and a log line about a missing signing key.
 *
 * The fix is import order, so this file is imported on the first line of
 * `job-application-pipeline.ts` and everything downstream inherits it.
 *
 * Note that Inngest v4 does *not* infer dev mode from `NODE_ENV`; without
 * `INNGEST_DEV` it defaults to cloud. `.env` carries `INNGEST_DEV=1` as the
 * committed default for this repo's local-demo stage, and `.env.local` (loaded
 * first, and dotenv never overwrites) can override it.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));

// `.env.local` (secrets, gitignored) first, then `.env` (committed defaults).
// dotenv never overwrites an already-set variable, so first load wins and real
// process env still beats both. Same order as every CLI in `lib/`.
const localEnv = config({ path: resolve(__dirname, "../.env.local") });
config({ path: resolve(__dirname, "../.env") });

if (localEnv.error) {
  console.warn(
    "[act-009] No readable ../.env.local — relying on the ambient environment for " +
      "APIFY_API_TOKEN / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / STAGEHAND_LLM_API_KEY."
  );
}
