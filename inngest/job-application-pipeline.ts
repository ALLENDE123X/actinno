/**
 * ACT-009 — the orchestration layer. Two Inngest functions, wired to the real
 * ACT-002 through ACT-008 modules.
 *
 *   1. discoverListings — ONE bulk search per request, runs once.
 *   2. applyToJob       — fans out from that single list. N listings = N
 *                         independent runs, at most 5 in flight (`concurrency`).
 *                         Each run is its own sequential chain internally
 *                         (account → maybe verify → fill+submit) because those
 *                         are causally dependent; every listing's chain runs in
 *                         parallel with every other listing's.
 *
 * ── Four things the original stub got wrong, and what replaced them ──────────
 *
 * **1. A live browser cannot be handed between steps.** The stub did
 * `const account = await step.run("create-account", …)` and then passed
 * `account.session` into a later `fill-application` step. Inngest's durable
 * execution can run those two steps in different invocations of this process —
 * that is the whole point of it — so `account.session` would arrive as a JSON
 * corpse of a Playwright page. This is exactly why ACT-012/007/008 were each
 * built as self-contained, re-entrant calls keyed only by a `job_applications`
 * row id: `createBoardAccount` takes strings and returns plain data,
 * `submitApplication` takes a row id and returns plain data, and neither has a
 * session in its signature at all. Nothing crosses a step boundary here but ids
 * and strings.
 *
 * **2. Filling and submitting are ONE step, not two.** `submitApplication()`
 * (ACT-008) already calls ACT-007's `fillApplicationFormRetainingSession()` and
 * submits in *the same browser* — see its "Why this calls ACT-007 rather than
 * resuming it" header. A separate `fill-application` step followed by a
 * `submit-application` step would open two browsers, fill the form in the first,
 * throw it away, and then ask the second to submit a form it never filled. So
 * there is one `fill-and-submit-application` step and it calls ACT-008 alone.
 *
 * **3. The verification wait is conditional.** The stub always waited for
 * `email/verification-received` before proceeding. Most Greenhouse listings are
 * direct-apply — ACT-012's whole design — and `createBoardAccount` reports that
 * as `no_account_required`, meaning there is no account, no signup mail, and
 * nothing to wait for. Waiting anyway would park the majority of real listings
 * on a ten-minute timeout for an email that is never sent. The wait is entered
 * on exactly one status, `awaiting_verification`, which is the only one that
 * means a signup was actually submitted.
 *
 * **4. Events carry a `candidateId`, not raw resume/LinkedIn/email strings.**
 * `candidates.resume_url` is a bucket-qualified path into a *private* bucket
 * (`resumes/{id}.pdf`), not a fetchable URL, and ACT-007 reads the object itself
 * with the service-role client rather than being handed a link. `linkedin_url`
 * and `application_email` live on the same row. So the events carry the row's
 * id and the one step that needs the email looks it up. The field is spelled
 * `candidateId` rather than the stub's `userId` because that is what it has to
 * be: see `verificationMatch` below.
 *
 * ── What this file does NOT do ──────────────────────────────────────────────
 * It never writes to `job_applications`. The stub had a `log-to-tracker` step
 * calling `updateTrackerRow`, and there is no table for it to write to: the
 * actinno project has exactly two tables, `candidates` and `job_applications`,
 * and every module in the chain already writes its own status to the latter as
 * it goes (`creating_account` → `no_account_required` / `awaiting_verification`
 * → `email_verified` → `filling_form` → `form_filled` → `submitted`). That row
 * *is* the tracker; a second writer would only ever disagree with it. The one
 * Supabase call in this file is a read of `candidates`.
 */

// FIRST, and it has to stay first: the Inngest client below reads `INNGEST_DEV`
// at construction time. See `load-env.ts`.
import "./load-env.js";

import { Inngest, NonRetriableError, eventType, staticSchema } from "inngest";

