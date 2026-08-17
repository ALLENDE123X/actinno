#!/usr/bin/env node
/**
 * Local test entrypoint for ACT-003 (candidate intake).
 *
 * Run from `lib/`:
 *   npm run intake -- --resume ./resume.pdf --email jane@example.com \
 *     --linkedin https://linkedin.com/in/jane --title "entry-level software engineer" \
 *     --pay-min 90000 --locations "Remote,New York"
 *
 * Reads credentials from the repo-root `.env.local` (gitignored). This writes
 * real rows and real storage objects to the actinno Supabase project.
 */

import { config } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { intakeCandidate } from "./candidate-intake.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// `.env.local` (secrets, gitignored) first, then `.env` (committed defaults).
// dotenv never overwrites an already-set variable, so first load wins and real
// process env still beats both.
const localEnv = config({ path: resolve(__dirname, "../.env.local") });
config({ path: resolve(__dirname, "../.env") });

if (localEnv.error) {
  console.warn(
    "[intake] No readable ../.env.local — relying on the ambient environment " +
      "for SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY."
  );
}

const FLAGS = [
  "--resume",
  "--email",
  "--linkedin",
  "--title",
  "--pay-min",
  "--locations",
] as const;
type Flag = (typeof FLAGS)[number];

const USAGE =
  "Usage: npm run intake -- --resume <path-to-pdf> --email <email> " +
  "[--linkedin <url>] [--title <title>] [--pay-min <integer>] [--locations <csv>]";

/**
 * Parses `--flag value` and `--flag=value`. Rejects unknown flags, repeated
 * flags, and missing values so a typo (e.g. `--linkedln`) fails loudly instead
 * of silently dropping the field.
 */
function parseArgs(argv: string[]): Map<Flag, string> {
  const out = new Map<Flag, string>();
  const isFlag = (s: string): s is Flag => (FLAGS as readonly string[]).includes(s);

  for (let i = 0; i < argv.length; i++) {
    // Loop bound guarantees this is defined; noUncheckedIndexedAccess can't see that.
    const token = argv[i]!;
    const eq = token.indexOf("=");
    const name = token.startsWith("--") && eq !== -1 ? token.slice(0, eq) : token;

    if (!isFlag(name)) {
      throw new Error(`Unknown argument: ${token}\n${USAGE}`);
    }
    if (out.has(name)) {
      throw new Error(`Duplicate argument: ${name}`);
    }

    let value: string | undefined;
    if (token.startsWith("--") && eq !== -1) {
      value = token.slice(eq + 1);
    } else {
      value = argv[++i];
      // Guard against `--title --pay-min 90000` swallowing the next flag.
      if (value !== undefined && isFlag(value)) {
        throw new Error(`Missing value for ${name} (got the next flag: ${value})`);
      }
    }
    if (value === undefined || value.trim() === "") {
      throw new Error(`Missing value for ${name}\n${USAGE}`);
    }
    out.set(name, value);
  }
  return out;
}

function parsePayMin(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  // Plain decimal digits only — Number() would also accept "1e5" or "0x100"
  // as valid integers, which isn't what a human typing --pay-min intends.
  if (!/^\d+$/.test(raw)) {
    throw new Error(`--pay-min must be a non-negative whole number, got: ${raw}`);
  }
  return Number(raw);
}

/** Never let a credential reach stdout/stderr, even inside a wrapped error. */
function redact(text: string): string {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return key ? text.split(key).join("[REDACTED_SERVICE_ROLE_KEY]") : text;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const resumeFilePath = args.get("--resume");
  const applicationEmail = args.get("--email");
  if (!resumeFilePath || !applicationEmail) {
    throw new Error(`--resume and --email are required\n${USAGE}`);
  }

  const locationsRaw = args.get("--locations");

  const result = await intakeCandidate({
    resumeFilePath,
    applicationEmail,
    linkedinUrl: args.get("--linkedin"),
    targetTitle: args.get("--title"),
    payMin: parsePayMin(args.get("--pay-min")),
    locations: locationsRaw?.split(",").map((s) => s.trim()).filter(Boolean),
  });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((err: unknown) => {
  // Message only, redacted — printing the raw error object risks dumping
  // request context from the Supabase client into the terminal or CI logs.
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[intake] ${redact(message)}`);
  process.exit(1);
});
