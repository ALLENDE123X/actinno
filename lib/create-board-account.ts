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
 *   2. navigate to the apply URL in a real (Playwright) browser and probe the
 *      rendered DOM — a static fetch is not enough, ATS pages build their forms
 *      client-side
 *   3. if there is no account gate  → status `no_account_required`
 *      if there is an account gate → create the account with a password from
 *      ACT-004, then status `awaiting_verification`
 *
 * Scope stops there. Filling the application form is ACT-007 and submitting it
 * is ACT-008; this module must never touch either, even when account creation
 * lands it on the form.
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
import { generateBoardPassword } from "./generate-board-password.js";
import {
  ApifyMcpError,
  ApifyMcpSession,
  PlaywrightBrowser,
} from "./apify-mcp-client.js";

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
   * Close the shared Actor browser when finished. Default true — the standby
   * instance is shared, so leaving a page open is not neighbourly. Set false to
   * hand a warm page to a follow-on step.
   */
  closeBrowser?: boolean;
};

/** What the in-page probe reports back about the rendered apply page. */
export type PageProbe = {
  url: string;
  title: string;
  passwordFields: FieldDescriptor[];
  emailFields: FieldDescriptor[];
  fileInputs: number;
  textInputs: number;
  forms: Array<{ id: string | null; action: string | null; fields: number }>;
  authTexts: string[];
  applyTexts: string[];
  submitTexts: string[];
  iframes: string[];
  bodyMentionsAccount: boolean;
};

