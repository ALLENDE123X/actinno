/**
 * ACT-002's Greenhouse listing search, lifted out of `mcp-server/index.ts` so
 * the MCP `call_actor` path and the Inngest `discoverListings` function run the
 * *same* code rather than two copies that drift. ACT-009's brief is explicit
 * about this: "port/share the logic rather than duplicating it".
 *
 * ── What changed on the way out of mcp-server, and why ──────────────────────
 * The call being shared did not work. Ported verbatim it returns HTTP 400:
 *
 *     Input is not valid: Field input.mode must be equal to one of the allowed
 *     values: "company_jobs", "job_details"
 *
 * `automation-lab/greenhouse-jobs-scraper` has no keyword-search mode at all —
 * not a renamed one, none. Its published input schema is
 * `{ mode, companySlugs, jobIds, includeContent, includeQuestions,
 * filterDepartment, filterLocation, maxJobsPerCompany }`, and every field the
 * old call sent (`mode: "search"`, `keywords`, `location`, `maxResults`,
 * `includeDescription`) is either invalid or unrecognised. So this is not a
 * refactor that took liberties: a straight port would have made the pipeline's
 * one entry point a guaranteed 400, and ACT-009 cannot be accepted — "trigger a
 * job-search/requested event, watch N apply-to-job runs fan out" — without a
 * search that returns listings.
 *
 * Three consequences worth knowing before reading the code:
 *
 *  · **Targets are company boards, not a keyword.** The actor lists jobs for
 *    named Greenhouse slugs ("stripe", "airbnb"). `title` survives as a
 *    client-side narrowing filter, which is the closest honest equivalent, and
 *    `companies` is now the required input. There is no way around this short of
 *    a different actor.
 *
 *  · **`includeQuestions` must be sent, and defaults to false.** ACT-002's
 *    `requiresCoverLetter` was read off `j.questions`, which the actor only
 *    populates when asked. Unsent, the field is always `undefined` and
 *    `requiresCoverLetter` is silently always `false` — which would have flowed
 *    straight into ACT-007's "generate a cover letter ONLY when this is true".
 *
 *  · **`payMin` still does nothing.** The actor exposes no compensation data and
 *    there is nothing to filter on. It is accepted and ignored exactly as
 *    before, rather than being quietly dropped from the interface.
 *
 * Everything here is read-only: one POST that runs a public scraper and returns
 * its dataset. It writes nothing, anywhere.
 */

/** Apify actor id. Unchanged from ACT-002. */
const GREENHOUSE_ACTOR = "automation-lab~greenhouse-jobs-scraper";

/**
 * How many of a board's jobs to *fetch* — not how many to apply to. `title` is
 * a filter applied to this list afterwards, so it can only ever find what this
 * pulled down, and the actor returns a board's jobs in roughly alphabetical
 * order rather than by relevance.
 *
 * At 10 that made title search useless in a way that looked like "no such jobs
 * exist": stripe + airbnb returned 20 listings — Acquisition Manager, AMER
 * Gathering Programs Manager, Business Operations Lead, Compensation Partner,
 * Creative Producer — of which zero matched "software engineer", because the
 * sample was the front of the alphabet rather than a search result. A real
 * board carries hundreds of roles.
 *
 * 250 is a whole board for most employers and still well inside the actor's own
 * 500 default. The thing that actually bounds cost is `MAX_LISTINGS`, which
 * caps how many listings are ever applied to, and a browser only opens for
 * those.
 */
const DEFAULT_MAX_PER_COMPANY = 250;

/** Hard ceiling on one search's fan-out. `applyToJob` opens a browser per listing. */
const MAX_LISTINGS = 25;

/**
 * How much job-description text travels in the `job-application/requested`
 * event. It exists to give ACT-007's cover-letter writer context, and a full
 * Greenhouse posting is 10-30KB of boilerplate whose first couple of thousand
 * characters carry the role. Capping here rather than at the consumer keeps the
 * event payload small — this string is copied into every fanned-out event.
 */
const MAX_DESCRIPTION_CHARS = 8_000;

/** Scraped text lands in Postgres columns and in Inngest match expressions. */
const MAX_FIELD_CHARS = 300;

const LOG = "[act-002]";

export type JobSearchPreferences = {
  /**
   * Greenhouse board slugs to list jobs from — "stripe", "airbnb", or a pasted
   * board URL like "https://boards.greenhouse.io/airbnb". Required: the actor
   * has no way to find companies for you (see the header).
   */
  companies: string[];
  /**
   * Target role, e.g. "entry-level software engineer". Applied *after* the
   * fetch, as a narrowing filter over each listing's title and departments —
   * every word in it has to appear. Omit it to take every open job on the board.
   */
  title?: string;
  /** Accepted and ignored — the actor returns no compensation data. */
  payMin?: number;
  /** First entry becomes the actor's `filterLocation` substring match. */
  locations?: string[];
  /** Per company, before the title filter. Default 10. */
  maxPerCompany?: number;
};

