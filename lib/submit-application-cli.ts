#!/usr/bin/env node
/**
 * Local test entrypoint for ACT-008 (submit the application + capture the
 * confirmation).
 *
 * ── READ THIS BEFORE RUNNING IT ─────────────────────────────────────────────
 * Every other CLI in this repo either reads something or leaves a form sitting
 * unsent. This one presses the button. It fills the application (ACT-007, in
 * the same browser) and then submits it to a real employer under a real
 * candidate's real name. There is no undo, no draft, and no grace period. Do
 * not run it to "see if it works".
 *
 * Because of that, `--yes-really-submit` is required. It is an argument-parsing
 * guard on this CLI and nothing more — it is deliberately **not** the review
 * gate the ticket discusses. The module itself defaults to full autonomy, which
 * is the behaviour ACT-009 will drive from Inngest with no human present; this
 * flag only stops a stray `npm run submit-application` in a terminal from being
 * an irreversible act. See `AUTO_APPROVE_SUBMISSION` in `submit-application.ts`
 * for the real gate and where to swap one in.
 *
 * Run from `lib/`:
 *   npm run submit-application -- \
 *     --application <job_applications uuid> \
 *     --yes-really-submit
 *
 * or, when you have the listing rather than the row id:
 *   npm run submit-application -- \
 *     --candidate <uuid> --apply-url <listing url> --yes-really-submit
 *
 * Prerequisites, in order: `npm run intake` (ACT-003), `npm run create-account`
 * (ACT-005), and — if the row is at `awaiting_verification` — the code and/or
 * link from ACT-006's `email/verification-received` event. There is no separate
 * `npm run fill-form` step to do first: this runs the fill itself, in the same
 * browser session, because a filled form cannot outlive its browser.
 *
 * ── This is the acceptance test ─────────────────────────────────────────────
 * ACT-008's criterion is "one real end-to-end submission, confirmation email
 * lands in the inbox used for ACT-006, `job_applications` row correctly reflects
 * `submitted` status". The report below covers the third of those and captures
 * what the board itself said; the inbox is checked by a human afterwards, and
 * deliberately not re-detected here (that is ACT-006's job, and re-implementing
 * it would be scope creep).
 *
 * Exit codes are distinct on purpose:
 *   0  submitted, confirmed
 *   2  stopped before clicking anything — safe, needs a human, nothing sent
 *   3  the submit control WAS clicked and the outcome is unknown — do not re-run
 *   1  an unexpected failure before anything was clicked
 */

import { config } from "dotenv";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  submitApplication,
  SubmissionBlockedError,
  type SubmitApplicationResult,
} from "./submit-application.js";
import { findJobApplicationId, FormFillBlockedError } from "./fill-application-form.js";
import { InjectionSuspectedError } from "./resume-parser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// `.env.local` (secrets, gitignored) first, then `.env` (committed defaults).
// dotenv never overwrites an already-set variable, so first load wins and real
// process env still beats both.
const localEnv = config({ path: resolve(__dirname, "../.env.local") });
config({ path: resolve(__dirname, "../.env") });

