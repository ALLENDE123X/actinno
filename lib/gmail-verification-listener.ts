/**
 * ACT-006 — Gmail verification listener.
 *
 * ACT-005/ACT-012 (`create-board-account.ts`) submits a signup on a real
 * employer's job board and parks the row at
 * `job_applications.status = "awaiting_verification"`. Meanwhile the Inngest
 * run for that listing is asleep inside `step.waitForEvent("await-verification")`
 * (`inngest/job-application-pipeline.ts`). This module is the thing that wakes
 * it up: it polls one Gmail mailbox, finds the verification mail belonging to
 * that specific signup, pulls the code/link out of it, and sends
 * `email/verification-received`.
 *
 * ── The security boundary (read this before changing any matching rule) ──────
 * An agent that reads inbound email and then *acts* on what it says is a
 * phishing target by construction. Anyone who knows the mailbox address can put
 * a message in it; "looks like a confirmation email" is a filter an attacker
 * writes past in one line. So a message is only ever acted on when ALL of the
 * following hold:
 *
 *   1. **Sender domain.** The `From:` domain is the registrable domain of the
 *      board the agent itself navigated to (`job_applications.apply_url`), or a
 *      domain belonging to that board's ATS vendor (`ATS_SENDER_DOMAINS`).
 *      Nothing else. Not "a domain resembling the company name", not "a domain
 *      in the body".
 *   2. **Time window.** The message arrived no earlier than the signup and no
 *      later than `VERIFICATION_WINDOW_MS` after it, where the signup instant is
 *      `job_applications.updated_at` at the moment ACT-005 wrote
 *      `awaiting_verification`.
 *   3. **Intent.** Subject or body actually reads as a verification/confirmation
 *      request.
 *   4. **Extractable.** A code or an allowlisted verification link comes out of
 *      it. A link is only ever emitted if its own host is on the same sender
 *      allowlist, so a matched email cannot steer a later step to an arbitrary
 *      URL.
 *   5. **Unambiguous.** If two pending signups could both claim the same
 *      message — the ordinary case, since five concurrent Greenhouse
 *      applications all trust `greenhouse.io` — it is only attributed to one of
 *      them when the message itself names that employer. Otherwise it is
 *      dropped, loudly.
 *
 * Rules 1 and 2 are pushed into the Gmail query itself (`from:(...) after:...
 * before:...`) rather than applied after fetching everything, so the scope is
 * structural: an unscoped message is never even downloaded. They are then
 * re-checked in-process against the exact timestamps, because Gmail's own
 * `after:`/`before:` granularity is not contractually to-the-second.
 *
 * Every rule fails **closed**. A missed verification shows up as the Inngest
 * wait timing out after 10m (`verification_timeout`) — visible, recoverable,
 * and vastly preferable to acting on someone else's email.
 *
 * ── What this module does NOT do ────────────────────────────────────────────
 * It never writes to Supabase (read-only service-role queries), never mutates
 * the mailbox, and never opens a browser. Clicking the verification link and
 * moving the row past `awaiting_verification` belong to the steps downstream of
 * the Inngest wait, not here.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Inngest } from "inngest";
import type { gmail_v1 } from "googleapis";
import { APPLICATION_STATUS } from "./create-board-account.js";
import {
  assertUsableCredentials,
  createGmailClient,
  GmailAuthError,
  rethrowAsAuthError,
} from "./gmail-client.js";

// ───────────────────────────────────
// Contract with inngest/job-application-pipeline.ts
// ───────────────────────────────────

/**
 * The event the `await-verification` step is parked on. Must match
 * `inngest/job-application-pipeline.ts` exactly.
 */
export const VERIFICATION_EVENT_NAME = "email/verification-received";

/** Same app id as the pipeline's client. Cosmetic when only sending, kept identical anyway. */
const INNGEST_APP_ID = "actinno-job-agent";

/**
 * Payload of `email/verification-received`.
 *
 * The waiting step's condition is, verbatim:
 *
 *   if: `async.data.userId == "${userId}" && async.data.company == "${listing.company}"`
 *
 * so **`userId` and `company` are the only two fields that decide whether a run
 * resumes**, and both are compared as exact strings. Everything else here is
 * payload for the steps that run after the wait.
 *
 *  · `company` is `job_applications.company` read straight back out of the row
 *    ACT-005 wrote, and ACT-005 writes `input.company.trim()`. As long as the
 *    pipeline passes `listing.company` through to `createBoardAccount` unchanged
 *    (it must — see ACT-009's wiring of the `create-account` step), the two
 *    sides are byte-identical by construction rather than by convention.
 *
 *  · `userId` is `job_applications.candidate_id`. The pipeline's `userId` and
 *    the `candidates.id` UUID that ACT-003 mints are the same identity — the
 *    schema has no other per-person key, and `job_applications.candidate_id` is
 *    a foreign key onto `candidates.id`. **ACT-009 must therefore send
 *    `job-search/requested` with `userId` set to the candidate UUID.** If it
 *    ever sends something else (an auth subject, an email address), this event
 *    will be correct about the mailbox and wrong about the run, and the wait
 *    will time out with no visible cause. That is the one contract in this file
 *    that cannot be enforced from here.
 */
