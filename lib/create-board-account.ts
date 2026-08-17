/**
 * ACT-005 — job-board account creation, and detection of the case where no
 * account is needed at all.
 *
 * Most Greenhouse postings are *direct-apply*: the application form is right
 * there on the listing page, and there is nothing to sign up for. Forcing an
 * account onto a board that does not want one is how this pipeline would break
 * on the majority of listings, so the flow here is detection-first:
 *
 *   1. insert a `job_applications` row with status `creating_account`
 *   2. navigate to the apply URL in a real browser and read the rendered page —
 *      a static fetch is not enough, ATS pages build their forms client-side
 *   3. if there is no account gate  → status `no_account_required`
 *      if there is an account gate → create the account with a password from
 *      ACT-004, then status `awaiting_verification`
 *
 * Scope stops there. Filling the application form is ACT-007 and submitting it
 * is ACT-008; this module must never touch either, even when account creation
 * lands it on the form.
 *
 * ── ACT-012: perception layer ────────────────────────────────────────────────
 * The browser is driven by Stagehand (`@browserbasehq/stagehand`) against a
 * **local, dedicated** Chrome, and the page is read by `extract()` — an LLM
 * reasoning over the accessibility tree — rather than by a hand-written
 * selector probe. Two things changed because of that, and both are load-bearing:
 *
 *  · **Unlabelled fields stopped being a problem.** The selector probe this
 *    replaces reached Salesforce's Workday create-account page and stopped one
 *    field short: Workday's email box is a plain `<input type="text">` with a
 *    generated id and no `name`, so nothing in its attributes says "email" and
 *    the probe correctly refused to guess. A reader that can see the *rendered
 *    label* has no such blind spot, and does not need a new selector per ATS.
 *
 *  · **The hijack-defence layer is gone.** The previous transport was a
 *    *shared* remote browser that another tenant could be routed into
 *    mid-flow, which is what the probe corroboration, board-identity keying and
 *    re-probe stability loops all existed to survive. A browser process this
 *    module launches, owns, and kills cannot be driven by anyone else, so those
 *    defences protect against nothing and were deleted rather than ported.
 *
 * What did *not* change is the decision layer: `classifyGate`,
 * `applicationFormSignals`, `APPLICATION_CONTROL_RE`, the `blocked()`
 * fail-closed exits and the never-retry-after-submit rule are the same rules,
 * reading the same facts from a different source.
 *
 * Targets the **actinno** Supabase project (`oihpglvvzzmjigxrlmfz`). The guard
 * below is deliberately the same shape as `candidate-intake.ts`'s — the meminno
 * project (`hlaeqvuyapkvixwaqxcs`) is a separate live product on the same
 * account and must never be written to from here. It is duplicated rather than
 * imported because `candidate-intake.ts` does not export it and is out of scope
 * for this ticket; if a third consumer appears, lift both copies into a shared
 * `lib/supabase.ts` at that point rather than now.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { type Page } from "@browserbasehq/stagehand";
// Session lifecycle, the observe() cache and `typeInto` used to live in this
// file. ACT-007 needs all three verbatim, so they moved to `stagehand-session.ts`
// rather than being copied — see that file's header.
import {
  closeBrowserSession,
  openBrowserSession,
  resolveAction,
  samePage,
  sleep,
  typeInto,
  NAVIGATION_TIMEOUT_MS,
  type BrowserSession,
} from "./stagehand-session.js";
import { generateBoardPassword } from "./generate-board-password.js";

/** Log prefix for this module's flow. */
const LOG = "[act-005]";

/** Project ref this module is allowed to write to. */
const EXPECTED_PROJECT_REF = "oihpglvvzzmjigxrlmfz";

/**
 * `job_applications.status` values this module writes. The column is free text
 * with a `discovered` default, so these are a convention, not a constraint.
 *
 * `no_account_required` is this ticket's addition: ACT-005's brief names
 * `creating_account` and `awaiting_verification`, but neither describes the
 * direct-apply outcome, and reusing `awaiting_verification` for it would tell
 * ACT-006 to sit waiting for a verification email that is never coming. The
 * ACT-007 form-fill step should treat `no_account_required` and
 * `email_verified` as equally ready to proceed.
 *
 * The table has outgrown "values *this module* writes" — it is now the whole
 * pipeline's status vocabulary, and it lives here because
 * `gmail-verification-listener.ts` already imports it from here. The lower half
 * is written by `fill-application-form.ts` (ACT-007) and
 * `submit-application.ts` (ACT-008). ACT-012's brief forbade
 * changing the values above; nothing forbids a later ticket adding values below
 * for a capability that did not exist yet, and the alternative — a second,
 * competing enum in another file — is how a status column stops meaning
 * anything.
 */
export const APPLICATION_STATUS = {
  /** Row created; browser work in flight. */
  CREATING_ACCOUNT: "creating_account",
  /** Direct-apply board — no signup exists, proceed straight to form fill. */
  NO_ACCOUNT_REQUIRED: "no_account_required",
  /** Signup submitted; waiting on the email verification listener (ACT-006). */
  AWAITING_VERIFICATION: "awaiting_verification",
  /**
   * An account gate exists but could not be filled safely — e.g. the signup
   * lives behind an SSO-only button, or the fields could not be identified
   * unambiguously. Needs a human; we do not guess-click on a real employer's
   * site. `error_message` carries the detail.
   */
  ACCOUNT_GATE_BLOCKED: "account_gate_blocked",
  /** Unrecoverable failure. `error_message` carries the detail. */
  ERROR: "error",

  // ── written by ACT-007 (`fill-application-form.ts`) ────────────────────────

  /**
   * The emailed verification ACT-006 detected has actually been completed — the
   * link was opened, or the code was entered — and the board accepted it.
   *
   * ACT-006 only *reports* the mail; nobody clicked anything. ACT-007 is what
   * completes it, and it records the fact here immediately, before it touches
   * the application form, because verification links and codes are single-use:
   * a crash between "verified" and "filled" must not send a retry back to a
   * link the board has already burned.
   */
  EMAIL_VERIFIED: "email_verified",
  /** Form-fill browser work in flight. Mirrors `creating_account`. */
  FILLING_FORM: "filling_form",
  /**
   * ACT-007's terminal success, and ACT-008's pickup signal: the application
   * form carries the candidate's data and has **not** been submitted.
   */
  FORM_FILLED: "form_filled",
  /**
   * The form could not be filled safely — an unreachable form, a captcha, a
   * required cover letter with nowhere to type it, a field whose identity could
   * not be corroborated. Nothing was submitted. Needs a human.
   * `error_message` carries the detail. Mirrors `account_gate_blocked`.
   */
  FORM_FILL_BLOCKED: "form_fill_blocked",

  // ── written by ACT-008 (`submit-application.ts`) ───────────────────────────
  //
  // On the naming: ACT-008's brief says "on failure, set status to `failed`".
  // These three values implement that requirement without adding a `failed`
  // synonym for the `error` above, because a single "failed" would collapse the
  // one distinction that matters most in this pipeline — whether the submit
  // button was pressed. `error` already means "a failure a retry might genuinely
  // fix" everywhere else here, and after a real submit a retry is precisely the
  // forbidden action, so the post-click case needs a value of its own that no
  // retry path will ever match.

  /**
   * The application was really submitted to the employer. Terminal, and the one
   * status in this table that can never be undone — `confirmation_ref` carries
   * whatever the board showed back (a reference number, the confirmation
   * wording, or "email confirmation incoming").
   *
   * Deliberately absent from ACT-007's `READY_STATUSES`, which is what stops a
   * second submission attempt against the same row before a browser is opened.
   */
  SUBMITTED: "submitted",
  /**
   * ACT-008 stopped **before** clicking anything — no control on the filled form
   * could be identified as *the* application submit, the candidates were
   * ambiguous, or a review gate declined. Nothing was sent; the form is still
   * sitting filled in a now-closed browser. `error_message` carries the detail.
   * Mirrors `form_fill_blocked`, and is safe to re-run from for the same reason.
   */
  SUBMISSION_BLOCKED: "submission_blocked",
  /**
   * The submit control **was clicked** and the result could not be confirmed —
   * the session died mid-click, the page could not be read afterwards, or the
   * board still shows the form. Whether a real application now exists at the
   * employer is unknown.
   *
   * This is not `error` on purpose. Never retry a row in this state
   * automatically: a human has to check the employer's side (and the inbox from
   * ACT-006) for an application that may already be there. `error_message`
   * carries the detail.
   */
  SUBMISSION_UNCONFIRMED: "submission_unconfirmed",
} as const;

