/**
 * ACT-003 — candidate intake: resume upload + `candidates` row.
 *
 * Targets the **actinno** Supabase project (`oihpglvvzzmjigxrlmfz`) — see
 * `.env.example`. The `meminno` project (`hlaeqvuyapkvixwaqxcs`) is a separate
 * live product on the same account; `assertActinnoProject()` below exists
 * specifically to make pointing this code at it a hard failure rather than a
 * silent write. The README's "meminno project" line is stale.
 *
 * Storage layout: bucket `resumes` (private), object key `{candidateId}.pdf`.
 * `candidates.resume_url` stores the bucket-qualified path
 * `resumes/{candidateId}.pdf` — NOT a fetchable URL. The bucket is private, so
 * downstream consumers must mint a signed URL from `bucket` + `objectPath`
 * (both returned here) rather than using `resume_url` directly.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

export const RESUMES_BUCKET = "resumes";

/**
 * Project ref this module is allowed to write to. If the actinno project ever
 * moves, change this one constant together with `SUPABASE_URL`.
 */
const EXPECTED_PROJECT_REF = "oihpglvvzzmjigxrlmfz";

/** Storage's own default cap is 50MB; fail early with a readable message. */
const MAX_RESUME_BYTES = 25 * 1024 * 1024;

const PDF_MAGIC = "%PDF-";

export type CandidateIntakeInput = {
  /** Path to a PDF resume on the local filesystem. */
  resumeFilePath: string;
  applicationEmail: string;
  linkedinUrl?: string;
  targetTitle?: string;
  /** Whole dollars per year. Column is `integer`. */
  payMin?: number;
  locations?: string[];
};

export type CandidateIntakeResult = {
  candidateId: string;
  /** Value written to `candidates.resume_url`: `resumes/{candidateId}.pdf`. */
  resumeUrl: string;
  /** Storage bucket name — use with `objectPath` to sign a URL. */
  bucket: string;
  /** Object key within the bucket: `{candidateId}.pdf`. */
  objectPath: string;
};

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

  // Service-role, server-side only: no session to persist and nothing to
  // refresh. Leaving the defaults on keeps a refresh timer alive and prevents
  // short-lived processes (the CLI) from exiting cleanly.
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function normalizeOptionalText(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function validateInput(input: CandidateIntakeInput): void {
  if (!input.resumeFilePath?.trim()) {
    throw new Error("resumeFilePath is required");
  }

  // `application_email` is NOT NULL and the whole downstream pipeline keys off
  // it, so reject obvious garbage rather than persisting it.
  const email = input.applicationEmail?.trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error(
      `applicationEmail must be a valid email address (got: ${JSON.stringify(
        input.applicationEmail
      )})`
    );
  }

  // `pay_min` is int4: catch out-of-range here so we never upload a resume
  // only to have Postgres reject the row and force a rollback.
  const INT4_MAX = 2147483647;
  if (input.payMin !== undefined) {
    if (!Number.isInteger(input.payMin) || input.payMin < 0 || input.payMin > INT4_MAX) {
      throw new Error(
        `payMin must be an integer between 0 and ${INT4_MAX} (column is int4), got: ${input.payMin}`
      );
    }
  }

  if (input.linkedinUrl?.trim()) {
    try {
      new URL(input.linkedinUrl.trim());
    } catch {
      throw new Error(`linkedinUrl must be a valid URL, got: ${input.linkedinUrl}`);
    }
  }
}

