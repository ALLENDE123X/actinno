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
