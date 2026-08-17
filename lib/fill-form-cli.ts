#!/usr/bin/env node
/**
 * Local test entrypoint for ACT-007 (application form-fill from resume).
 *
 * Run from `lib/`:
 *   npm run fill-form -- \
 *     --candidate 6636fa5e-aa43-4ad6-a074-c2ad096b2287 \
 *     --apply-url https://job-boards.greenhouse.io/discord/jobs/8545663002 \
 *     --keep-browser
 *
 * or, once you know the row id:
 *   npm run fill-form -- --application <job_applications uuid>
 *
 * Prerequisites, in order:
 *   1. `npm run intake` (ACT-003) — a `candidates` row with a **text** PDF
 *      resume in the private `resumes` bucket. A scanned resume has no text
 *      layer and this will refuse it; OCR is out of scope.
 *   2. `npm run create-account` (ACT-005) — a `job_applications` row sitting at
 *      `no_account_required` or `awaiting_verification`.
 *   3. If the row is at `awaiting_verification`, the code and/or link from
 *      ACT-006's `email/verification-received` event, passed with
 *      `--verification-link` / `--verification-code`. This is the step that
 *      actually completes the verification — ACT-006 only reports it.
 *
 * ── This is the acceptance test ─────────────────────────────────────────────
 * ACT-007's criterion is "run against one real listing, confirm the filled-but-
 * not-yet-submitted form matches the resume data correctly". The report printed
 * below is that confirmation: every field is listed with what was typed, what
 * the browser reads back out of the control afterwards, and how the control was
 * identified. `--keep-browser` shows the same thing on screen while it happens,
 * and a full-page screenshot is written either way.
 *
 * This drives a REAL browser against a REAL employer's job board with a REAL
 * candidate's data. It **never** submits — that is ACT-008. It is deliberately
 * one-shot with no retry loop; do not wrap it in one.
 */

import { config } from "dotenv";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fillApplicationForm,
  findJobApplicationId,
  FormFillBlockedError,
  type FillApplicationFormResult,
} from "./fill-application-form.js";
import { InjectionSuspectedError } from "./resume-parser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// `.env.local` (secrets, gitignored) first, then `.env` (committed defaults).
// dotenv never overwrites an already-set variable, so first load wins and real
// process env still beats both.
const localEnv = config({ path: resolve(__dirname, "../.env.local") });
config({ path: resolve(__dirname, "../.env") });

if (localEnv.error) {
  console.warn(
    "[act-007] No readable ../.env.local — relying on the ambient environment for " +
      "STAGEHAND_LLM_API_KEY / RESUME_LLM_API_KEY / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY."
  );
}

const VALUE_FLAGS = [
  "--application",
  "--candidate",
  "--apply-url",
  "--job-description-file",
  "--verification-link",
  "--verification-code",
  "--screenshot-dir",
] as const;
const BOOL_FLAGS = ["--requires-cover-letter", "--keep-browser"] as const;

type ValueFlag = (typeof VALUE_FLAGS)[number];
type BoolFlag = (typeof BOOL_FLAGS)[number];

const USAGE = [
  "Usage: npm run fill-form -- (--application <uuid> | --candidate <uuid> --apply-url <url>)",
  "                          [--requires-cover-letter] [--job-description-file <path>]",
  "                          [--verification-link <url>] [--verification-code <code>]",
  "                          [--screenshot-dir <path>] [--keep-browser]",
  "",
  "  --application             job_applications row id (from ACT-005)",
  "  --candidate / --apply-url look the row up instead of passing its id",
  "  --requires-cover-letter   ACT-002's requiresCoverLetter for this listing. A cover",
  "                            letter is written ONLY when this is given.",
  "  --job-description-file    file holding the listing's description text; used as",
  "                            (untrusted) background for the cover letter",
  "  --verification-link       verificationLink from ACT-006's event",
  "  --verification-code       verificationCode from ACT-006's event",
  "  --screenshot-dir          where to write the filled-form screenshot",
  "  --keep-browser            run Chrome headed (visible) instead of headless",
].join("\n");

type ParsedArgs = { values: Map<ValueFlag, string>; flags: Set<BoolFlag> };

/**
 * Parses `--flag value` and `--flag=value`. Rejects unknown and repeated flags
 * so a typo fails loudly instead of silently dropping the field — a dropped
 * `--verification-code` would look like an ordinary "no code supplied" block.
 */