import { loadCandidate } from "../lib/candidate-intake.js";
import {
  APPLICATION_STATUS,
  createBoardAccount,
  type ApplicationStatus,
} from "../lib/create-board-account.js";
import { FormFillBlockedError, type VerificationInput } from "../lib/fill-application-form.js";
// A value import, and it costs a second or two of startup: this module reaches
// `gmail-client.ts`, which loads `googleapis`. Worth it. `VERIFICATION_EVENT_NAME`
// and `VerificationEventData` are the producer side of the contract the wait
// below depends on, and importing them makes a rename over there a compile error
// over here instead of a ten-minute timeout with no visible cause.
import {
  VERIFICATION_EVENT_NAME,
  type VerificationEventData,
} from "../lib/gmail-verification-listener.js";
import { InjectionSuspectedError } from "../lib/resume-parser.js";
import {
  searchJobListings,
  type JobListing,
  type JobSearchPreferences,
} from "../lib/search-job-listings.js";
import { SubmissionBlockedError, submitApplication } from "../lib/submit-application.js";

/** Same app id ACT-006's sender uses. */
export const inngest = new Inngest({ id: "actinno-job-agent" });

// ───────────────────────────────────
// Events
// ───────────────────────────────────

export const JOB_SEARCH_REQUESTED = "job-search/requested";
export const JOB_APPLICATION_REQUESTED = "job-application/requested";

/**
 * What starts a search.
 *
 * `candidateId` **is the `candidates.id` UUID** minted by ACT-003, and it is
 * carried through to `job_applications.candidate_id` unchanged. That is not a
 * naming preference; it is the contract described under `verificationMatch`.
 */
export type JobSearchRequestedData = {
  candidateId: string;
  /**
   * Optional. `companies` (Greenhouse board slugs) is the only field with no
   * column on `candidates`, so it must be supplied; `title`, `payMin` and
   * `locations` fall back to `target_title` / `pay_min` / `locations` on the
   * candidate's own row, which is what ACT-003 stored them for and what nothing
   * has read until now.
   */
  preferences: Partial<JobSearchPreferences> & { companies: string[] };
};

/** One listing, one run. Everything else is looked up from `candidateId`. */
export type JobApplicationRequestedData = {
  candidateId: string;
  listing: JobListing;
  /**
   * ACT-015. The candidate's own answers to questions a previous attempt could
   * not answer truthfully — work authorization, current country, and whatever
   * else a particular board asks that no stored fact covers.
   *
   * Optional, and additive to ACT-009's contract on purpose: an event sent
   * without it behaves exactly as it did before. Its presence is what turns a
   * run that stopped at `form_fill_blocked` with `needsInput` into one that
   * finishes, without any state having been kept in between — the caller asked
   * the person, and re-sends the same event with the answers attached.
   */
  additionalAnswers?: Record<string, string>;
};

// `staticSchema` gives the handlers real types without a runtime validation
// dependency. It is a passthrough at runtime, so the two guards below —
// `requireCandidateId` and `normalizeListing` — are what actually reject a
// malformed event, and they do it with a message that names the contract that
// was broken rather than a schema path.
export const jobSearchRequested = eventType(JOB_SEARCH_REQUESTED, {
  schema: staticSchema<JobSearchRequestedData>(),
});
export const jobApplicationRequested = eventType(JOB_APPLICATION_REQUESTED, {
  schema: staticSchema<JobApplicationRequestedData>(),
});
/** The consumer side of ACT-006's event. Name and shape imported, not retyped. */
export const verificationReceived = eventType(VERIFICATION_EVENT_NAME, {
  schema: staticSchema<VerificationEventData>(),
});

/**
 * How long to hold a run open for a verification email.
 *
 * Deliberately still the stub's ten minutes. ACT-006 sized its own 15-minute
 * `VERIFICATION_WINDOW_MS` as "just above the pipeline's own timeout: 10m" —
 * moving this without moving that would either strand runs waiting past the
 * window in which the listener will still look, or leave the listener matching
 * mail no run is listening for.
 */
const VERIFICATION_TIMEOUT = "10m";

/**
 * ══ THE ONE CONTRACT THAT CANNOT BE ENFORCED BY A TYPE ══════════════════════
 *
 * ACT-006 sends `email/verification-received` with
 * `data.userId = job_applications.candidate_id` and `data.company =
 * job_applications.company`, and those two fields are the *only* thing that
 * decides whether a parked run wakes up. So:
 *
 *  · `async.data.userId` is compared against this pipeline's `candidateId`.
 *    The field names differ because ACT-006's is already written and deployed;
 *    the *values* are the same UUID, which is the half that matters. Anything
 *    else in `candidateId` — an auth subject, an email address — and this wait
 *    times out silently. `requireCandidateId` and `loadCandidate` between them
 *    make that fail at the start of the run instead.
 *
 *  · `async.data.company` is compared against the company string. ACT-006 reads
 *    it back out of the row, and ACT-005 wrote `input.company.trim()` into that
 *    row — so the comparison is against the *trimmed* company, which is why
 *    `normalizeListing` trims once and both the `createBoardAccount` call and
 *    this expression use its output.
 *
 * Both values are interpolated with `JSON.stringify`, not with bare quotes.
 * `company` is scraped text off a real employer's job board; a listing titled
 * `Acme " || true || "` pasted straight into this expression is a broken match
 * at best and a match on somebody else's mail at worst.
 * ════════════════════════════════════════════════════════════════════════════
 */