export type ApplicationStatus =
  (typeof APPLICATION_STATUS)[keyof typeof APPLICATION_STATUS];

export type CreateBoardAccountInput = {
  candidateId: string;
  company: string;
  jobTitle: string;
  applyUrl: string;
  applicationEmail: string;
  atsProvider?: string;
  /**
   * Run Chrome headless. Default true. Set false to watch the run happen —
   * the local-debugging equivalent of the old `--keep-browser`, which meant
   * "leave the shared remote container alive so a human can open its console".
   * There is no remote console any more; there is a window on this machine.
   *
   * The browser is closed either way when the call returns: at
   * `concurrency: { limit: 5 }` a leaked Chrome per run is not survivable.
   */
  headless?: boolean;
};

// ───────────────────────────────────
// What the page reader reports back
// ───────────────────────────────────

/**
 * The shape `extract()` is asked to fill in. Every field here is something the
 * decision layer below actually reads — this is deliberately not a general page
 * description, because each extra field is another thing an LLM can be wrong
 * about on a page where being wrong writes to a real employer's row.
 *
 * The `.describe()` text is not documentation: zod's `toJSONSchema` carries it
 * into the schema Stagehand hands the model, so it *is* the instruction for
 * each field. That is where the precision lives — especially for
 * `emailFieldCount` (the field this whole migration exists for) and
 * `captchaPresent` (where the obvious naive question has a notorious false
 * positive).
 */
const GateSignalsSchema = z.object({
  passwordFieldCount: z
    .number()
    .int()
    .min(0)
    .describe(
      "Number of password inputs that are actually rendered and visible on the page. " +
        "A 'password' and a 'confirm password' box count as 2. Do not count hidden, " +
        "off-screen or collapsed fields, and do not count a password field that only " +
        "exists inside a closed menu or an unopened dialog."
    ),
  emailFieldCount: z
    .number()
    .int()
    .min(0)
    .describe(
      "Number of visible text inputs into which the applicant would type an EMAIL " +
        "ADDRESS, no matter how the input is marked up. Judge this from what a sighted " +
        "visitor reads — the field's visible label, or the surrounding form — not from " +
        "its HTML attributes. Workday, for example, renders its sign-up email box as a " +
        "plain <input type=\"text\"> with a generated id and no name attribute; it is " +
        "still an email field and must be counted. Do NOT count a field that asks for a " +
        "username, handle or member id rather than an address. Do NOT count password " +
        "fields, and do not count the same input twice."
    ),
  fileInputCount: z
    .number()
    .int()
    .min(0)
    .describe(
      "Number of visible controls that upload a FILE from the applicant's computer — " +
        "an <input type=file>, a 'Choose file' / 'Upload resume' / 'Attach CV' button, " +
        "or a drag-and-drop upload zone. Count the drag-and-drop zones: they are file " +
        "inputs wearing a costume. Do not count a link to a document."
    ),
  textInputCount: z
    .number()
    .int()
    .min(0)
    .describe(
      "Number of visible free-text inputs and textareas on the page (name, phone, " +
        "cover letter, and so on). Include the email field(s) counted above; exclude " +
        "password fields."
    ),
  formCount: z
    .number()
    .int()
    .min(0)
    .describe("Number of distinct forms rendered on the page."),
  iframeCount: z
    .number()
    .int()
    .min(0)
    .describe(
      "Number of embedded frames on the page. Some boards host their whole " +
        "application inside one, so this is evidence that an application may exist " +
        "even when no fields are visible at this level."
    ),
  clickableTexts: z
    .array(z.string())
    .describe(
      "The visible label of every link, button or clickable control on the page, as " +
        "the applicant reads it (e.g. \"Apply\", \"Apply Manually\", \"Sign In\", " +
        "\"Create Account\", \"Submit Application\"). Copy the wording exactly. Include " +
        "entries of an open menu. Omit controls that are not currently visible."
    ),
  captchaPresent: z
    .boolean()
    .describe(
      "True ONLY if the page shows an interactive anti-bot CHALLENGE the visitor would " +
        "have to solve or interact with — a reCAPTCHA checkbox, an image-selection " +
        "grid, an hCaptcha or Cloudflare Turnstile widget, a slider puzzle, or a " +
        "'Checking your browser' interstitial. It is FALSE for a passive notice such as " +
        "the 'This site is protected by reCAPTCHA and the Google Privacy Policy and " +
        "Terms of Service apply' footnote, a Cloudflare logo, or any other badge or " +
        "legal text that asks nothing of the visitor. Those appear on a large share of " +
        "ordinary forms and are not a challenge."
    ),
  captchaEvidence: z
    .string()
    .describe(
      "If captchaPresent is true, what was seen and where, in one short sentence. " +
        "Empty string otherwise."
    ),
});