export type JobListing = {
  company: string;
  title: string;
  /** Always https. Listings without one are dropped rather than passed on. */
  applyUrl: string;
  location: string | null;
  atsProvider: "greenhouse" | "lever" | "other";
  /**
   * Whether the board's application form has a **required** cover-letter field.
   *
   * Presence is not enough, which is a deliberate reading of the name: Greenhouse
   * renders an optional "Cover Letter" question on a large share of postings, so
   * a presence test would ask ACT-007 to write a cover letter for almost every
   * listing. `required: true` is what "requires" means. No behaviour regressed
   * here — the field could only ever be `false` before, since `includeQuestions`
   * was never sent.
   */
  requiresCoverLetter: boolean;
  /** Plain-text job description, capped. UNTRUSTED — see ACT-007's handling. */
  jobDescription: string | null;
};

/** Shape the actor actually returns. Every field optional — it is scraped data. */
type RawGreenhouseJob = {
  title?: unknown;
  companyName?: unknown;
  companySlug?: unknown;
  location?: unknown;
  /** Canonical `boards.greenhouse.io/{slug}/jobs/{id}` URL. */
  url?: unknown;
  /** The employer's own careers page for the same job. */
  absoluteUrl?: unknown;
  content?: unknown;
  departments?: unknown;
  questions?: unknown;
};

// ───────────────────────────────────
// Text handling — all of it on untrusted, scraped input
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

/**
 * Greenhouse returns `content` HTML-*escaped*, so the JSON string holds
 * `&lt;p&gt;…` rather than `<p>…`. That needs an entity pass to become markup, a
 * tag strip to become text, and a second entity pass for the `&amp;` that was
 * double-escaped by the first. Doing it in the other order leaves literal `<p>`
 * tags in the output, which is how this reads as noise in a cover-letter prompt.
 */