if (localEnv.error) {
  console.warn(
    "[act-008] No readable ../.env.local — relying on the ambient environment for " +
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
  "--fill-screenshot-dir",
] as const;
const BOOL_FLAGS = ["--requires-cover-letter", "--keep-browser", "--yes-really-submit"] as const;

type ValueFlag = (typeof VALUE_FLAGS)[number];
type BoolFlag = (typeof BOOL_FLAGS)[number];

const USAGE = [
  "Usage: npm run submit-application -- (--application <uuid> | --candidate <uuid> --apply-url <url>)",
  "                                   --yes-really-submit",
  "                                   [--requires-cover-letter] [--job-description-file <path>]",
  "                                   [--verification-link <url>] [--verification-code <code>]",
  "                                   [--screenshot-dir <path>] [--fill-screenshot-dir <path>]",
  "                                   [--keep-browser]",
  "",
  "  --yes-really-submit       REQUIRED. This really does send a real application to a",
  "                            real employer, under a real candidate's name, with no undo.",
  "  --application             job_applications row id (from ACT-005)",
  "  --candidate / --apply-url look the row up instead of passing its id",
  "  --requires-cover-letter   ACT-002's requiresCoverLetter for this listing. A cover",
  "                            letter is written ONLY when this is given.",
  "  --job-description-file    file holding the listing's description text; used as",
  "                            (untrusted) background for the cover letter",
  "  --verification-link       verificationLink from ACT-006's event",
  "  --verification-code       verificationCode from ACT-006's event",
  "  --screenshot-dir          where to write the post-submit screenshot",
  "  --fill-screenshot-dir     where ACT-007 writes its filled-form screenshot",
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

function printReport(result: SubmitApplicationResult): void {
  const line = "─".repeat(78);
  console.log(`\n${line}`);
  console.log(`ACT-008 submit — job_applications ${result.jobApplicationId}`);
  console.log(`status:    ${result.status}`);
  console.log(`submitted: ${result.submitted}    submit clicked: ${result.submitAttempted}`);
  console.log(`page:      ${result.finalUrl}`);
  console.log(`row updated: ${result.rowUpdated}`);
  console.log(line);

  console.log(`\nreview gate (${result.approval.gate}): ${result.approval.detail}`);

  if (result.fill !== null) {
    const filled = result.fill.fields.filter((f) => f.outcome === "filled").length;
    console.log(
      `\nfill (ACT-007): ${result.fill.status} — ${filled}/${result.fill.fields.length} ` +
        `field(s) filled and read back`
    );
    for (const field of result.fill.fields) {
      const mark = field.outcome === "filled" ? "✓" : field.outcome === "mismatch" ? "✗" : "·";
      console.log(`  ${mark} ${field.field.padEnd(12)} ${field.outcome}`);
    }
    if (result.fill.screenshotPath !== null) {
      console.log(`  screenshot of the filled form: ${result.fill.screenshotPath}`);
    }
  }

  console.log(
    `\nsubmit control: ${
      result.submitControlLabel === null ? "(none chosen)" : JSON.stringify(result.submitControlLabel)
    }`
  );

  if (result.confirmation !== null) {
    const c = result.confirmation;
    console.log("\nwhat the board said back:");
    console.log(`  confirmation page:      ${c.confirmationPresent}`);
    console.log(`  reference shown:        ${c.confirmationReference || "(none)"}`);
    console.log(`  email promised:         ${c.emailConfirmationPromised}`);
    console.log(`  form still on screen:   ${c.applicationFormStillPresent}`);
    if (c.confirmationText !== "") console.log(`  text: ${c.confirmationText}`);
    if (c.validationErrorsShown) console.log(`  errors: ${c.validationErrorText}`);
  }
  if (result.confirmationRef !== null) {
    console.log(`\nconfirmation_ref written to the row:\n  ${result.confirmationRef}`);
  }
  if (result.screenshotPath !== null) {
    console.log(`\npost-submit screenshot: ${result.screenshotPath}`);
  }

  if (result.blockedReason !== null) {
    console.log(`\nSTOPPED — nothing was clicked, needs a human:\n  ${result.blockedReason}`);
  }
  if (result.unconfirmedReason !== null) {
    console.log(
      `\n══ THE SUBMIT CONTROL WAS CLICKED AND THE OUTCOME IS UNKNOWN ══\n` +
        `  ${result.unconfirmedReason}\n` +
        `  Do NOT re-run this listing. Check the employer's side and the ACT-006\n` +
        `  inbox for an application that may already exist.`
    );
  }
  if (result.submitted) {
    console.log(
      `\nThe application has been sent. The acceptance check now needs a human: confirm the\n` +
        `confirmation email landed in the ACT-006 inbox.`
    );
  }
  console.log(`${line}\n`);
}

async function main(): Promise<void> {
  const { values, flags } = parseArgs(process.argv.slice(2));

  if (!flags.has("--yes-really-submit")) {
    throw new Error(
      "Refusing to run without --yes-really-submit.\n\n" +
        "This command submits a REAL job application to a REAL employer under a REAL\n" +
        "candidate's name. It cannot be undone, recalled or cancelled. If you wanted to\n" +
        "fill the form and look at it without sending it, that is `npm run fill-form`.\n\n" +
        USAGE
    );
  }

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
    console.log(`[act-008] resolved job_applications ${jobApplicationId}`);
  }

  const descriptionFile = values.get("--job-description-file");
  const jobDescription =
    descriptionFile === undefined ? null : await readFile(descriptionFile, "utf8");

  const result = await submitApplication({
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
    ...(values.get("--fill-screenshot-dir") === undefined
      ? {}
      : { fillScreenshotDir: values.get("--fill-screenshot-dir")! }),
  });

  printReport(result);
  console.log(JSON.stringify(result, null, 2));

  // Three distinct non-zero outcomes, because they need three distinct human
  // reactions: "fix it and re-run", "never re-run this row", and "it worked".
  if (result.unconfirmedReason !== null) process.exit(3);
  if (!result.submitted) process.exit(2);
}

main().catch((err: unknown) => {
  // Everything that reaches here happened before anything was clicked —
  // `submitApplication` only ever rejects on that side of the click. That is
  // the property this banner is allowed to assert.
  if (
    err instanceof SubmissionBlockedError ||
    err instanceof FormFillBlockedError ||
    err instanceof InjectionSuspectedError
  ) {
    console.error(
      `\n[act-008] ══ STOPPED FOR A HUMAN ═════════════════════════════════════\n` +
        `[act-008] ${redact(err.message)}\n` +
        `[act-008] Nothing was submitted. Re-running will not change this.\n` +
        `[act-008] ════════════════════════════════════════════════════════════\n`
    );
    process.exit(2);
  }
  // Message only, redacted — printing the raw error object risks dumping request
  // context from the Supabase client into the terminal.
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[act-008] ${redact(message)} (nothing was submitted)`);
  process.exit(1);
});
