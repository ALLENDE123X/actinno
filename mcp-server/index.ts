#!/usr/bin/env node
/**
 * Actinno — local MCP server
 *
 * Mirrors Apify's own tool shape on purpose: search_actors finds the right
 * pre-built workflow for a stated goal, call_actor runs it. Two top-level
 * tools total, not one tool per actor — this is what keeps tool-bloat down
 * as the actor registry grows (the same problem the Reddit "MCP setups
 * don't scale past 100 tools" research flagged earlier).
 *
 * Runs over stdio for now — add directly to Claude Desktop's config,
 * no hosting, no marketplace submission, nothing remote yet.
 *
 * ── ACT-010: one of these two actors blocks, the other does not ─────────────
 * `bulk-search-job-listings` is a single read-only API call and returns its
 * result inline. `apply-to-job` is a browser chain that can run for minutes
 * (account → email verification wait → fill → submit), so it does **not** run
 * here at all: it sends `job-application/requested` to Inngest and returns a
 * tracking id immediately. The work happens in `inngest/job-application-
 * pipeline.ts`, durably, at five listings in flight; this process only posts
 * the event and gets out of the way.
 *
 * ── ACT-013: the third actor, and why a UUID stopped being an input ─────────
 * `intake-candidate` closes the hole ACT-011's demo prep walked into. ACT-003's
 * `intakeCandidate()` was reachable only through `lib/intake-cli.ts`, so a
 * person talking to Claude Desktop could not onboard at all, and `apply-to-job`
 * demanded the `candidates.id` UUID that only intake mints — a value nobody has
 * before their first terminal session. Both halves are fixed here: intake is an
 * actor, and `apply-to-job` accepts the application email as an alternative
 * identifier, resolving it to the row's id *in this layer*. The
 * `job-application/requested` event still carries `candidateId` and nothing
 * else; that contract is ACT-009's and is deliberately untouched.
 *
 * ── ACT-014: the resume stops being a file path the user has to produce ─────
 * ACT-013 made onboarding *possible* from Claude Desktop and left it starting
 * with a terminal: copy the PDF into `~/.actinno-mcp/resumes/`, then quote a
 * path. `create-resume-upload` replaces that with the thing people actually do
 * — attach the PDF to the conversation — by handing the model a presigned
 * Supabase upload URL and letting its own execution environment PUT the bytes
 * straight there, around the context window and around this process. See the
 * ACT-014 block further down for the mechanics, the security consequence of a
 * URL that anyone holding it can write to, and the one leg of it that is not
 * guaranteed to exist. `resumeFilePath` is untouched and remains the fallback.
 */

// FIRST, and it has to stay first: the Inngest client below reads `INNGEST_DEV`
// at construction time. See `load-env.ts`.
import "./load-env.js";

import { constants as FS_CONSTANTS } from "node:fs";
import { access, mkdir, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Inngest } from "inngest";

// ACT-009 moved this out of the file. The Inngest `discoverListings` function
// needs the same call, and the ticket is explicit that it should be shared
// rather than copied — see `lib/search-job-listings.ts`, which also documents
// why the input this used to send returned HTTP 400.
import {
  searchJobListings,
  type JobListing,
  type JobSearchPreferences,
} from "../lib/search-job-listings.js";

/**
 * The event contract, imported as **types only**.
 *
 * `inngest/job-application-pipeline.ts` is the authority on what
 * `job-application/requested` carries, and a copy of that shape here would rot
 * silently. But importing it for real costs ~2.5s of startup — it pulls in
 * Stagehand, googleapis and Supabase, none of which this process needs to answer
 * a handshake — and Claude Desktop is waiting on that handshake for every
 * millisecond of it. (ACT-013 does eventually reach Supabase, and reaches it
 * through the lazy import below rather than through this one.)
 *
 * `import type` and `typeof import(...)` are erased entirely at build time, so
 * this gets the compile-time coupling with none of the runtime weight: rename
 * the event or change a field over there and *this file stops compiling*, while
 * the running server still only ever loads `inngest`'s client.
 */
import type { JobApplicationRequestedData } from "../inngest/job-application-pipeline.js";

/**
 * ACT-015's answer shape, as a **type only** — same trick and same reasoning as
 * the event type above: real compile-time coupling to `lib/candidate-intake.ts`,
 * erased entirely at build time, so the handshake still pays nothing for it.
 */
import type { CandidateApplicationAnswers } from "../lib/candidate-intake.js";

/**
 * ACT-003's intake, loaded **on first use** rather than at startup.
 *
 * Same budget as the note above, applied to a smaller number: importing
 * `lib/candidate-intake.ts` pulls in `@supabase/supabase-js`, measured at 278ms
 * on this machine. That is nothing next to Stagehand, and it is still 278ms
 * added to every Claude Desktop handshake — including the great majority of
 * sessions that never touch Supabase at all, because `search_actors` and
 * `bulk-search-job-listings` don't. A dynamic `import()` moves the cost onto the
 * first `intake-candidate` or email-resolved `apply-to-job` call, where it is
 * invisible next to a resume upload or an Inngest round trip.
 *
 * The promise, not the module, is memoised: two `apply-to-job` calls arriving in
 * the same batch then share one evaluation instead of racing to start two.
 * esbuild keeps the laziness when it inlines the module into the bundle — the
 * `import()` becomes `Promise.resolve().then(() => (init_candidate_intake(),
 * …))`, an initialiser that runs on first access — so this survives `npm run
 * bundle`, which is the build that actually ships. Measured on the bundles
 * either side of this change: ~965ms from spawn to the `initialize` response,
 * unchanged, on a file that grew 1.3mb → 2.1mb.
 */
type CandidateIntakeModule = typeof import("../lib/candidate-intake.js");

let candidateIntakeModule: Promise<CandidateIntakeModule> | undefined;

function loadCandidateIntake(): Promise<CandidateIntakeModule> {
  candidateIntakeModule ??= import("../lib/candidate-intake.js");
  return candidateIntakeModule;
}

type PipelineEventName =
  typeof import("../inngest/job-application-pipeline.js").JOB_APPLICATION_REQUESTED;

/** Byte-identical to the pipeline's own constant, and checked to be. */
const JOB_APPLICATION_REQUESTED: PipelineEventName = "job-application/requested";

/**
 * Same app id as `inngest/job-application-pipeline.ts` and `inngest/trigger-
 * cli.ts`. The dev server correlates registered functions and inbound events by
 * app; a different id here means events that arrive, sit in the stream, and
 * trigger nothing.
 */
const inngest = new Inngest({ id: "actinno-job-agent" });

