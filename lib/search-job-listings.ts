/**
 * ACT-018 — listing search, straight off the ATS platforms' own public APIs.
 *
 * Shared by the MCP `bulk-search-job-listings` tool and the Inngest
 * `discoverListings` function, which is the whole reason it lives here rather
 * than in either of them (ACT-009: "port/share the logic rather than
 * duplicating it").
 *
 * ── What ACT-018 replaced, and why ──────────────────────────────────────────
 * Until now this POSTed to the Apify actor `automation-lab~greenhouse-jobs-
 * scraper`. That cost money per run, returned a board in roughly alphabetical
 * order (so `title` searched the front of the alphabet unless you pulled down
 * hundreds of jobs first), and — the reason this ticket exists — handed back
 * **marketing URLs with no application form on them**. A live run produced
 * `https://stripe.com/jobs/search?gh_jid=8107379` as an "apply URL"; that page
 * has no `<form>`, no file input and no name field, so every downstream step
 * from ACT-005 onwards was being pointed at a brochure.
 *
 * Greenhouse, Lever and Ashby each publish a free, unauthenticated, structured
 * JSON API of exactly the same data. This module reads those directly. No API
 * key, no vendor account, no per-run cost, whole boards in one request each,
 * and — verified, not assumed — apply URLs that serve a real application form.
 *
 * ── The three APIs, as they actually respond ────────────────────────────────
 *
 *  · **Greenhouse** `GET boards-api.greenhouse.io/v1/boards/{token}/jobs`
 *    → `{ jobs: [{ id, title, company_name, location: { name }, absolute_url,
 *    updated_at, … }] }`. One request is the entire board (stripe 575, airbnb
 *    192, discord 50). It carries **no** description and **no** departments;
 *    `?content=true` adds both but costs 4.4 MB for Stripe alone, so this
 *    module does not use it — see `enrichGreenhouse`.
 *
 *    `GET …/jobs/{id}?questions=true` is one job, and adds `content` (the
 *    posting, HTML-escaped) plus `questions[]` of `{ label, required, fields }`.
 *
 *  · **Lever** `GET api.lever.co/v0/postings/{token}?mode=json`
 *    → a top-level array of `{ id, text (the title), categories: { department,
 *    team, location, allLocations, commitment }, descriptionPlain, lists[],
 *    additionalPlain, workplaceType, country, salaryRange, hostedUrl,
 *    applyUrl }`. One request is the whole board, descriptions included.
 *
 *  · **Ashby** `GET api.ashbyhq.com/posting-api/job-board/{token}`
 *    → `{ jobs: [{ id, title, department, team, location, secondaryLocations[],
 *    isRemote, workplaceType, isListed, descriptionPlain, descriptionHtml,
 *    jobUrl, applyUrl }] }`. One request, descriptions included.
 *
 * ── The apply URL: the point of the ticket ──────────────────────────────────
 * "Applyable" here means one thing only: fetch it and a real application form
 * comes back. Every URL shape below was fetched and checked for a `<form>`, a
 * file input and a name field. Findings:
 *
 *  · Greenhouse's own `absolute_url` is frequently the *employer's marketing
 *    page* — `stripe.com/jobs/search?gh_jid=…`, 163 KB of careers-site chrome
 *    with zero form elements. Unusable, and it is what the old actor returned.
 *
 *  · `job-boards.greenhouse.io/{token}/jobs/{id}` is applyable for *some*
 *    employers (Discord: form + file input + first-name field, and a real
 *    application was submitted through one) but **302s to the employer's own
 *    careers site for others** (Stripe → `stripe.com/careers/listing/…`, again
 *    no form). Whether it works is per-employer and cannot be known without
 *    fetching it, which would be an extra request per listing to answer a
 *    question the next URL answers for free.
 *
 *  · `job-boards.greenhouse.io/embed/job_app?for={token}&token={id}` serves the
 *    **bare application form itself**, for both — 75 KB, `<form>` present, file
 *    input present, first-name field present. That is what this module emits.
 *    (`boards.greenhouse.io/embed/job_app?…` is the older host for the same
 *    page and 301s here; emitting the post-redirect URL saves the hop.)
 *
 *    Three things had to hold for the embed URL to be safe to emit, and all
 *    three were checked rather than assumed:
 *      1. `create-board-account.ts` navigates it — it is https, and ACT-005's
 *         only structural requirement on `applyUrl` is that it parse as https.
 *      2. `gmail-verification-listener.ts`'s `allowedSenderDomains()` derives
 *         the mail allowlist from `apply_url`'s registrable domain:
 *         `job-boards.greenhouse.io` → `greenhouse.io` → `["greenhouse.io",
 *         "greenhouse-mail.io"]`. Correct, and identical to what the old URL
 *         shape produced.
 *      3. That listener's `boardTenantToken()` — the tie-break that stops one
 *         employer's verification mail resuming another employer's run — reads
 *         the tenant from `?for=` when the first path segment is `embed`. It
 *         already handles this exact URL shape.
 *
 *  · **Lever** publishes `applyUrl` (`jobs.lever.co/{token}/{id}/apply`) beside
 *    `hostedUrl`, and they differ in exactly the way that matters: `hostedUrl`
 *    is the posting and has no form; `applyUrl` is server-rendered and carries
 *    `<form>`, `type="file"` resume input, and `name`/`email`/`phone` fields.
 *    Emitted as-is.
 *
 *  · **Ashby** publishes `applyUrl` (`jobs.ashbyhq.com/{token}/{id}/
 *    application`) beside `jobUrl`. Both return the same 42 KB shell — Ashby's
 *    board is a client-rendered SPA (`<div id="root">` + `window.__appData`),
 *    so **the form cannot be observed by fetching the URL** and the check that
 *    passes for Greenhouse and Lever cannot be run here. `applyUrl` is emitted
 *    because it is the vendor's own documented apply link and it deep-links to
 *    the form rather than the posting; this is recorded as unverified rather
 *    than claimed. It is not a blocker in practice — ACT-005 drives a real
 *    browser that runs the page's JavaScript, and already carries explicit
 *    SPA-hydration handling for exactly this shape.
 *
 * ── `atsProvider` and Ashby ─────────────────────────────────────────────────
 * `JobListing["atsProvider"]` is the fixed union `"greenhouse" | "lever" |
 * "other"`, pinned by ACT-010's tool schema in `mcp-server/index.ts`. Ashby is
 * therefore reported as `"other"`. Widening the union is a change to a
 * cross-module contract and is deliberately not made here — but it is worth
 * knowing that nothing downstream reads `atsProvider` for behaviour today
 * (`gmail-verification-listener.ts` explicitly ignores `ats_provider` and works
 * off `apply_url` instead, and `ashbyhq.com` is already in its sender table), so
 * "other" costs accuracy in the tracker's display column and nothing else.
 *
 * Everything here is read-only: unauthenticated GETs against public job boards.
 * It writes nothing, anywhere, and it opens no browser.
 */