type ExtractedGateSignals = z.infer<typeof GateSignalsSchema>;

/**
 * Everything the decision layer reads about one look at one page: what
 * `extract()` reported, what the browser knows for free (URL, title), and the
 * regex-filtered control-label buckets the gate rules match on.
 */
export type PageSignals = ExtractedGateSignals & {
  url: string;
  title: string;
  /** Length of `document.body.innerText` — context for the bail-out messages. */
  textLength: number;
  /** Control labels matching `AUTH_RE` — recorded, never acted on. */
  authTexts: string[];
  /** Control labels matching `APPLY_RE` — the only labels this flow will click. */
  applyTexts: string[];
  /** Control labels matching `SUBMIT_RE` — signup-submit candidates. */
  submitTexts: string[];
};

export type CreateBoardAccountResult = {
  jobApplicationId: string;
  status: ApplicationStatus;
  /** Whether the board actually gates applications behind an account. */
  accountGate: boolean;
  /** Human-readable justification for the gate verdict — logged and reviewable. */
  reasons: string[];
  finalUrl: string;
  pageTitle: string;
  signals: PageSignals;
  /** True only when a signup form was actually filled and submitted. */
  accountCreated: boolean;
};

// ───────────────────────────────────
// Supabase
// ───────────────────────────────────

/**
 * Guards against writing to the wrong Supabase project. Accepts the actinno
 * project ref, or a local/self-hosted Supabase (localhost / 127.0.0.1).
 */
function assertActinnoProject(rawUrl: string): void {
  let host: string;
  try {
    host = new URL(rawUrl).hostname;
  } catch {
    throw new Error(`SUPABASE_URL is not a valid URL: ${rawUrl}`);
  }

  if (host === "localhost" || host === "127.0.0.1") return;

  const ref = host.split(".")[0];
  if (ref !== EXPECTED_PROJECT_REF) {
    throw new Error(
      `Refusing to run: SUPABASE_URL points at Supabase project "${ref}", ` +
        `expected the actinno project "${EXPECTED_PROJECT_REF}". ` +
        `Check .env.local — do not reuse another project's credentials here.`
    );
  }
}

function getSupabaseClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars are required " +
        "(actinno project — see .env.example)"
    );
  }
  assertActinnoProject(url);

  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ───────────────────────────────────
// Reading the page
// ───────────────────────────────────

// \b on both ends is load-bearing, not decoration: without it "sign\s?-?\s?in"
// matches inside "de-signin-g", which made this fire on a Discord job
// description that says "designing backend systems". Verified against that real
// page after the fix.
const AUTH_RE =
  /\b(sign\s?-?\s?(in|up)|log\s?-?\s?in|logon|regist(er|ration)|create\s+(an\s+|your\s+)?account|candidate\s+(login|portal|profile)|forgot\s+password)\b/i;
const APPLY_RE = /^\s*apply\b/i;
const SUBMIT_RE =
  /\b(submit|continue|next|create|regist(er|ration)|sign\s?-?\s?up)\b/i;

const GATE_EXTRACT_INSTRUCTION =
  "You are looking at a job listing or job application page. Report the structure of " +
  "the page as an applicant sees it: how many sign-up fields, application fields and " +
  "upload controls are rendered, what every clickable control is labelled, and whether " +
  "an anti-bot challenge is blocking the page. Count only what is actually visible " +
  "right now — ignore hidden, disabled, off-screen and not-yet-opened elements.";

/**
 * The handful of facts a DOM query answers exactly and an LLM answers
 * approximately, read as a floor under the extracted counts.
 *
 * This is *not* the old `PAGE_PROBE_SCRIPT` coming back in disguise, and the
 * distinction matters: that probe's job was to *identify* fields — which input
 * is the email box — by accumulating selectors and heuristics per ATS, and that
 * job is exactly what `extract()` does better and is gone for good. This one
 * counts three element types that `querySelectorAll` counts exactly, and it
 * exists for one reason: for two of them, an *undercount* is the direction that
 * causes irreversible harm.
 *
 *  · `passwordFields` — undercount reads as DIRECT APPLY on a board that does
 *    gate applications, i.e. the false success this module is built to avoid.
 *  · `fileInputs` — undercount reads as "the signup form is isolated from the
 *    application form", which is the one mistake that can post a half-finished
 *    job application to a real employer under the candidate's name.
 *
 * `iframes` rides along because it is free and improves the apply-affordance
 * count; nothing safety-critical depends on it. The counts are merged with
 * `Math.max`, so this can only ever make the module *more* cautious than the
 * model was — it can add a bail-out, never remove one.
 */
const STRUCTURAL_FLOOR_SCRIPT = `(() => ({
  passwordFields: document.querySelectorAll('input[type=password]').length,
  fileInputs: document.querySelectorAll('input[type=file]').length,
  iframes: document.querySelectorAll('iframe').length,
  textLength: ((document.body && document.body.innerText) || '').trim().length
}))()`;

type StructuralFloor = {
  passwordFields: number;
  fileInputs: number;
  iframes: number;
  textLength: number;
};

/**
 * Anything at all that could hold or host an application, counted without an
 * LLM. Used only to decide whether it is worth paying for another `extract()`
 * while waiting for a late-mounting form — never to draw a verdict.
 */
const DOM_AFFORDANCE_SCRIPT = `document.querySelectorAll('form, input, textarea, select, iframe').length`;

async function readStructuralFloor(page: Page): Promise<StructuralFloor> {
  const raw = (await page.evaluate(STRUCTURAL_FLOOR_SCRIPT)) as Partial<StructuralFloor> | null;
  const count = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
  return {
    passwordFields: count(raw?.passwordFields),
    fileInputs: count(raw?.fileInputs),
    iframes: count(raw?.iframes),
    textLength: count(raw?.textLength),
  };
}

/** `uniq`, `slice` and the length filter exactly as the old probe applied them. */
function bucketControlLabels(clickableTexts: string[]): {
  authTexts: string[];
  applyTexts: string[];
  submitTexts: string[];
} {
  const texts = clickableTexts
    .map((text) => String(text ?? "").replace(/\s+/g, " ").trim())
    .filter((t) => t.length > 0 && t.length < 60);
  const uniq = (list: string[]): string[] => Array.from(new Set(list));

  return {
    authTexts: uniq(texts.filter((t) => AUTH_RE.test(t))).slice(0, 20),
    applyTexts: uniq(texts.filter((t) => APPLY_RE.test(t))).slice(0, 10),
    submitTexts: uniq(texts.filter((t) => SUBMIT_RE.test(t))).slice(0, 15),
  };
}

