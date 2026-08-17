/**
 * Job Application Pipeline — Inngest functions
 *
 * Flow:
 *   1. discoverListings  — ONE bulk search, sequential, runs once.
 *   2. applyToJob        — fans out from that single list. N listings =
 *                           N concurrent, independent runs of this function.
 *                           Each run is its own sequential chain internally
 *                           (account → verify → fill → submit) because those
 *                           steps are causally dependent on each other — but
 *                           every listing's chain runs in parallel with every
 *                           other listing's chain.
 */

import { Inngest } from "inngest";

export const inngest = new Inngest({ id: "actinno-job-agent" });

type JobSearchRequested = {
  data: {
    userId: string;
    resumeUrl: string;
    linkedinUrl: string;
    applicationEmail: string;
    preferences: {
      title: string;
      payMin?: number;
      locations?: string[];
    };
  };
};

type JobApplicationRequested = {
  data: {
    userId: string;
    resumeUrl: string;
    linkedinUrl: string;
    applicationEmail: string;
    listing: {
      company: string;
      title: string;
      applyUrl: string;
      atsProvider: "greenhouse" | "lever" | "other";
    };
  };
};

export const discoverListings = inngest.createFunction(
  { id: "discover-listings" },
  { event: "job-search/requested" },
  async ({ event, step }: { event: JobSearchRequested; step: any }) => {
    const { userId, resumeUrl, linkedinUrl, applicationEmail, preferences } =
      event.data;

    const listings = await step.run("bulk-search-job-boards", async () => {
      return await searchJobBoards(preferences);
    });

    await step.run("log-discovery", async () => {
      console.log(`Found ${listings.length} matching listings for ${userId}`);
    });

    const events = listings.map((listing: any) => ({
      name: "job-application/requested" as const,
      data: { userId, resumeUrl, linkedinUrl, applicationEmail, listing },
    }));

    await step.sendEvent("fan-out-applications", events);

    return { discovered: listings.length };
  }
);

export const applyToJob = inngest.createFunction(
  {
    id: "apply-to-job",
    concurrency: { limit: 5 },
  },
  { event: "job-application/requested" },
  async ({ event, step }: { event: JobApplicationRequested; step: any }) => {
    const { userId, resumeUrl, linkedinUrl, applicationEmail, listing } =
      event.data;

    const account = await step.run("create-account", async () => {
      return await createJobBoardAccount({ applyUrl: listing.applyUrl, email: applicationEmail });
    });

    const verification = await step.waitForEvent("await-verification", {
      event: "email/verification-received",
      timeout: "10m",
      if: `async.data.userId == "${userId}" && async.data.company == "${listing.company}"`,
    });

    if (!verification) {
      await step.run("log-verification-timeout", async () => {
        await updateTrackerRow(userId, listing, "verification_timeout");
      });
      return { status: "verification_timeout", listing };
    }

    const filled = await step.run("fill-application", async () => {
      return await fillApplicationForm({
        accountSession: account.session,
        resumeUrl,
        linkedinUrl,
        requiresCoverLetter: listing.requiresCoverLetter,
      });
    });

    const result = await step.run("submit-application", async () => {
      return await submitApplication(filled);
    });

    await step.run("log-to-tracker", async () => {
      await updateTrackerRow(userId, listing, "submitted", result);
    });

    return { status: "submitted", listing };
  }
);

async function searchJobBoards(preferences: any) {
  throw new Error("TODO: call Apify job-board search actor (see ACT-002 — done in mcp-server/index.ts, port here)");
}
async function createJobBoardAccount(args: any) {
  throw new Error("TODO: Playwright account creation flow (ACT-005)");
}
async function fillApplicationForm(args: any) {
  throw new Error("TODO: Playwright form-fill from resume + LinkedIn (ACT-007)");
}
async function submitApplication(filled: any) {
  throw new Error("TODO: submit + capture confirmation (ACT-008)");
}
async function updateTrackerRow(userId: string, listing: any, status: string, result?: any) {
  throw new Error("TODO: write row to Supabase job_applications table (ACT-003/009)");
}