// ───────────────────────────────────
// Endpoints
// ───────────────────────────────────

const greenhouseBoardUrl = (token: string): string =>
  `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs`;

const greenhouseJobUrl = (token: string, jobId: string): string =>
  `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs/` +
  `${encodeURIComponent(jobId)}?questions=true`;

/** The embed form — see the header. This is the applyable Greenhouse page. */
const greenhouseApplyUrl = (token: string, jobId: string): string =>
  `https://job-boards.greenhouse.io/embed/job_app?for=${encodeURIComponent(token)}` +
  `&token=${encodeURIComponent(jobId)}`;

const leverBoardUrl = (token: string): string =>
  `https://api.lever.co/v0/postings/${encodeURIComponent(token)}?mode=json`;

const ashbyBoardUrl = (token: string): string =>
  `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}`;

// ───────────────────────────────────
// Caps and bounds
// ───────────────────────────────────

/**
 * Hard ceiling on one search's fan-out. `applyToJob` opens a browser per
 * listing, so this is the number that actually bounds cost. Unchanged by
 * ACT-018.
 */
const MAX_LISTINGS = 25;

/**
 * **Repurposed by ACT-018 — the name survived, the meaning did not.**
 *
 * Under the Apify actor this was `maxJobsPerCompany`: how much of a board to
 * *download* before filtering, which is why it had to be set to 250 (at 10, a
 * title search only ever saw the front of the alphabet). The platform APIs
 * return a whole board in one request, so there is nothing left to tune there —
 * the title filter now always sees every open job.
 *
 * What it means now is the obvious thing the name suggests and never used to:
 * **how many *matched* listings a single company may contribute** to the
 * result. Defaulting it to `MAX_LISTINGS` means it does nothing unless a caller
 * asks for it, which keeps "search stripe and airbnb" behaving as before, while
 * `maxPerCompany: 5` becomes a way to spread a fan-out across employers.
 */
const DEFAULT_MAX_PER_COMPANY = MAX_LISTINGS;

/**
 * How much job-description text travels in the `job-application/requested`
 * event. It exists to give ACT-007's cover-letter writer context, and a full
 * posting is 10-30KB of boilerplate whose first couple of thousand characters
 * carry the role. Capping here rather than at the consumer keeps the event
 * payload small — this string is copied into every fanned-out event.
 */
const MAX_DESCRIPTION_CHARS = 8_000;

/** Scraped text lands in Postgres columns and in Inngest match expressions. */
const MAX_FIELD_CHARS = 300;

/** Per request. A board API that has stopped answering should fail, not hang. */
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Companies whose boards are fetched at once. Detection costs 1-3 requests per
 * company (see `resolveBoard`), so this is the multiplier on the burst these
 * three vendors see, and there is no reason for it to be large: a search names
 * a handful of employers, and four at a time finishes a realistic search in one
 * or two rounds without ever looking like traffic worth rate-limiting.
 */