export type VerificationEventData = {
  /** `job_applications.candidate_id` — matched against the waiting run's `userId`. */
  userId: string;
  /** `job_applications.company`, verbatim — matched against the waiting run's `listing.company`. */
  company: string;
  jobApplicationId: string;
  applyUrl: string;
  /** Extracted one-time code, or `null` when the mail carried only a link. */
  verificationCode: string | null;
  /** Extracted verification URL — guaranteed to be on an allowlisted domain — or `null`. */
  verificationLink: string | null;
  /** Domain the mail actually came from, after allowlist checking. */
  senderDomain: string;
  subject: string;
  gmailMessageId: string;
  /** RFC3339, from Gmail's `internalDate`. */
  receivedAt: string;
};

export type EventSender = (data: VerificationEventData) => Promise<void>;

// ───────────────────────────────────
// Scope constants — the security boundary's dimensions
// ───────────────────────────────────

/**
 * How long after a signup a verification mail is still considered to belong to
 * it. Sized just above the pipeline's own `timeout: "10m"` on
 * `step.waitForEvent`: a match found after the wait has already timed out
 * cannot help anybody, and every extra minute is extra time in which an
 * unrelated message from the same ATS could be mistaken for this one.
 *
 * Deliberately a constant and not an env var. It is half of the boundary this
 * ticket exists to enforce, and a boundary with a tuning knob on it is a
 * boundary someone widens at 2am during a demo.
 */
export const VERIFICATION_WINDOW_MS = 15 * 60_000;

/**
 * Tolerance on the *lower* bound only, for clock skew between this machine and
 * Google's mail servers. Mail genuinely triggered by our signup can carry an
 * `internalDate` a few seconds before our own `updated_at`.
 */
export const CLOCK_SKEW_MS = 90_000;

export const DEFAULT_POLL_INTERVAL_MS = 15_000;

/** Pending signups examined per cycle. Demo scale is ~5; this is headroom. */
const MAX_PENDING_ROWS = 50;

/** Messages pulled per pending signup per cycle. A verification mail is the newest thing from that sender. */
const MAX_MESSAGES_PER_QUERY = 10;

/** Guard against a pathological mail body dominating a poll cycle. */
const MAX_BODY_CHARS = 200_000;

const LOG = "[act-006]";

// ───────────────────────────────────
// Which domains may speak for a board
// ───────────────────────────────────

/**
 * Second-level labels used by country registries, so `example.co.uk` is not
 * mistaken for a site called `co.uk`. Not a public suffix list — see
 * `registrableDomain`. Same table as the pre-ACT-012 `create-board-account.ts`
 * used; duplicated rather than imported because that copy was deleted with the
 * probe layer and this one answers a different question (who may send mail),
 * not the same one (which board is this page).
 */
const GENERIC_SECOND_LEVEL = new Set([
  "co",
  "com",
  "net",
  "org",
  "edu",
  "gov",
  "ac",
  "ne",
  "or",
]);

/**
 * Cheap registrable-domain approximation (no PSL dependency): the last two
 * hostname labels, or three when the second-to-last is a country registry's
 * generic second level.
 *
 * A wrong answer here lands on "these are different domains", i.e. no match,
 * i.e. a visible timeout — never on a false match.
 */
export function registrableDomain(hostname: string): string {
  const labels = hostname.toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const take = GENERIC_SECOND_LEVEL.has(labels[labels.length - 2] ?? "") ? 3 : 2;
  return labels.slice(-take).join(".");
}