function htmlToText(html: string): string {
  return decodeEntities(
    decodeEntities(html)
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(CONTROL_CHARS_KEEP_NEWLINES_RE, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** One line of scraped text, safe to store and to embed in a match expression. */
function cleanField(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  const cleaned = text.replace(CONTROL_CHARS_RE, " ").replace(/\s+/g, " ").trim();
  return cleaned.length > MAX_FIELD_CHARS ? cleaned.slice(0, MAX_FIELD_CHARS) : cleaned;
}

// ───────────────────────────────────
// Input mapping
// ───────────────────────────────────

/**
 * "airbnb", "https://boards.greenhouse.io/airbnb" and
 * "https://job-boards.greenhouse.io/airbnb/jobs/123" all name the same board.
 * The actor documents that it accepts a pasted URL, but normalising here means a
 * slug typo fails as a slug typo rather than as an empty result set.
 */
export function normalizeCompanySlug(raw: string): string {
  const trimmed = String(raw ?? "").trim();
  if (trimmed === "") return "";
  if (!/^https?:\/\//i.test(trimmed)) {
    return trimmed.replace(/^\/+|\/+$/g, "").toLowerCase();
  }
  try {
    const segments = new URL(trimmed).pathname.split("/").filter(Boolean);
    return (segments[0] ?? "").toLowerCase();
  } catch {
    return "";
  }
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

function matchesTitle(job: RawGreenhouseJob, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const departments = Array.isArray(job.departments)
    ? job.departments
        .map((d) =>
          d && typeof d === "object" ? String((d as { name?: unknown }).name ?? "") : ""
        )
        .join(" ")
    : "";
  const haystack = `${cleanField(job.title)} ${departments}`.toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

/** True when the board asks for a cover letter and will not accept the form without one. */
function requiresCoverLetter(questions: unknown): boolean {
  if (!Array.isArray(questions)) return false;
  return questions.some((q) => {
    if (!q || typeof q !== "object") return false;
    const question = q as { label?: unknown; required?: unknown; fields?: unknown };
    if (question.required !== true) return false;
    if (/cover\s*letter/i.test(String(question.label ?? ""))) return true;
    return (
      Array.isArray(question.fields) &&
      question.fields.some(
        (f) =>
          !!f &&
          typeof f === "object" &&
          String((f as { name?: unknown }).name ?? "").startsWith("cover_letter")
      )
    );
  });
}

/**
 * `url` before `absoluteUrl` — deliberately. `url` is the canonical
 * `boards.greenhouse.io/{slug}/jobs/{id}` page, which renders the application
 * form directly; `absoluteUrl` is the employer's own careers site, which is
 * usually a JS app wrapping the same posting and is exactly the "rendered but
 * empty" shape `create-board-account.ts`'s `awaitApplyUi` exists to survive.
 * Give ACT-005 the page that has a form on it.
 */
function pickApplyUrl(job: RawGreenhouseJob): string | null {
  for (const candidate of [job.url, job.absoluteUrl]) {
    const raw = typeof candidate === "string" ? candidate.trim() : "";
    if (raw === "") continue;
    try {
      const parsed = new URL(raw);
      // ACT-005 refuses anything but https, and would rather refuse it here,
      // where the listing can simply be skipped with a log line.
      if (parsed.protocol === "https:") return parsed.toString();
    } catch {
      /* not a URL — try the next candidate */
    }
  }
  return null;
}

function toListing(job: RawGreenhouseJob): JobListing | null {
  const applyUrl = pickApplyUrl(job);
  const company = cleanField(job.companyName) || cleanField(job.companySlug);
  const title = cleanField(job.title);
  if (applyUrl === null || company === "" || title === "") return null;

  const description =
    typeof job.content === "string" && job.content.trim() !== ""
      ? htmlToText(job.content).slice(0, MAX_DESCRIPTION_CHARS)
      : "";

  return {
    company,
    title,
    applyUrl,
    location: cleanField(job.location) || null,
    atsProvider: "greenhouse",
    requiresCoverLetter: requiresCoverLetter(job.questions),
    jobDescription: description === "" ? null : description,
  };
}

// ───────────────────────────────────
// The call
// ───────────────────────────────────

/**
 * Lists open Greenhouse jobs for the named company boards, narrowed by title and
 * location, with the two facts the rest of the pipeline needs about each one:
 * whether a cover letter is mandatory (ACT-007) and what the posting says
 * (ACT-007's cover-letter context).
 *
 * Throws on a missing token or a failed actor call — both are configuration or
 * upstream problems a retry can legitimately fix.
 */
export async function searchJobListings(
  preferences: JobSearchPreferences
): Promise<JobListing[]> {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) {
    throw new Error(
      "APIFY_API_TOKEN env var not set — get one from apify.com/settings/integrations"
    );
  }

  const companySlugs = Array.from(
    new Set((preferences.companies ?? []).map(normalizeCompanySlug).filter((s) => s !== ""))
  );
  if (companySlugs.length === 0) {
    throw new Error(
      "searchJobListings needs at least one Greenhouse company slug in `companies` " +
        '(e.g. ["stripe", "airbnb"]). This actor lists jobs per company board; it has no ' +
        "keyword-search mode — see the header of lib/search-job-listings.ts."
    );
  }

  const location = preferences.locations?.find((l) => String(l ?? "").trim() !== "")?.trim();
  const maxPerCompany = Math.max(
    1,
    Math.min(preferences.maxPerCompany ?? DEFAULT_MAX_PER_COMPANY, 1_000)
  );

  console.log(
    `${LOG} greenhouse search — boards: ${JSON.stringify(companySlugs)}, ` +
      `title: ${JSON.stringify(preferences.title ?? "(any)")}, ` +
      `location: ${JSON.stringify(location ?? "(any)")}, max ${maxPerCompany}/board`
  );

  const runResp = await fetch(
    `https://api.apify.com/v2/acts/${GREENHOUSE_ACTOR}/run-sync-get-dataset-items?token=${token}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "company_jobs",
        companySlugs,
        // Both are sent explicitly. `includeQuestions` defaults to FALSE, which
        // is what made `requiresCoverLetter` structurally unreachable; and
        // `includeContent` defaults to true today, which is not a promise.
        includeContent: true,
        includeQuestions: true,
        ...(location === undefined ? {} : { filterLocation: location }),
        maxJobsPerCompany: maxPerCompany,
      }),
    }
  );

  if (!runResp.ok) {
    throw new Error(`Greenhouse actor call failed: ${runResp.status} ${await runResp.text()}`);
  }

  const payload: unknown = await runResp.json();
  if (!Array.isArray(payload)) {
    throw new Error(
      `Greenhouse actor returned ${typeof payload}, expected an array of jobs: ` +
        `${JSON.stringify(payload).slice(0, 500)}`
    );
  }

  const tokens = titleTokens(preferences.title);
  const listings: JobListing[] = [];
  let skipped = 0;

  for (const raw of payload as RawGreenhouseJob[]) {
    if (!matchesTitle(raw, tokens)) continue;
    const listing = toListing(raw);
    if (listing === null) {
      skipped += 1;
      continue;
    }
    listings.push(listing);
    if (listings.length >= MAX_LISTINGS) break;
  }

  if (preferences.payMin !== undefined) {
    console.log(
      `${LOG} note: payMin=${preferences.payMin} was ignored — this actor returns no ` +
        `compensation data, so there is nothing to filter on.`
    );
  }
  if (skipped > 0) {
    console.warn(
      `${LOG} ${skipped} listing(s) skipped — no https apply URL, company or title on them.`
    );
  }
  console.log(
    `${LOG} ${payload.length} job(s) from the actor -> ${listings.length} after filtering`
  );

  return listings;
}