export type FieldDescriptor = {
  tag: string;
  type: string | null;
  name: string | null;
  id: string | null;
  autocomplete: string | null;
  label: string | null;
  placeholder: string | null;
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
  probe: PageProbe;
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
// Page probe
// ───────────────────────────────────

/**
 * One `evaluate` call that reports everything the gate decision needs. Done as
 * a single scripted probe rather than a series of get_html/click round-trips
 * because every Actor tool call is a separate billed event *and* a separate
 * page interaction — one probe is both cheaper and gentler on the target site.
 *
 * `String.raw` so the regex backslashes reach the browser intact. Deliberately
 * contains no `${`, which the tag would still interpolate.
 */
const PAGE_PROBE_SCRIPT = String.raw`
// \b on both ends is load-bearing, not decoration: without it "sign\s?-?\s?in"
// matches inside "de-signin-g", which made bodyMentionsAccount fire on a
// Discord job description that says "designing backend systems". Verified
// against that real page after the fix.
const AUTH_RE = /\b(sign\s?-?\s?(in|up)|log\s?-?\s?in|logon|regist(er|ration)|create\s+(an\s+|your\s+)?account|candidate\s+(login|portal|profile)|forgot\s+password)\b/i;
const APPLY_RE = /^\s*apply\b/i;
const SUBMIT_RE = /\b(submit|continue|next|create|regist(er|ration)|sign\s?-?\s?up)\b/i;

function describe(el) {
  var label = null;
  try {
    if (el.labels && el.labels.length > 0 && el.labels[0].innerText) {
      label = el.labels[0].innerText.replace(/\s+/g, ' ').trim().slice(0, 80);
    }
  } catch (e) { label = null; }
  return {
    tag: el.tagName.toLowerCase(),
    type: el.getAttribute('type'),
    name: el.getAttribute('name'),
    id: el.id || null,
    autocomplete: el.getAttribute('autocomplete'),
    label: label,
    placeholder: el.getAttribute('placeholder')
  };
}

function textOf(el) {
  var raw = el.innerText || el.value || el.getAttribute('aria-label') || '';
  return raw.replace(/\s+/g, ' ').trim();
}

var clickable = Array.prototype.slice.call(
  document.querySelectorAll('a,button,input[type=submit],input[type=button],[role=button]')
);
var texts = clickable.map(textOf).filter(function (t) { return t.length > 0 && t.length < 60; });
function uniq(list) { return Array.prototype.slice.call(new Set(list)); }

var passwords = Array.prototype.slice.call(document.querySelectorAll('input[type=password]'));
var emails = Array.prototype.slice.call(
  document.querySelectorAll('input[type=email],input[name*="email" i],input[id*="email" i]')
);

return {
  url: location.href,
  title: document.title,
  passwordFields: passwords.map(describe),
  emailFields: emails.map(describe),
  fileInputs: document.querySelectorAll('input[type=file]').length,
  textInputs: document.querySelectorAll('input[type=text],input:not([type])').length,
  forms: Array.prototype.slice.call(document.forms).map(function (f) {
    return { id: f.id || null, action: f.action || null, fields: f.elements.length };
  }).slice(0, 10),
  authTexts: uniq(texts.filter(function (t) { return AUTH_RE.test(t); })).slice(0, 20),
  applyTexts: uniq(texts.filter(function (t) { return APPLY_RE.test(t); })).slice(0, 10),
  submitTexts: uniq(texts.filter(function (t) { return SUBMIT_RE.test(t); })).slice(0, 15),
  iframes: Array.prototype.slice.call(document.querySelectorAll('iframe'))
    .map(function (f) { return f.src || '(srcdoc)'; }).slice(0, 10),
  bodyMentionsAccount: AUTH_RE.test((document.body && document.body.innerText) || '')
};
`;

/**
 * The probe is a string of JS executed in a remote browser, so a typo or a page
 * that breaks it comes back as `undefined`/`null` rather than a thrown error.
 * Validate the shape before any gate logic reads it — silently treating a
 * broken probe as "no password fields found" would report DIRECT APPLY on a
 * page nobody actually inspected, which is the one wrong answer that looks
 * like success.
 */
function assertProbeShape(value: unknown): asserts value is PageProbe {
  const probe = value as Partial<PageProbe> | null | undefined;
  const bad =
    !probe ||
    typeof probe !== "object" ||
    typeof probe.url !== "string" ||
    !Array.isArray(probe.passwordFields) ||
    !Array.isArray(probe.emailFields) ||
    typeof probe.fileInputs !== "number";

  if (bad) {
    throw new Error(
      `Page probe returned an unusable shape (expected PageProbe, got ` +
        `${JSON.stringify(value)?.slice(0, 300) ?? String(value)}) — refusing to ` +
        `judge the account gate from it.`
    );
  }

  // A blank page is structurally a perfect PageProbe: no password field, no
  // forms, no auth text — i.e. it reads as a confident "direct apply". It only
  // ever means the shared Actor browser lost the page, never that the board is
  // direct-apply, so it must never reach `classifyGate`.
  if (probe.url === "about:blank" || probe.url === "") {
    throw new Error(
      `Page probe ran against "${probe.url}" — the browser is not on the apply ` +
        `page, so no gate verdict can be drawn from it.`
    );
  }
}

/** Runs the probe and validates it in one step. */
async function probePage(browser: PlaywrightBrowser): Promise<PageProbe> {
  const raw = await browser.evaluate<unknown>(PAGE_PROBE_SCRIPT);
  assertProbeShape(raw);
  return raw;
}

/** Compares URLs by origin + path — query/hash churn is not a different page. */
function samePage(a: string, b: string): boolean {
  try {
    const left = new URL(a);
    const right = new URL(b);
    return (
      left.origin === right.origin &&
      left.pathname.replace(/\/+$/, "") === right.pathname.replace(/\/+$/, "")
    );
  } catch {
    return false;
  }
}

/**
 * Navigates and probes, refusing to return a probe of the wrong page.
 *
 * This guard exists because it fired in practice. `navigate` returned Discord's
 * real URL and title, and the very next `evaluate` — a separate billed
 * round-trip — ran against `about:blank`. The Playwright Actor's browser
 * belongs to a *shared* standby instance (see `apify-mcp-client.ts`), so
 * between two calls the instance can recycle, or another tenant of this public
 * Actor can navigate it away.
 *
 * The failure mode is the dangerous kind: a blank page has no password field,
 * so `classifyGate` reports a confident "DIRECT APPLY" for a board nobody
 * looked at. Structural validation cannot catch it — `about:blank` yields a
 * perfectly well-formed PageProbe. Only comparing the probed URL against the
 * URL we asked for catches it.
 *
 * One re-navigation is allowed, because this is a transient property of a
 * third-party Actor rather than a problem with the target site. Beyond that it
 * fails loudly: reporting no verdict is correct, guessing one is not.
 */
async function navigateAndProbe(
  browser: PlaywrightBrowser,
  applyUrl: string,
  attemptsLeft = 1
): Promise<PageProbe> {
  console.log(`[act-005] navigate → ${applyUrl}`);
  const nav = await browser.navigate(applyUrl);
  console.log(`[act-005] landed on ${nav.url} — "${nav.title}"`);

  const probe = await probePage(browser);

  // Match against what `navigate` actually reported, not the requested URL, so
  // a legitimate board-side redirect is accepted while a lost page is not.
  if (samePage(probe.url, nav.url)) return probe;

  const complaint =
    `probe ran against "${probe.url}" but navigation had landed on "${nav.url}" — ` +
    `the shared Actor browser lost the page between calls`;

  if (attemptsLeft > 0) {
    console.warn(`[act-005] ${complaint}; re-navigating once`);
    return await navigateAndProbe(browser, applyUrl, attemptsLeft - 1);
  }
  throw new Error(
    `${complaint}. Refusing to report a gate verdict for a page that was never inspected.`
  );
}

/**
 * Second-level labels used by country registries, so `example.co.uk` is not
 * mistaken for a site called `co.uk`. Not a public suffix list — see `siteOf`.
 */
const GENERIC_SECOND_LEVEL = new Set(["co", "com", "net", "org", "edu", "gov", "ac", "ne", "or"]);

/**
 * Cheap registrable-domain approximation (no PSL dependency): the last two
 * hostname labels, or three when the second-to-last is a country registry's
 * generic second level. Wrong answers land on "these are different sites",
 * which only ever costs a safe bail-out.
 */
function siteOf(hostname: string): string {
  const labels = hostname.toLowerCase().split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const take = GENERIC_SECOND_LEVEL.has(labels[labels.length - 2]!) ? 3 : 2;
  return labels.slice(-take).join(".");
}

/**
 * ATS platforms that put *every* employer on one shared hostname and identify
 * the employer by the first path segment (`boards.greenhouse.io/acme/jobs/1`,
 * `jobs.lever.co/acme/<id>`). For these, hostname alone is not an identity:
 * `siteOf` reduces Company A's and Company B's boards to the same
 * `greenhouse.io`, so a hostname-only check would happily corroborate one
 * company's page as evidence about another company's submission.
 *
 * That is not hypothetical here — `inngest/job-application-pipeline.ts` runs
 * this flow at `concurrency: { limit: 5 }` against one *shared* standby browser
 * (see `apify-mcp-client.ts`), and five concurrent runs on Greenhouse is the
 * expected case, not the exotic one.
 *
 * Matched against the full hostname. Greenhouse and Lever are the two providers
 * this pipeline names (`inngest/job-application-pipeline.ts`, `mcp-server/index.ts`);
 * the rest are the common shared-domain boards an `atsProvider: "other"` listing
 * can land on. A wrong or stale entry only ever makes the check *stricter* —
 * the cost is a safe bail-out, never a false success — so erring towards
 * inclusion is the right direction.
 */
const PATH_TENANT_HOSTS: readonly RegExp[] = [
  /^(job-)?boards(\.eu)?\.greenhouse\.io$/, // boards. / job-boards. / .eu. variants
  /^jobs(\.eu)?\.lever\.co$/,
  /^jobs\.ashbyhq\.com$/,
  /^(careers|jobs)\.smartrecruiters\.com$/,
  /^apply\.workable\.com$/,
  /^jobs\.jobvite\.com$/,
];

/**
 * The same problem one level up: platforms that give each employer its own
 * *subdomain* (`acme.wd5.myworkdayjobs.com`, `acme.icims.com`). `siteOf`'s
 * registrable-domain reduction is precisely what erases the tenant here, so for
 * these the whole hostname is the identity.
 */
const SUBDOMAIN_TENANT_SITES: ReadonlySet<string> = new Set([
  "myworkdayjobs.com",
  "icims.com",
  "bamboohr.com",
  "breezy.hr",
  "recruitee.com",
  "teamtailor.com",
  "applytojob.com", // JazzHR
  "workable.com", // legacy acme.workable.com boards; apply.workable.com is path-tenanted above
]);

/**
 * The employer slug carried by a shared-hostname board URL, or `null` if the
 * URL carries no identifiable employer at all (in which case it must not be
 * treated as matching anything, including another such URL).
 */
function tenantSegmentOf(url: URL): string | null {
  const segments = url.pathname.split("/").filter(Boolean);
  const first = segments[0]?.toLowerCase();
  // No path at all (a board root) is nobody's flow; it can only ever match
  // another board root, which `samePage` would have caught already.
  if (first === undefined) return "";
  // Greenhouse's embedded boards carry the employer in `?for=` instead, e.g.
  // `boards.greenhouse.io/embed/job_app?for=acme&token=1`. Normalising it to
  // the same slug keeps an embed → hosted-board redirect corroborating. Every
  // employer's embed shares the identical `/embed/job_app` path, so a
  // `for`-less embed carries no employer identity to key on at all — return
  // null rather than a path-based fallback, which would be indistinguishable
  // across employers and reintroduce the exact collision this function
  // exists to prevent.
  if (first === "embed") {
    const employer = url.searchParams.get("for")?.trim().toLowerCase();
    return employer || null;
  }
  return first;
}

/**
 * Identity of the *board* a URL belongs to — the unit that has to match for one
 * page to be evidence about another. Registrable domain for an employer's own
 * career site (presumed single-tenant), domain + employer slug on a shared ATS
 * host, full hostname where the ATS tenants by subdomain.
 *
 * Ambiguous pairs (say `boards.greenhouse.io/acme/...` vs `my.greenhouse.io/...`)
 * resolve to different keys and therefore to "not corroborated". That is the
 * intended direction: the alternative is corroborating Company A's submit
 * against a page that may belong to Company B.
 */
function boardKeyOf(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  const site = siteOf(hostname);
  if (PATH_TENANT_HOSTS.some((pattern) => pattern.test(hostname))) {
    const tenant = tenantSegmentOf(url);
    if (tenant === null) return null;
    // Keyed on the site rather than the hostname so Greenhouse's own
    // boards. → job-boards. move stays the same board.
    return `${site}/${tenant}`;
  }
  if (SUBDOMAIN_TENANT_SITES.has(site)) return hostname;
  return site;
}

/**
 * Deliberately coarser than `samePage`: used only to check that a page reached
 * by clicking plausibly belongs to the board we were just on, rather than to
 * another tenant of the shared Actor browser — including the case where that
 * other tenant is a *different employer on the same ATS vendor*, which a
 * hostname-only comparison cannot see.
 */
function sameBoard(a: string, b: string): boolean {
  const left = boardKeyOf(a);
  const right = boardKeyOf(b);
  return left !== null && left === right;
}

type ReprobeOutcome =
  | { corroborated: true; probe: PageProbe; note: string }
  | { corroborated: false; probe: PageProbe; complaint: string };

/** Probes after an interaction; two agreeing passes minimum, three attempts max. */
const REPROBE_PASSES = 3;

/**
 * `navigateAndProbe`'s guarantee, for pages reached by *clicking* rather than
 * navigating.
 *
 * `navigateAndProbe` corroborates a probe against the URL `navigate` reported.
 * After a click there is no such reference point, and the naive substitute —
 * "the URL changed, so the click must have worked" — is exactly what the shared
 * Actor browser breaks: another tenant navigating the instance between our
 * click and our probe also changes the URL, and would be read as proof our
 * click did something. That misread is worse after a *submit* click than
 * anywhere else in this module, because it writes `awaiting_verification` for
 * an account that was never created, and ACT-006 then waits forever for a
 * verification email nobody sent.
 *
 * Two independent checks replace the missing reference point:
 *
 *  1. **Stability** — probe until two consecutive probes describe the same page.
 *     A page being churned by another caller (or one still mid-navigation from
 *     our own click) does not hold still across two round-trips.
 *  2. **Relatedness** — the settled page must be the page we interacted with, or
 *     at least elsewhere on the *same employer's board* (`sameBoard`, not merely
 *     the same hostname: on a multi-tenant ATS every employer shares one
 *     domain). A hijacked browser is on somebody else's URL — quite possibly
 *     another Greenhouse employer's, since concurrent runs share this browser;
 *     a real signup step stays within this employer's own board.
 *
 * Retries are re-probes only, never re-clicks: this runs after a submit that may
 * already have taken effect, and clicking twice on a real employer's ATS is not
 * a recoverable mistake. Callers get a verdict rather than an exception, because
 * "we cannot tell what happened" resolves differently before a submit (retry the
 * flow) and after one (stop, a human must look).
 */
async function reprobeAfterInteraction(
  browser: PlaywrightBrowser,
  before: PageProbe,
  interaction: string
): Promise<ReprobeOutcome> {
  let previous = await probePage(browser);
  let settled: PageProbe | undefined;

  for (let pass = 1; pass < REPROBE_PASSES; pass++) {
    const current = await probePage(browser);
    if (samePage(current.url, previous.url)) {
      settled = current;
      break;
    }
    console.warn(
      `[act-005] page moved between probes ("${previous.url}" → "${current.url}") after ` +
        `${interaction}; re-probing`
    );
    previous = current;
  }

  if (!settled) {
    return {
      corroborated: false,
      probe: previous,
      complaint:
        `the page never held still across ${REPROBE_PASSES} consecutive probes after ` +
        `${interaction} (last seen "${previous.url}") — the shared Actor browser is being ` +
        `driven by someone else, so nothing observed on it can be attributed to us`,
    };
  }

  // Relatedness is checked *before* `samePage`, not after it, because on a
  // multi-tenant ATS "same origin + same path" does not imply "same employer":
  // Greenhouse's embedded boards identify the employer in the query string
  // (`/embed/job_app?for=acme`), which `samePage` deliberately ignores as churn.
  // Two concurrent runs on two employers' embed URLs would otherwise short-circuit
  // straight to `corroborated: true` on the strongest branch of all.
  if (!sameBoard(settled.url, before.url)) {
    return {
      corroborated: false,
      probe: settled,
      complaint:
        `after ${interaction} the browser settled on "${settled.url}", which does not belong to ` +
        `the same board as the page that was interacted with ("${before.url}") — a page belonging ` +
        `to another site, or to another employer on the same ATS, cannot be evidence about what ` +
        `that interaction did`,
    };
  }

  if (samePage(settled.url, before.url)) {
    return {
      corroborated: true,
      probe: settled,
      note: `page stayed on "${settled.url}" after ${interaction}`,
    };
  }
  return {
    corroborated: true,
    probe: settled,
    note: `page moved "${before.url}" → "${settled.url}" (same board) after ${interaction}`,
  };
}

/**
 * Decides whether the rendered page gates applying behind an account.
 *
 * A rendered password input is the only signal treated as conclusive. Auth
 * *wording* alone is not: plenty of direct-apply boards carry a "Sign in" link
 * in site chrome, or an optional "autofill from your profile" affordance, and
 * treating those as a gate is exactly the false positive this ticket is about.
 */
function classifyGate(probe: PageProbe): { accountGate: boolean; reasons: string[] } {
  const reasons: string[] = [];

  if (probe.passwordFields.length > 0) {
    reasons.push(
      `${probe.passwordFields.length} rendered password field(s) — conclusive account gate`
    );
    return { accountGate: true, reasons };
  }

  reasons.push("no rendered password field on the apply page");

  if (probe.fileInputs > 0) {
    reasons.push(`${probe.fileInputs} file input(s) present — resume upload is inline`);
  }
  if (probe.emailFields.length > 0) {
    reasons.push(`${probe.emailFields.length} email field(s) present in the inline form`);
  }
  if (probe.authTexts.length > 0) {
    // Recorded, not acted on — see the doc comment above.
    reasons.push(
      `auth-flavoured link text present but not gating: ${JSON.stringify(probe.authTexts)}`
    );
  }
  if (probe.iframes.length > 0) {
    reasons.push(`iframes present (probe cannot see inside): ${JSON.stringify(probe.iframes)}`);
  }

  return { accountGate: false, reasons };
}

/** Whether the application form itself is already on screen. */
function applicationFormVisible(probe: PageProbe): boolean {
  return probe.fileInputs > 0 || probe.emailFields.length > 0;
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
 * document. Only page-level evidence is available — the probe reports counts,
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
function applicationFormSignals(probe: PageProbe): string[] {
  const signals: string[] = [];

  if (probe.fileInputs > 0) {
    signals.push(
      `${probe.fileInputs} file input(s) on the page — resume/cover-letter upload sits alongside ` +
        `the signup fields`
    );
  }

  return signals;
}

/** Most specific stable selector we can build for a probed field. */
function selectorFor(field: FieldDescriptor, fallback: string): string {
  if (field.id) return `#${CSS_escape(field.id)}`;
  if (field.name) return `${field.tag}[name="${field.name}"]`;
  return fallback;
}

/** Minimal CSS.escape for ids — ATS ids routinely contain `:` and `.`. */
function CSS_escape(value: string): string {
  return value.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
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
  // The browser Actor will happily open file:// or a raw IP; an apply URL that
  // is not plain https is a configuration bug, not something to navigate to.
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
      input.closeBrowser !== false
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

async function runBrowserFlow(
  supabase: SupabaseClient,
  jobApplicationId: string,
  applyUrl: string,
  applicationEmail: string,
  closeBrowser: boolean
): Promise<Omit<CreateBoardAccountResult, "jobApplicationId">> {
  const session = await ApifyMcpSession.open();
  const browser = new PlaywrightBrowser(session);

  try {
    let probe = await navigateAndProbe(browser, applyUrl);
    let verdict = classifyGate(probe);

    // "Start the application flow": on boards where the listing page only shows
    // a description, the form (and any gate behind it) appears after Apply.
    // Skipped when the form is already on screen — no reason to click anything
    // on a live employer's site that we do not need to.
    if (!verdict.accountGate && !applicationFormVisible(probe) && probe.applyTexts.length > 0) {
      const applyLabel = probe.applyTexts[0]!;
      console.log(`[act-005] no inline form yet — clicking "${applyLabel}" to start the flow`);
      await browser.click({ text: applyLabel });

      // Same discipline as `navigateAndProbe`: a probe that cannot be tied back
      // to the page we clicked is not evidence about what the click did, and
      // "direct apply" drawn from a page belonging to another tenant of the
      // shared browser is the false success this module exists to avoid.
      // Failing here is safe to retry — nothing has been filled or submitted
      // yet — so it throws, and `createBoardAccount` records `error` on the row.
      const started = await reprobeAfterInteraction(
        browser,
        probe,
        `clicking "${applyLabel}"`
      );
      if (!started.corroborated) {
        throw new Error(
          `Clicked "${applyLabel}" to start the application flow, but ${started.complaint}. ` +
            `Refusing to report a gate verdict for a page that was never inspected.`
        );
      }
      probe = started.probe;
      verdict = classifyGate(probe);
      verdict.reasons.unshift(`re-probed after clicking "${applyLabel}" — ${started.note}`);
    }

    console.log(
      `[act-005] gate verdict: ${verdict.accountGate ? "ACCOUNT REQUIRED" : "DIRECT APPLY"}`
    );
    for (const reason of verdict.reasons) console.log(`[act-005]   · ${reason}`);

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
        finalUrl: probe.url,
        pageTitle: probe.title,
        probe,
        accountCreated: false,
      };
    }

    return await createAccount(
      supabase,
      browser,
      jobApplicationId,
      applicationEmail,
      probe,
      verdict.reasons
    );
  } finally {
    if (closeBrowser) {
      const closeFailure = await browser.closeQuietly();
      if (closeFailure) console.warn(`[act-005] close_browser failed (ignored): ${closeFailure}`);
    }
    await session.close();
  }
}

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
  browser: PlaywrightBrowser,
  jobApplicationId: string,
  applicationEmail: string,
  probe: PageProbe,
  reasons: string[]
): Promise<Omit<CreateBoardAccountResult, "jobApplicationId">> {
  // `observed` defaults to the pre-submit probe, but a bail-out that happens
  // *after* a click should report where the browser actually ended up — that is
  // the first thing the human this status escalates to will want to know.
  const blocked = async (why: string, observed: PageProbe = probe) => {
    await updateApplication(supabase, jobApplicationId, {
      status: APPLICATION_STATUS.ACCOUNT_GATE_BLOCKED,
      error_message: why,
    });
    console.warn(`[act-005] ${APPLICATION_STATUS.ACCOUNT_GATE_BLOCKED}: ${why}`);
    return {
      status: APPLICATION_STATUS.ACCOUNT_GATE_BLOCKED as ApplicationStatus,
      accountGate: true,
      reasons: [...reasons, why],
      finalUrl: observed.url,
      pageTitle: observed.title,
      probe: observed,
      accountCreated: false,
    };
  };

  if (probe.emailFields.length !== 1) {
    return await blocked(
      `Account gate detected but ${probe.emailFields.length} email fields were found ` +
        `(expected exactly 1) — cannot fill the signup form unambiguously.`
    );
  }
  // Two password fields is the normal "password + confirm" pair. Three or more
  // means we do not understand the form.
  if (probe.passwordFields.length > 2) {
    return await blocked(
      `Account gate detected but ${probe.passwordFields.length} password fields were found ` +
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
  const applicationSignals = applicationFormSignals(probe);
  if (applicationSignals.length > 0) {
    return await blocked(
      `Account gate detected, but the signup form is not isolated from the job application ` +
        `form on this page (${applicationSignals.join("; ")}). Submitting here risks sending a ` +
        `partial job application, which is out of scope for ACT-005 (form fill is ACT-007, ` +
        `submission is ACT-008) — stopping for a human.`
    );
  }

  const submitCandidates = probe.submitTexts.filter((t) =>
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
        `(candidates: ${JSON.stringify(probe.submitTexts)}` +
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
  // app-level envelope encryption) and decrypt only for the `typeText` call
  // below — that pair of lines is the entire blast radius.
  const boardPassword = generateBoardPassword();
  await updateApplication(supabase, jobApplicationId, { board_password: boardPassword });

  const emailSelector = selectorFor(probe.emailFields[0]!, 'input[type="email"]');
  console.log(`[act-005] account gate — filling signup (email → ${emailSelector})`);
  await browser.typeText(emailSelector, applicationEmail);

  for (const [index, field] of probe.passwordFields.entries()) {
    const selector = selectorFor(field, `input[type="password"]:nth-of-type(${index + 1})`);
    await browser.typeText(selector, boardPassword);
  }

  console.log(`[act-005] submitting signup via "${submitLabel}"`);
  await browser.click({ text: submitLabel });

  // The evidence that the board accepted the submission is only as good as the
  // page it is read from, so corroborate the page before reading anything off
  // it. A bare `probePage` here would accept any URL change as proof of success
  // — including a change caused by another tenant of the shared Actor browser
  // navigating it away — and write `awaiting_verification` for an account that
  // was never created.
  const settled = await reprobeAfterInteraction(browser, probe, `submitting "${submitLabel}"`);
  if (!settled.corroborated) {
    // Note this is *not* `error`: the submit click may well have created the
    // account, so a retry could double-submit. A human has to establish what
    // actually happened. The password is already stored on the row for them.
    return await blocked(
      `Signup was submitted via "${submitLabel}", but ${settled.complaint}. Whether the account ` +
        `was created is unknown — refusing to report ${APPLICATION_STATUS.AWAITING_VERIFICATION} ` +
        `on unverifiable evidence, and not retrying, since the submission may already have ` +
        `taken effect. Needs a human.`,
      settled.probe
    );
  }

  const after = settled.probe;
  // Both signals now come from a page confirmed to be the one we submitted on
  // (or its same-board successor). The signup form disappearing is the stronger
  // of the two; a move to a different page of the board is the weaker one, and
  // is only trustworthy because of the corroboration above.
  const formGone = after.passwordFields.length === 0;
  const movedOn = !samePage(after.url, probe.url);
  if (!formGone && !movedOn) {
    return await blocked(
      `Signup form was filled and submitted but the password field is still rendered at ` +
        `${after.url} — the board likely rejected the submission (validation or captcha).`,
      after
    );
  }

  await updateApplication(supabase, jobApplicationId, {
    status: APPLICATION_STATUS.AWAITING_VERIFICATION,
    error_message: null,
  });
  console.log(
    `[act-005] job_applications ${jobApplicationId} → ${APPLICATION_STATUS.AWAITING_VERIFICATION}` +
      ` (stopping here: form fill is ACT-007)`
  );

  return {
    status: APPLICATION_STATUS.AWAITING_VERIFICATION,
    accountGate: true,
    reasons: [
      ...reasons,
      `signup submitted via "${submitLabel}"; ${settled.note}`,
      formGone
        ? `password field is gone from the corroborated page — form accepted`
        : `password field still rendered, but the board moved us on to "${after.url}"`,
    ],
    finalUrl: after.url,
    pageTitle: after.title,
    probe: after,
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

export { ApifyMcpError };