/**
 * ── The design decision this ticket had to make ──────────────────────────────
 *
 * "Sender domain must match the board" is not one rule, because on a hosted ATS
 * the board and the sender are different companies. `job-boards.greenhouse.io`
 * is Greenhouse's hostname, not the employer's, and the account-verification
 * mail for a Discord listing arrives from Greenhouse, not from discord.com.
 *
 * Two options were on the table:
 *
 *   (a) a known-ATS sender table, or
 *   (b) a looser "the apply URL's registrable domain OR any known ATS domain"
 *       rule.
 *
 * (b) was rejected: "any known ATS domain" means every pending signup trusts
 * every ATS vendor at once, so a Workday listing would accept mail from Lever.
 * What is implemented is (a) **keyed by the board actually visited** — the
 * allowlist for one row is that row's own apply-URL domain plus only the mail
 * domains of the one ATS that hosts it. A Greenhouse listing never trusts
 * Workday.
 *
 * Entries are restricted to domains the ATS vendor itself owns. Notably absent
 * are generic delivery and click-tracking domains (sendgrid.net, mailgun.org,
 * pstmrk.it, …): those are shared by the entire internet, and putting one here
 * would hand the boundary to anyone with a free ESP account.
 *
 * **Known limitation, deliberate:** many ATSs let an employer configure a
 * custom sending domain (Greenhouse in particular will send candidate mail as
 * `no-reply@<employer>.com`), and plenty of employers run careers pages on a
 * domain unrelated to their corporate mail domain. When that happens this
 * listener will not match, the Inngest wait will hit its 10m timeout, and the
 * row will read `verification_timeout`. That is the intended failure direction:
 * the alternative — inferring a trusted domain from the company *name* — is
 * precisely the unscoped guess this ticket forbids. The fix for a specific
 * employer is a one-line addition to the table below, made deliberately by a
 * human who knows that employer really does send from that domain.
 *
 * Keys are registrable domains of *board* hostnames; values are registrable
 * domains that board's mail may come from (subdomains of a listed value are
 * accepted — see `senderDomainAllowed`).
 */
const ATS_SENDER_DOMAINS: ReadonlyMap<string, readonly string[]> = new Map([
  // boards.greenhouse.io / job-boards.greenhouse.io / *.eu variants.
  ["greenhouse.io", ["greenhouse.io", "greenhouse-mail.io"]],
  // jobs.lever.co — transactional mail comes from hire.lever.co.
  ["lever.co", ["lever.co", "hire.lever.co"]],
  ["ashbyhq.com", ["ashbyhq.com"]],
  // <employer>.<wdN>.myworkdayjobs.com — Workday's notification domain differs
  // from its job-board domain.
  ["myworkdayjobs.com", ["myworkdayjobs.com", "myworkday.com", "workday.com"]],
  ["icims.com", ["icims.com"]],
  ["smartrecruiters.com", ["smartrecruiters.com"]],
  ["workable.com", ["workable.com", "workablemail.com"]],
  ["jobvite.com", ["jobvite.com"]],
  ["bamboohr.com", ["bamboohr.com"]],
  ["breezy.hr", ["breezy.hr"]],
  ["recruitee.com", ["recruitee.com"]],
  ["teamtailor.com", ["teamtailor.com"]],
  // JazzHR
  ["applytojob.com", ["applytojob.com", "jazzhr.com"]],
  ["taleo.net", ["taleo.net"]],
]);

/**
 * ATS platforms that put every employer on one shared hostname and identify the
 * employer by the first path segment. Used only to work out which employer a
 * board URL belongs to, for the ambiguity tie-break in `attributeMessage`.
 */
const PATH_TENANT_HOSTS: readonly RegExp[] = [
  /^(job-)?boards(\.eu)?\.greenhouse\.io$/,
  /^jobs(\.eu)?\.lever\.co$/,
  /^jobs\.ashbyhq\.com$/,
  /^(careers|jobs)\.smartrecruiters\.com$/,
  /^apply\.workable\.com$/,
  /^jobs\.jobvite\.com$/,
];

/** Platforms that give each employer its own subdomain instead. */
const SUBDOMAIN_TENANT_SITES: ReadonlySet<string> = new Set([
  "myworkdayjobs.com",
  "icims.com",
  "bamboohr.com",
  "breezy.hr",
  "recruitee.com",
  "teamtailor.com",
  "applytojob.com",
  "workable.com",
]);

/** Syntactically a domain, so nothing exotic can be spliced into a Gmail query. */
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * Domains that may send mail about one specific signup.
 *
 * Derived from `apply_url` alone. `job_applications.ats_provider` is
 * deliberately ignored: the column defaults to `'greenhouse'` for every row, so
 * trusting it would add Greenhouse's mail domains to every listing on earth,
 * including ones the agent never went near Greenhouse for. The apply URL is
 * evidence — it is the page the browser actually loaded.
 */
export function allowedSenderDomains(applyUrl: string): string[] {
  let host: string;
  try {
    host = new URL(applyUrl).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return [];
  }

  const site = registrableDomain(host);
  const domains = new Set<string>();
  if (site) domains.add(site);
  for (const extra of ATS_SENDER_DOMAINS.get(site) ?? []) domains.add(extra);

  return [...domains].filter((d) => DOMAIN_RE.test(d)).sort();
}

/**
 * True when `fromHeader`'s address sits on one of `domains`, or on a subdomain
 * of one. Subdomains are accepted because vendors routinely send from
 * `mail.<vendor>` / `email.<vendor>`; the parent is still the vendor.
 */