function verificationMatch(candidateId: string, company: string): string {
  return (
    `async.data.userId == ${JSON.stringify(candidateId)} && ` +
    `async.data.company == ${JSON.stringify(company)}`
  );
}

// ───────────────────────────────────
// Event-payload guards
// ───────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A bad event never becomes a good event, so every rejection here is
 * `NonRetriableError`. Retrying a malformed payload just fills the dashboard
 * with identical failures and buries the one that explains them.
 */
function requireCandidateId(raw: unknown): string {
  const id = String(raw ?? "").trim();
  if (!UUID_RE.test(id)) {
    throw new NonRetriableError(
      `candidateId must be the candidates.id UUID, got ${JSON.stringify(raw)}. It is the ` +
        `same identity as job_applications.candidate_id and as the userId ACT-006 puts on ` +
        `${VERIFICATION_EVENT_NAME} — see verificationMatch() in this file.`
    );
  }
  return id;
}

/**
 * The listing, trimmed and checked once, at the top of the run.
 *
 * `applyToJob` is triggered by an event, and an event can be hand-written — from
 * the Inngest dev dashboard today, from the MCP `apply-to-job` tool once ACT-010
 * wires it. So the listing is not assumed to have come from
 * `searchJobListings`. The https check in particular is `createBoardAccount`'s
 * own rule, applied here so a bad URL fails before a browser is launched.
 */
function normalizeListing(raw: JobListing | undefined): JobListing {
  const listing = raw ?? ({} as JobListing);
  const company = String(listing.company ?? "").trim();
  const title = String(listing.title ?? "").trim();
  const applyUrl = String(listing.applyUrl ?? "").trim();

  const reject = (why: string): never => {
    throw new NonRetriableError(`job-application/requested carries an unusable listing: ${why}`);
  };

  if (company === "") reject("no company");
  if (title === "") reject("no title");
  try {
    if (new URL(applyUrl).protocol !== "https:") reject(`applyUrl is not https: ${applyUrl}`);
  } catch {
    reject(`applyUrl is not a URL: ${JSON.stringify(listing.applyUrl)}`);
  }

  return {
    company,
    title,
    applyUrl,
    location: typeof listing.location === "string" ? listing.location : null,
    atsProvider: listing.atsProvider ?? "greenhouse",
    requiresCoverLetter: listing.requiresCoverLetter === true,
    jobDescription: typeof listing.jobDescription === "string" ? listing.jobDescription : null,
  };
}

/**
 * ACT-015 — the candidate's answers off the wire, shaped and bounded.
 *
 * An event can be hand-written, so this is checked rather than trusted, on the
 * same reasoning as `normalizeListing` above. Bounded rather than validated:
 * whether a key names a real field and whether a value is a real option are
 * questions only the live form can answer, and ACT-007 asks them there. What
 * this rules out is the shapes that are not answers at all — non-strings,
 * blanks, and a payload large enough to be something other than a few replies.
 */
function normalizeAdditionalAnswers(raw: unknown): Record<string, string> | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "string") continue;
    const trimmedKey = key.trim().slice(0, 200);
    const trimmedValue = value.trim().slice(0, 2_000);
    if (trimmedKey === "" || trimmedValue === "") continue;
    out[trimmedKey] = trimmedValue;
    if (Object.keys(out).length >= 40) break;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/**
 * Failures that a retry cannot fix, re-thrown so Inngest stops instead of
 * launching three more browsers to be told the same thing.
 *
 * All three mean "a human has to look at this", and all three are raised *before
 * anything irreversible happens*: `FormFillBlockedError` and
 * `InjectionSuspectedError` come from ACT-007, which never submits anything at
 * all, and `SubmissionBlockedError` comes from ACT-008's pre-flight, which runs
 * before a browser is opened. The row already carries the reason.
 *
 * Everything else propagates unchanged and stays retryable — which is safe for
 * the reason ACT-008 documents at the top of `submitApplication`: a rejected
 * promise from it *always* means nothing was clicked. A submission whose outcome
 * is unknown does not throw; it returns `submission_unconfirmed`.
 */
