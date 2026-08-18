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
  // ACT-015. The reusable answers every ATS form asks for. Collected once here
  // so no application has to stop and ask for them; each is genuinely optional,
  // and leaving one out means "not stated", never "no".
  "--work-authorized-us",
  "--requires-sponsorship",
  "--country",
  "--city",
  "--willing-to-relocate",
] as const;
type Flag = (typeof FLAGS)[number];

const USAGE = [
  "Usage: npm run intake -- --resume <path-to-pdf> --email <email>",
  "                        [--linkedin <url>] [--title <title>] [--pay-min <integer>]",
  "                        [--locations <csv>]",
  "",
  "  Application answers (ACT-015) — asked on almost every ATS form, stored once,",
  "  reused on every application. Omit any you have not been told; omitted means",
  "  \"not stated\", and a form asking for one will stop and ask rather than guess.",
  "",
  "  --work-authorized-us yes|no   legally authorized to work in the US",
  "  --requires-sponsorship yes|no will now or in future need visa sponsorship",
  "  --country <name>              country they currently live in, e.g. \"United States\"",
  "  --city <name>                 city they currently live in, e.g. \"Atlanta\"",
  "  --willing-to-relocate yes|no  willing to relocate for a role",
].join("\n");

/**
 * A yes/no answer, or a refusal to interpret one.
 *
 * Deliberately strict, and deliberately without a default. These become
 * statements a real person makes to a real employer, so "y", "yes", "true" and
 * "1" are all accepted as yes — and anything this does not recognise is an
 * error rather than a silent `false`, because a silent `false` here is an
 * answer nobody gave.
 */
function parseYesNo(flag: Flag, raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim().toLowerCase();
  if (["yes", "y", "true", "t", "1"].includes(value)) return true;
  if (["no", "n", "false", "f", "0"].includes(value)) return false;
  throw new Error(
    `${flag} must be yes or no, got: ${JSON.stringify(raw)}. Leave the flag out entirely if ` +
      `the candidate has not told you — that is recorded as "not stated", and a form that ` +
      `asks will stop and ask them rather than assume an answer.`
  );
}

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

  // Only the answers actually given are passed: an absent key means "never
  // asked", which is what the fill layer needs it to mean.
  const applicationAnswers = {
    ...(parseYesNo("--work-authorized-us", args.get("--work-authorized-us")) === undefined
      ? {}
      : { workAuthorizedUs: parseYesNo("--work-authorized-us", args.get("--work-authorized-us")) }),
    ...(parseYesNo("--requires-sponsorship", args.get("--requires-sponsorship")) === undefined
      ? {}
      : {
          requiresSponsorship: parseYesNo(
            "--requires-sponsorship",
            args.get("--requires-sponsorship")
          ),
        }),
    ...(parseYesNo("--willing-to-relocate", args.get("--willing-to-relocate")) === undefined
      ? {}
      : {
          willingToRelocate: parseYesNo("--willing-to-relocate", args.get("--willing-to-relocate")),
        }),
    ...(args.get("--country") === undefined ? {} : { currentCountry: args.get("--country") }),
    ...(args.get("--city") === undefined ? {} : { currentCity: args.get("--city") }),
  };

  const result = await intakeCandidate({
    resumeFilePath,
    applicationEmail,
    linkedinUrl: args.get("--linkedin"),
    targetTitle: args.get("--title"),
    payMin: parsePayMin(args.get("--pay-min")),
    locations: locationsRaw?.split(",").map((s) => s.trim()).filter(Boolean),
    ...(Object.keys(applicationAnswers).length === 0 ? {} : { applicationAnswers }),
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