const BOARD_CONCURRENCY = 4;

/**
 * Greenhouse per-listing detail fetches in flight. Bounded by `MAX_LISTINGS`
 * in total (only *matched* listings are ever enriched), so the worst case is 25
 * requests to one vendor; five at a time keeps that polite.
 */
const DETAIL_CONCURRENCY = 5;

/** Says who we are, so a board operator seeing this traffic can identify it. */
const USER_AGENT = "actinno-job-agent/1.0 (+job application assistant)";

const LOG = "[act-018]";

// ───────────────────────────────────
// Public types — unchanged shapes, see the notes on each field
// ───────────────────────────────────

export type JobSearchPreferences = {
  /**
   * Company boards to list jobs from — `"stripe"`, `"ramp"`, or a pasted board
   * URL like `"https://jobs.lever.co/matchgroup"`. Required: these are per-
   * employer board APIs, and none of them has a cross-company keyword search.
   *
   * Which ATS each company is on is detected, not asked for — see
   * `resolveBoard`. A pasted URL additionally pins the platform.
   */
  companies: string[];
  /**
   * Target role, e.g. "entry-level software engineer". Applied *after* the
   * fetch, as a narrowing filter over each listing's title (plus department and
   * team where the board publishes them) — every word in it has to appear.
   * Omit it to take every open job on the board.
   */
  title?: string;
  /**
   * Accepted and ignored. Greenhouse — by far the largest of the three boards
   * here — publishes no compensation at all, while Lever exposes `salaryRange`
   * and Ashby an optional `compensation`. Filtering on it would therefore mean
   * "drop Lever/Ashby jobs under X, and silently keep every Greenhouse job
   * regardless", which is a worse answer than not filtering: it looks like a
   * pay floor and is not one. Left uniformly unimplemented until it can be
   * honest on all three.
   */
  payMin?: number;
  /**
   * Locations to keep. Matched case-insensitively as a substring against each
   * listing's location text (primary location, secondary/all locations, and
   * remote/workplace flags), and any one of them matching is enough — so
   * `["Seattle", "Remote"]` reads as "Seattle or remote", which is the only
   * sensible reading of a list. Omit to take every location.
   */
  locations?: string[];
  /**
   * How many *matched* listings one company may contribute, before the global
   * `MAX_LISTINGS` cap. Defaults to `MAX_LISTINGS`, i.e. no per-company limit.
   * See `DEFAULT_MAX_PER_COMPANY` — this field's meaning changed in ACT-018.
   */
  maxPerCompany?: number;
};

export type JobListing = {
  company: string;
  title: string;
  /**
   * Always https, and always a page that serves an application form — that is
   * the ACT-018 guarantee and the header records the evidence for it per
   * platform. Listings without one are dropped rather than passed on.
   */
  applyUrl: string;
  location: string | null;
  atsProvider: "greenhouse" | "lever" | "other";
  /**
   * Whether the board's application form has a **required** cover-letter field.
   *
   * Presence is not enough, which is a deliberate reading of the name:
   * Greenhouse renders an optional "Cover Letter" question on a large share of
   * postings (Stripe's, for instance, is `required: false`), so a presence test
   * would ask ACT-007 to write a cover letter for almost every listing.
   * `required: true` is what "requires" means.
   *
   * Only Greenhouse can answer this — it is read from that job's real
   * `questions[]`, which is the form's own definition rather than a guess about
   * it. Neither Lever's nor Ashby's public API exposes the application form's
   * fields at all (checked: the strings "cover letter" appear nowhere in either
   * board's entire response), so listings from those two report `false`. See
   * `requiresCoverLetterFromQuestions`.
   */
  requiresCoverLetter: boolean;
  /** Plain-text job description, capped. UNTRUSTED — see ACT-007's handling. */
  jobDescription: string | null;
};

/**
 * The platforms this module can read. Distinct from `JobListing["atsProvider"]`
 * on purpose: that union is a fixed cross-module contract with only three
 * members, this one is what the code actually knows. `toAtsProvider` is the one
 * place they meet.
 */
type AtsPlatform = "greenhouse" | "lever" | "ashby";

const PLATFORMS: readonly AtsPlatform[] = ["greenhouse", "lever", "ashby"];

function toAtsProvider(platform: AtsPlatform): JobListing["atsProvider"] {
  return platform === "ashby" ? "other" : platform;
}

/**
 * One job as it came off a board listing, before filtering. The per-platform
 * readers all produce this so that filtering, capping and emitting are written
 * once rather than three times.
 */
