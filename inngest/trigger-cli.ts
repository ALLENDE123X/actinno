#!/usr/bin/env node
/**
 * Sends one `job-search/requested` event — the pipeline's front door until
 * ACT-010 wires the MCP `apply-to-job` tool to it.
 *
 *   cd inngest
 *   npm run trigger -- --candidate <uuid> --companies stripe,airbnb \
 *                      --title "software engineer" --location Remote
 *
 * The dev dashboard can send the same event by hand; this exists because the
 * acceptance check for ACT-009 is "trigger it with real preferences and watch N
 * runs fan out", and a command that always sends the same well-formed payload is
 * a better test than a JSON box.
 *
 * ⚠️  This starts REAL browser runs. Discovery itself is harmless — one
 * read-only Apify call — but each listing it finds fans out into an
 * `apply-to-job` run that opens a browser against a real employer and, at the
 * end of it, submits a real application. `--discover-only` stops after the
 * search and prints what *would* have been dispatched.
 */

import { Inngest } from "inngest";

// Imports `./load-env.js` on its first line, so `INNGEST_DEV` is set before the
// client below is constructed. See that file.
import { JOB_SEARCH_REQUESTED, type JobSearchRequestedData } from "./job-application-pipeline.js";

const USAGE = [
  "Usage: npm run trigger -- --candidate <uuid> --companies <slug,slug>",
  "                         [--title <text>] [--location <text>] [--pay-min <n>]",
  "                         [--max-per-company <n>] [--discover-only]",
  "",
  "  --candidate         candidates.id UUID from ACT-003 intake",
  "  --companies         Greenhouse board slugs, comma-separated (required —",
  "                      the actor lists jobs per board, it cannot search)",
  "  --title             narrows by title; defaults to the candidate's target_title",
  "  --location          defaults to the candidate's first stored location",
  "  --discover-only     run the search here and print it. Sends NOTHING, so no",
  "                      browser is ever opened and no application is submitted.",
].join("\n");

function arg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const at = argv.indexOf(`--${name}`);
  if (at !== -1) return argv[at + 1];
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  return inline?.slice(name.length + 3);
}

const has = (name: string): boolean => process.argv.slice(2).includes(`--${name}`);

async function main(): Promise<number> {
  const candidateId = arg("candidate")?.trim();
  const companies = (arg("companies") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!candidateId || companies.length === 0) {
    console.error(USAGE);
    return 1;
  }

  const payMinRaw = arg("pay-min");
  const maxRaw = arg("max-per-company");
  const location = arg("location")?.trim();
  const title = arg("title")?.trim();

  const preferences: JobSearchRequestedData["preferences"] = {
    companies,
    ...(title ? { title } : {}),
    ...(location ? { locations: [location] } : {}),
    ...(payMinRaw ? { payMin: Number(payMinRaw) } : {}),
    ...(maxRaw ? { maxPerCompany: Number(maxRaw) } : {}),
  };

  if (has("discover-only")) {
    // Deliberately calls the search directly instead of sending the event.
    // Sending it would run discovery *and* fan out, and the fan-out is the part
    // that opens browsers.
    const { searchJobListings } = await import("../lib/search-job-listings.js");
    const listings = await searchJobListings({ ...preferences, companies });
    console.log(`\n${listings.length} listing(s) — this is what would have fanned out:\n`);
    for (const l of listings) {
      console.log(
        `  · ${l.company} — ${l.title}\n    ${l.applyUrl}\n` +
          `    location: ${l.location ?? "(none)"}, cover letter required: ` +
          `${l.requiresCoverLetter}, description: ${l.jobDescription?.length ?? 0} chars`
      );
    }
    console.log("\nNothing was sent. Drop --discover-only to run the real pipeline.\n");
    return 0;
  }

  // Same app id as the pipeline's client and ACT-006's sender. Cosmetic for a
  // send-only client — it never serves, so it never registers as a second app —
  // but the repo keeps them identical and there is no reason to be the exception.
  const inngest = new Inngest({ id: "actinno-job-agent" });
  const data: JobSearchRequestedData = { candidateId, preferences };
  const { ids } = await inngest.send({ name: JOB_SEARCH_REQUESTED, data });

  console.log(`Sent ${JOB_SEARCH_REQUESTED} (event ${ids[0]}) for candidate ${candidateId}.`);
  console.log("Watch it at http://localhost:8288 — discovery runs once, then one");
  console.log("apply-to-job run per listing, five at a time.");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
);