// ───────────────────────────────────
// Actor registry — the "marketplace" surface.
// Hardcoded for now; later this could be a real registry (DB / remote fetch)
// exactly like Apify's Store, just consumer-facing instead of dev-facing.
// ───────────────────────────────────
const ACTORS = [
  {
    name: "actinno/create-resume-upload",
    title: "Create Resume Upload URL (do this FIRST when a resume PDF is attached)",
    description:
      "STEP 0 of Actinno, and the way onboarding is supposed to start: it returns a short-lived presigned URL that YOU then PUT the attached resume PDF's raw bytes to, straight from your own execution environment (analysis tool, sandbox, VM — wherever you can read the attached file and make an HTTPS request). No credentials are involved and none are returned. Call this the moment a person attaches their resume and wants to onboard — do NOT ask them for a filesystem path, and do NOT ask them to copy anything in a terminal first. It takes no required input. Its `instructions` field tells you exactly how to send the bytes; follow it literally, then call actinno/intake-candidate with the `assetHandle` it returned. If your environment turns out to have no network access, the actor's response says what to fall back to.",
    inputSchema: {
      type: "object",
      properties: {
        fileName: {
          type: "string",
          description:
            "The attached PDF's filename, e.g. 'jane-doe-resume.pdf'. Optional and cosmetic — it is echoed back into the upload instructions so the code snippet reads the right file, and it never becomes part of the stored object's name.",
        },
      },
      required: [],
    },
  },
  {
    name: "actinno/check-resume-upload",
    title: "Check Resume Upload Arrived",
    description:
      "Answers one question about an assetHandle from actinno/create-resume-upload: did the bytes actually arrive at Supabase, and how many? Read-only, cheap (it never downloads the file), and safe to call as often as you like. Use it right after you PUT the resume if you are at all unsure the request went through — the upload leg runs in YOUR execution environment, which may have no network egress, and this is the way to find that out before committing to an intake. It does NOT validate that the bytes are a real PDF; actinno/intake-candidate does that when it reads them.",
    inputSchema: {
      type: "object",
      properties: {
        assetHandle: {
          type: "string",
          description:
            "The `actinno-upload-…` handle returned by actinno/create-resume-upload. Not a candidateId, and not a filename.",
        },
      },
      required: ["assetHandle"],
    },
  },
  {
    name: "actinno/intake-candidate",
    title: "Candidate Intake (run this ONCE, before anything else)",
    description:
      "Onboards a person: stores their resume PDF and the email address applications will be filed under, plus optional LinkedIn URL and job preferences. Returns a candidateId. This is STEP 1 of Actinno and it is a one-time setup — the resume and LinkedIn are read from the stored row on every later application, so the user is never asked for them again. Run it once per person, not once per job. The resume reaches it one of two ways and you must supply exactly one: `assetHandle`, from actinno/create-resume-upload, which is the normal route when the user has attached the PDF to this conversation; or `resumeFilePath`, a path on a filesystem this server can read, which is the fallback when the upload route is unavailable. If the user has already been through intake, do NOT run it again (a second run creates a second candidate for the same email and makes that email ambiguous) — just apply, passing the applicationEmail they used. It also stores the answers every application form asks for — work authorization, visa sponsorship, current country and city, willingness to relocate — so that no individual application has to stop and ask. Ask the person for those during onboarding; if they do not answer one, leave the field out rather than guessing, because an omitted answer is recorded as 'not stated' and an application that needs it will come back and ask, while a guessed one is a false statement to an employer. Order of operations: create-resume-upload + intake-candidate (once) -> bulk-search-job-listings (once) -> apply-to-job (once per listing).",
    inputSchema: {
      type: "object",
      properties: {
        assetHandle: {
          type: "string",
          description:
            "The `actinno-upload-…` handle from actinno/create-resume-upload, naming a resume PDF you have ALREADY uploaded to that actor's presigned URL. This is the preferred route: it needs no filesystem access and no terminal step from the user. Only pass it after the PUT returned HTTP 200 (or actinno/check-resume-upload reported arrived: true) — if nothing was uploaded, this call fails and says so rather than creating a resume-less candidate. Pass this OR resumeFilePath, never both.",
        },
        resumeFilePath: {
          type: "string",
          description:
            "Absolute path to the candidate's resume as a PDF — the FALLBACK route, for when the upload above is not possible. IMPORTANT: this server runs inside a macOS sandbox that is separate from the Claude app's own file access, and it CANNOT read ~/Desktop, ~/Documents, ~/Downloads or iCloud Drive no matter what permissions the app itself has. The reliable drop spot is ~/.actinno-mcp/resumes/ (created automatically) — copy the PDF there first, e.g. `cp ~/Desktop/resume.pdf ~/.actinno-mcp/resumes/`, and pass ~/.actinno-mcp/resumes/resume.pdf. A bare filename is resolved against that directory. If a path elsewhere happens to be readable it is used as given. Pass this OR assetHandle, never both.",
        },
        applicationEmail: {
          type: "string",
          description:
            "The email address applications are filed under. It is also the address the employer's confirmation mail arrives at, and the identifier the user can quote later instead of the candidateId, so it must be a real inbox they control.",
        },
        linkedinUrl: {
          type: "string",
          description: "The candidate's LinkedIn profile URL. Optional but usually asked for on application forms.",
        },
        targetTitle: {
          type: "string",
          description:
            "The kind of role wanted, e.g. 'entry-level software engineer'. Stored as the default title filter for later searches.",
        },
        payMin: {
          type: "number",
          description: "Minimum acceptable salary in whole dollars per year, e.g. 90000. Stored on the candidate; no job board this talks to exposes pay to filter on.",
        },
        locations: {
          type: "array",
          items: { type: "string" },
          description: "Preferred locations, e.g. ['Remote', 'New York']. Stored as the default location filter for later searches.",
        },
        workAuthorizedUs: {
          type: "boolean",
          description:
            "Is the candidate legally authorized to work in the United States? Almost every US application form asks this, and it is a legally meaningful statement made under the candidate's name — so it is stored once here and reused, and NOTHING will ever guess it. Only pass it if the candidate actually told you. Omit it entirely if they did not: omitted is recorded as 'not stated', and an application that hits the question will stop and ask them rather than assume.",
        },
        requiresSponsorship: {
          type: "boolean",
          description:
            "Will the candidate now or in the future require sponsorship for an employment visa? The companion question to workAuthorizedUs and just as commonly asked. Same rule: only if they told you, omit otherwise.",
        },
        currentCountry: {
          type: "string",
          description:
            "The country the candidate currently LIVES in, e.g. 'United States'. This is a fact about where they are, not a job-search preference — `locations` is the preference. Used to answer country dropdowns and 'are you currently located in X?' questions.",
        },
        currentCity: {
          type: "string",
          description:
            "The city or metro the candidate currently lives in, e.g. 'Atlanta'. Used to answer the 'Location (City)' field most ATS forms require.",
        },
        willingToRelocate: {
          type: "boolean",
          description:
            "Is the candidate willing to relocate for a role? Asked by most listings tied to an office. Only if they told you.",
        },
      },
      required: ["applicationEmail"],
      oneOf: [{ required: ["assetHandle"] }, { required: ["resumeFilePath"] }],
    },
  },
  {
    name: "actinno/bulk-search-job-listings",
    title: "Bulk Job Listings Search",
    description:
      "Lists open jobs from one or more named Greenhouse company boards, optionally narrowed by job title and location. Call this ONCE per job search — it returns every matched listing across every named company in a single pass. Do not call it per-listing, and do not call it per-company. This is STEP 2 of Actinno: the candidate must already have been through actinno/intake-candidate (step 1) before the listings this returns can be applied to with actinno/apply-to-job (step 3, once per listing). Searching does not require a candidate, so it is fine to run first and onboard after — but nothing can be applied to until intake has happened.",
    inputSchema: {
      type: "object",
      properties: {
        companies: {
          type: "array",
          items: { type: "string" },
          description:
            "Greenhouse board slugs to list jobs from, e.g. ['stripe', 'airbnb']. A pasted board URL works too. REQUIRED: this searches named company boards — it cannot discover companies from a job title alone.",
        },
        title: {
          type: "string",
          description:
            "Narrows the results to listings whose title or department contains every word of this, e.g. 'entry-level software engineer'. Omit to get every open job on the named boards.",
        },
        payMin: {
          type: "number",
          description:
            "Accepted and ignored — the underlying job board API returns no compensation data to filter on.",
        },
        locations: { type: "array", items: { type: "string" } },
        maxPerCompany: { type: "number" },
      },
      required: ["companies"],
    },
  },
  {
    name: "actinno/apply-to-job",
    title: "Apply To Job (end-to-end, runs in the background)",
    description:
      "Starts an end-to-end application to ONE job listing: creates an account on the job board, waits for and handles email verification, fills the application from the candidate's stored resume and LinkedIn, and submits. STEP 3 of Actinno — the candidate must have been through actinno/intake-candidate first, and is identified here by EITHER their applicationEmail OR their candidateId. ASYNCHRONOUS — it returns a trackingId in about a second and the application then runs in the background for several minutes. Call this once PER LISTING, all of them in parallel in a single batch, and do NOT wait for one to finish before starting the next. There is no polling tool and no completion callback: once you have a trackingId the job is running, so report the trackingIds and stop. The candidate is told they are done by the confirmation email the employer sends them, not by you.",
    inputSchema: {
      type: "object",
      properties: {
        applicationEmail: {
          type: "string",
          description:
            "The email address the candidate went through intake with. The usual way to identify them — a person knows their own email and does not know their candidateId. It is looked up in Actinno's candidate table and resolved to that row before anything starts, so it must match an existing intake exactly; if no candidate has that email the call fails and says to run actinno/intake-candidate first. Pass this OR candidateId, never both.",
        },
        candidateId: {
          type: "string",
          description:
            "The candidate's `candidates.id` UUID, as returned by actinno/intake-candidate. Use it when you have it — it is unambiguous, and it is the only way to pick a specific candidate when one email address has been through intake more than once. Everything personal comes from that row: resume, LinkedIn URL, and the email applications are filed under. Do NOT pass a resume, a LinkedIn URL or personal details as fields here; they are not accepted. Pass this OR applicationEmail, never both.",
        },
        listing: {
          type: "object",
          description:
            "ONE listing, exactly as it appeared in the `listings` array returned by actinno/bulk-search-job-listings. Pass the object through unchanged — do not re-type it, summarise it, or drop fields.",
          properties: {
            company: { type: "string", description: "Employer name." },
            title: { type: "string", description: "Job title." },
            applyUrl: {
              type: "string",
              description: "The listing's application page. Must be an https URL.",
            },
            location: { type: ["string", "null"], description: "Listed location, or null." },
            atsProvider: {
              type: "string",
              enum: ["greenhouse", "lever", "other"],
              description: "Applicant tracking system. Defaults to greenhouse if omitted.",
            },
            requiresCoverLetter: {
              type: "boolean",
              description:
                "True only when the board's form has a REQUIRED cover-letter field. When true, one is written and pasted in. Defaults to false.",
            },
            jobDescription: {
              type: ["string", "null"],
              description:
                "Plain-text job description, used to tailor the cover letter. Null if the search did not return one.",
            },
          },
          required: ["company", "title", "applyUrl"],
        },
        additionalAnswers: {
          type: "object",
          additionalProperties: { type: "string" },
          description:
            "The candidate's own answers to questions a PREVIOUS attempt at this listing could not answer truthfully, keyed by the `key` that attempt reported. Only ever used after actinno/check-application-status has come back with `needsInput` questions and you have put them to the candidate IN CHAT and they have answered. Never invent an entry here and never fill one in on the candidate's behalf: these are statements made to a real employer under their name, and a wrong one is a misrepresentation on a real job application. Leave the whole field out on a first attempt.",
        },
      },
      required: ["listing"],
      oneOf: [{ required: ["applicationEmail"] }, { required: ["candidateId"] }],
    },
  },
  {
    name: "actinno/check-application-status",
    title: "Check How An Application Went (and what it still needs from the candidate)",
    description:
      "Reads back what happened to the applications already started for one candidate: which submitted, which are still running, and — the reason this exists — which stopped because the employer's form asked something that could not be answered truthfully from what Actinno knows. apply-to-job runs in the background and cannot ask a question mid-run, so this is how its questions reach the person. Call it a few minutes after starting applications, or whenever the user asks how theirs are going. Read-only and cheap; it opens no browser and changes nothing. When a row comes back needing input, put its questions to the user IN CHAT, wait for their real answers, then call actinno/apply-to-job again for that same listing with `additionalAnswers` filled in from what they said — and with nothing in it that they did not say.",
    inputSchema: {
      type: "object",
      properties: {
        applicationEmail: {
          type: "string",
          description:
            "The email address the candidate went through intake with. Pass this OR candidateId, never both.",
        },
        candidateId: {
          type: "string",
          description:
            "The candidate's `candidates.id` UUID. Pass this OR applicationEmail, never both.",
        },
        applyUrl: {
          type: "string",
          description:
            "Optional. Narrows the answer to one listing's application page, when you only care about that one.",
        },
      },
      required: [],
      oneOf: [{ required: ["applicationEmail"] }, { required: ["candidateId"] }],
    },
  },
];