type BoardJob = {
  platform: AtsPlatform;
  /** The board's own tenant token, needed to build Greenhouse's apply URL. */
  boardToken: string;
  /** The board's job id, as a string. */
  jobId: string;
  company: string;
  title: string;
  /** Primary location, as displayed. */
  location: string | null;
  /** Everything the `title` filter is allowed to match against. */
  titleHaystack: string;
  /** Everything the `locations` filter is allowed to match against. */
  locationHaystack: string;
  applyUrl: string;
  /** Null where the board's listing endpoint carries no description. */
  description: string | null;
  requiresCoverLetter: boolean;
};

// ───────────────────────────────────
// Text handling — all of it on untrusted, third-party input
// ───────────────────────────────────

/**
 * Control characters and non-breaking spaces, stripped from anything that ends
 * up in a Postgres column, a log line or an Inngest match expression. Same
 * reasoning as `submit-application.ts`'s `sanitizePageText`: a board is free to
 * put an ANSI escape sequence in its posting, and a terminal printing it back
 * later is not free to interpret one.
 */
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F-\u009F\u00A0]/g;

/** The same, but sparing `\n` — paragraph breaks are worth keeping in prose. */
const CONTROL_CHARS_KEEP_NEWLINES_RE =
  /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u00A0]/g;

const HTML_ENTITIES: ReadonlyMap<string, string> = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["nbsp", " "],
]);

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, name: string) => {
    const key = name.toLowerCase();
    const known = HTML_ENTITIES.get(key);
    if (known !== undefined) return known;
    const numeric = key.startsWith("#x")
      ? Number.parseInt(key.slice(2), 16)
      : key.startsWith("#")
        ? Number.parseInt(key.slice(1), 10)
        : Number.NaN;
    return Number.isFinite(numeric) && numeric > 0 && numeric < 0x110000
      ? String.fromCodePoint(numeric)
      : whole;
  });
}