function parseArgs(argv: string[]): ParsedArgs {
  const values = new Map<ValueFlag, string>();
  const flags = new Set<BoolFlag>();
  const isValueFlag = (s: string): s is ValueFlag =>
    (VALUE_FLAGS as readonly string[]).includes(s);
  const isBoolFlag = (s: string): s is BoolFlag => (BOOL_FLAGS as readonly string[]).includes(s);

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
    if (values.has(name)) throw new Error(`Duplicate argument: ${name}`);

    let value: string | undefined;
    if (token.startsWith("--") && eq !== -1) {
      value = token.slice(eq + 1);
    } else {
      value = argv[++i];
      // Guard against `--candidate --apply-url x` swallowing the next flag.
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
  for (const secret of [
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    process.env.STAGEHAND_LLM_API_KEY,
    process.env.RESUME_LLM_API_KEY,
    process.env.APIFY_API_TOKEN,
  ]) {
    if (secret) out = out.split(secret).join("[REDACTED]");
  }
  return out;
}

/**
 * The human-readable half of the acceptance check.
 *
 * `readBack` is the load-bearing column: it is what the browser says is in the
 * control now, read back out of the page after the fill, not what this process
 * believes it typed.
 */
function printReport(result: FillApplicationFormResult): void {
  const line = "─".repeat(78);
  console.log(`\n${line}`);
  console.log(`ACT-007 form fill — job_applications ${result.jobApplicationId}`);
  console.log(`status: ${result.status}    submitted: ${result.submitted}`);
  console.log(`page:   ${result.finalUrl}`);
  console.log(line);

  console.log(`\nverification: ${result.verification.detail}`);

  console.log("\nfields:");
  for (const field of result.fields) {
    const mark =
      field.outcome === "filled" ? "✓" : field.outcome === "mismatch" ? "✗" : "·";
    console.log(`  ${mark} ${field.field.padEnd(12)} ${field.outcome}`);
    if (field.intended !== null) console.log(`      typed:     ${field.intended}`);
    if (field.readBack !== undefined && field.readBack !== null) {
      console.log(`      reads as:  ${field.readBack}`);
    }
    console.log(`      ${field.detail}`);
  }

  console.log(
    `\ncover letter: required=${result.coverLetter.required} ` +
      `generated=${result.coverLetter.generated} filled=${result.coverLetter.filled} ` +
      `(${result.coverLetter.characters} chars)`
  );
  console.log(`  ${result.coverLetter.detail}`);

  // Parsed but not typed: a Greenhouse form has nowhere to put these, and its
  // education fields are typeahead comboboxes rather than text inputs. Printed
  // so the acceptance check covers the parse as well as the fill — the resume
  // PDF attached to the application is what actually carries them to the
  // employer.
  const { workHistory, education, skills } = result.parsedProfile;
  if (workHistory.length > 0 || education.length > 0) {
    console.log("\nparsed from the resume but not typed (no field on a Greenhouse form):");
    for (const job of workHistory) {
      console.log(
        `  · ${job.title ?? "?"} at ${job.company ?? "?"} ` +
          `(${[job.startDate, job.endDate].filter(Boolean).join(" – ") || "no dates"})`
      );
    }
    for (const school of education) {
      console.log(
        `  · ${[school.degree, school.discipline].filter(Boolean).join(", ") || "?"} ` +
          `at ${school.school ?? "?"}${school.endDate ? ` (${school.endDate})` : ""}`
      );
    }
    if (skills.length > 0) console.log(`  · ${skills.length} skill(s): ${skills.join(", ")}`);
  }

  if (result.profileWarnings.length > 0) {
    console.log("\nnotes from parsing the resume:");
    for (const warning of result.profileWarnings) console.log(`  · ${warning}`);
  }

  if (result.submitControlLabels.length > 0) {
    console.log(
      `\nNOT clicked (this is ACT-008's job): ${JSON.stringify(result.submitControlLabels)}`
    );
  }
  if (result.screenshotPath !== null) {
    console.log(`\nscreenshot of the filled, unsubmitted form: ${result.screenshotPath}`);
  }
  if (result.blockedReason !== null) {
    console.log(`\nBLOCKED — needs a human:\n  ${result.blockedReason}`);
  }
  console.log(`${line}\n`);
}

async function main(): Promise<void> {
  const { values, flags } = parseArgs(process.argv.slice(2));

  let jobApplicationId = values.get("--application");
  if (jobApplicationId === undefined) {
    const candidateId = values.get("--candidate");
    const applyUrl = values.get("--apply-url");
    if (!candidateId || !applyUrl) {
      throw new Error(
        `Either --application, or both --candidate and --apply-url, are required\n${USAGE}`
      );
    }
    jobApplicationId = await findJobApplicationId(candidateId, applyUrl);
    console.log(`[act-007] resolved job_applications ${jobApplicationId}`);
  }

  const descriptionFile = values.get("--job-description-file");
  const jobDescription =
    descriptionFile === undefined ? null : await readFile(descriptionFile, "utf8");

  const result = await fillApplicationForm({
    jobApplicationId,
    requiresCoverLetter: flags.has("--requires-cover-letter"),
    jobDescription,
    verification: {
      link: values.get("--verification-link") ?? null,
      code: values.get("--verification-code") ?? null,
    },
    headless: !flags.has("--keep-browser"),
    ...(values.get("--screenshot-dir") === undefined
      ? {}
      : { screenshotDir: values.get("--screenshot-dir")! }),
  });

  printReport(result);
  console.log(JSON.stringify(result, null, 2));

  // A blocked run is a real outcome with a real report, not a crash — but it did
  // not achieve the ticket's goal, so it must not look like success to a script.
  if (result.blockedReason !== null) process.exit(2);
}

main().catch((err: unknown) => {
  // A stop-for-a-human gets its own banner: unlike an ordinary failure it will
  // not be fixed by running the command again, and the row already says so.
  if (err instanceof FormFillBlockedError || err instanceof InjectionSuspectedError) {
    console.error(
      `\n[act-007] ══ STOPPED FOR A HUMAN ═════════════════════════════════════\n` +
        `[act-007] ${redact(err.message)}\n` +
        `[act-007] Nothing was submitted. Re-running will not change this.\n` +
        `[act-007] ════════════════════════════════════════════════════════════\n`
    );
    process.exit(2);
  }
  // Message only, redacted — printing the raw error object risks dumping request
  // context from the Supabase client into the terminal.
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[act-007] ${redact(message)}`);
  process.exit(1);
});