const server = new Server(
  { name: "actinno", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

// ───────────────────────────────────
// Two top-level tools only: search_actors, call_actor
// ───────────────────────────────────
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "search_actors",
      description:
        "Search Actinno's actor marketplace for a ready-made workflow that accomplishes a stated goal. Always search here first before assuming a task needs to be built from scratch — a pre-built actor may already exist for it.",
      inputSchema: {
        type: "object",
        properties: { keywords: { type: "string" } },
        required: ["keywords"],
      },
    },
    {
      name: "call_actor",
      description:
        "Run a specific Actinno actor by name, found via search_actors. For actors designed to run per-item (like apply-to-job), call this multiple times in parallel rather than sequentially — check the actor's own description for the recommended batch size.",
      inputSchema: {
        type: "object",
        properties: {
          actor: { type: "string" },
          input: { type: "object" },
        },
        required: ["actor", "input"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params as {
    name: string;
    arguments: Record<string, unknown>;
  };

  if (name === "search_actors") {
    const keywords = String(args?.keywords ?? "").toLowerCase();
    const terms = keywords.split(/\s+/).filter(Boolean);

    const matches = ACTORS.filter((a) => {
      const haystack = `${a.name} ${a.title} ${a.description}`.toLowerCase();
      return terms.length === 0 || terms.some((t) => haystack.includes(t));
    });

    const results = matches.length > 0 ? matches : ACTORS;

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            results.map(({ name, title, description, inputSchema }) => ({
              name,
              title,
              description,
              inputSchema,
            })),
            null,
            2
          ),
        },
      ],
    };
  }

  if (name === "call_actor") {
    const { actor, input } = args as { actor: string; input: Record<string, unknown> };

    switch (actor) {
      case "actinno/create-resume-upload": {
        const result = await createResumeUploadActor(input);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "actinno/check-resume-upload": {
        const result = await checkResumeUploadActor(input);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "actinno/intake-candidate": {
        const result = await intakeCandidateActor(input);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "actinno/bulk-search-job-listings": {
        const listings = await bulkSearchJobListings(input);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  listings,
                  note:
                    `Found ${listings.length} listing(s). To apply, call actinno/apply-to-job ` +
                    `once per listing, all of them in parallel in one batch — each call returns ` +
                    `a trackingId in about a second and the applications then run in the ` +
                    `background. Inngest paces them at five in flight, so there is no reason ` +
                    `to hold any back. Each of those calls identifies the candidate by their ` +
                    `applicationEmail (or candidateId). If this person has not been through ` +
                    `actinno/intake-candidate yet, run that once first — without it there is ` +
                    `no resume to apply with and every apply call will fail the same way.`,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "actinno/apply-to-job": {
        const result = await applyToJob(input);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "actinno/check-application-status": {
        const result = await checkApplicationStatus(input);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      default:
        throw new Error(`Unknown actor: ${actor}`);
    }
  }

  throw new Error(`Unknown tool: ${name}`);
});

// ───────────────────────────────────
// Actor implementations
// ───────────────────────────────────

// ── ACT-013: reading a resume from inside Claude Desktop's sandbox ──────────
//
// Claude Desktop spawns each MCP server inside a macOS Seatbelt sandbox that is
// **separate from the app's own Full Disk Access grant**, and that sandbox
// denies reads under `~/Desktop` — the discovery that forced this server to ship
// as a bundle at `~/.actinno-mcp/server.mjs` in the first place (see the
// README, and commit 8bbe64a). Intake is the first thing here that reads a file
// *at runtime*, so it walks straight back into it: `~/Desktop`, `~/Documents`,
// `~/Downloads` and iCloud Drive are all TCC-protected and all plausible homes
// for a resume, and a denial there arrives as EPERM/EACCES, which reads exactly
// like a chmod problem and is not one.
//
// `~/.actinno-mcp/` is the one directory *proven* readable from inside that
// sandbox: node loads the bundle itself out of it on every launch. So intake
// establishes `~/.actinno-mcp/resumes/` as the drop spot, creates it, resolves
// bare filenames against it, falls back to it by basename, and — when a path is
// genuinely unreadable — says which of the two failures happened and what to do
// about it. Naming the remedy matters more than usual here: the model relaying
// the error can run the `cp` itself, because the Claude app's own tools are not
// in this sandbox.
//
// **Why not accept the PDF as base64 instead, and skip the filesystem?**
// Considered and rejected. The bytes would have to reach this process through
// the model's own output: a 100-500KB resume is 140-700KB of base64, which is
// ~35-175k tokens the model must emit *verbatim, without a single character
// wrong*, for every intake. That is not a fallback, it is a coin flip with a
// dollar cost. Nor does the obvious source exist — a PDF attached to a Claude
// conversation arrives as extracted text, never as retrievable raw bytes. One
// `cp` into a directory that is known to work beats a transport that is
// expensive when it succeeds and silently corrupt when it doesn't.

/** Where the bundle lives, and the one path known to survive the sandbox. */
const ACTINNO_HOME = join(homedir(), ".actinno-mcp");

/** The documented drop spot for resumes. Created on demand. */
const RESUME_DROP_DIR = join(ACTINNO_HOME, "resumes");

/** `~` and `$HOME` are shell conveniences; nothing expands them for us here. */
function expandHome(rawPath: string): string {
  const path = rawPath.trim();
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  if (path.startsWith("$HOME/")) return join(homedir(), path.slice(6));
  return path;
}

/**
 * Best-effort `mkdir -p` on the drop spot, so the directory the error messages
 * and the input schema both point at actually exists to be dropped into.
 * Returns the failure rather than throwing it: a resume at a readable absolute
 * path elsewhere does not need this directory, and losing that intake over a
 * directory it never touches would be absurd.
 */
async function ensureResumeDropDir(): Promise<string | undefined> {
  try {
    await mkdir(RESUME_DROP_DIR, { recursive: true });
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function errnoOf(err: unknown): string | undefined {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Every path worth trying for one requested resume, in order.
 *
 * The second entry is the one that earns its keep: the user is told to copy the
 * file into the drop spot, does it, and then — or the model on their behalf —
 * quotes the original `~/Desktop/resume.pdf` anyway. Same basename, readable
 * location, and the result reports which file was actually used so the match is
 * never silent.
 */
function resumePathCandidates(rawPath: string): string[] {
  const expanded = expandHome(rawPath);
  const primary = isAbsolute(expanded) ? expanded : join(RESUME_DROP_DIR, expanded);
  const inDropDir = join(RESUME_DROP_DIR, basename(expanded));
  return primary === inDropDir ? [primary] : [primary, inDropDir];
}

/** PDFs already sitting in the drop spot, to make a "not found" error useful. */
async function listDropDir(): Promise<string[]> {
  try {
    const entries = await readdir(RESUME_DROP_DIR);
    return entries.filter((name) => name.toLowerCase().endsWith(".pdf")).slice(0, 10);
  } catch {
    return [];
  }
}

/**
 * Picks the first readable candidate path, or explains — in terms of the fix,
 * not the errno — why none of them are.
 *
 * The probe is `access(R_OK)` rather than letting `intakeCandidate()` do the
 * read and reporting whatever it throws, because the choice *between* paths has
 * to be made before the read: trying the fallback by catching an exception out
 * of intake would mean re-entering a function that also mints ids and builds
 * clients, to find out something `access` answers in a syscall.
 */
async function resolveResumeFile(rawPath: string): Promise<{ path: string; fallback: boolean }> {
  const requested = String(rawPath ?? "").trim();
  if (requested === "") {
    throw new Error(
      `actinno/intake-candidate needs \`resumeFilePath\`: the path to the candidate's resume ` +
        `as a PDF. Copy it into ${RESUME_DROP_DIR}/ first — this process cannot read ` +
        `~/Desktop, ~/Documents or ~/Downloads.`
    );
  }

  const dropDirFailure = await ensureResumeDropDir();
  const candidates = resumePathCandidates(requested);
  const failures: string[] = [];

  for (const [index, candidate] of candidates.entries()) {
    try {
      await access(candidate, FS_CONSTANTS.R_OK);
      return { path: candidate, fallback: index > 0 };
    } catch (err) {
      failures.push(errnoOf(err) ?? "unknown error");
    }
  }

  const primary = candidates[0]!;
  const primaryFailure = failures[0];
  const denied = primaryFailure === "EPERM" || primaryFailure === "EACCES";

  const cause = denied
    ? `Reading "${primary}" was DENIED (${primaryFailure}). This is almost certainly the ` +
      `macOS sandbox Claude Desktop runs this server in, not a broken file: that sandbox is ` +
      `separate from the Claude app's own file access and refuses ~/Desktop, ~/Documents, ` +
      `~/Downloads and iCloud Drive whatever permissions the app itself has been granted.`
    : primaryFailure === "ENOENT"
      ? `There is no file at "${primary}".`
      : `"${primary}" could not be opened (${primaryFailure ?? "unknown error"}).`;

  const alreadyThere = await listDropDir();
  const dropDirNote =
    dropDirFailure !== undefined
      ? `NOTE: ${RESUME_DROP_DIR} does not exist and could not be created (${dropDirFailure}) — ` +
        `create it by hand.`
      : alreadyThere.length > 0
        ? `PDFs already in ${RESUME_DROP_DIR}: ${alreadyThere.join(", ")}.`
        : `${RESUME_DROP_DIR} exists and is empty.`;

  throw new Error(
    `${cause}\n\nThe fix: put the PDF in ${RESUME_DROP_DIR}/ and pass that path. That ` +
      `directory is the one place known to work — this server's own bundle is loaded from ` +
      `${ACTINNO_HOME}, so the sandbox demonstrably reads it.\n\n` +
      `    cp "${expandHome(requested)}" ${RESUME_DROP_DIR}/\n\n` +
      `then call actinno/intake-candidate again with resumeFilePath ` +
      `${join(RESUME_DROP_DIR, basename(expandHome(requested)) || "resume.pdf")}. ` +
      `${dropDirNote} (Tried: ${candidates
        .map((path, i) => `${path} -> ${failures[i]}`)
        .join("; ")}.)`
  );
}

/** Whole dollars per year, from a model that may well have typed it as text. */
function toPayMin(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw === "number") return raw;
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) return Number(raw.trim());
  throw new Error(
    `payMin must be a minimum salary in whole dollars per year, e.g. 90000 — got ` +
      `${JSON.stringify(raw)}.`
  );
}

/** An array, or the comma-separated string a model reaches for just as often. */
function toLocations(raw: unknown): string[] | undefined {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === "string") return raw.split(",");
  return undefined;
}

/**
 * ACT-015 — a yes/no answer a model may have typed as a word.
 *
 * The important half of this function is what it does with anything else:
 * `undefined`. A value this does not recognise as a clear yes or no is dropped,
 * not coerced — because the column it would land in is a statement the
 * candidate makes to an employer, and a coerced `false` is an answer nobody
 * gave. The consequence of dropping it is that an application which needs the
 * answer stops and asks, which is the correct outcome.
 */
function toYesNo(raw: unknown): boolean | undefined {
  if (typeof raw === "boolean") return raw;
  if (typeof raw !== "string") return undefined;
  const value = raw.trim().toLowerCase();
  if (["yes", "y", "true", "t", "1"].includes(value)) return true;
  if (["no", "n", "false", "f", "0"].includes(value)) return false;
  return undefined;
}

/** The ACT-015 answers a model supplied, with everything unstated left out. */
function toApplicationAnswers(
  input: Record<string, unknown>
): CandidateApplicationAnswers | undefined {
  const answers: CandidateApplicationAnswers = {};
  const workAuthorizedUs = toYesNo(input.workAuthorizedUs);
  if (workAuthorizedUs !== undefined) answers.workAuthorizedUs = workAuthorizedUs;
  const requiresSponsorship = toYesNo(input.requiresSponsorship);
  if (requiresSponsorship !== undefined) answers.requiresSponsorship = requiresSponsorship;
  const willingToRelocate = toYesNo(input.willingToRelocate);
  if (willingToRelocate !== undefined) answers.willingToRelocate = willingToRelocate;
  const currentCountry =
    typeof input.currentCountry === "string" ? input.currentCountry.trim() : "";
  if (currentCountry !== "") answers.currentCountry = currentCountry;
  const currentCity = typeof input.currentCity === "string" ? input.currentCity.trim() : "";
  if (currentCity !== "") answers.currentCity = currentCity;
  return Object.keys(answers).length === 0 ? undefined : answers;
}

// ═══════════════════════════════════════════════════════════════════════════
// ACT-014 — the resume arrives over HTTP, and the model does the carrying
// ═══════════════════════════════════════════════════════════════════════════
//
// ACT-013's drop-spot machinery above is correct and stays. What it is not is
// the product: "copy your PDF into ~/.actinno-mcp/resumes/ from a terminal, then
// tell me the path" is a terminal step in the middle of a conversation whose
// entire pitch is that there isn't one. The thing a person actually does is
// attach the PDF to the chat.
//
// The bytes still cannot come through the model — ACT-013's note on base64
// stands, and the deeper problem is that an attached PDF reaches the model as
// *extracted text*, so there are no bytes in the context to re-emit even if the
// token cost were acceptable. So the design routes around the context entirely:
//
//   1. `create-resume-upload` asks Supabase for a presigned upload URL — a
//      capability scoped to one object path, valid two hours, containing no
//      credential of ours — and returns it with instructions.
//   2. The model's own execution environment PUTs the attached file's bytes to
//      that URL. That leg is not code in this repo. It is a paragraph of English
//      the model reads and acts on, which is exactly why the `instructions`
//      field below is written as carefully as it is: it is the only specification
//      the uploader gets, and every detail in it was checked against the live
//      endpoint rather than recalled (PUT works, POST returns a 400 complaining
//      about a missing `authorization` header, no auth header is needed, and a
//      zero-byte body is accepted with a 200).
//   3. `intake-candidate` takes the resulting `assetHandle` instead of a path,
//      reads the staged object with the service-role client — from in here,
//      where the credentials legitimately live — and runs the ordinary ACT-003
//      intake on those bytes, unchanged validation included.
//
// ── The leg that may not exist ─────────────────────────────────────────────
// Step 2 is an assumption about somebody else's sandbox, and it is not
// guaranteed: an execution environment with no outbound network makes this whole
// route a dead end. (Supabase's own side is not the obstacle — its gateway
// serves `access-control-allow-origin: *` on the upload endpoint, verified
// against this project, so a browser-based tool is not CORS-blocked.) Hence
// `check-resume-upload`, so the answer costs one cheap call instead of a failed
// intake, and hence the deliberately loud "did not land" error from
// `readStagedResume` — a failure here has to land the user on the
// `resumeFilePath` fallback with the `cp` command in hand, not in a half-state
// where a candidate exists and their resume does not.

/** Cap on the echoed filename, which is display-only and model-supplied. */
const MAX_ECHOED_FILE_NAME = 80;

/**
 * The attached file's name, made safe to interpolate into instructions.
 *
 * It never reaches a storage key — `createResumeUploadSlot()` names the object
 * after a UUID it mints itself — so this is not a path-traversal defence. It is
 * a defence against the string being *prose*: the value lands inside a code
 * snippet the model is told to run, so a newline or a quote in it would end the
 * string literal and turn the rest into instructions.
 */
function sanitizeFileName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const cleaned = raw
    // Control characters first: a newline here would end the string literal in
    // the snippet this value is pasted into and turn the remainder into code.
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/["'`\\]/g, "")
    .trim();
  return cleaned.slice(0, MAX_ECHOED_FILE_NAME);
}

/**
 * The upload leg, written out for the one reader it has.
 *
 * Every "do X, not Y" here is a failure mode that was reproduced against the
 * live endpoint first, and the wording is blunt on purpose: this is not
 * documentation for a person who can go and read the API reference, it is the
 * complete and only brief handed to a model that gets one attempt at it.
 */
function uploadInstructions(uploadUrl: string, assetHandle: string, fileName: string): string {
  const file = fileName === "" ? "the attached resume.pdf" : fileName;
  return (
    `UPLOAD THE RESUME NOW, YOURSELF, BEFORE CALLING ANY OTHER ACTOR. This is one HTTP ` +
    `request that YOU make from your own execution environment. The user does not do it, ` +
    `and they must not be asked to open a terminal.\n\n` +
    `1. GET THE RAW BYTES of ${file}. In the analysis tool that is ` +
    `\`await window.fs.readFile("${file}")\`, which returns a Uint8Array; in a shell or VM ` +
    `it is the file on disk. Do NOT base64 them, do NOT print them into your reply, and do ` +
    `NOT reconstruct a PDF from the text you were shown — these exact bytes are what a real ` +
    `employer receives, so they must be the original file, unmodified.\n\n` +
    `2. SEND THEM AS EXACTLY THIS REQUEST:\n` +
    `     method : PUT — it must be PUT. POST is a different endpoint on the same path and ` +
    `answers 400 "headers must have required property 'authorization'".\n` +
    `     url    : ${uploadUrl}\n` +
    `              Use it verbatim. The ?token= is already part of it and is the entire ` +
    `authorization.\n` +
    `     headers: content-type: application/pdf — that one, and nothing else. Do NOT add ` +
    `Authorization, apikey, x-upsert or any other Supabase header; there is no key to send ` +
    `and none is needed.\n` +
    `     body   : the raw bytes, unmodified. Not a form, not a multipart body, not JSON.\n` +
    `   Success is HTTP 200 with a body like {"Key":"resumes/staging/<id>.pdf"}. The request ` +
    `is idempotent — if you cannot tell whether it went through, send it again rather than ` +
    `guessing.\n\n` +
    `3. THEN CALL actinno/intake-candidate with assetHandle "${assetHandle}" (NOT ` +
    `resumeFilePath), together with the person's applicationEmail and any linkedinUrl / ` +
    `targetTitle / payMin / locations they gave you. If you want to confirm the bytes landed ` +
    `first, actinno/check-resume-upload takes the same handle and is cheap.\n\n` +
    `IF THE PUT FAILS, OR YOUR ENVIRONMENT CANNOT MAKE OUTBOUND HTTP REQUESTS AT ALL: stop ` +
    `and switch routes rather than retrying indefinitely, and do not create a candidate ` +
    `without a resume. Tell the user to run\n\n` +
    `    mkdir -p ~/.actinno-mcp/resumes && cp <their resume>.pdf ~/.actinno-mcp/resumes/\n\n` +
    `and then call actinno/intake-candidate with resumeFilePath ` +
    `~/.actinno-mcp/resumes/<their file>.pdf instead of assetHandle. That route always works ` +
    `and is what this actor exists to spare them, not to replace.\n\n` +
    `Do not show the url above to the user. It is a short-lived write capability, not ` +
    `information.`
  );
}

/**
 * ACT-014. Mints the upload slot. Writes nothing a human has to live with —
 * the whole point of splitting it from intake is that a slot nobody uploads to
 * is worth exactly one swept object and no rows at all.
 */
async function createResumeUploadActor(input: Record<string, unknown>) {
  const fileName = sanitizeFileName(input.fileName);

  const { createResumeUploadSlot } = await loadCandidateIntake();
  const slot = await createResumeUploadSlot();

  return {
    status: "upload_url_created" as const,
    assetHandle: slot.assetHandle,
    uploadUrl: slot.uploadUrl,
    // Already inside `uploadUrl`, so this exposes nothing further. It is here
    // for a resumable/TUS uploader, which wants the bare token in `x-signature`
    // rather than a query string.
    token: slot.token,
    method: "PUT" as const,
    headers: { "content-type": slot.contentType },
    expiresIn: slot.expiresInSeconds,
    expiresAt: slot.expiresAt,
    maxBytes: slot.maxBytes,
    instructions: uploadInstructions(slot.uploadUrl, slot.assetHandle, fileName),
    snippets: {
      javascript:
        `const bytes = await window.fs.readFile(${JSON.stringify(fileName || "resume.pdf")});\n` +
        `const res = await fetch(${JSON.stringify(slot.uploadUrl)}, {\n` +
        `  method: "PUT",\n` +
        `  headers: { "content-type": "application/pdf" },\n` +
        `  body: bytes,\n` +
        `});\n` +
        `console.log(res.status, await res.text()); // expect 200 {"Key":"resumes/staging/..."}`,
      python:
        `import urllib.request\n` +
        `data = open(${JSON.stringify(fileName || "resume.pdf")}, "rb").read()\n` +
        `req = urllib.request.Request(${JSON.stringify(slot.uploadUrl)}, data=data,\n` +
        `                             method="PUT",\n` +
        `                             headers={"content-type": "application/pdf"})\n` +
        `print(urllib.request.urlopen(req).status)  # expect 200`,
      bash:
        `curl -sS -X PUT ${JSON.stringify(slot.uploadUrl)} \\\n` +
        `  -H "content-type: application/pdf" \\\n` +
        `  --data-binary @${JSON.stringify(fileName || "resume.pdf")}`,
    },
    next:
      `Do the PUT, then call actinno/intake-candidate with assetHandle ` +
      `${slot.assetHandle} and the candidate's applicationEmail. This slot holds one PDF and ` +
      `expires ${slot.expiresAt}; after that, ask for a new one rather than reusing it.`,
  };
}

/**
 * ACT-014. "Did my own upload work?" — the question the model cannot otherwise
 * answer about an environment whose network access is not knowable in advance.
 */
async function checkResumeUploadActor(input: Record<string, unknown>) {
  const assetHandle = String(input.assetHandle ?? "").trim();
  if (assetHandle === "") {
    throw new Error(
      `actinno/check-resume-upload needs the \`assetHandle\` that ` +
        `actinno/create-resume-upload returned (an "actinno-upload-…" string).`
    );
  }

  const { describeResumeUpload } = await loadCandidateIntake();
  const status = await describeResumeUpload(assetHandle);

  if (!status.arrived) {
    return {
      status: "upload_not_arrived" as const,
      assetHandle: status.assetHandle,
      arrived: false as const,
      note:
        `Nothing has been uploaded for ${status.assetHandle} — the PUT either was not made ` +
        `or did not reach Supabase. If you have not sent it yet, send it now (PUT the raw ` +
        `bytes to the uploadUrl with content-type: application/pdf). If you did send it and ` +
        `it errored, or your environment has no outbound network access, switch to the file ` +
        `route: have the user run \`mkdir -p ${RESUME_DROP_DIR} && cp <their resume>.pdf ` +
        `${RESUME_DROP_DIR}/\` and call actinno/intake-candidate with resumeFilePath instead ` +
        `of assetHandle. Do NOT run intake with this handle as things stand — it will fail.`,
    };
  }

  if (status.bytes === 0) {
    return {
      status: "upload_landed_empty" as const,
      assetHandle: status.assetHandle,
      arrived: true as const,
      bytes: 0,
      note:
        `The request reached Supabase but carried no body, so a 0-byte object is all that ` +
        `landed. Read the file's bytes and send them as the request body — a 0-byte resume ` +
        `is refused at intake, and would be worse than no application if it were not.`,
    };
  }

  return {
    status: "upload_arrived" as const,
    assetHandle: status.assetHandle,
    arrived: true as const,
    bytes: status.bytes,
    contentType: status.contentType,
    uploadedAt: status.uploadedAt,
    note:
      `${status.bytes ?? "an unknown number of"} bytes are staged for ${status.assetHandle}. ` +
      `Whether they are a usable PDF is checked at intake, not here. Call ` +
      `actinno/intake-candidate with this assetHandle and the candidate's applicationEmail.`,
  };
}

/**
 * ACT-013. The onboarding step, and the only actor here that writes a row a
 * human then has to live with.
 *
 * Everything about *what* intake means — the PDF magic-number check, the 25MB
 * cap, the upload into the private `resumes` bucket, the `candidates` insert,
 * and deleting the uploaded object again if that insert fails — belongs to
 * `intakeCandidate()` and is deliberately not re-implemented, re-validated or
 * second-guessed here. This function's whole job is the two things that are
 * specific to being called by a model over MCP: finding a file the sandbox will
 * actually let it read, and handing back something the model can act on.
 *
 * ACT-014 added a second way in, and the *only* thing that changes here is
 * which of two keys is put on `intakeCandidate`'s input. An `assetHandle` skips
 * `resolveResumeFile` entirely — there is no local file to find, so none of
 * ACT-013's sandbox probing runs and none of its advice would make sense — and
 * a `resumeFilePath` goes through exactly the code it went through before,
 * character for character. That is deliberate: the file route is the fallback
 * for when the upload route cannot work, so it has to be the one thing here
 * that ACT-014 could not have broken.
 */
async function intakeCandidateActor(input: Record<string, unknown>) {
  const assetHandle = String(input.assetHandle ?? "").trim();
  const requestedPath = String(input.resumeFilePath ?? "").trim();

  if (assetHandle !== "" && requestedPath !== "") {
    throw new Error(
      `actinno/intake-candidate takes EITHER \`assetHandle\` OR \`resumeFilePath\`, not both ` +
        `(got ${JSON.stringify(input.assetHandle)} and ` +
        `${JSON.stringify(input.resumeFilePath)}). They can name two different PDFs and this ` +
        `will not guess which one is the resume. Send the assetHandle alone if the upload ` +
        `succeeded; send the path alone if it did not.`
    );
  }
  if (assetHandle === "" && requestedPath === "") {
    throw new Error(
      `actinno/intake-candidate needs the candidate's resume, and neither way of giving it ` +
        `was used. Normally: call actinno/create-resume-upload, PUT the attached PDF's bytes ` +
        `to the uploadUrl it returns, then call this again with the \`assetHandle\`. If that ` +
        `upload is not possible from where you are running, use \`resumeFilePath\` instead — ` +
        `copy the PDF into ${RESUME_DROP_DIR}/ first, since this process cannot read ` +
        `~/Desktop, ~/Documents or ~/Downloads.`
    );
  }

  // Only when a path was actually given: this probes the filesystem and creates
  // the drop directory, neither of which an upload-based intake should touch.
  const resume = assetHandle === "" ? await resolveResumeFile(requestedPath) : undefined;

  const applicationEmail = String(input.applicationEmail ?? "").trim();
  const payMin = toPayMin(input.payMin);
  const locations = toLocations(input.locations);
  const applicationAnswers = toApplicationAnswers(input);

  const { intakeCandidate } = await loadCandidateIntake();

  // Optional fields are spread in only when the model actually supplied one —
  // it costs nothing (`intakeCandidate` normalises blanks to NULL either way)
  // and it keeps the call a record of what was said rather than of which
  // properties happened to appear in the schema.
  const result = await intakeCandidate({
    ...(resume === undefined ? { assetHandle } : { resumeFilePath: resume.path }),
    applicationEmail,
    ...(typeof input.linkedinUrl === "string" && input.linkedinUrl.trim() !== ""
      ? { linkedinUrl: input.linkedinUrl }
      : {}),
    ...(typeof input.targetTitle === "string" && input.targetTitle.trim() !== ""
      ? { targetTitle: input.targetTitle }
      : {}),
    ...(payMin === undefined ? {} : { payMin }),
    ...(locations === undefined ? {} : { locations }),
    ...(applicationAnswers === undefined ? {} : { applicationAnswers }),
  });

  // The staged object is deleted on success, so saying "uploaded" rather than
  // naming a path is not vagueness — there is deliberately no longer anything
  // at the staging path to name.
  const provenance =
    resume === undefined
      ? `the resume you uploaded (${assetHandle})`
      : `the resume at ${resume.path}`;

  return {
    status: "intake_complete" as const,
    candidateId: result.candidateId,
    applicationEmail,
    resumeSource: result.resumeSource,
    ...(resume === undefined ? { assetHandle } : { resumeFileRead: resume.path }),
    resumeStoredAs: result.resumeUrl,
    confirmation:
      `Intake complete. ${applicationEmail} is now set up with ${provenance}, and ` +
      `applications will be filed under that address. Their candidate id is ` +
      `${result.candidateId}.` +
      (resume?.fallback
        ? ` (Note: the path given was not readable, so the matching file in ` +
          `${RESUME_DROP_DIR} was used instead — check that is the right resume.)`
        : "") +
      (result.stagedUpload && !result.stagedUpload.removed
        ? ` (Minor: the staged upload could not be deleted afterwards — ` +
          `${result.stagedUpload.removalError ?? "unknown reason"} — so a duplicate copy is ` +
          `left at ${result.bucket}/${result.stagedUpload.objectPath}. Harmless; it is ` +
          `swept within 24 hours. The candidate's own resume is stored correctly.)`
        : ""),
    next:
      `Run this actor ONCE per person; it does not need repeating for each job. To apply, ` +
      `find listings with actinno/bulk-search-job-listings and then call ` +
      `actinno/apply-to-job once per listing with applicationEmail ${applicationEmail} ` +
      `(or candidateId ${result.candidateId}, which is unambiguous). Tell the user their ` +
      `candidate id so they can quote it in a later conversation.`,
  };
}

/**
 * Thin adapter over the shared ACT-002 search. The actor call itself now lives
 * in `lib/search-job-listings.ts` so `inngest/job-application-pipeline.ts` runs
 * the identical code; all this does is narrow the MCP tool's untyped
 * `Record<string, unknown>` input into that function's arguments.
 */
async function bulkSearchJobListings(input: Record<string, unknown>) {
  const { companies, title, payMin, locations, maxPerCompany } =
    input as Partial<JobSearchPreferences>;

  return await searchJobListings({
    companies: Array.isArray(companies) ? companies.map(String) : [],
    ...(typeof title === "string" ? { title } : {}),
    ...(typeof payMin === "number" ? { payMin } : {}),
    ...(Array.isArray(locations) ? { locations: locations.map(String) } : {}),
    ...(typeof maxPerCompany === "number" ? { maxPerCompany } : {}),
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The listing, in the exact shape `JobApplicationRequestedData` declares — the
 * same normalisation `discoverListings` gets for free by fanning out listings it
 * just built itself.
 *
 * The pipeline's own `normalizeListing()` re-does all of this and remains the
 * authority; nothing here is load-bearing for its safety. What it buys is
 * *where the error surfaces*. A malformed listing that reaches Inngest becomes a
 * `NonRetriableError` inside a run — a failure Claude Desktop never sees, having
 * already been handed a trackingId and told the job started. Rejecting it here
 * turns that into a synchronous tool error the model can read and fix, which is
 * the only kind of feedback an async tool has left.
 */
function toEventListing(raw: unknown): JobListing {
  const listing = (raw ?? {}) as Partial<Record<keyof JobListing, unknown>>;
  const company = String(listing.company ?? "").trim();
  const title = String(listing.title ?? "").trim();
  const applyUrl = String(listing.applyUrl ?? "").trim();

  const reject = (why: string): never => {
    throw new Error(
      `actinno/apply-to-job needs a usable listing: ${why}. Pass one of the objects from ` +
        `actinno/bulk-search-job-listings' \`listings\` array through unchanged.`
    );
  };

  if (company === "") reject("no company");
  if (title === "") reject("no title");

  // Parsed inside the `try`, judged outside it. Calling `reject()` from within
  // the `try` would throw into the adjacent `catch`, which would swallow the
  // real complaint and re-report every rejected URL as unparseable — including
  // the http ones, which parse perfectly well. (`normalizeListing()` in the
  // pipeline is written the first way; the rejection is correct there either
  // way, only the message it prints is misleading.)
  let protocol: string | null = null;
  try {
    protocol = new URL(applyUrl).protocol;
  } catch {
    protocol = null;
  }
  if (protocol === null) reject(`applyUrl is not a URL: ${JSON.stringify(listing.applyUrl)}`);
  else if (protocol !== "https:") reject(`applyUrl is not https: ${applyUrl}`);

  // Defaults match `normalizeListing()` in the pipeline exactly, so an event
  // sent from here and an event fanned out from `discoverListings` are
  // indistinguishable by the time `applyToJob` reads them.
  //
  // `atsProvider` is the one field checked harder here than there, and for a
  // reason specific to this entry point: the pipeline's listings come from
  // `searchJobListings`, which can only ever emit the three declared values,
  // whereas these arrive from a language model reading a schema. Clamping an
  // invented "workday" back to the declared default is what keeps the two
  // sources indistinguishable, not a departure from it.
  const ATS: readonly JobListing["atsProvider"][] = ["greenhouse", "lever", "other"];
  const atsProvider = ATS.find((p) => p === listing.atsProvider) ?? "greenhouse";

  return {
    company,
    title,
    applyUrl,
    location: typeof listing.location === "string" ? listing.location : null,
    atsProvider,
    requiresCoverLetter: listing.requiresCoverLetter === true,
    jobDescription: typeof listing.jobDescription === "string" ? listing.jobDescription : null,
  };
}

/**
 * ACT-013 — who is applying, resolved to the one identity the pipeline accepts.
 *
 * The event that leaves this file carries `candidateId` and only `candidateId`.
 * That is ACT-009's contract and it is not negotiable from here: the same UUID
 * is `job_applications.candidate_id`, and it is the `userId` ACT-006 stamps on
 * `email/verification-received`, which is what a parked run's `waitForEvent`
 * matches on. Widening the event to accept an email would mean the pipeline
 * resolving identity mid-run, after `createBoardAccount` has already opened a
 * browser. So the resolution happens *here*, before the event exists, and the
 * wire format is untouched.
 *
 * What changes is only what a caller may say. A person knows their email
 * address; nobody knows their own UUID, and until ACT-013 the tool demanded one
 * anyway — which is why onboarding through Claude Desktop was impossible.
 *
 * Both at once is an error rather than a preference order. They can disagree,
 * and the disagreement is silent: an email resolving to a different row than the
 * id supplied means a real application, at a real employer, under the wrong
 * person's resume. There is no reading of "pass both" worth that, and a caller
 * holding both loses nothing by dropping one.
 */
async function resolveCandidateId(
  input: Record<string, unknown>,
  // ACT-015 gave this a second caller, and the messages below name the tool the
  // reader actually called rather than always naming apply-to-job.
  actor = "actinno/apply-to-job"
): Promise<string> {
  const candidateId = String(input.candidateId ?? "").trim();
  const applicationEmail = String(input.applicationEmail ?? "").trim();

  if (candidateId !== "" && applicationEmail !== "") {
    throw new Error(
      `${actor} takes EITHER \`candidateId\` OR \`applicationEmail\`, not both ` +
        `(got both: ${JSON.stringify(candidateId)} and ${JSON.stringify(applicationEmail)}). ` +
        `They can point at different people and this call will not guess which one you meant. ` +
        `Re-send with just \`candidateId\` — it is exact — or just \`applicationEmail\`.`
    );
  }

  if (candidateId === "" && applicationEmail === "") {
    // Named explicitly because the pre-ACT-010 schema took `resumeUrl` /
    // `linkedinUrl` / `applicationEmail` as *data*, and a caller working from a
    // stale memory of this tool will send those instead. `applicationEmail` is
    // accepted now, but only ever as a way to find an existing row.
    throw new Error(
      `${actor} needs to know whose application this is: pass ` +
        `\`applicationEmail\` (the address the candidate went through intake with) or ` +
        `\`candidateId\` (the UUID actinno/intake-candidate returned). Neither was given. ` +
        `The resume and LinkedIn URL are read from that stored row and are not accepted as ` +
        `arguments here. If this person has never been through intake, run ` +
        `actinno/intake-candidate first — it needs their resume PDF and an email address.`
    );
  }

  if (candidateId !== "") {
    if (!UUID_RE.test(candidateId)) {
      throw new Error(
        `\`candidateId\` must be the candidates.id UUID returned by actinno/intake-candidate ` +
          `— got ${JSON.stringify(input.candidateId)}. If what you have is an email address, ` +
          `pass it as \`applicationEmail\` instead and it will be looked up.`
      );
    }
    return candidateId;
  }

  // Throws, with a message that tells the user to run intake, when the address
  // matches no row — and, because `application_email` has no unique constraint,
  // when it matches more than one. See `findCandidateByEmail`.
  const { findCandidateByEmail } = await loadCandidateIntake();
  const candidate = await findCandidateByEmail(applicationEmail);
  return candidate.candidateId;
}

/**
 * ACT-010. Fire and return — this is the whole point of the ticket.
 *
 * The chain behind `job-application/requested` opens a browser, may park for up
 * to ten minutes waiting on a verification email, and only then fills and
 * submits. An MCP tool call cannot be held open across that, and it does not
 * need to be: the run is durable on the Inngest side, so the *only* thing this
 * function is on the hook for is getting the event accepted. One HTTP POST to
 * the local dev server, then it returns.
 *
 * The trackingId is Inngest's own event id — `send()` resolves to `{ ids }` —
 * rather than an id minted here. An id this process invented would be a label
 * for nothing: it would appear in no dashboard and correlate with no run.
 *
 * Proof of completion is deliberately *not* this function's problem. The
 * candidate learns their application landed from the employer's own confirmation
 * email (ACT-006 sees it, ACT-008 records the reference on the
 * `job_applications` row). Blocking here to be able to say "done" in the chat
 * would trade a working demo for a worse one.
 */
async function applyToJob(input: Record<string, unknown>) {
  const candidateId = await resolveCandidateId(input);
  const listing = toEventListing(input.listing);
  const additionalAnswers = toAdditionalAnswers(input.additionalAnswers);
  const data: JobApplicationRequestedData = {
    candidateId,
    listing,
    ...(additionalAnswers === undefined ? {} : { additionalAnswers }),
  };

  let ids: string[];
  try {
    ({ ids } = await inngest.send({ name: JOB_APPLICATION_REQUESTED, data }));
  } catch (err) {
    // The one failure mode a demo actually hits: the pipeline processes are not
    // up, so there is nothing on :8288 to accept the event. Say so, rather than
    // letting a bare fetch error reach the chat.
    throw new Error(
      `Could not reach Inngest to start the application (${
        err instanceof Error ? err.message : String(err)
      }). The local pipeline has to be running: \`cd inngest && npm run dev\` for the dev ` +
        `server on :8288 and \`npm run serve\` for the functions on :3000.`
    );
  }

  const trackingId = ids[0];
  if (trackingId === undefined) {
    // Inngest accepted the request but named no event. Reporting "started" with
    // no id would be a lie the caller has no way to check.
    throw new Error(
      `Inngest accepted ${JOB_APPLICATION_REQUESTED} for ${listing.company} but returned no ` +
        `event id, so there is no trackingId to report and no way to confirm the run started.`
    );
  }

  return {
    status: "started" as const,
    trackingId,
    company: listing.company,
    title: listing.title,
    applyUrl: listing.applyUrl,
    ...(additionalAnswers === undefined
      ? {}
      : { answersSupplied: Object.keys(additionalAnswers) }),
    note:
      "The application is now running in the background and will take several minutes " +
      "(account creation, email verification, form fill, submit). This tool has no " +
      "completion callback — do not wait on it and do not re-run this listing. " +
      "Progress is visible at http://localhost:8288, and the candidate's own confirmation " +
      "email from the employer is the real proof it went through. One thing IS worth " +
      "coming back for: if this employer's form asks something that cannot be answered " +
      "truthfully from what Actinno knows about the candidate, the run stops without " +
      "submitting and writes the question down rather than inventing an answer. " +
      "actinno/check-application-status a few minutes from now is how that question " +
      "reaches you, and the candidate's reply goes back through this tool's " +
      "`additionalAnswers`.",
  };
}

/**
 * ACT-015 — the candidate's answers, off a model's keyboard.
 *
 * Shaped and bounded only. Whether a key names a field on the employer's form
 * and whether a value is one of that control's options are questions the live
 * page answers, and ACT-007 asks them there rather than trusting anything
 * decided here.
 */
function toAdditionalAnswers(raw: unknown): Record<string, string> | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `actinno/apply-to-job's \`additionalAnswers\` must be an object of ` +
        `{ "<the key the status check reported>": "<the candidate's answer>" }, got ` +
        `${JSON.stringify(raw)}.`
    );
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "string") continue;
    const trimmedKey = key.trim();
    const trimmedValue = value.trim();
    if (trimmedKey === "" || trimmedValue === "") continue;
    out[trimmedKey] = trimmedValue;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/**
 * ACT-015 — how a background run's questions get back to the person who can
 * answer them.
 *
 * `apply-to-job` returns a tracking id in a second and then runs for minutes, so
 * there has never been a way for it to say anything to the user afterwards. That
 * was tolerable while its only two endings were "submitted" and "a human needs
 * to look at this", because the employer's own confirmation email covers the
 * first. ACT-015 adds an ending that is explicitly a *question for the
 * candidate*, and a question nobody can hear is the same as a guess.
 *
 * So this reads the row. It stores nothing new, and it invents nothing: the
 * questions are already in `job_applications.error_message`, put there by the
 * same code that records every other stop, and this hands them back with enough
 * framing for the model to know what to do — put them to the user, then re-run
 * the same listing with their answers.
 */
async function checkApplicationStatus(input: Record<string, unknown>) {
  const candidateId = await resolveCandidateId(input, "actinno/check-application-status");
  const applyUrl = String(input.applyUrl ?? "").trim();

  const { listCandidateApplications } = await loadCandidateIntake();
  const rows = await listCandidateApplications(candidateId, {
    ...(applyUrl === "" ? {} : { applyUrl }),
  });

  if (rows.length === 0) {
    return {
      status: "no_applications" as const,
      candidateId,
      applications: [],
      note:
        `No applications have been started for this candidate` +
        (applyUrl === "" ? "" : ` at ${applyUrl}`) +
        `. If you expected one, it may not have been accepted by the pipeline — start it ` +
        `with actinno/apply-to-job.`,
    };
  }

  const applications = rows.map((row) => ({
    jobApplicationId: row.jobApplicationId,
    company: row.company,
    title: row.jobTitle,
    applyUrl: row.applyUrl,
    status: row.status,
    submitted: row.status === "submitted",
    confirmationRef: row.confirmationRef,
    updatedAt: row.updatedAt,
    // The blocked reason verbatim, questions and all. Not reformatted here:
    // this text was written for a person to read, and paraphrasing a question
    // about someone's work authorization is a good way to change it.
    detail: row.errorMessage,
    needsCandidateInput: (row.errorMessage ?? "").includes("needs_candidate_input"),
  }));

  const waiting = applications.filter((application) => application.needsCandidateInput);
  const running = applications.filter(
    (application) =>
      !application.submitted &&
      !application.needsCandidateInput &&
      !["form_fill_blocked", "submission_blocked", "account_gate_blocked", "error"].includes(
        application.status
      )
  );

  return {
    status: "ok" as const,
    candidateId,
    applications,
    note:
      (waiting.length > 0
        ? `${waiting.length} application(s) are waiting on the candidate. Each one's ` +
          `\`detail\` lists the exact questions the employer's form asked and the \`key\` to ` +
          `answer each under. Put those questions to the user in chat, in their own words, ` +
          `and wait for real answers — these are statements made to a real employer under ` +
          `the user's name, so do not answer any of them yourself and do not fill in a ` +
          `plausible-looking value. Then call actinno/apply-to-job again for that same ` +
          `listing with \`additionalAnswers\` set to what they told you. Nothing was ` +
          `submitted for these, and nothing will be until the form is complete. `
        : "") +
      (running.length > 0
        ? `${running.length} application(s) are still running; check again in a few minutes. `
        : "") +
      `Anything already at "submitted" is done — the employer's confirmation email to the ` +
      `candidate is the real proof, and re-running a submitted listing would file a second ` +
      `application.`,
  };
}

const transport = new StdioServerTransport();
await server.connect(transport);