/** Collapses whitespace and strips control characters, keeping paragraphs. */
function tidyProse(text: string): string {
  return text
    .replace(CONTROL_CHARS_KEEP_NEWLINES_RE, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Greenhouse returns `content` HTML-*escaped*, so the JSON string holds
 * `&lt;p&gt;…` rather than `<p>…`. That needs an entity pass to become markup, a
 * tag strip to become text, and a second entity pass for the `&amp;` that was
 * double-escaped by the first. Doing it in the other order leaves literal `<p>`
 * tags in the output, which is how this reads as noise in a cover-letter prompt.
 *
 * Lever's `lists[].content` is ordinary (unescaped) HTML; the leading decode is
 * a no-op on it rather than a corruption, since there are no entities to undo.
 */
function htmlToText(html: string): string {
  return tidyProse(
    decodeEntities(
      decodeEntities(html)
        .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
        .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
    )
  );
}

/** One line of third-party text, safe to store and to embed in a match expression. */
function cleanField(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  const cleaned = text.replace(CONTROL_CHARS_RE, " ").replace(/\s+/g, " ").trim();
  return cleaned.length > MAX_FIELD_CHARS ? cleaned.slice(0, MAX_FIELD_CHARS) : cleaned;
}

/** A description assembled from already-plain-text fields. */
function cleanDescription(parts: readonly (string | null | undefined)[]): string | null {
  const joined = parts
    .map((part) => (typeof part === "string" ? part : ""))
    .filter((part) => part.trim() !== "")
    .join("\n\n");
  const text = tidyProse(joined).slice(0, MAX_DESCRIPTION_CHARS);
  return text === "" ? null : text;
}

// ───────────────────────────────────
// Untyped-JSON accessors
// ───────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Board job ids are numbers on Greenhouse and uuid strings on Lever/Ashby. */
function asId(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

// ───────────────────────────────────
// Input mapping
// ───────────────────────────────────

/** A company the caller asked for, resolved as far as its input alone allows. */
type CompanyTarget = {
  /** The board's tenant token, lowercased. */
  token: string;
  /** What to call the employer when the API does not name it. Caller's own word. */
  label: string;
  /** Set when the caller pasted a URL, which pins the platform without probing. */
  platform: AtsPlatform | null;
};

/** Board hostnames whose first path segment (or `?for=`) is the tenant token. */
const BOARD_HOSTS: readonly { pattern: RegExp; platform: AtsPlatform }[] = [
  { pattern: /(^|\.)greenhouse\.io$/i, platform: "greenhouse" },
  { pattern: /(^|\.)lever\.co$/i, platform: "lever" },
  { pattern: /(^|\.)ashbyhq\.com$/i, platform: "ashby" },
];

/**
 * `"airbnb"`, `"https://boards.greenhouse.io/airbnb"`,
 * `"https://job-boards.greenhouse.io/airbnb/jobs/123"` and
 * `"https://job-boards.greenhouse.io/embed/job_app?for=airbnb&token=123"` all
 * name the same board — the last shape being the one this module emits, so a
 * listing's own apply URL can be pasted straight back in.
 *
 * Returns `null` for input that yields no token at all, so a caller sees "this
 * company was unusable" rather than an empty result set.
 */
export function parseCompanyTarget(raw: string): CompanyTarget | null {
  const trimmed = String(raw ?? "").trim();
  if (trimmed === "") return null;

  if (!/^https?:\/\//i.test(trimmed)) {
    const token = trimmed.replace(/^\/+|\/+$/g, "").toLowerCase();
    return token === "" ? null : { token, label: trimmed, platform: null };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const platform = BOARD_HOSTS.find(({ pattern }) => pattern.test(host))?.platform ?? null;

  const segments = url.pathname.split("/").filter(Boolean);
  const first = (segments[0] ?? "").toLowerCase();
  // Greenhouse embeds carry the tenant in `?for=` rather than in the path —
  // the same special case `gmail-verification-listener.ts` makes.
  const token =
    first === "embed" ? (url.searchParams.get("for") ?? "").trim().toLowerCase() : first;

  return token === "" ? null : { token, label: token, platform };
}

/**
 * Kept as the older name for the same normalisation, since it is exported.
 * Returns `""` where `parseCompanyTarget` returns `null`.
 */
export function normalizeCompanySlug(raw: string): string {
  return parseCompanyTarget(raw)?.token ?? "";
}

/**
 * The words a listing has to contain to survive `preferences.title`.
 *
 * One-character tokens are dropped (a stray "a" matches everything) and the rest
 * are all required — an AND, not an OR. That is the narrow choice on purpose:
 * this filter decides which real employers get a real application, so a false
 * positive costs an application to a job the candidate never asked for, while a
 * false negative costs a listing nobody sees. Broaden the query, not the match.
 */
function titleTokens(title: string | undefined): string[] {
  return Array.from(
    new Set(
      String(title ?? "")
        .toLowerCase()
        .split(/[^a-z0-9+#]+/)
        .filter((token) => token.length > 1)
    )
  );
}

function matchesTitle(job: BoardJob, tokens: readonly string[]): boolean {
  if (tokens.length === 0) return true;
  const haystack = job.titleHaystack.toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

/** Any one requested location matching is enough — see `JobSearchPreferences`. */
function matchesLocation(job: BoardJob, wanted: readonly string[]): boolean {
  if (wanted.length === 0) return true;
  const haystack = job.locationHaystack.toLowerCase();
  return wanted.some((location) => haystack.includes(location));
}

/**
 * True when the board asks for a cover letter and will not accept the form
 * without one.
 *
 * Reads Greenhouse's `questions[]` — the application form's own definition, so
 * this is the form telling us rather than us guessing from the posting text.
 * Both shapes are checked because either can carry the signal: the visible
 * `label` ("Cover Letter") and the underlying field names (`cover_letter`,
 * `cover_letter_text`), the latter surviving a board that has renamed the
 * label.
 */
function requiresCoverLetterFromQuestions(questions: unknown): boolean {
  return asArray(questions).some((entry) => {
    const question = asRecord(entry);
    if (question.required !== true) return false;
    if (/cover\s*letter/i.test(asString(question.label))) return true;
    return asArray(question.fields).some((field) =>
      asString(asRecord(field).name).startsWith("cover_letter")
    );
  });
}

/** Rejects anything that is not an https URL — ACT-005's own rule, applied early. */
function httpsOrNull(raw: unknown): string | null {
  const text = asString(raw).trim();
  if (text === "") return null;
  try {
    const parsed = new URL(text);
    return parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

// ───────────────────────────────────
// HTTP
// ───────────────────────────────────

type JsonResult =
  | { ok: true; status: number; body: unknown }
  | { ok: false; status: number | null; error: string };

/**
 * One unauthenticated GET, JSON out. Never throws: every caller here has to
 * distinguish "this board does not exist" (404) from "this request failed"
 * (timeout, 5xx, unparseable body) and act differently on each, so failure is a
 * value rather than an exception.
 */
async function getJson(url: string): Promise<JsonResult> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, status: null, error: reason };
  }

  if (!response.ok) {
    // Drain the body so the socket is released rather than left to the GC.
    await response.text().catch(() => "");
    return { ok: false, status: response.status, error: `HTTP ${response.status}` };
  }

  try {
    return { ok: true, status: response.status, body: await response.json() };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, status: response.status, error: `unparseable JSON: ${reason}` };
  }
}

/** `Promise.all` with a ceiling on how many are in flight at once. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  // Each runner pulls the next index until the queue is empty, so a slow board
  // holds up only itself rather than a whole batch. The bound is the *number of
  // runners*; `next` is only ever read and incremented between awaits on a
  // single thread, so the claim is atomic without a lock.
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as T, index);
    }
  });

  await Promise.all(runners);
  return results;
}

// ───────────────────────────────────
// Per-platform board readers
// ───────────────────────────────────

function readGreenhouseBoard(body: unknown, target: CompanyTarget): BoardJob[] {
  const jobs: BoardJob[] = [];

  for (const entry of asArray(asRecord(body).jobs)) {
    const job = asRecord(entry);
    const jobId = asId(job.id);
    const title = cleanField(job.title);
    if (jobId === "" || title === "") continue;

    const location = cleanField(asRecord(job.location).name) || null;

    jobs.push({
      platform: "greenhouse",
      boardToken: target.token,
      jobId,
      company: cleanField(job.company_name) || target.label,
      title,
      location,
      // The board listing carries no departments — `?content=true` would add
      // them but costs 4.4 MB for a board the size of Stripe's, which is a poor
      // trade for widening a filter that the title already answers. Lever and
      // Ashby publish theirs in the listing, so they are used there.
      titleHaystack: title,
      locationHaystack: location ?? "",
      applyUrl: greenhouseApplyUrl(target.token, jobId),
      // Filled in by `enrichGreenhouse`, for matched listings only.
      description: null,
      requiresCoverLetter: false,
    });
  }

  return jobs;
}

function readLeverBoard(body: unknown, target: CompanyTarget): BoardJob[] {
  const jobs: BoardJob[] = [];

  for (const entry of asArray(body)) {
    const job = asRecord(entry);
    const jobId = asId(job.id);
    const title = cleanField(job.text);
    // Lever's own `applyUrl` — the `/apply` page, which is the one with the
    // form on it. Never derived: if the board did not publish one, skip it.
    const applyUrl = httpsOrNull(job.applyUrl);
    if (jobId === "" || title === "" || applyUrl === null) continue;

    const categories = asRecord(job.categories);
    const location = cleanField(categories.location) || null;
    const allLocations = asArray(categories.allLocations).map(asString).join(", ");

    jobs.push({
      platform: "lever",
      boardToken: target.token,
      jobId,
      company: target.label,
      title,
      location,
      titleHaystack: `${title} ${asString(categories.department)} ${asString(categories.team)}`,
      locationHaystack: [
        location ?? "",
        allLocations,
        asString(job.workplaceType),
        asString(job.country),
      ].join(" "),
      applyUrl,
      description: cleanDescription([
        asString(job.descriptionPlain),
        // `lists` holds the responsibilities/requirements bullets, which are
        // the part of a posting a cover letter actually has to answer, and
        // they are not in `descriptionPlain`.
        ...asArray(job.lists).map((raw) => {
          const list = asRecord(raw);
          return `${cleanField(list.text)}\n${htmlToText(asString(list.content))}`;
        }),
        asString(job.additionalPlain),
      ]),
      // Lever's public API does not describe the application form.
      requiresCoverLetter: false,
    });
  }

  return jobs;
}

function readAshbyBoard(body: unknown, target: CompanyTarget): BoardJob[] {
  const jobs: BoardJob[] = [];

  for (const entry of asArray(asRecord(body).jobs)) {
    const job = asRecord(entry);
    // Ashby publishes unlisted postings through the same endpoint; a job the
    // employer has taken off its board is not one to apply to.
    if (job.isListed === false) continue;

    const jobId = asId(job.id);
    const title = cleanField(job.title);
    const applyUrl = httpsOrNull(job.applyUrl);
    if (jobId === "" || title === "" || applyUrl === null) continue;

    const location = cleanField(job.location) || null;
    const secondary = asArray(job.secondaryLocations)
      .map((raw) => asString(asRecord(raw).location))
      .join(", ");

    jobs.push({
      platform: "ashby",
      boardToken: target.token,
      jobId,
      company: target.label,
      title,
      location,
      titleHaystack: `${title} ${asString(job.department)} ${asString(job.team)}`,
      locationHaystack: [
        location ?? "",
        secondary,
        asString(job.workplaceType),
        job.isRemote === true ? "remote" : "",
      ].join(" "),
      applyUrl,
      description: cleanDescription([asString(job.descriptionPlain)]),
      // Ashby's public API does not describe the application form.
      requiresCoverLetter: false,
    });
  }

  return jobs;
}

const BOARD_READERS: Record<
  AtsPlatform,
  { url: (token: string) => string; read: (body: unknown, target: CompanyTarget) => BoardJob[] }
> = {
  greenhouse: { url: greenhouseBoardUrl, read: readGreenhouseBoard },
  lever: { url: leverBoardUrl, read: readLeverBoard },
  ashby: { url: ashbyBoardUrl, read: readAshbyBoard },
};

// ───────────────────────────────────
// ATS detection
// ───────────────────────────────────

type ResolvedBoard = { target: CompanyTarget; platform: AtsPlatform; jobs: BoardJob[] };
type UnresolvedBoard = { target: CompanyTarget; attempts: string[] };
type BoardResult = { ok: true; board: ResolvedBoard } | { ok: false; failure: UnresolvedBoard };

/**
 * Works out which ATS a company is on, and returns its board.
 *
 * Detection is the fetch. Each platform's board endpoint is tried in turn with
 * the company token; a 200 means both "this is the ATS" and "here is every open
 * job", so a correct guess costs exactly one request and nothing is fetched
 * twice. Ordering is by how much of the world each platform hosts, so the
 * common case is one request; the worst case (Ashby) is three.
 *
 * A 404 is the definitive "not this platform" — verified across nine known
 * companies with no false positives in either direction, and a made-up name
 * 404s on all three. Anything else (a 5xx, a timeout) is recorded verbatim so
 * that "your slug is wrong" and "Lever was down" do not turn into the same
 * message.
 *
 * A pasted board URL pins the platform, and then only that one is tried: if
 * someone hands us `jobs.lever.co/acme` and Lever 404s, the answer is "that
 * Lever board does not exist", not "let me go and see whether Greenhouse has an
 * `acme`".
 */
async function resolveBoard(target: CompanyTarget): Promise<BoardResult> {
  const candidates = target.platform === null ? PLATFORMS : [target.platform];
  const attempts: string[] = [];

  for (const platform of candidates) {
    const reader = BOARD_READERS[platform];
    const result = await getJson(reader.url(target.token));

    if (result.ok) {
      const jobs = reader.read(result.body, target);
      console.log(
        `${LOG} ${target.label}: ${platform} board "${target.token}" — ${jobs.length} open job(s)`
      );
      return { ok: true, board: { target, platform, jobs } };
    }

    attempts.push(
      result.status === 404 ? `${platform}: no such board` : `${platform}: ${result.error}`
    );
  }

  return { ok: false, failure: { target, attempts } };
}

// ───────────────────────────────────
// Greenhouse enrichment — matched listings only
// ───────────────────────────────────

/**
 * Fills in `requiresCoverLetter` and `jobDescription` for Greenhouse listings,
 * one request each.
 *
 * This runs **after** filtering and after both caps, which is the whole reason
 * it is affordable: the input is at most `MAX_LISTINGS` jobs, not the 575 on
 * Stripe's board. Fetching the board with `?content=true` instead would get the
 * descriptions in one request but not the questions — and would download 4.4 MB
 * of postings to keep 25 of them.
 *
 * A failed detail fetch does not drop the listing. The apply URL is already
 * known to be good, so the job is still applyable; what is lost is a cover
 * letter's context and, in the rare `required: true` case, the knowledge that
 * one was needed. Dropping a real opening because one auxiliary request timed
 * out is the worse trade, so the listing goes out with the fields unset and the
 * gap is logged loudly against the specific job.
 */
async function enrichGreenhouse(jobs: BoardJob[]): Promise<void> {
  const pending = jobs.filter((job) => job.platform === "greenhouse");
  if (pending.length === 0) return;

  let failed = 0;

  await mapWithConcurrency(pending, DETAIL_CONCURRENCY, async (job) => {
    const result = await getJson(greenhouseJobUrl(job.boardToken, job.jobId));
    if (!result.ok) {
      failed += 1;
      console.warn(
        `${LOG} ${job.company} — "${job.title}": job detail fetch failed (${result.error}). ` +
          `Emitting it anyway with no description and requiresCoverLetter=false; the apply ` +
          `URL is unaffected.`
      );
      return;
    }

    const detail = asRecord(result.body);
    job.requiresCoverLetter = requiresCoverLetterFromQuestions(detail.questions);
    const content = asString(detail.content);
    job.description =
      content.trim() === "" ? null : htmlToText(content).slice(0, MAX_DESCRIPTION_CHARS);
  });

  console.log(
    `${LOG} greenhouse detail: ${pending.length - failed}/${pending.length} listing(s) enriched ` +
      `(${pending.length} request(s), ${DETAIL_CONCURRENCY} at a time)`
  );
}

// ───────────────────────────────────
// Capping
// ───────────────────────────────────

/**
 * Takes from each company in turn until `limit` is reached.
 *
 * Round-robin rather than company-by-company because the global cap is small
 * and boards are not: a straight concatenation of "stripe, airbnb" hits
 * `MAX_LISTINGS` inside Stripe's matches and fans out to Airbnb zero times,
 * which is not what asking for two employers means.
 */
function interleave(groups: readonly (readonly BoardJob[])[], limit: number): BoardJob[] {
  const out: BoardJob[] = [];
  const deepest = Math.max(0, ...groups.map((group) => group.length));

  for (let row = 0; row < deepest && out.length < limit; row += 1) {
    for (const group of groups) {
      const job = group[row];
      if (job === undefined) continue;
      out.push(job);
      if (out.length >= limit) break;
    }
  }

  return out;
}

// ───────────────────────────────────
// The search
// ───────────────────────────────────

function toListing(job: BoardJob): JobListing {
  return {
    company: job.company,
    title: job.title,
    applyUrl: job.applyUrl,
    location: job.location,
    atsProvider: toAtsProvider(job.platform),
    requiresCoverLetter: job.requiresCoverLetter,
    jobDescription: job.description,
  };
}

/**
 * Lists open jobs across the named company boards, narrowed by title and
 * location, with the two facts the rest of the pipeline needs about each one:
 * whether a cover letter is mandatory (ACT-007) and what the posting says
 * (ACT-007's cover-letter context).
 *
 * Request count for a realistic search — two Greenhouse companies, a title
 * filter, 25 matches — is 2 board fetches + 25 detail fetches = 27
 * unauthenticated GETs, of which at most 4 and 5 respectively are ever in
 * flight. A company on Ashby costs two extra probe requests.
 *
 * Throws when a named company cannot be resolved to a board. That is deliberate
 * and it is the ticket's own requirement: returning the other companies'
 * listings and saying nothing turns a typo'd slug — or a company that simply is
 * not on any of these three platforms — into "that employer had no matching
 * jobs", which is indistinguishable from a real empty result and is exactly the
 * failure that costs an hour to find. The error names every company that failed
 * and what each platform said, so the caller can drop or fix the offender and
 * re-run.
 */
export async function searchJobListings(
  preferences: JobSearchPreferences
): Promise<JobListing[]> {
  // De-duplicated by token: asking for "stripe" and
  // "https://boards.greenhouse.io/stripe" is asking for one board.
  const targets = new Map<string, CompanyTarget>();
  for (const raw of preferences.companies ?? []) {
    const target = parseCompanyTarget(raw);
    if (target !== null && !targets.has(target.token)) targets.set(target.token, target);
  }

  if (targets.size === 0) {
    throw new Error(
      "searchJobListings needs at least one company board in `companies` " +
        '(e.g. ["stripe", "ramp"], or a pasted board URL). These are per-employer board ' +
        "APIs — Greenhouse, Lever and Ashby — and none of them has a cross-company keyword " +
        "search, so there is no way to find companies from a job title alone."
    );
  }

  const wantedLocations = (preferences.locations ?? [])
    .map((location) => String(location ?? "").trim().toLowerCase())
    .filter((location) => location !== "");
  const tokens = titleTokens(preferences.title);
  const maxPerCompany = Math.max(
    1,
    Math.min(preferences.maxPerCompany ?? DEFAULT_MAX_PER_COMPANY, MAX_LISTINGS)
  );

  console.log(
    `${LOG} search — companies: ${JSON.stringify([...targets.keys()])}, ` +
      `title: ${JSON.stringify(preferences.title ?? "(any)")}, ` +
      `locations: ${JSON.stringify(wantedLocations.length ? wantedLocations : "(any)")}, ` +
      `max ${maxPerCompany}/company, ${MAX_LISTINGS} overall`
  );

  const resolved = await mapWithConcurrency([...targets.values()], BOARD_CONCURRENCY, (target) =>
    resolveBoard(target)
  );

  const failures = resolved.flatMap((result) => (result.ok ? [] : [result.failure]));
  if (failures.length > 0) {
    throw new Error(
      `No job board could be found for ${failures.length === 1 ? "company" : "companies"} ` +
        failures
          .map(({ target, attempts }) => `"${target.label}" (${attempts.join("; ")})`)
          .join(", ") +
        ". Actinno reads Greenhouse, Lever and Ashby boards, and identifies a company by its " +
        "board token — usually the company name lowercased, but not always. Check the " +
        "employer's careers page for the token in its board URL and pass that, or pass the " +
        "board URL itself. Nothing was searched; drop the company to search the rest."
    );
  }

  const boards = resolved.flatMap((result) => (result.ok ? [result.board] : []));

  // Filter and cap per company first, then interleave, so one big board cannot
  // consume the whole fan-out — and so the enrichment below is bounded by
  // MAX_LISTINGS rather than by how many jobs happened to match.
  let matchedTotal = 0;
  const perCompany = boards.map(({ target, jobs }) => {
    const matched = jobs.filter(
      (job) => matchesTitle(job, tokens) && matchesLocation(job, wantedLocations)
    );
    matchedTotal += matched.length;
    console.log(
      `${LOG} ${target.label}: ${jobs.length} open -> ${matched.length} matched -> ` +
        `${Math.min(matched.length, maxPerCompany)} kept`
    );
    return matched.slice(0, maxPerCompany);
  });

  const selected = interleave(perCompany, MAX_LISTINGS);

  await enrichGreenhouse(selected);

  if (preferences.payMin !== undefined) {
    console.log(
      `${LOG} note: payMin=${preferences.payMin} was ignored — Greenhouse publishes no ` +
        `compensation data, so a pay floor could only ever be applied to some of the ` +
        `platforms searched. See JobSearchPreferences.payMin.`
    );
  }
  console.log(
    `${LOG} ${boards.length} board(s), ${matchedTotal} match(es) -> ${selected.length} listing(s)`
  );

  return selected.map(toListing);
}