/**
 * One look at the page: what the model reports, floored by what the DOM knows
 * for certain, plus the URL and title the browser can simply be asked for.
 *
 * URL and title deliberately do not come from `extract()`. They are facts the
 * browser already holds; routing them through an LLM would spend tokens to make
 * them less reliable.
 */
async function readPageSignals(session: BrowserSession): Promise<PageSignals> {
  const { stagehand, page } = session;

  const { data: extracted } = await stagehand.extract(
    GATE_EXTRACT_INSTRUCTION,
    GateSignalsSchema,
    { page }
  );

  const floor = await readStructuralFloor(page);
  const [url, title] = await Promise.all([page.url(), page.title()]);

  const buckets = bucketControlLabels(extracted.clickableTexts);

  return {
    ...extracted,
    // Fail-closed merge — see STRUCTURAL_FLOOR_SCRIPT.
    passwordFieldCount: Math.max(extracted.passwordFieldCount, floor.passwordFields),
    fileInputCount: Math.max(extracted.fileInputCount, floor.fileInputs),
    iframeCount: Math.max(extracted.iframeCount, floor.iframes),
    url,
    title,
    textLength: floor.textLength,
    ...buckets,
  };
}

// ───────────────────────────────────
// The gate decision
// ───────────────────────────────────

/**
 * Decides whether the rendered page gates applying behind an account.
 *
 * A rendered password input is the only signal treated as conclusive. Auth
 * *wording* alone is not: plenty of direct-apply boards carry a "Sign in" link
 * in site chrome, or an optional "autofill from your profile" affordance, and
 * treating those as a gate is exactly the false positive this ticket is about.
 */
function classifyGate(signals: PageSignals): { accountGate: boolean; reasons: string[] } {
  const reasons: string[] = [];

  if (signals.passwordFieldCount > 0) {
    reasons.push(
      `${signals.passwordFieldCount} rendered password field(s) — conclusive account gate`
    );
    return { accountGate: true, reasons };
  }

  reasons.push("no rendered password field on the apply page");

  if (signals.fileInputCount > 0) {
    reasons.push(`${signals.fileInputCount} file input(s) present — resume upload is inline`);
  }
  if (signals.emailFieldCount > 0) {
    reasons.push(`${signals.emailFieldCount} email field(s) present in the inline form`);
  }
  if (signals.authTexts.length > 0) {
    // Recorded, not acted on — see the doc comment above.
    reasons.push(
      `auth-flavoured link text present but not gating: ${JSON.stringify(signals.authTexts)}`
    );
  }
  if (signals.iframeCount > 0) {
    reasons.push(`${signals.iframeCount} iframe(s) present (their contents were not read)`);
  }

  return { accountGate: false, reasons };
}

/**
 * How many apply-ish controls the flow will click through before giving up on
 * reaching the application. Two covers both shapes seen in the wild — a button
 * that reveals the form (Greenhouse-style) and a button that opens a menu whose
 * entry reveals it (Workday) — while keeping the number of actions taken on a
 * real employer's site to the minimum that answers the question.
 */
const APPLY_CLICK_ROUNDS = 2;

/** Whether the application form itself is already on screen. */
function applicationFormVisible(signals: PageSignals): boolean {
  return signals.fileInputCount > 0 || signals.emailFieldCount > 0;
}

/**
 * Anything on the page that could conceivably be applied or signed up *with*.
 *
 * Zero of these at the end of the apply flow is the false positive that survives
 * every emptiness check: a page whose chrome rendered fine while the application
 * widget never mounted. It has text, a title and clickable elements, so the page
 * plainly "rendered" — and then `classifyGate` finds no password field and
 * reports a confident DIRECT APPLY for a board nobody ever saw an application
 * on. Verified live on the old transport: Salesforce's Workday listing, one
 * second after "Apply Manually", was a 691-character page with 14 clickable
 * elements, a correct title, and not one form, input or upload control in it.
 *
 * Iframes count. A board that hosts its form in an iframe (Greenhouse's embedded
 * boards) legitimately shows no top-level inputs, and treating that as "no
 * application here" would break the direct-apply majority this module serves.
 */
function applyAffordanceCount(signals: PageSignals): number {
  return (
    signals.passwordFieldCount +
    signals.emailFieldCount +
    signals.fileInputCount +
    signals.textInputCount +
    signals.formCount +
    signals.iframeCount
  );
}

/**
 * How long to keep waiting for that widget before calling it absent.
 *
 * Shorter than the ladder this replaces, because it is now doing less work:
 * Stagehand's `domSettleTimeoutMs` has already absorbed first-paint timing by
 * the time anything here runs, so this is only waiting on a *second*, later
 * mount — a modal, a lazily-loaded form. Each rung costs one cheap DOM check;
 * only a rung that actually finds something pays for an `extract()`.
 */
const APPLY_UI_BACKOFF_MS: readonly number[] = [2_000, 4_000, 8_000];

/**
 * Waits for a page that rendered without an application on it to grow one, and
 * refuses to return if it never does.
 *
 * The refusal is the point. Every other outcome this module can reach says
 * something it has evidence for; "no account required" drawn from a page with
 * nothing to apply on says something it does not, and writes it to a real
 * employer's row where ACT-007 will act on it.
 */
async function awaitApplyUi(
  session: BrowserSession,
  before: PageSignals
): Promise<{ signals: PageSignals; note: string }> {
  let signals = before;
  let waitedMs = 0;

  for (const delayMs of APPLY_UI_BACKOFF_MS) {
    console.warn(
      `[act-005] "${signals.url}" rendered (${signals.textLength} chars, ` +
        `${signals.clickableTexts.length} clickable) but carries no form, input, upload ` +
        `control or iframe — waiting ${delayMs}ms for the application UI to mount`
    );
    await sleep(delayMs);
    waitedMs += delayMs;

    // Cheap deterministic check first: re-reading the page with the model on
    // every rung would spend three LLM calls to be told the DOM is still empty.
    const domAffordances = Number(await session.page.evaluate(DOM_AFFORDANCE_SCRIPT)) || 0;
    if (domAffordances === 0) continue;

    signals = await readPageSignals(session);
    if (applyAffordanceCount(signals) > 0) {
      return {
        signals,
        note:
          `the apply page had no form or input on first read; one mounted after ${waitedMs}ms ` +
          `of waiting`,
      };
    }
  }

  throw new Error(
    `Reached "${signals.url}" at the end of the apply flow and the page is rendered ` +
      `(${signals.textLength} characters of text, ${signals.clickableTexts.length} clickable ` +
      `elements), but after ${waitedMs}ms it still has no form, no text input, no email field, ` +
      `no file input, no password field and no iframe — there is nothing on it to apply with. ` +
      `Reporting "${APPLICATION_STATUS.NO_ACCOUNT_REQUIRED}" here would be a claim about an ` +
      `application nobody ever saw. Auth wording on the page: ` +
      `${JSON.stringify(signals.authTexts)}; apply-ish controls: ` +
      `${JSON.stringify(signals.applyTexts)}; submit-ish controls: ` +
      `${JSON.stringify(signals.submitTexts)}.`
  );
}

