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
 */

// FIRST, and it has to stay first: the Inngest client below reads `INNGEST_DEV`
// at construction time. See `load-env.ts`.
import "./load-env.js";

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
 * Stagehand, googleapis and Supabase, none of which this process ever uses — and
 * Claude Desktop is waiting on the MCP handshake for every millisecond of it.
 *
 * `import type` and `typeof import(...)` are erased entirely at build time, so
 * this gets the compile-time coupling with none of the runtime weight: rename
 * the event or change a field over there and *this file stops compiling*, while
 * the running server still only ever loads `inngest`'s client.
 */
import type { JobApplicationRequestedData } from "../inngest/job-application-pipeline.js";

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
    name: "actinno/bulk-search-job-listings",
    title: "Bulk Job Listings Search",
    description:
      "Lists open jobs from one or more named Greenhouse company boards, optionally narrowed by job title and location. Call this ONCE per job search — it returns every matched listing across every named company in a single pass. Do not call it per-listing, and do not call it per-company.",
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
      "Starts an end-to-end application to ONE job listing: creates an account on the job board, waits for and handles email verification, fills the application from the candidate's stored resume and LinkedIn, and submits. ASYNCHRONOUS — it returns a trackingId in about a second and the application then runs in the background for several minutes. Call this once PER LISTING, all of them in parallel in a single batch, and do NOT wait for one to finish before starting the next. There is no polling tool and no completion callback: once you have a trackingId the job is running, so report the trackingIds and stop. The candidate is told they are done by the confirmation email the employer sends them, not by you.",
    inputSchema: {
      type: "object",
      properties: {
        candidateId: {
          type: "string",
          description:
            "The candidate's `candidates.id` UUID from Actinno intake. Everything personal comes from that row — resume, LinkedIn URL, and the email address applications are filed under — so do NOT pass those as fields here; they are not accepted. Ask the user for their candidate id if you do not already have one.",
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
      },
      required: ["candidateId", "listing"],
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
                    `to hold any back.`,
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

      default:
        throw new Error(`Unknown actor: ${actor}`);
    }
  }

  throw new Error(`Unknown tool: ${name}`);
});

// ───────────────────────────────────
// Actor implementations
// ───────────────────────────────────

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
  const candidateId = String(input.candidateId ?? "").trim();
  if (!UUID_RE.test(candidateId)) {
    // Named explicitly because the old input schema took `resumeUrl` /
    // `linkedinUrl` / `applicationEmail` and a caller working from a stale
    // memory of this tool will send those instead.
    throw new Error(
      `actinno/apply-to-job needs \`candidateId\`, the candidates.id UUID from Actinno ` +
        `intake — got ${JSON.stringify(input.candidateId)}. The resume, LinkedIn URL and ` +
        `application email are read from that row and are not accepted as arguments.`
    );
  }

  const listing = toEventListing(input.listing);
  const data: JobApplicationRequestedData = { candidateId, listing };

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
    note:
      "The application is now running in the background and will take several minutes " +
      "(account creation, email verification, form fill, submit). This tool has no " +
      "completion callback and there is nothing further to call — do not wait, do not " +
      "poll, and do not re-run this listing. Progress is visible at http://localhost:8288, " +
      "and the candidate's own confirmation email from the employer is the real proof it " +
      "went through.",
  };
}

const transport = new StdioServerTransport();
await server.connect(transport);