export function senderDomainAllowed(
  fromHeader: string,
  domains: readonly string[]
): string | null {
  const address = parseAddress(fromHeader);
  if (address === null) return null;
  const at = address.lastIndexOf("@");
  if (at === -1) return null;

  const host = address.slice(at + 1).toLowerCase().replace(/\.$/, "");
  if (!host) return null;

  for (const domain of domains) {
    if (host === domain || host.endsWith(`.${domain}`)) return host;
  }
  return null;
}

/** `"Greenhouse <no-reply@greenhouse.io>"` → `"no-reply@greenhouse.io"`. */
function parseAddress(header: string): string | null {
  const angled = /<([^>]+)>/.exec(header);
  const raw = (angled?.[1] ?? header).trim().replace(/^["']|["']$/g, "");
  return raw.includes("@") ? raw.toLowerCase() : null;
}

/**
 * A short token identifying the employer a board URL belongs to — the tenant
 * slug on a shared ATS host, the tenant subdomain where the ATS tenants that
 * way, otherwise the first label of the registrable domain. Used only to break
 * ties between two pending signups on the same ATS.
 */
function boardTenantToken(applyUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(applyUrl);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const site = registrableDomain(host);

  if (PATH_TENANT_HOSTS.some((pattern) => pattern.test(host))) {
    const segments = url.pathname.split("/").filter(Boolean);
    const first = segments[0]?.toLowerCase();
    // Greenhouse embeds carry the employer in `?for=` instead of the path.
    const slug = first === "embed" ? url.searchParams.get("for")?.toLowerCase() : first;
    return normalizeToken(slug ?? "");
  }
  if (SUBDOMAIN_TENANT_SITES.has(site)) {
    const labels = host.split(".");
    return labels.length > 2 ? normalizeToken(labels[0] ?? "") : null;
  }
  return normalizeToken(site.split(".")[0] ?? "");
}

/** Lowercased, alphanumerics only — so "Acme, Inc." and "acme" compare equal. */
function normalizeToken(value: string): string | null {
  const token = value.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return token.length >= 3 ? token : null;
}

// ───────────────────────────────────
// Gmail query
// ───────────────────────────────────

/**
 * The Gmail search that *is* the scope check. Both halves of the boundary —
 * who sent it, and when — are expressed as query terms, so a message outside
 * the scope is never returned, let alone downloaded and parsed.
 *
 * Bounds are re-verified exactly in `matchMessage`, because Gmail does not
 * contractually promise second-level precision on `after:`/`before:`.
 */
export function buildGmailQuery(
  domains: readonly string[],
  signupAtMs: number,
  nowMs: number
): string | null {
  const safe = domains.filter((d) => DOMAIN_RE.test(d));
  if (safe.length === 0) return null;

  const afterSec = Math.floor((signupAtMs - CLOCK_SKEW_MS) / 1000);
  // Never look past the window's end, and never past now.
  const beforeSec = Math.ceil(
    Math.min(signupAtMs + VERIFICATION_WINDOW_MS, nowMs + CLOCK_SKEW_MS) / 1000
  );

  return `from:(${safe.join(" OR ")}) after:${afterSec} before:${beforeSec}`;
}

// ───────────────────────────────────
// Message parsing
// ───────────────────────────────────

function headerValue(message: gmail_v1.Schema$Message, name: string): string {
  const headers = message.payload?.headers ?? [];
  const wanted = name.toLowerCase();
  for (const header of headers) {
    if (header.name?.toLowerCase() === wanted) return header.value ?? "";
  }
  return "";
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

type MessageBodies = { text: string; html: string };

/** Depth-first walk of the MIME tree, concatenating text/plain and text/html leaves. */
function collectBodies(part: gmail_v1.Schema$MessagePart | undefined): MessageBodies {
  const out: MessageBodies = { text: "", html: "" };
  if (!part) return out;

  const visit = (node: gmail_v1.Schema$MessagePart): void => {
    if (out.text.length + out.html.length > MAX_BODY_CHARS) return;

    const data = node.body?.data;
    if (data) {
      const mime = (node.mimeType ?? "").toLowerCase();
      if (mime.startsWith("text/plain")) out.text += `\n${decodeBase64Url(data)}`;
      else if (mime.startsWith("text/html")) out.html += `\n${decodeBase64Url(data)}`;
    }
    for (const child of node.parts ?? []) visit(child);
  };

  visit(part);
  out.text = out.text.slice(0, MAX_BODY_CHARS);
  out.html = out.html.slice(0, MAX_BODY_CHARS);
  return out;
}

const HTML_ENTITIES: ReadonlyMap<string, string> = new Map([
  ["&amp;", "&"],
  ["&lt;", "<"],
  ["&gt;", ">"],
  ["&quot;", '"'],
  ["&#39;", "'"],
  ["&apos;", "'"],
  ["&nbsp;", " "],
]);

function decodeEntities(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39);/g, (m) => HTML_ENTITIES.get(m) ?? m);
}

function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
  );
}