/**
 * Control labels that belong to the job application rather than to a signup.
 * `resume`/`CV` included because a control offering to submit one is submitting
 * an application, not creating an account.
 */
const APPLICATION_CONTROL_RE = /\b(apply|application|resume|cv)\b/i;

/**
 * Signs that a page carrying a signup form is *also* carrying the job
 * application form — the combined "create an account and upload your resume"
 * screen some ATS platforms use, where one button does both.
 *
 * A file input is the signal because it is the one element that has no business
 * on a pure signup form: boards ask for an email and a password, never for a
 * document. Only page-level evidence is available — the reader reports counts,
 * not which form owns each control — so a file input anywhere on the page has
 * to be treated as possibly wired to the same submit we are about to click.
 * That is the conservative direction on purpose: a false positive costs a row a
 * human has to look at, a false negative costs a half-finished job application
 * sent to a real employer under the candidate's name.
 *
 * Deliberately *not* signals, because each would fire on ordinary signup pages:
 * email fields (a signup needs one), text inputs (first/last name are normal),
 * and "Apply" link text (standard ATS page chrome — the same false positive
 * `classifyGate` documents).
 */
function applicationFormSignals(signals: PageSignals): string[] {
  const found: string[] = [];

  if (signals.fileInputCount > 0) {
    found.push(
      `${signals.fileInputCount} file input(s) on the page — resume/cover-letter upload sits ` +
        `alongside the signup fields`
    );
  }

  return found;
}

/**
 * Tag that makes a captcha bail-out greppable in `error_message`, since it
 * shares the `account_gate_blocked` status with every other stop-for-a-human
 * exit.
 */
const CAPTCHA_BLOCK_TAG = "captcha_present";

/**
 * The captcha reason string, or `null` when the page is clear.
 *
 * Solving is out of scope permanently, not just for this ticket. reCAPTCHA
 * Enterprise scores solver traffic and acts on it at the *account* level, so a
 * failed solve does not cost this run — it risks getting the candidate flagged
 * in a real employer's hiring pipeline, which is not a trade this pipeline is
 * ever allowed to make on their behalf. Detect, stop, hand it to a human.
 */
function captchaBlockReason(signals: PageSignals): string | null {
  if (!signals.captchaPresent) return null;
  const evidence = signals.captchaEvidence.trim();
  return (
    `${CAPTCHA_BLOCK_TAG}: an interactive anti-bot challenge is on the page at ` +
    `"${signals.url}"${evidence ? ` (${evidence})` : ""}. Nothing was filled or submitted. ` +
    `Solving captchas is permanently out of scope — automated attempts are flagged by ` +
    `reCAPTCHA Enterprise and risk banning the candidate from this employer's real hiring ` +
    `pipeline. A human has to complete this one.`
  );
}

// ───────────────────────────────────
// Main flow
// ───────────────────────────────────

function validateInput(input: CreateBoardAccountInput): void {
  const required: Array<[string, string | undefined]> = [
    ["candidateId", input.candidateId],
    ["company", input.company],
    ["jobTitle", input.jobTitle],
    ["applyUrl", input.applyUrl],
  ];
  for (const [name, value] of required) {
    if (!value?.trim()) throw new Error(`${name} is required`);
  }

  const email = input.applicationEmail?.trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error(
      `applicationEmail must be a valid email address (got: ${JSON.stringify(
        input.applicationEmail
      )})`
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(input.applyUrl.trim());
  } catch {
    throw new Error(`applyUrl must be a valid URL, got: ${input.applyUrl}`);
  }
  // A local Chrome will happily open file:// or a raw IP; an apply URL that is
  // not plain https is a configuration bug, not something to navigate to.
  if (parsed.protocol !== "https:") {
    throw new Error(`applyUrl must be https, got: ${parsed.protocol}//…`);
  }
}

/**
 * Drives a browser to the listing, determines whether the board requires an
 * account, and creates one only if it does.
 *
 * Always leaves a `job_applications` row behind: on failure the row's status is
 * `error` and `error_message` carries the reason, and the original error is
 * then rethrown so a caller (Inngest step, CLI) can retry or exit non-zero.
 */