async function readResumePdf(path: string): Promise<Buffer> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not read resume file at "${path}": ${reason}`);
  }

  if (bytes.byteLength === 0) {
    throw new Error(`Resume file is empty: ${path}`);
  }
  if (bytes.byteLength > MAX_RESUME_BYTES) {
    throw new Error(
      `Resume file is ${bytes.byteLength} bytes, over the ${MAX_RESUME_BYTES}-byte limit: ${path}`
    );
  }
  // The object key and content-type are hardcoded to PDF, so a non-PDF would be
  // stored mislabelled and silently break downstream form-fill.
  if (bytes.subarray(0, PDF_MAGIC.length).toString("latin1") !== PDF_MAGIC) {
    throw new Error(
      `Resume file does not look like a PDF (missing "${PDF_MAGIC}" header): ${path}`
    );
  }
  return bytes;
}

/**
 * Uploads a resume to the private `resumes` bucket and inserts the matching
 * `candidates` row. On insert failure the uploaded object is removed so a
 * failed intake does not leave an orphan behind.
 *
 * Throws on any failure. Error messages are safe to log — they never include
 * credentials.
 */
export async function intakeCandidate(
  input: CandidateIntakeInput
): Promise<CandidateIntakeResult> {
  validateInput(input);

  const supabase = getSupabaseClient();
  const candidateId = randomUUID();
  const objectPath = `${candidateId}.pdf`;
  const resumeUrl = `${RESUMES_BUCKET}/${objectPath}`;
  const resumeBytes = await readResumePdf(input.resumeFilePath);

  const { error: uploadError } = await supabase.storage
    .from(RESUMES_BUCKET)
    .upload(objectPath, resumeBytes, {
      contentType: "application/pdf",
      upsert: false,
    });
  if (uploadError) {
    throw new Error(`Resume upload to "${resumeUrl}" failed: ${uploadError.message}`);
  }

  const locations = input.locations
    ?.map((l) => l.trim())
    .filter((l) => l.length > 0);

  try {
    const { data, error: insertError } = await supabase
      .from("candidates")
      .insert({
        id: candidateId,
        resume_url: resumeUrl,
        linkedin_url: normalizeOptionalText(input.linkedinUrl),
        application_email: input.applicationEmail.trim(),
        target_title: normalizeOptionalText(input.targetTitle),
        pay_min: input.payMin ?? null,
        locations: locations && locations.length > 0 ? locations : null,
      })
      // Round-trips the id so a silently-filtered insert (e.g. RLS) surfaces
      // as an error instead of a false success.
      .select("id")
      .single();

    if (insertError) {
      throw new Error(`Candidate row insert failed: ${insertError.message}`);
    }
    if (data?.id !== candidateId) {
      throw new Error(
        `Candidate row insert did not return the expected id (got: ${data?.id ?? "none"})`
      );
    }
  } catch (err) {
    await cleanupOrphanedResume(supabase, objectPath, err);
    throw err;
  }

  return { candidateId, resumeUrl, bucket: RESUMES_BUCKET, objectPath };
}

/**
 * Everything the pipeline needs to know about a candidate, read back out of the
 * row this module wrote.
 *
 * Added for ACT-009. Its `job-search/requested` and `job-application/requested`
 * events carry a `candidateId` and nothing else about the person — see that
 * file's header for why — so something has to turn that id into an
 * `application_email` for `createBoardAccount`, and this module owns the
 * `candidates` table's conventions (the project guard, the private-bucket
 * caveat on `resume_url`). Putting the read anywhere else would mean a sixth
 * copy of `assertActinnoProject`.
 *
 * `resumeUrl` is repeated here with the same caveat it carries on the way in:
 * it is the bucket-qualified path `resumes/{candidateId}.pdf`, not something
 * that can be fetched. Nothing in the pipeline uses it — ACT-007's
 * `loadResume` reads the object itself with the service-role client — and it is
 * returned only so a caller cannot mistake its absence for the file not
 * existing.
 */
export type CandidateRecord = {
  candidateId: string;
  applicationEmail: string;
  linkedinUrl: string | null;
  /** Bucket-qualified path, NOT a fetchable URL. */
  resumeUrl: string;
  targetTitle: string | null;
  payMin: number | null;
  locations: string[] | null;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reads one `candidates` row by id.
 *
 * The UUID check is not defensive clutter. `candidates.id` is the only
 * per-person key this schema has, `job_applications.candidate_id` is a foreign
 * key onto it, and ACT-006 emits it as `email/verification-received.data.userId`
 * for the pipeline's `waitForEvent` to match on. Anything else passed in here —
 * an auth subject, an email address — would be *accepted by Postgres as a
 * malformed-uuid error* deep inside a query, or worse, silently match nothing;
 * failing on the shape first is what turns that into one legible sentence.
 */
export async function loadCandidate(candidateId: string): Promise<CandidateRecord> {
  const id = String(candidateId ?? "").trim();
  if (!UUID_RE.test(id)) {
    throw new Error(
      `candidateId must be a candidates.id UUID, got ${JSON.stringify(candidateId)}. ` +
        `This is the same identity as job_applications.candidate_id and as the userId ` +
        `ACT-006 puts on email/verification-received — an email address or an auth ` +
        `subject here will make the pipeline's verification wait time out with no ` +
        `visible cause.`
    );
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("candidates")
    .select("id,resume_url,linkedin_url,application_email,target_title,pay_min,locations")
    .eq("id", id)
    .limit(1);
  if (error) throw new Error(`candidates lookup failed: ${error.message}`);

  const row = data?.[0];
  if (!row) throw new Error(`No candidates row with id ${id} — run ACT-003 intake first.`);

  const applicationEmail = String(row.application_email ?? "").trim();
  if (applicationEmail === "") {
    throw new Error(`candidates ${id} has no application_email.`);
  }

  return {
    candidateId: id,
    applicationEmail,
    linkedinUrl: typeof row.linkedin_url === "string" ? row.linkedin_url : null,
    resumeUrl: String(row.resume_url ?? ""),
    targetTitle: typeof row.target_title === "string" ? row.target_title : null,
    payMin: typeof row.pay_min === "number" ? row.pay_min : null,
    locations: Array.isArray(row.locations) ? row.locations.map(String) : null,
  };
}

/**
 * Best-effort removal of an uploaded object after a failed insert. Never
 * throws: a cleanup failure must not mask the original error, so it is
 * annotated onto that error's message instead.
 */
async function cleanupOrphanedResume(
  supabase: SupabaseClient,
  objectPath: string,
  originalError: unknown
): Promise<void> {
  let cleanupFailure: string | undefined;
  try {
    const { error } = await supabase.storage.from(RESUMES_BUCKET).remove([objectPath]);
    if (error) cleanupFailure = error.message;
  } catch (err) {
    cleanupFailure = err instanceof Error ? err.message : String(err);
  }

  if (cleanupFailure && originalError instanceof Error) {
    originalError.message +=
      ` (WARNING: also failed to clean up the uploaded object ` +
      `"${RESUMES_BUCKET}/${objectPath}" — it is now orphaned: ${cleanupFailure})`;
  }
}