// ───────────────────────────────────
// Intent + extraction
// ───────────────────────────────────

/**
 * Does this read as a verification request at all? A third check on top of
 * sender and time — cheap, and it keeps the ordinary "we received your
 * application" mail from the same ATS out of the way.
 */
const VERIFICATION_INTENT_RE =
  /\b(verify|verifying|verification|confirm|confirming|confirmation|activate|activation|validate|validation)\b/i;

/**
 * Ordered most-specific-first. Each must anchor on a word that says the number
 * *is* a code — a bare six-digit run in a mail body is as likely to be a
 * requisition id as a one-time code.
 */
const CODE_PATTERNS: readonly RegExp[] = [
  /\b(?:verification|confirmation|security|activation|one[-\s]?time|login|sign[-\s]?in)\s+code\b[\s\S]{0,60}?\b([0-9]{4,8})\b/i,
  /\b(?:verification|confirmation|security|activation|one[-\s]?time)\s+code\b[\s\S]{0,60}?\b([A-Z0-9]{4,10})\b/i,
  /\bcode\s*(?:is|:)\s*\b([0-9]{4,8})\b/i,
  /\byour\s+code\b[\s\S]{0,30}?\b([0-9]{4,8})\b/i,
];

const URL_RE = /https?:\/\/[^\s<>"'`\])]+/gi;

/**
 * A URL only counts as *the* verification link if it says so. Without this the
 * first allowlisted URL in a footer ("Privacy Policy", "Unsubscribe") would be
 * handed downstream as the thing to click.
 */
const VERIFY_URL_RE =
  /(verif|confirm|activat|validat|email[-_]?token|signup[-_]?token|account[-_]?setup|set[-_]?password|create[-_]?password|invite)/i;

export type Extraction = { code: string | null; link: string | null };

/**
 * Pulls the code and/or link out of a message that has already passed the
 * sender and time checks.
 *
 * `domains` is passed in and applied to the link's own host: an allowlisted
 * sender is trusted to have sent us mail, not trusted to point us anywhere on
 * the internet. An emitted link is therefore always on the same board/ATS the
 * agent signed up with.
 */
export function extractVerification(
  subject: string,
  text: string,
  html: string,
  domains: readonly string[]
): Extraction {
  const prose = `${subject}\n${text}\n${htmlToText(html)}`;

  let code: string | null = null;
  for (const pattern of CODE_PATTERNS) {
    const match = pattern.exec(prose);
    const candidate = match?.[1];
    // Second pattern is alphanumeric and case-insensitive (real emails write
    // "Verification Code", not the lowercase-only literal the pattern used to
    // require); require a digit so it still cannot latch onto an ordinary word
    // following "verification code".
    if (candidate && /[0-9]/.test(candidate)) {
      code = candidate;
      break;
    }
  }

  // Search the raw HTML too: the link lives in an href, which htmlToText drops.
  let link: string | null = null;
  for (const raw of `${text}\n${html}`.matchAll(URL_RE)) {
    const cleaned = decodeEntities(raw[0]).replace(/[.,;:!?)"'\]]+$/, "");
    if (!VERIFY_URL_RE.test(cleaned)) continue;

    let host: string;
    try {
      host = new URL(cleaned).hostname.toLowerCase().replace(/\.$/, "");
    } catch {
      continue;
    }
    if (domains.some((d) => host === d || host.endsWith(`.${d}`))) {
      link = cleaned;
      break;
    }
  }

  return { code, link };
}

// ───────────────────────────────────
// Supabase (read-only)
// ───────────────────────────────────

/** Project ref this module is allowed to read from — same guard shape as ACT-003/ACT-005. */
const EXPECTED_PROJECT_REF = "oihpglvvzzmjigxrlmfz";

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

export function getSupabaseClient(): SupabaseClient {
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

export type PendingSignup = {
  jobApplicationId: string;
  candidateId: string;
  company: string;
  applyUrl: string;
  /** ms epoch — when ACT-005 wrote `awaiting_verification`. */
  signupAtMs: number;
  domains: string[];
  tenantToken: string | null;
};

/**
 * Signups still waiting on a verification mail, *within the window*.
 *
 * The `updated_at` floor is the same time bound the Gmail query applies, hoisted
 * to the database: a row that has sat in `awaiting_verification` for an hour has
 * already lost its Inngest listener to the 10m timeout, so continuing to watch
 * the inbox on its behalf would be an unbounded standing subscription to
 * "anything from greenhouse.io" — exactly the unscoped listener this ticket
 * forbids. Ageing out of this query is how a pending signup stops being watched.
 *
 * `updated_at` is the right anchor because `create-board-account.ts` sets it on
 * every status write (`updateApplication` bumps it explicitly), so for a row
 * reading `awaiting_verification` it is the instant the signup was submitted.
 */
export async function loadPendingSignups(
  supabase: SupabaseClient,
  nowMs: number
): Promise<PendingSignup[]> {
  const floor = new Date(nowMs - VERIFICATION_WINDOW_MS).toISOString();

  const { data, error } = await supabase
    .from("job_applications")
    .select("id,candidate_id,company,apply_url,updated_at")
    .eq("status", APPLICATION_STATUS.AWAITING_VERIFICATION)
    .gte("updated_at", floor)
    .order("updated_at", { ascending: false })
    .limit(MAX_PENDING_ROWS);

  if (error) {
    throw new Error(`job_applications lookup failed: ${error.message}`);
  }

  const pending: PendingSignup[] = [];
  for (const row of data ?? []) {
    const id = typeof row.id === "string" ? row.id : null;
    const candidateId = typeof row.candidate_id === "string" ? row.candidate_id : null;
    const company = typeof row.company === "string" ? row.company : null;
    const applyUrl = typeof row.apply_url === "string" ? row.apply_url : null;
    const updatedAt = typeof row.updated_at === "string" ? Date.parse(row.updated_at) : NaN;

    if (!id || !candidateId || !company || !applyUrl || Number.isNaN(updatedAt)) {
      console.warn(`${LOG} skipping malformed job_applications row: ${JSON.stringify(row)}`);
      continue;
    }

    const domains = allowedSenderDomains(applyUrl);
    if (domains.length === 0) {
      // No derivable domain means no boundary to enforce, so there is nothing
      // safe to watch for. Fail closed and say so.
      console.warn(
        `${LOG} job_applications ${id} (${company}): no sender domain could be derived ` +
          `from apply_url "${applyUrl}" — not watching it. Verification will time out.`
      );
      continue;
    }

    pending.push({
      jobApplicationId: id,
      candidateId,
      company,
      applyUrl,
      signupAtMs: updatedAt,
      domains,
      tenantToken: boardTenantToken(applyUrl),
    });
  }
  return pending;
}

// ───────────────────────────────────
// Matching one message against one pending signup
// ───────────────────────────────────

export type MatchRejection = { ok: false; reason: string };
export type MatchAcceptance = {
  ok: true;
  senderDomain: string;
  subject: string;
  receivedAtMs: number;
  extraction: Extraction;
  /** Normalized body+subject, kept for the ambiguity tie-break. */
  normalizedText: string;
};
export type MatchResult = MatchAcceptance | MatchRejection;

export function matchMessage(
  message: gmail_v1.Schema$Message,
  signup: PendingSignup
): MatchResult {
  const from = headerValue(message, "From");
  const senderDomain = senderDomainAllowed(from, signup.domains);
  if (senderDomain === null) {
    return { ok: false, reason: `sender "${from}" is not on ${signup.domains.join(", ")}` };
  }

  // Exact time bound. Gmail's after:/before: already narrowed this, but their
  // granularity is not guaranteed, and this half of the boundary is worth
  // enforcing against a number we control.
  const receivedAtMs = Number(message.internalDate ?? NaN);
  if (!Number.isFinite(receivedAtMs)) {
    return { ok: false, reason: "message has no usable internalDate" };
  }
  if (receivedAtMs < signup.signupAtMs - CLOCK_SKEW_MS) {
    return { ok: false, reason: "arrived before the signup" };
  }
  if (receivedAtMs > signup.signupAtMs + VERIFICATION_WINDOW_MS) {
    return { ok: false, reason: "arrived after the verification window closed" };
  }

  const subject = headerValue(message, "Subject");
  const bodies = collectBodies(message.payload ?? undefined);
  const intentSource = `${subject}\n${bodies.text}\n${htmlToText(bodies.html)}`;
  if (!VERIFICATION_INTENT_RE.test(intentSource)) {
    return { ok: false, reason: "does not read as a verification request" };
  }

  const extraction = extractVerification(subject, bodies.text, bodies.html, signup.domains);
  if (extraction.code === null && extraction.link === null) {
    return {
      ok: false,
      reason:
        "no verification code, and no verification link on an allowlisted domain, " +
        "could be extracted",
    };
  }

  return {
    ok: true,
    senderDomain,
    subject,
    receivedAtMs,
    extraction,
    normalizedText: intentSource.toLowerCase().replace(/[^a-z0-9]+/g, ""),
  };
}

/**
 * Picks which pending signup a message belongs to when more than one accepted
 * it.
 *
 * Five concurrent Greenhouse applications all trust `greenhouse.io` in
 * overlapping windows, so "two rows accepted the same message" is the normal
 * case rather than the exotic one, and guessing would attribute Company A's
 * verification code to Company B's run. The tie-break is the message naming the
 * employer — its company name or the board's tenant slug. If that does not
 * single one out, nobody gets it.
 */
export function attributeMessage(
  accepted: readonly { signup: PendingSignup; match: MatchAcceptance }[]
): { winner: { signup: PendingSignup; match: MatchAcceptance } | null; reason: string } {
  const first = accepted[0];
  if (!first) return { winner: null, reason: "no pending signup accepted this message" };
  if (accepted.length === 1) return { winner: first, reason: "single claimant" };

  const named = accepted.filter(({ signup, match }) => {
    const tokens = [normalizeToken(signup.company), signup.tenantToken].filter(
      (t): t is string => t !== null
    );
    return tokens.some((token) => match.normalizedText.includes(token));
  });

  if (named.length === 1) {
    return { winner: named[0] ?? null, reason: "named the employer" };
  }
  return {
    winner: null,
    reason:
      `${accepted.length} pending signups accepted it ` +
      `(${accepted.map((a) => a.signup.company).join(", ")}) and ` +
      (named.length === 0
        ? "none is named in the message"
        : `${named.length} are named in it`) +
      " — refusing to guess which run it belongs to",
  };
}

// ───────────────────────────────────
// Event senders
// ───────────────────────────────────

export function createInngestSender(): EventSender {
  const inngest = new Inngest({ id: INNGEST_APP_ID });
  return async (data) => {
    await inngest.send({ name: VERIFICATION_EVENT_NAME, data });
  };
}

/** Prints what would be sent. Used by `--dry-run`, which is how the acceptance
 *  test ("does NOT fire on unrelated emails") is run without a live pipeline. */
export function createDryRunSender(): EventSender {
  return async (data) => {
    console.log(
      `${LOG} DRY RUN — would send ${VERIFICATION_EVENT_NAME} ` +
        `{ userId: "${data.userId}", company: "${data.company}", ` +
        `jobApplicationId: "${data.jobApplicationId}" }`
    );
  };
}

// ───────────────────────────────────
// Poll cycle
// ───────────────────────────────────

export type PollSummary = {
  pending: number;
  examined: number;
  sent: number;
};

export type ListenerDeps = {
  supabase: SupabaseClient;
  gmail: gmail_v1.Gmail;
  send: EventSender;
  /** Job application ids already announced, so a standing poll fires once. */
  notified: Set<string>;
  now?: () => number;
};

/**
 * One full pass: read the pending signups, run each one's scoped Gmail query,
 * fetch each distinct candidate message once, and send at most one event per
 * signup.
 *
 * Throws `GmailAuthError` on a credential failure so the caller can exit rather
 * than loop; every other Gmail failure is left to the caller's retry.
 */
export async function pollOnce(deps: ListenerDeps): Promise<PollSummary> {
  const now = deps.now?.() ?? Date.now();
  const pending = (await loadPendingSignups(deps.supabase, now)).filter(
    (signup) => !deps.notified.has(signup.jobApplicationId)
  );
  if (pending.length === 0) return { pending: 0, examined: 0, sent: 0 };

  // messageId → the signups whose scoped query returned it.
  const claims = new Map<string, PendingSignup[]>();

  for (const signup of pending) {
    const query = buildGmailQuery(signup.domains, signup.signupAtMs, now);
    if (query === null) continue;

    let listed: gmail_v1.Schema$ListMessagesResponse;
    try {
      const response = await deps.gmail.users.messages.list({
        userId: "me",
        q: query,
        maxResults: MAX_MESSAGES_PER_QUERY,
      });
      listed = response.data;
    } catch (err) {
      rethrowAsAuthError(err);
    }

    for (const stub of listed.messages ?? []) {
      if (!stub.id) continue;
      const existing = claims.get(stub.id);
      if (existing) existing.push(signup);
      else claims.set(stub.id, [signup]);
    }
  }

  let sent = 0;
  for (const [messageId, claimants] of claims) {
    // A signup that already got its event this cycle is done.
    const live = claimants.filter((s) => !deps.notified.has(s.jobApplicationId));
    if (live.length === 0) continue;

    let message: gmail_v1.Schema$Message;
    try {
      const response = await deps.gmail.users.messages.get({
        userId: "me",
        id: messageId,
        format: "full",
      });
      message = response.data;
    } catch (err) {
      rethrowAsAuthError(err);
    }

    const accepted: { signup: PendingSignup; match: MatchAcceptance }[] = [];
    for (const signup of live) {
      const result = matchMessage(message, signup);
      if (result.ok) accepted.push({ signup, match: result });
      else {
        console.log(
          `${LOG} message ${messageId} rejected for ${signup.company} ` +
            `(job_applications ${signup.jobApplicationId}): ${result.reason}`
        );
      }
    }

    const { winner, reason } = attributeMessage(accepted);
    if (!winner) {
      if (accepted.length > 0) {
        console.warn(`${LOG} message ${messageId} NOT acted on: ${reason}`);
      }
      continue;
    }

    const { signup, match } = winner;
    const data: VerificationEventData = {
      userId: signup.candidateId,
      company: signup.company,
      jobApplicationId: signup.jobApplicationId,
      applyUrl: signup.applyUrl,
      verificationCode: match.extraction.code,
      verificationLink: match.extraction.link,
      senderDomain: match.senderDomain,
      subject: match.subject,
      gmailMessageId: messageId,
      receivedAt: new Date(match.receivedAtMs).toISOString(),
    };

    await deps.send(data);
    // Mark only after a successful send, so a transient Inngest failure is
    // retried on the next cycle instead of being swallowed.
    deps.notified.add(signup.jobApplicationId);
    sent += 1;

    console.log(
      `${LOG} ${VERIFICATION_EVENT_NAME} sent for ${signup.company} ` +
        `(job_applications ${signup.jobApplicationId}, userId ${signup.candidateId}) — ` +
        `from ${match.senderDomain}, ${reason}, ` +
        // The code and the link are single-use credentials: report their shape,
        // never their value. The event carries the real thing.
        `${match.extraction.code ? `${match.extraction.code.length}-char code` : "no code"}, ` +
        `${match.extraction.link ? `link on ${safeHost(match.extraction.link)}` : "no link"}`
    );
  }

  return { pending: pending.length, examined: claims.size, sent };
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "(unparseable)";
  }
}

// ───────────────────────────────────
// Poll loop
// ───────────────────────────────────

export type ListenerOptions = {
  intervalMs?: number;
  /** Run a single cycle and return — used by `--once`. */
  once?: boolean;
  /** Log the event instead of sending it. */
  dryRun?: boolean;
  /** Resolves to stop the loop cleanly (SIGINT). */
  stopSignal?: Promise<void>;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

/**
 * Runs until stopped.
 *
 * Failure policy is the whole point of the split below: a credential failure is
 * **fatal and rethrown**, because a listener quietly retrying a 7-day-expired
 * refresh token every 15 seconds is precisely the silent breakage this ticket
 * calls out. Anything else (a 5xx, a dropped connection, a Supabase blip) is
 * logged and retried, because those genuinely do heal.
 */

/**
 * Never let a credential reach stdout/stderr, even inside a wrapped error.
 * Same convention as `gmail-auth-cli.ts`/`verification-listener-cli.ts`'s own
 * `redact()`, duplicated here rather than imported because this is the one log
 * line in the module that logs a caught error *without* it first passing back
 * through one of those CLIs' own redaction — the poll loop below swallows and
 * retries instead of rethrowing, so nothing upstream ever gets a chance to
 * sanitize this specific message.
 */
function redact(text: string): string {
  let out = text;
  for (const secret of [
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
    process.env.INNGEST_EVENT_KEY,
  ]) {
    if (secret) out = out.split(secret).join("[REDACTED]");
  }
  return out;
}

export async function runVerificationListener(
  options: ListenerOptions = {}
): Promise<void> {
  const intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const supabase = getSupabaseClient();
  const { gmail, auth } = createGmailClient();

  const mailbox = await assertUsableCredentials(gmail, auth);
  console.log(
    `${LOG} watching ${mailbox} — poll every ${Math.round(intervalMs / 1000)}s, ` +
      `${Math.round(VERIFICATION_WINDOW_MS / 60_000)}m window per signup` +
      (options.dryRun ? " (DRY RUN: no events will be sent)" : "")
  );

  const deps: ListenerDeps = {
    supabase,
    gmail,
    send: options.dryRun ? createDryRunSender() : createInngestSender(),
    notified: new Set<string>(),
  };

  let stopped = false;
  void options.stopSignal?.then(() => {
    stopped = true;
  });

  for (;;) {
    try {
      const summary = await pollOnce(deps);
      if (summary.pending > 0) {
        console.log(
          `${LOG} cycle: ${summary.pending} pending, ${summary.examined} message(s) examined, ` +
            `${summary.sent} event(s) sent`
        );
      }
    } catch (err) {
      if (err instanceof GmailAuthError) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`${LOG} poll cycle failed (retrying in ${intervalMs}ms): ${redact(reason)}`);
    }

    if (options.once || stopped) return;
    await sleep(intervalMs);
    if (stopped) return;
  }
}