function rethrowTerminal(err: unknown): never {
  if (
    err instanceof SubmissionBlockedError ||
    err instanceof FormFillBlockedError ||
    err instanceof InjectionSuspectedError
  ) {
    throw new NonRetriableError(`${err.name}: ${err.message}`, { cause: err });
  }
  throw err;
}

// ───────────────────────────────────
// 1. Discovery — one search, then fan out
// ───────────────────────────────────

export const discoverListings = inngest.createFunction(
  { id: "discover-listings", triggers: [{ event: jobSearchRequested }] },
  async ({ event, step }) => {
    const candidateId = requireCandidateId(event.data.candidateId);
    const requested = event.data.preferences ?? { companies: [] };

    // Also the existence check. A `candidateId` that is a well-formed UUID but
    // not a real row would otherwise survive discovery and fail N times over in
    // N fanned-out runs.
    //
    // Only the three search-preference columns come back out of the step. The
    // rest of the row — the email, the LinkedIn URL — is not needed here, and a
    // step's return value is durable state that outlives the run: there is no
    // reason for a candidate's contact details to exist in two systems when one
    // of them was not asked to hold them.
    const stored = await step.run("load-candidate", async () => {
      const candidate = await loadCandidate(candidateId);
      return {
        targetTitle: candidate.targetTitle,
        payMin: candidate.payMin,
        locations: candidate.locations,
      };
    });

    // `||` rather than `??` on purpose: an empty string or an empty array in the
    // event means "I did not specify this", and should fall through to the
    // candidate's own stored preferences rather than override them with nothing.
    const preferences: JobSearchPreferences = {
      companies: requested.companies ?? [],
      title: requested.title?.trim() || stored.targetTitle || undefined,
      payMin: requested.payMin ?? stored.payMin ?? undefined,
      locations: requested.locations?.length ? requested.locations : stored.locations ?? undefined,
      ...(requested.maxPerCompany === undefined
        ? {}
        : { maxPerCompany: requested.maxPerCompany }),
    };

    const listings = await step.run("bulk-search-job-boards", () =>
      searchJobListings(preferences)
    );

    // One run per apply URL. ACT-005's `claimApplicationRow` reuses the row for
    // a (candidate, apply_url) pair — which is what makes its own retries safe —
    // but `(candidate_id, apply_url)` has no unique index, so two *concurrent*
    // runs on the same URL would both insert and the tracker would show one
    // listing twice. A duplicate in the actor's output is cheap to drop here and
    // expensive to untangle there.
    const seen = new Set<string>();
    const dispatch = listings.filter((listing) => {
      const key = listing.applyUrl;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    if (dispatch.length === 0) {
      console.warn(
        `[act-009] no listings matched for candidate ${candidateId} ` +
          `(boards: ${JSON.stringify(preferences.companies)}, ` +
          `title: ${JSON.stringify(preferences.title ?? "(any)")}) — nothing to fan out`
      );
      return { candidateId, discovered: listings.length, dispatched: 0 };
    }

    console.log(
      `[act-009] ${dispatch.length} listing(s) for candidate ${candidateId} → ` +
        `${dispatch.length} concurrent apply-to-job run(s), 5 at a time`
    );

    // The fan-out. One event per listing; Inngest starts one run of `applyToJob`
    // per event and its `concurrency.limit` does the batching.
    await step.sendEvent(
      "fan-out-applications",
      dispatch.map((listing) => ({
        name: JOB_APPLICATION_REQUESTED,
        data: { candidateId, listing } satisfies JobApplicationRequestedData,
      }))
    );

    return {
      candidateId,
      discovered: listings.length,
      dispatched: dispatch.length,
      companies: preferences.companies,
    };
  }
);

// ───────────────────────────────────
// 2. Apply — one listing, one run
// ───────────────────────────────────

/**
 * The part of `CreateBoardAccountResult` the `create-account` step keeps. What
 * it drops is `signals` — every clickable label the page reader saw, which is
 * useful in a log and pure weight in durable step state.
 */
type AccountOutcome = {
  jobApplicationId: string;
  status: ApplicationStatus;
  accountGate: boolean;
  accountCreated: boolean;
  finalUrl: string;
  reasons: string[];
};

export const applyToJob = inngest.createFunction(
  {
    id: "apply-to-job",
    triggers: [{ event: jobApplicationRequested }],
    // Five listings in flight = five Chrome processes on this machine. The limit
    // is the reason `createBoardAccount` closes its browser on every exit path.
    concurrency: { limit: 5 },
    // Below Inngest's default of 4, because a retry here is not free: each one
    // relaunches a browser against a real employer's site. Two is enough for the
    // failures retrying actually fixes (a flaky navigation, a Supabase blip) and
    // stops well short of hammering a board that is simply refusing us.
    retries: 2,
  },
  async ({ event, step }) => {
    const candidateId = requireCandidateId(event.data.candidateId);
    const listing = normalizeListing(event.data.listing);
    // ACT-015. Passed through untouched: these are the candidate's own words,
    // and every check that matters — does this key name a field on the form, is
    // this value one of that control's options — can only be made against the
    // live page, which is ACT-007's job and not this file's.
    const additionalAnswers = normalizeAdditionalAnswers(event.data.additionalAnswers);
    // What the run *reports*, as opposed to what it works from. The full listing
    // carries up to 8KB of job-description text, and echoing that back into
    // every run's output would triple the size of the run list for no reader's
    // benefit — the description is already in the event that started the run.
    const summary = {
      company: listing.company,
      title: listing.title,
      applyUrl: listing.applyUrl,
    };

    // The email, and only the email — see `discoverListings`'s note on keeping a
    // candidate's details out of durable step state. `createBoardAccount` needs
    // it explicitly; every module after that one reads what it needs off the
    // `job_applications` row instead.
    const { applicationEmail } = await step.run("load-candidate", async () => ({
      applicationEmail: (await loadCandidate(candidateId)).applicationEmail,
    }));

    // ── ACT-005/ACT-012: is there even an account gate? ──────────────────────
    // Safe to retry: `claimApplicationRow` reuses the row for this (candidate,
    // apply URL) instead of inserting a second one, and every failure past the
    // signup click returns `account_gate_blocked` rather than throwing, so a
    // retry can never re-submit a signup.
    const account: AccountOutcome = await step.run("create-account", async () => {
      const result = await createBoardAccount({
        candidateId,
        company: listing.company,
        jobTitle: listing.title,
        applyUrl: listing.applyUrl,
        applicationEmail,
        atsProvider: listing.atsProvider,
      });
      // Trimmed deliberately. The full result carries `signals`, which includes
      // every clickable label on the page — useful in a log, pure weight in
      // durable step state that Inngest stores and replays on every subsequent
      // step of this run.
      return {
        jobApplicationId: result.jobApplicationId,
        status: result.status,
        accountGate: result.accountGate,
        accountCreated: result.accountCreated,
        finalUrl: result.finalUrl,
        reasons: result.reasons,
      };
    });

    const jobApplicationId = account.jobApplicationId;

    if (account.status === APPLICATION_STATUS.ACCOUNT_GATE_BLOCKED) {
      // A captcha, an SSO-only signup, a signup form sharing a page with the
      // application form. ACT-005 has already written the status and the reason
      // to the row; there is nothing for this run to add and nothing safe for it
      // to do next.
      console.warn(
        `[act-009] ${listing.company} — ${account.status}: ${account.reasons.at(-1) ?? ""}`
      );
      return { jobApplicationId, status: account.status, listing: summary, needsHuman: true };
    }

    // ── Correction 3: the wait is entered only when a signup really happened ──
    let verification: VerificationInput | undefined;

    if (account.status === APPLICATION_STATUS.AWAITING_VERIFICATION) {
      const received = await step.waitForEvent("await-verification", {
        event: verificationReceived,
        timeout: VERIFICATION_TIMEOUT,
        if: verificationMatch(candidateId, listing.company),
      });

      if (!received) {
        // The row stays at `awaiting_verification`, and that is the truthful
        // status: no mail arrived, and one still might. Nothing is written here
        // — see this file's header on why the pipeline is not a second writer to
        // `job_applications`. Re-running this listing once the mail lands is a
        // supported path (ACT-007 accepts `awaiting_verification` and takes the
        // code/link as input); a stray `verification_timeout` in the status
        // column would take that path away.
        console.warn(
          `[act-009] no ${VERIFICATION_EVENT_NAME} for ${listing.company} within ` +
            `${VERIFICATION_TIMEOUT} (job_applications ${jobApplicationId}, candidate ` +
            `${candidateId}). Row left at ${APPLICATION_STATUS.AWAITING_VERIFICATION}. Check ` +
            `that the ACT-006 listener is running and that its Gmail credentials are fresh.`
        );
        return {
          jobApplicationId,
          status: "verification_timeout" as const,
          listing: summary,
          needsHuman: true,
        };
      }

      // ACT-006 only *detects* the mail. Completing the verification — opening
      // the link, or typing the code — is ACT-007's job, and this is how it gets
      // handed the single-use credential to do it with.
      verification = {
        code: received.data.verificationCode,
        link: received.data.verificationLink,
      };
      console.log(
        `[act-009] verification received for ${listing.company} ` +
          `(${verification.code ? "code" : "no code"}, ${verification.link ? "link" : "no link"})`
      );
    } else if (account.status !== APPLICATION_STATUS.NO_ACCOUNT_REQUIRED) {
      // `no_account_required` and a verified `awaiting_verification` are equally
      // ready to fill — ACT-012's own words, and ACT-007's `READY_STATUSES`
      // agrees. Any *other* status out of `createBoardAccount` is a state this
      // wiring has not been reasoned about, and guessing on a real employer's
      // site is the one thing every module here refuses to do.
      throw new NonRetriableError(
        `createBoardAccount returned an unexpected status "${account.status}" for ` +
          `${listing.company} (job_applications ${jobApplicationId}). Refusing to fill or ` +
          `submit anything from a state this pipeline does not recognise.`
      );
    }

    // ── ACT-008, which calls ACT-007 inside it. ONE step, one browser ────────
    // See correction 2 in the header: `submitApplication` fills the form via
    // `fillApplicationFormRetainingSession` and submits in that same session.
    // Splitting this in two would fill a form in a browser that is then closed.
    const submission = await step.run("fill-and-submit-application", async () => {
      try {
        const result = await submitApplication({
          jobApplicationId,
          requiresCoverLetter: listing.requiresCoverLetter,
          jobDescription: listing.jobDescription,
          ...(verification === undefined ? {} : { verification }),
          ...(additionalAnswers === undefined ? {} : { additionalAnswers }),
        });
        // Trimmed for the same reason as `create-account`: the full result nests
        // ACT-007's entire field-by-field report and the parsed resume profile —
        // a candidate's real personal data, which has no business being copied
        // into durable step state that outlives the run.
        return {
          status: result.status,
          submitted: result.submitted,
          submitAttempted: result.submitAttempted,
          confirmationRef: result.confirmationRef,
          submitControlLabel: result.submitControlLabel,
          blockedReason: result.blockedReason,
          unconfirmedReason: result.unconfirmedReason,
          screenshotPath: result.screenshotPath,
          rowUpdated: result.rowUpdated,
          finalUrl: result.finalUrl,
        };
      } catch (err) {
        rethrowTerminal(err);
      }
    });

    if (submission.status === APPLICATION_STATUS.SUBMISSION_UNCONFIRMED) {
      // The loudest thing this pipeline can say. ACT-008 has already recorded it
      // and refused to retry; this makes it visible in the run list too.
      console.error(
        `[act-009] ══ ${listing.company} / ${listing.title}: SUBMIT CLICKED, OUTCOME ` +
          `UNKNOWN ══\n[act-009] job_applications ${jobApplicationId} — do NOT re-run this ` +
          `listing until a human has checked the employer's side. ` +
          `${submission.unconfirmedReason ?? ""}`
      );
    } else {
      console.log(
        `[act-009] ${listing.company} / ${listing.title} → ${submission.status}` +
          (submission.confirmationRef === null ? "" : ` (${submission.confirmationRef})`)
      );
    }

    return {
      jobApplicationId,
      status: submission.status,
      submitted: submission.submitted,
      confirmationRef: submission.confirmationRef,
      accountGate: account.accountGate,
      verificationRequired: account.status === APPLICATION_STATUS.AWAITING_VERIFICATION,
      listing: summary,
      needsHuman:
        submission.status !== APPLICATION_STATUS.SUBMITTED || submission.rowUpdated === false,
    };
  }
);

/** Everything `inngest/serve.ts` registers. */
export const functions = [discoverListings, applyToJob];