export async function createBoardAccount(
  input: CreateBoardAccountInput
): Promise<CreateBoardAccountResult> {
  validateInput(input);

  const supabase = getSupabaseClient();
  const applicationEmail = input.applicationEmail.trim();
  const applyUrl = input.applyUrl.trim();

  const jobApplicationId = await claimApplicationRow(supabase, input, applyUrl);

  try {
    const result = await runBrowserFlow(
      supabase,
      jobApplicationId,
      applyUrl,
      applicationEmail,
      input.headless !== false
    );
    return { jobApplicationId, ...result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Persist before rethrowing: the ticket's requirement is that a failure is
    // never invisible in the table, not that it stops propagating.
    await recordFailure(supabase, jobApplicationId, message);
    throw err;
  }
}

/**
 * Returns the `job_applications` row id for this (candidate, apply URL),
 * creating it if needed, and marks it `creating_account`.
 *
 * Reuses an existing row rather than always inserting because this function is
 * driven from an Inngest `step.run` (`inngest/job-application-pipeline.ts`),
 * which re-executes its body on retry. A plain insert would leave one row per
 * attempt, so a listing that failed twice before succeeding would look like
 * three separate applications in the tracker.
 *
 * Caveat: `(candidate_id, apply_url)` has no unique index, so two *concurrent*
 * first-attempts could still both insert. That needs a DB constraint to fix
 * properly; the retry case this guards is the one that actually occurs, since
 * Inngest retries are sequential.
 */
async function claimApplicationRow(
  supabase: SupabaseClient,
  input: CreateBoardAccountInput,
  applyUrl: string
): Promise<string> {
  const candidateId = input.candidateId.trim();

  const { data: existing, error: selectError } = await supabase
    .from("job_applications")
    .select("id,status")
    .eq("candidate_id", candidateId)
    .eq("apply_url", applyUrl)
    .order("created_at", { ascending: true })
    .limit(1);

  if (selectError) {
    throw new Error(`job_applications lookup failed: ${selectError.message}`);
  }

  const found = existing?.[0];
  if (found?.id) {
    const id = found.id as string;
    // Clear any error from a previous attempt so a stale message cannot outlive
    // the failure it described.
    await updateApplication(supabase, id, {
      status: APPLICATION_STATUS.CREATING_ACCOUNT,
      error_message: null,
    });
    console.log(
      `[act-005] job_applications ${id} reused (was "${found.status}") → ` +
        `${APPLICATION_STATUS.CREATING_ACCOUNT}`
    );
    return id;
  }

  const { data: inserted, error: insertError } = await supabase
    .from("job_applications")
    .insert({
      candidate_id: candidateId,
      company: input.company.trim(),
      job_title: input.jobTitle.trim(),
      apply_url: applyUrl,
      ats_provider: input.atsProvider?.trim() || "greenhouse",
      status: APPLICATION_STATUS.CREATING_ACCOUNT,
    })
    // Round-trip the id so a silently-filtered insert (e.g. RLS) surfaces as an
    // error instead of a false success.
    .select("id")
    .single();

  if (insertError || !inserted?.id) {
    throw new Error(
      `job_applications insert failed: ${insertError?.message ?? "no id returned"}`
    );
  }
  const id = inserted.id as string;
  console.log(
    `[act-005] job_applications ${id} inserted → ${APPLICATION_STATUS.CREATING_ACCOUNT}`
  );
  return id;
}

type GateOutcome = {
  signals: PageSignals;
  verdict: { accountGate: boolean; reasons: string[] };
};

/**
 * Everything between "open a browser" and "we know whether this board gates
 * applications": navigate, read the page, click through to the application if
 * the listing hides it, and classify what is on screen.
 *
 * Nothing here writes to the board. Every step either navigates, reads, or
 * clicks a control whose label already matched `APPLY_RE`; nothing is typed and
 * nothing is submitted. Adding a step that writes would silently break that
 * property, so such a step belongs in `createAccount`, not here.
 */
async function detectAccountGate(
  session: BrowserSession,
  applyUrl: string
): Promise<GateOutcome> {
  console.log(`[act-005] navigate → ${applyUrl}`);
  await session.page.goto(applyUrl, { timeout: NAVIGATION_TIMEOUT_MS });

  let signals = await readPageSignals(session);
  console.log(`[act-005] landed on ${signals.url} — "${signals.title}"`);
  let verdict = classifyGate(signals);

  // "Start the application flow": on boards where the listing page only shows
  // a description, the form (and any gate behind it) appears after Apply.
  // Skipped when the form is already on screen — no reason to click anything
  // on a live employer's site that we do not need to.
  //
  // Rounds, rather than a single click, because one is not always enough:
  // Workday's "Apply" opens a *menu* ("Apply Manually", "Autofill with
  // Resume") and it is the menu entry that reaches the application. Stopping
  // after the first click left the run staring at an open menu with no form
  // and no password field, i.e. a confident — and wrong — DIRECT APPLY on a
  // board that does gate applications. Verified against the real Salesforce
  // Workday listing.
  //
  // Only labels already classified as apply-ish are ever clicked (`APPLY_RE`
  // anchors on a leading "apply"), which is what keeps "Autofill with Resume"
  // and "Use My Last Application" — controls that would upload a document or
  // submit a prior application — out of reach.
  const clickedApplyLabels = new Set<string>();
  const flowNotes: string[] = [];

  for (let round = 0; round < APPLY_CLICK_ROUNDS; round++) {
    if (verdict.accountGate || applicationFormVisible(signals)) break;
    // A label already clicked is not a next step — on a menu, clicking it
    // again just closes what the last click opened.
    const applyLabel = signals.applyTexts.find((text) => !clickedApplyLabels.has(text));
    if (applyLabel === undefined) break;
    clickedApplyLabels.add(applyLabel);

    console.log(`[act-005] no inline form yet — clicking "${applyLabel}" to start the flow`);
    await session.stagehand.act(
      `Click the control whose visible label is exactly "${applyLabel}". Do not click any ` +
        `other control, and do not upload anything.`,
      { page: session.page }
    );

    signals = await readPageSignals(session);
    verdict = classifyGate(signals);
    flowNotes.push(`re-read the page after clicking "${applyLabel}" — now at "${signals.url}"`);
  }

  // Last check before a verdict is drawn, and only in the direction that could
  // produce a false DIRECT APPLY: a gate that has already been *found* is
  // conclusive (a password field is on screen), so there is nothing to wait for
  // and nothing to doubt. It is the negative that needs the page to have shown
  // an application at all.
  if (!verdict.accountGate && applyAffordanceCount(signals) === 0) {
    const mounted = await awaitApplyUi(session, signals);
    signals = mounted.signals;
    verdict = classifyGate(signals);
    flowNotes.push(mounted.note);
  }

  // Applied once, after the loop: `classifyGate` returns a fresh reasons array
  // each round, so notes pushed onto an earlier round's verdict would be
  // dropped by the next one.
  verdict.reasons.unshift(...flowNotes);

  return { signals, verdict };
}

async function runBrowserFlow(
  supabase: SupabaseClient,
  jobApplicationId: string,
  applyUrl: string,
  applicationEmail: string,
  headless: boolean
): Promise<Omit<CreateBoardAccountResult, "jobApplicationId">> {
  // One Chrome process, owned by this call for its whole life. There is no
  // dead-session recovery below and none is needed: the browser cannot be
  // reassigned to another tenant, and if it dies the failure is real. Anything
  // Stagehand throws propagates to `createBoardAccount`, which records `error`
  // on the row and rethrows.
  const session = await openBrowserSession({ headless, logTag: LOG });
  console.log(
    `${LOG} local browser session opened (headless=${headless}) — dedicated to this run`
  );

  try {
    const { signals, verdict } = await detectAccountGate(session, applyUrl);

    console.log(
      `[act-005] gate verdict: ${verdict.accountGate ? "ACCOUNT REQUIRED" : "DIRECT APPLY"}`
    );
    for (const reason of verdict.reasons) console.log(`[act-005]   · ${reason}`);

    // Before either branch, because a challenge in front of the page invalidates
    // both of them: an unsolved captcha means neither "this board wants no
    // account" nor "here is its signup form" was ever really observed, and the
    // direct-apply verdict would send ACT-007 straight into the same wall.
    const captcha = captchaBlockReason(signals);
    if (captcha !== null) {
      await updateApplication(supabase, jobApplicationId, {
        status: APPLICATION_STATUS.ACCOUNT_GATE_BLOCKED,
        error_message: captcha,
      });
      console.warn(`[act-005] ${APPLICATION_STATUS.ACCOUNT_GATE_BLOCKED}: ${captcha}`);
      return {
        status: APPLICATION_STATUS.ACCOUNT_GATE_BLOCKED,
        accountGate: verdict.accountGate,
        reasons: [...verdict.reasons, captcha],
        finalUrl: signals.url,
        pageTitle: signals.title,
        signals,
        accountCreated: false,
      };
    }

    if (!verdict.accountGate) {
      await updateApplication(supabase, jobApplicationId, {
        status: APPLICATION_STATUS.NO_ACCOUNT_REQUIRED,
        error_message: null,
      });
      console.log(
        `[act-005] job_applications ${jobApplicationId} → ${APPLICATION_STATUS.NO_ACCOUNT_REQUIRED}` +
          ` (stopping here: form fill is ACT-007)`
      );
      return {
        status: APPLICATION_STATUS.NO_ACCOUNT_REQUIRED,
        accountGate: false,
        reasons: verdict.reasons,
        finalUrl: signals.url,
        pageTitle: signals.title,
        signals,
        accountCreated: false,
      };
    }

    return await createAccount(
      supabase,
      session,
      jobApplicationId,
      applicationEmail,
      signals,
      verdict.reasons
    );
  } finally {
    await closeBrowserSession(session);
  }
}

/** Instructions cached by `resolveAction`. Stable strings — they are cache keys. */
const EMAIL_FIELD_INSTRUCTION =
  "the input on the sign-up form where the applicant types their email address";
const PASSWORD_FIELD_INSTRUCTION =
  "the password input on the sign-up form";
const CONFIRM_PASSWORD_FIELD_INSTRUCTION =
  "the confirm-password / verify-password input on the sign-up form";
const SIGNUP_SUBMIT_INSTRUCTION = (label: string): string =>
  `the button labelled "${label}" that submits the sign-up form`;

/**
 * Fills and submits the board's signup form. Only reached when a password field
 * was actually rendered.
 *
 * Bails out to `account_gate_blocked` rather than guessing whenever the form is
 * ambiguous — clicking hopefully through a real employer's ATS is worse than
 * stopping and asking for a human.
 */
async function createAccount(
  supabase: SupabaseClient,
  session: BrowserSession,
  jobApplicationId: string,
  applicationEmail: string,
  signals: PageSignals,
  reasons: string[]
): Promise<Omit<CreateBoardAccountResult, "jobApplicationId">> {
  // `observed` defaults to the pre-submit read, but a bail-out that happens
  // *after* a click should report where the browser actually ended up — that is
  // the first thing the human this status escalates to will want to know.
  // `neverThrow` is set by every call site downstream of the submit click (the
  // point of no return — see below): once the browser has actually attempted a
  // submit, a failure recording that here must never escape as a rejected
  // promise, because `createBoardAccount`'s outer catch turns any rejection
  // into a retryable `error` status, and retrying after a submit risks a
  // double-signup. Call sites *before* the submit click deliberately keep the
  // default (rethrow on write failure): nothing has happened yet there, so
  // surfacing the failure and letting Inngest retry is the safe and desired
  // behaviour.
  const blocked = async (
    why: string,
    observed: PageSignals = signals,
    neverThrow = false
  ) => {
    try {
      await updateApplication(supabase, jobApplicationId, {
        status: APPLICATION_STATUS.ACCOUNT_GATE_BLOCKED,
        error_message: why,
      });
    } catch (err) {
      if (!neverThrow) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      console.error(
        `[act-005] could not record ${APPLICATION_STATUS.ACCOUNT_GATE_BLOCKED} on ` +
          `job_applications ${jobApplicationId} (the row may not reflect this): ${reason}. Not ` +
          `escalating to a retryable \`error\` status regardless — this is past the point of no ` +
          `return, and a retry here could double-submit. Needs a human to check the row directly.`
      );
    }
    console.warn(`[act-005] ${APPLICATION_STATUS.ACCOUNT_GATE_BLOCKED}: ${why}`);
    return {
      status: APPLICATION_STATUS.ACCOUNT_GATE_BLOCKED as ApplicationStatus,
      accountGate: true,
      reasons: [...reasons, why],
      finalUrl: observed.url,
      pageTitle: observed.title,
      signals: observed,
      accountCreated: false,
    };
  };

  if (signals.emailFieldCount !== 1) {
    return await blocked(
      `Account gate detected but ${signals.emailFieldCount} email fields were found ` +
        `(expected exactly 1) — cannot fill the signup form unambiguously.`
    );
  }
  // Two password fields is the normal "password + confirm" pair. Three or more
  // means we do not understand the form.
  if (signals.passwordFieldCount > 2) {
    return await blocked(
      `Account gate detected but ${signals.passwordFieldCount} password fields were found ` +
        `(expected 1 or 2) — cannot fill the signup form unambiguously.`
    );
  }

  // Scope boundary, enforced rather than assumed. Filling the application form
  // is ACT-007 and submitting it is ACT-008; some ATS platforms put "create your
  // account" and "upload your resume" on one screen behind one button, and on
  // such a page this function's email+password fill followed by a submit click
  // would post a half-finished *job application* to a real employer. There is no
  // way to un-send that, so any sign of the application form sharing the page
  // with the signup form stops the flow for a human.
  const applicationSignals = applicationFormSignals(signals);
  if (applicationSignals.length > 0) {
    return await blocked(
      `Account gate detected, but the signup form is not isolated from the job application ` +
        `form on this page (${applicationSignals.join("; ")}). Submitting here risks sending a ` +
        `partial job application, which is out of scope for ACT-005 (form fill is ACT-007, ` +
        `submission is ACT-008) — stopping for a human.`
    );
  }

  const submitCandidates = signals.submitTexts.filter((t) =>
    /(sign\s?-?\s?up|create|register|continue|submit)/i.test(t)
  );
  // Second half of the scope boundary, at control level rather than page level:
  // a control that names the application submits the application, whatever else
  // its label says. "Submit application" matches the generic submit pattern
  // above on the word "submit" alone, and clicking it is precisely the thing
  // ACT-005 must not do.
  const rejected = submitCandidates.filter((t) => APPLICATION_CONTROL_RE.test(t));
  const submitLabel = submitCandidates.find((t) => !APPLICATION_CONTROL_RE.test(t));
  if (!submitLabel) {
    return await blocked(
      `Account gate detected but no control on the page is safely a *signup* submit ` +
        `(candidates: ${JSON.stringify(signals.submitTexts)}` +
        (rejected.length > 0
          ? `; rejected because they submit the application itself, not a signup: ` +
            `${JSON.stringify(rejected)}`
          : "") +
        `).`
    );
  }

  // Password is generated per (candidate, board) by ACT-004 and stored before
  // it is typed, so a crash mid-submit still leaves the credential recoverable.
  //
  // TODO(before real / non-founder users): this is the write site ACT-004's
  // header TODO points at. `board_password` lands in Postgres as plaintext,
  // which is only acceptable while `job_applications` is service_role-only and
  // the sole user is the founder. Encrypt here (pgsodium / Supabase Vault, or
  // app-level envelope encryption) and decrypt only for the `typeInto` calls
  // below — that pair of lines is the entire blast radius.
  const boardPassword = generateBoardPassword();
  await updateApplication(supabase, jobApplicationId, { board_password: boardPassword });

  console.log(`[act-005] account gate — filling signup form at ${signals.url}`);

  // Filling is safe to fail loudly: nothing has been submitted, so nothing
  // exists to be confused about, and `error` (via `createBoardAccount`'s
  // handler) is both the honest status and the retryable one — a later run
  // starts from `goto` and fills a form it has actually looked at, which is the
  // only correct way to resume this.
  await typeInto(session, signals.url, EMAIL_FIELD_INSTRUCTION, applicationEmail);

  await typeInto(session, signals.url, PASSWORD_FIELD_INSTRUCTION, boardPassword);
  if (signals.passwordFieldCount === 2) {
    await typeInto(session, signals.url, CONFIRM_PASSWORD_FIELD_INSTRUCTION, boardPassword);
  }

  // Locating the submit control happens *before* the point of no return, and
  // deliberately outside the `try` below: an `observe()` that cannot find the
  // button has clicked nothing, so it is an ordinary retryable `error` — and
  // reporting it as a submission that may have landed would be a lie that costs
  // a human an investigation.
  const { action: submitAction } = await resolveAction(
    session,
    signals.url,
    SIGNUP_SUBMIT_INSTRUCTION(submitLabel)
  );

  // ── the point of no return ─────────────────────────────────────────────────
  // Everything from the submit click onward is wrapped, and *every* failure in
  // it exits as `account_gate_blocked` rather than `error`. That is deliberate
  // and is the single most important rule in this file.
  //
  // `error` invites a retry. A retry after this click would re-fill and
  // re-submit a signup that may already have registered this candidate's email
  // with a real employer, and nothing observable from here distinguishes "the
  // click never landed" from "the click landed and then the browser died" — the
  // page that would have answered is exactly what is gone. So the ambiguous
  // case is treated as the dangerous one. The password is already on the row for
  // whoever picks this up.
  let after: PageSignals;
  try {
    console.log(`[act-005] submitting signup via "${submitLabel}"`);
    // Deliberately no cache-miss retry here, unlike `typeInto`: a re-click is
    // not idempotent, and a second submit is precisely what must never happen.
    await session.stagehand.act({ ...submitAction, method: "click" }, {
      page: session.page,
    });

    after = await readPageSignals(session);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return await blocked(
      `Signup was submitted via "${submitLabel}", but the run failed before the result could ` +
        `be read: ${reason}. Whether the account was created is unknown — refusing to report ` +
        `${APPLICATION_STATUS.AWAITING_VERIFICATION} on no evidence, and not retrying, since ` +
        `the submission may already have taken effect. Needs a human.`,
      signals,
      true
    );
  }

  // The signup form disappearing is the stronger of the two signals; a move to a
  // different page of the board is the weaker one.
  const formGone = after.passwordFieldCount === 0;
  const movedOn = !samePage(after.url, signals.url);
  if (!formGone && !movedOn) {
    const captcha = captchaBlockReason(after);
    return await blocked(
      `Signup form was filled and submitted but the password field is still rendered at ` +
        `${after.url} — the board likely rejected the submission (validation or captcha).` +
        (captcha === null ? "" : ` ${captcha}`),
      after,
      true
    );
  }

  // Same never-throw discipline as `blocked(..., true)` above, and for the same
  // reason: the submit already happened, so a failure recording that here must
  // resolve, not reject — rejecting would let `createBoardAccount`'s outer catch
  // record a retryable `error` for a signup that has already gone through.
  try {
    await updateApplication(supabase, jobApplicationId, {
      status: APPLICATION_STATUS.AWAITING_VERIFICATION,
      error_message: null,
    });
    console.log(
      `[act-005] job_applications ${jobApplicationId} → ${APPLICATION_STATUS.AWAITING_VERIFICATION}` +
        ` (stopping here: form fill is ACT-007)`
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(
      `[act-005] signup was submitted and the browser confirmed it, but recording ` +
        `${APPLICATION_STATUS.AWAITING_VERIFICATION} on job_applications ${jobApplicationId} failed: ` +
        `${reason}. The row may still read a stale status — needs a human to check it directly. Not ` +
        `retrying regardless, since the submission already happened.`
    );
  }

  return {
    status: APPLICATION_STATUS.AWAITING_VERIFICATION,
    accountGate: true,
    reasons: [
      ...reasons,
      `signup submitted via "${submitLabel}"`,
      formGone
        ? `password field is gone from the page — form accepted`
        : `password field still rendered, but the board moved us on to "${after.url}"`,
    ],
    finalUrl: after.url,
    pageTitle: after.title,
    signals: after,
    accountCreated: true,
  };
}

// ───────────────────────────────────
// Row updates
// ───────────────────────────────────

type ApplicationPatch = {
  status?: ApplicationStatus;
  board_password?: string;
  error_message?: string | null;
};

async function updateApplication(
  supabase: SupabaseClient,
  jobApplicationId: string,
  patch: ApplicationPatch
): Promise<void> {
  // `updated_at` defaults to now() on insert only — nothing bumps it on UPDATE,
  // so set it explicitly or the column silently lies about row freshness.
  const { error } = await supabase
    .from("job_applications")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", jobApplicationId);

  if (error) {
    throw new Error(
      `Failed to update job_applications ${jobApplicationId} ` +
        `(${JSON.stringify(Object.keys(patch))}): ${error.message}`
    );
  }
}

/**
 * Records a failure on the row. Best-effort and never throws — if this is the
 * thing that failed, the caller still needs to see the *original* error, not a
 * bookkeeping error stacked on top of it.
 */
async function recordFailure(
  supabase: SupabaseClient,
  jobApplicationId: string,
  message: string
): Promise<void> {
  // Column is text so an oversized message would be accepted, but a full stack
  // dump in a status table helps nobody.
  const trimmed = message.length > 2000 ? `${message.slice(0, 2000)}…` : message;
  try {
    await updateApplication(supabase, jobApplicationId, {
      status: APPLICATION_STATUS.ERROR,
      error_message: trimmed,
    });
    console.error(`[act-005] job_applications ${jobApplicationId} → error: ${trimmed}`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(
      `[act-005] could not record failure on job_applications ${jobApplicationId}: ${reason}`
    );
  }
}
