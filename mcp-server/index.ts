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
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

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
      "Searches job boards (Greenhouse, Lever, and others) for listings matching a target role, pay range, and location. Call this ONCE per job search — it returns every matched listing in a single pass. Do not call it per-listing.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Target job title, e.g. 'entry-level software engineer'",
        },
        payMin: { type: "number" },
        locations: { type: "array", items: { type: "string" } },
      },
      required: ["title"],
    },
  },
  {
    name: "actinno/apply-to-job",
    title: "Apply To Job (end-to-end)",
    description:
      "Applies to ONE job listing end-to-end: creates an account on the job board, waits for and handles email verification, fills the application from the candidate's resume and LinkedIn, and submits. Call this once PER LISTING. For multiple listings, call it multiple times in parallel — batches of 5 recommended — rather than looping through listings one at a time.",
    inputSchema: {
      type: "object",
      properties: {
        listing: {
          type: "object",
          description: "A single listing object as returned by bulk-search-job-listings",
        },
        resumeUrl: { type: "string" },
        linkedinUrl: { type: "string" },
        applicationEmail: { type: "string" },
      },
      required: ["listing", "resumeUrl", "linkedinUrl", "applicationEmail"],
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
                  note: `Found ${listings.length} listings. Recommend calling actinno/apply-to-job in parallel, batches of 5.`,
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
const APIFY_API_TOKEN = process.env.APIFY_API_TOKEN;
const GREENHOUSE_ACTOR = "automation-lab~greenhouse-jobs-scraper";

async function bulkSearchJobListings(input: Record<string, unknown>) {
  if (!APIFY_API_TOKEN) {
    throw new Error("APIFY_API_TOKEN env var not set — get one from apify.com/settings/integrations");
  }

  const { title, locations } = input as { title: string; locations?: string[] };

  // Run the actor synchronously and get dataset items back in one call.
  const runResp = await fetch(
    `https://api.apify.com/v2/acts/${GREENHOUSE_ACTOR}/run-sync-get-dataset-items?token=${APIFY_API_TOKEN}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "search",
        keywords: title.split(" ").filter(Boolean),
        location: locations?.[0],
        maxResults: 25,
        includeDescription: true,
      }),
    }
  );

  if (!runResp.ok) {
    throw new Error(`Greenhouse actor call failed: ${runResp.status} ${await runResp.text()}`);
  }

  const jobs = (await runResp.json()) as any[];

  return jobs.map((j) => ({
    company: j.company ?? j.companyName,
    title: j.title,
    applyUrl: j.applyUrl ?? j.url,
    location: j.location,
    atsProvider: "greenhouse" as const,
    requiresCoverLetter: Boolean(j.questions?.some((q: any) => /cover letter/i.test(q?.label ?? ""))),
  }));
}

async function applyToJob(input: Record<string, unknown>) {
  throw new Error("TODO: implement — Playwright account + verify + fill + submit chain (see ACT-005 through ACT-008)");
}

const transport = new StdioServerTransport();
await server.connect(transport);
