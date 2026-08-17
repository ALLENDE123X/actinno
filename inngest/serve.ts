#!/usr/bin/env node
/**
 * The HTTP endpoint the Inngest dev server talks to.
 *
 * `npx inngest-cli dev` does not execute functions itself — it is a queue and a
 * dashboard. It discovers an app by fetching a *serve endpoint*, and then calls
 * back into that endpoint once per step. So the local demo is two processes:
 *
 *     cd inngest && npm run serve   # this file — holds the functions
 *     cd inngest && npm run dev     # inngest-cli — dashboard on :8288
 *
 * Order does not matter; the CLI polls for the app and the SDK announces itself.
 *
 * No Inngest Cloud keys are needed, but dev mode is not the default: Inngest v4
 * decides cloud-vs-dev from `INNGEST_DEV` alone and ignores `NODE_ENV`. `.env`
 * carries `INNGEST_DEV=1` for that reason, and `load-env.ts` (imported by the
 * pipeline module before its client is built) is what makes sure the variable is
 * set in time. ACT-006's listener is a separate process with its own client and
 * reads the same `.env`, so it lands in the same place.
 */

import http from "node:http";

import { serve } from "inngest/node";

// Imports `./load-env.js` on its first line — nothing here may read
// `process.env` before this import has been evaluated.
import { functions, inngest } from "./job-application-pipeline.js";

const PORT = Number(process.env.INNGEST_SERVE_PORT ?? process.env.PORT ?? 3000);
const SERVE_PATH = "/api/inngest";

const handler = serve({
  client: inngest,
  functions,
  // Stated rather than inferred. The SDK normally reads the path back off the
  // request, which is fine until something sits in front of it; being explicit
  // costs nothing and means the URL the dashboard shows is the URL that works.
  servePath: SERVE_PATH,
});

const server = http.createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  if (path === SERVE_PATH) return handler(req, res);

  // A health check that answers the question anyone debugging this actually has.
  res.writeHead(path === "/" ? 200 : 404, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      app: "actinno-job-agent",
      serve: SERVE_PATH,
      functions: ["discover-listings", "apply-to-job"],
    })
  );
});

server.listen(PORT, () => {
  console.log(`[act-009] serving Inngest functions on http://localhost:${PORT}${SERVE_PATH}`);
  console.log(
    `[act-009] start the dashboard with:  npx inngest-cli@latest dev ` +
      `-u http://localhost:${PORT}${SERVE_PATH}`
  );
});
