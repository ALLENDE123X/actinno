#!/usr/bin/env node
/**
 * Local test entrypoint for ACT-005 (job-board account creation / direct-apply
 * detection).
 *
 * Run from `lib/`:
 *   npm run create-account -- \
 *     --candidate 6636fa5e-aa43-4ad6-a074-c2ad096b2287 \
 *     --company Discord \
 *     --job-title "Software Engineer, Distributed Systems" \
 *     --apply-url https://job-boards.greenhouse.io/discord/jobs/8545663002 \
 *     --email pranavecommerce123@gmail.com
 *
 * Reads credentials from the repo-root `.env.local` (gitignored). This drives a
 * REAL browser against a REAL employer's job board and writes a real
 * `job_applications` row. It is deliberately one-shot with no retry loop — do
 * not wrap it in one.
 *
 * `--list-tools` skips all of that and just prints the Playwright Actor's MCP
 * tool list (`fetch-actor-details` with `output.mcpTools`), which is the cheap
 * way to check the Actor's surface without navigating anywhere.
 */

import { config } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBoardAccount } from "./create-board-account.js";
import { ApifyMcpSession, PLAYWRIGHT_MCP_ACTOR } from "./apify-mcp-client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// `.env.local` (secrets, gitignored) first, then `.env` (committed defaults).
// dotenv never overwrites an already-set variable, so first load wins and real
// process env still beats both.
const localEnv = config({ path: resolve(__dirname, "../.env.local") });
config({ path: resolve(__dirname, "../.env") });

if (localEnv.error) {
  console.warn(
    "[act-005] No readable ../.env.local — relying on the ambient environment " +
      "for APIFY_API_TOKEN / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY."
  );
}

const VALUE_FLAGS = [
  "--candidate",
  "--company",
  "--job-title",
  "--apply-url",
  "--email",
  "--ats",
] as const;
const BOOL_FLAGS = ["--list-tools", "--keep-browser"] as const;

type ValueFlag = (typeof VALUE_FLAGS)[number];
type BoolFlag = (typeof BOOL_FLAGS)[number];

const USAGE =
  "Usage: npm run create-account -- --candidate <uuid> --company <name> " +
  "--job-title <title> --apply-url <https url> --email <email> [--ats <provider>] " +
  "[--keep-browser]\n" +
  "   or: npm run create-account -- --list-tools";

type ParsedArgs = { values: Map<ValueFlag, string>; flags: Set<BoolFlag> };

/**
 * Parses `--flag value` and `--flag=value`. Rejects unknown and repeated flags
 * so a typo (e.g. `--aply-url`) fails loudly instead of silently dropping the
 * field and navigating somewhere unintended.
 */
function parseArgs(argv: string[]): ParsedArgs {
  const values = new Map<ValueFlag, string>();
  const flags = new Set<BoolFlag>();
  const isValueFlag = (s: string): s is ValueFlag =>
    (VALUE_FLAGS as readonly string[]).includes(s);
  const isBoolFlag = (s: string): s is BoolFlag =>
    (BOOL_FLAGS as readonly string[]).includes(s);

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    const eq = token.indexOf("=");
    const name = token.startsWith("--") && eq !== -1 ? token.slice(0, eq) : token;

    if (isBoolFlag(name)) {
      if (eq !== -1) throw new Error(`${name} does not take a value`);
      if (flags.has(name)) throw new Error(`Duplicate argument: ${name}`);
      flags.add(name);
      continue;
    }
    if (!isValueFlag(name)) {
      throw new Error(`Unknown argument: ${token}\n${USAGE}`);
    }
    if (values.has(name)) {
      throw new Error(`Duplicate argument: ${name}`);
    }

    let value: string | undefined;
    if (token.startsWith("--") && eq !== -1) {
      value = token.slice(eq + 1);
    } else {
      value = argv[++i];
      // Guard against `--company --email x@y.z` swallowing the next flag.
      if (value !== undefined && (isValueFlag(value) || isBoolFlag(value))) {
        throw new Error(`Missing value for ${name} (got the next flag: ${value})`);
      }
    }
    if (value === undefined || value.trim() === "") {
      throw new Error(`Missing value for ${name}\n${USAGE}`);
    }
    values.set(name, value);
  }
  return { values, flags };
}

/** Never let a credential reach stdout/stderr, even inside a wrapped error. */
function redact(text: string): string {
  let out = text;
  for (const key of [
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    process.env.APIFY_API_TOKEN,
  ]) {
    if (key) out = out.split(key).join("[REDACTED]");
  }
  return out;
}

async function main(): Promise<void> {
  const { values, flags } = parseArgs(process.argv.slice(2));

  if (flags.has("--list-tools")) {
    const session = await ApifyMcpSession.open();
    try {
      console.log(await session.fetchActorMcpTools(PLAYWRIGHT_MCP_ACTOR));
    } finally {
      await session.close();
    }
    return;
  }

  const candidateId = values.get("--candidate");
  const company = values.get("--company");
  const jobTitle = values.get("--job-title");
  const applyUrl = values.get("--apply-url");
  const applicationEmail = values.get("--email");

  if (!candidateId || !company || !jobTitle || !applyUrl || !applicationEmail) {
    throw new Error(
      `--candidate, --company, --job-title, --apply-url and --email are required\n${USAGE}`
    );
  }

  const result = await createBoardAccount({
    candidateId,
    company,
    jobTitle,
    applyUrl,
    applicationEmail,
    atsProvider: values.get("--ats"),
    closeBrowser: !flags.has("--keep-browser"),
  });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((err: unknown) => {
  // Message only, redacted — printing the raw error object risks dumping
  // request context from the Supabase or MCP client into the terminal.
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[act-005] ${redact(message)}`);
  process.exit(1);
});
