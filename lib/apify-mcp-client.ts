/**
 * ACT-005 — client for driving nexgendata/playwright-mcp-server on Apify.
 *
 * There are two transports in here, and the difference between them is the
 * whole point of this module:
 *
 *  - `DedicatedActorRun` (default) starts *our own* Actor run via the plain
 *    Actor Run API and talks MCP straight to that run's container. One run, one
 *    browser, one MCP session table, reachable by nobody else. This is what
 *    makes a 20-call account-creation flow survivable.
 *  - `ApifyMcpSession` is the original path: Apify's hosted MCP server at
 *    https://mcp.apify.com and its `call-actor` tool, which proxies each call
 *    into the Actor's *standby* pool. Kept as a fallback (see
 *    `openPlaywrightSession`) and for `fetch-actor-details`.
 *
 * The `call-actor` path's shape was verified live against mcp.apify.com
 * v0.14.3 (2026-08-17), not taken from docs:
 *  - Streamable HTTP at the root path; auth is `Authorization: Bearer <token>`.
 *  - `fetch-actor-details` with `output: { mcpTools: true }` lists an MCP
 *    Actor's tools. `mcpTools` is the one output flag that is OFF by default.
 *  - An MCP Actor's individual tools are invoked through `call-actor` with
 *    `actor` set to `"<username>/<actor>:<toolName>"` — there is no separate
 *    per-tool endpoint, and no `add-actor` step is required.
 *  - `call-actor` returns the tool's payload as a JSON *string* in
 *    `content[0].text`, never as structured content — hence `parseToolPayload`.
 *  - `waitSecs` is capped at 45 by the server; larger values are rejected.
 *
 * IMPORTANT — browser state, replicas, and concurrency. The Playwright Actor
 * keeps a single browser per standby *replica*, and that browser survives
 * across `call-actor` calls (verified: navigate to example.com, then `get_text`
 * with no arguments returned example.com's text). That is what makes
 * navigate → evaluate → click compose like a normal Playwright script.
 *
 * The flip side is that "the standby instance" is not one machine. Apify
 * autoscales the Actor's standby into several concurrent replicas, each its own
 * Actor run with its own browser *and its own in-memory MCP session table*, and
 * routes each incoming request to one of them. Reading the replicas' own logs
 * during a single run of this repo's CLI (2026-08-17) showed three replicas
 * started within 46s of each other, and on two of them:
 *
 *     INFO: 172.20.0.1:50156 - "POST /mcp HTTP/1.1" 404 Not Found
 *
 * — a call carrying a session id that replica had never issued, immediately
 * followed by a fresh handshake. That 404 is what surfaces to us as
 * `"Session not found"` (see `SESSION_LOST_RE`): not a crash, not a recycle,
 * not another tenant, but *our own* call landing on a replica that does not
 * know us. The odds of it scale with how many replicas are warm, which scales
 * with how many calls we make and how fast.
 *
 * Two consequences, both bigger than one ticket:
 *  - Sequential calls are only implicitly pinned to one browser. A run that
 *    survives is one whose calls happened to keep landing on the same replica.
 *  - `inngest/job-application-pipeline.ts` fans out with
 *    `concurrency: { limit: 5 }`, which multiplies both the replica count and
 *    the chance of two runs sharing one browser.
 *
 * ── The fix, and how it was established ──────────────────────────────────────
 *
 * Apify's standby load balancer offers no caller-visible way to pin requests to
 * one replica — no affinity cookie, no run-id header, no query param. Pinning
 * is therefore not achievable *through the standby endpoint at all*, and no
 * amount of retry tuning changes that. What is achievable is not using it.
 *
 * Verified live against the Apify API on 2026-08-17, each step by observation
 * rather than from docs:
 *  - `POST /v2/acts/nexgendata~playwright-mcp-server/runs` starts an ordinary
 *    Actor run (`meta.origin: "API"`, not `"STANDBY"`). The run object carries
 *    `containerUrl`, e.g. `https://kla7esogzhv3.runs.apify.net` — a hostname
 *    unique to that one run's container.
 *  - This Actor starts the same HTTP server in an API-started run as it does in
 *    standby: `GET {containerUrl}/` answers
 *    `{"status":"ok","service":"playwright-mcp-server","mcp_endpoint":"/mcp"}`,
 *    and `POST {containerUrl}/mcp` speaks Streamable HTTP MCP, issuing its own
 *    `mcp-session-id`. All 17 tools are listed and callable there, with
 *    byte-identical result envelopes to the `call-actor` path (a JSON string in
 *    `content[0].text`), so `PlaywrightBrowser` is unchanged by the switch.
 *  - Browser state persists across calls on that container exactly as it does
 *    on a standby replica (navigate → evaluate read back the same URL).
 *  - The container answered in **~4 seconds** from `POST .../runs` to HTTP 200.
 *    A dedicated run is not the 30-60s cold start it might sound like.
 *  - Nothing else can be routed to it. There is no balancer in front of a
 *    container URL: it is one container, and the only way to reach it is to
 *    hold the URL, which only the caller that started the run is given.
 *
 * Two properties of that container are load-bearing enough to state plainly:
 *  - It self-terminates on idle — measured at ~90s after the last tool call,
 *    and at 70s for a run that never received one. `DedicatedActorRun`
 *    therefore keeps it warm on a timer (see `KEEPALIVE_INTERVAL_MS`, which
 *    also records what does and does not count as activity) so a long think
 *    between tool calls cannot silently delete the browser mid-flow. That idle
 *    exit is also the safety net that stops a leaked run billing forever.
 *  - It is served on an unguessable hostname with no authentication. Holding
 *    the URL is the credential. We never print it (see `label`), and the run is
 *    aborted the moment the flow ends.
 *
 * The bounded fresh-session recovery in `create-board-account.ts` is kept on
 * top of this, and it is not ceremonial — it fired on the first live run of the
 * dedicated path (2026-08-17): an `evaluate` on run KDgA7eYrUWOXXJ3V7 came back
 * with `"Session not found"` while the platform still reported that run as
 * RUNNING. So the Actor's own server can lose a session *inside* one container,
 * independently of the standby routing this replaces — a worker restart or a
 * server-side session reaper would both look like this from out here, and the
 * Actor's source is closed. What changed is the scale: that was one loss at the
 * start of a flow, recovered from, and the flow then ran ~20 calls to
 * completion on a single container. Do not read "dedicated" as "the session can
 * never be lost"; read it as "losing it is no longer a function of how many
 * calls you make".
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export const APIFY_MCP_URL = "https://mcp.apify.com/";

/** The Playwright browser-automation MCP Actor this repo drives. */
export const PLAYWRIGHT_MCP_ACTOR = "nexgendata/playwright-mcp-server";

/** Server-side cap on `call-actor`'s `waitSecs`. Anything higher is rejected. */
const MAX_WAIT_SECS = 45;

/**
 * Client-side ceiling per MCP request. Must exceed `MAX_WAIT_SECS` plus Apify's
 * own proxying overhead, otherwise a slow navigation aborts locally while the
 * Actor is still working (and we would still be billed for the tool call).
 */
const REQUEST_TIMEOUT_MS = 120_000;

/**
 * Signature of the Actor-side session dying underneath us.
 *
 * There are *two* MCP sessions in play, one nested inside the other: ours with
 * mcp.apify.com, and a second one that `call-actor` holds with the Playwright
 * Actor's standby. Only the outer one is ours to manage. When a call is routed
 * to a standby replica that never issued the inner session — see the header's
 * account of the replica fan-out, which is the mechanism — it fails, verbatim:
 *
 *   Apify MCP tool "call-actor" returned an error: Failed to call MCP tool
 *   'click' on Actor 'nexgendata/playwright-mcp-server': Streamable HTTP error:
 *   Error POSTing to endpoint: {"jsonrpc":"2.0","id":"server-error","error":
 *   {"code":-32600,"message":"Session not found"}}. The MCP server may be
 *   temporarily unavailable. …
 *
 * (recorded verbatim on `job_applications` 267ac472-…, 2026-08-17). It is not a
 * property of any one tool — seen at both `click` and `evaluate`, at
 * essentially arbitrary points in a call sequence.
 *
 * Recovery is a brand-new session, which means a brand-new browser with no
 * navigation history. Note what that does and does not buy: because the cause
 * is routing rather than a dead machine, a plain retry on the same session
 * might also happen to land back on a replica that still knows it — but that is
 * a coin toss on Apify's load balancer, and a re-navigation inside a session
 * whose browser we may no longer be reaching is exactly the retry that does
 * nothing. A new session is the one recovery whose starting state we can
 * actually name: an empty browser. Whether starting from an empty browser is
 * *safe* is a question only the caller can answer, so this module classifies
 * the failure and `create-board-account.ts` decides what to do about it.
 *
 * Matched on the message, not on the JSON-RPC code: -32600 is the generic
 * "invalid request" code and carries no session meaning of its own.
 */
const SESSION_LOST_RE = /\bsession not found\b/i;

/** Raised for any Apify/MCP transport or tool-level failure. Never wraps credentials. */
export class ApifyMcpError extends Error {
  readonly tool: string | undefined;

  /**
   * True when this failure is the dead-session case above rather than an
   * ordinary tool failure (a selector that did not match, a navigation
   * timeout). Computed once at construction so callers test a flag instead of
   * re-deriving a regex against a message that may since have been reworded.
   */
  readonly sessionLost: boolean;

  /**
   * @param sessionLost Overrides the message-sniffing default. The dedicated
   *   transport needs this: when the container behind a run is gone, the
   *   failure that reaches us is a connection or 404 error whose text says
   *   nothing about sessions, but the *meaning* — "the browser you were driving
   *   no longer exists" — is exactly what `SESSION_LOST_RE` stands for, and
   *   callers key their recovery off that meaning. Only ever set true after the
   *   run has been observed to be in a terminal state (see `runIsGone` and its
   *   call site in `DedicatedActorRun.callPlaywrightTool`'s catch) so an
   *   ordinary tool error can never be mislabelled as a dead browser.
   */
  constructor(message: string, tool?: string, sessionLost?: boolean) {
    super(message);
    this.name = "ApifyMcpError";
    this.tool = tool;
    this.sessionLost = sessionLost ?? SESSION_LOST_RE.test(message);
  }
}

/**
 * Whether a caught value is the Actor-side session having died.
 *
 * Deliberately narrowed to `ApifyMcpError` instead of testing any Error's
 * message: these messages are built from Apify's own tool-result envelope,
 * whereas *page content* can say anything. A real ATS page titled "Session not
 * found" (an expired candidate portal — exactly the kind of page this flow
 * lands on) must not be mistaken for a dead browser by, say, a probe-shape
 * assertion that quotes the page back in its message.
 */
export function isSessionLostError(err: unknown): boolean {
  return err instanceof ApifyMcpError && err.sessionLost;
}

type McpToolResult = {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
};

/** Flattens an MCP tool result's content blocks into one string. */
function flattenContent(result: McpToolResult): string {
  if (!Array.isArray(result.content)) return "";
  return result.content
    .map((block) => (typeof block?.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

/** Keeps error messages bounded — an Actor can return a whole page of HTML. */
function truncate(text: string, max = 400): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * One way of reaching the Playwright Actor's tools, whichever transport is
 * behind it. `PlaywrightBrowser` is written against this and nothing else, so
 * the shared-standby and dedicated-run paths are interchangeable at the call
 * site and the flow code cannot accidentally depend on one of them.
 *
 * The three flags are here because `create-board-account.ts` has real decisions
 * to make about them — not as documentation.
 */
export interface PlaywrightSession {
  /**
   * Short description for logs. Must never contain the container URL or the API
   * token: for a dedicated run the URL *is* the access credential.
   */
  readonly label: string;

  /**
   * True when this session's browser cannot be reached by any other caller and
   * no other caller's request can be routed into it.
   */
  readonly isolated: boolean;

  /**
   * True when `release()` destroys the Actor-side browser by itself. Lets the
   * caller skip a `close_browser` call that would be pure cost — on the
   * dedicated path the browser dies with the container we are about to abort.
   */
  readonly disposesBrowser: boolean;

  /**
   * Invokes one tool on the Playwright Actor.
   *
   * @param waitSecs Only meaningful on the `call-actor` path, where it is the
   *   proxy's wait budget. Ignored by the dedicated transport, which has no
   *   proxy in between and is bounded by `REQUEST_TIMEOUT_MS` instead.
   */
  callPlaywrightTool<T = unknown>(
    tool: string,
    input?: Record<string, unknown>,
    waitSecs?: number
  ): Promise<T>;

  /**
   * Releases everything this session owns: always the local transport, and for
   * a dedicated run the remote container too.
   *
   * @param keepRemote Leaves the Actor run alive (for `--keep-browser`). The
   *   local transport is closed either way — leaving it open would hang the
   *   CLI. A kept run is not immortal: it idles out on its own in ~90s.
   */
  release(keepRemote?: boolean): Promise<void>;
}

/**
 * A live MCP session against Apify's hosted server. Open one per unit of work
 * and always `close()` it — the SDK's transport holds an open HTTP connection,
 * which keeps a short-lived process (the CLI) from exiting.
 *
 * Every call it makes goes through `call-actor` into the shared standby pool,
 * so `isolated` is false and the `"Session not found"` failure this module
 * documents at length is a live risk on every call. Prefer
 * `openPlaywrightSession()`.
 */
export class ApifyMcpSession implements PlaywrightSession {
  readonly label = "shared standby pool via mcp.apify.com";
  readonly isolated = false;
  readonly disposesBrowser = false;

  private constructor(private readonly client: Client) {}

  /**
   * Connects and completes the MCP handshake.
   *
   * @param token Apify API token. Defaults to `APIFY_API_TOKEN` from the env.
   */
  static async open(token = process.env.APIFY_API_TOKEN): Promise<ApifyMcpSession> {
    if (!token) {
      throw new ApifyMcpError(
        "APIFY_API_TOKEN env var is required (get one from apify.com/settings/integrations)"
      );
    }

    const client = new Client(
      { name: "actinno", version: "0.1.0" },
      { capabilities: {} }
    );
    // The token goes in the Authorization header rather than a `?token=` query
    // param so it cannot leak into an intermediary's request logs.
    const transport = new StreamableHTTPClientTransport(new URL(APIFY_MCP_URL), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });

    try {
      await client.connect(transport);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new ApifyMcpError(`Could not connect to ${APIFY_MCP_URL}: ${reason}`);
    }
    return new ApifyMcpSession(client);
  }

  /** Calls a tool on the Apify MCP server itself and returns its text content. */
  private async callServerTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<string> {
    let result: McpToolResult;
    try {
      result = (await this.client.callTool(
        { name, arguments: args },
        undefined,
        { timeout: REQUEST_TIMEOUT_MS }
      )) as McpToolResult;
    } catch (err) {
      // Transport-level failure (network, timeout, JSON-RPC error response).
      const reason = err instanceof Error ? err.message : String(err);
      throw new ApifyMcpError(`Apify MCP tool "${name}" failed: ${reason}`, name);
    }

    const text = flattenContent(result);
    // A failing Actor tool comes back as a normal result with isError set, not
    // as a JSON-RPC error, so this branch is the one that actually fires when
    // e.g. a selector does not match.
    if (result.isError) {
      throw new ApifyMcpError(
        `Apify MCP tool "${name}" returned an error: ${truncate(text) || "(no message)"}`,
        name
      );
    }
    return text;
  }

  /**
   * Lists the MCP tools exposed by an MCP-server Actor. Returns Apify's
   * markdown listing verbatim — this is a discovery/diagnostic aid, so it is
   * deliberately not parsed into a structure that would drift from the source.
   */
  async fetchActorMcpTools(actor: string): Promise<string> {
    return await this.callServerTool("fetch-actor-details", {
      actor,
      output: { mcpTools: true },
    });
  }

  /**
   * Invokes one tool on an MCP-server Actor.
   *
   * @param actor    Actor full name, e.g. `nexgendata/playwright-mcp-server`.
   * @param tool     Tool name on that Actor, e.g. `navigate`.
   * @param input    Tool arguments.
   * @param waitSecs Seconds to wait for completion; clamped to Apify's max of 45.
   */
  async callActorTool<T = unknown>(
    actor: string,
    tool: string,
    input: Record<string, unknown> = {},
    waitSecs = 30
  ): Promise<T> {
    const qualified = `${actor}:${tool}`;
    const text = await this.callServerTool("call-actor", {
      actor: qualified,
      input,
      waitSecs: Math.min(Math.max(waitSecs, 0), MAX_WAIT_SECS),
    });
    const payload = parseToolPayload<T>(text, qualified);
    assertSessionAlive(payload, qualified);
    return payload;
  }

  /** `PlaywrightSession` view of `callActorTool`, pinned to the one Actor. */
  async callPlaywrightTool<T = unknown>(
    tool: string,
    input: Record<string, unknown> = {},
    waitSecs = 30
  ): Promise<T> {
    return await this.callActorTool<T>(PLAYWRIGHT_MCP_ACTOR, tool, input, waitSecs);
  }

  /**
   * There is no remote resource of ours to release here — the standby pool is
   * Apify's to scale and idle out — so `keepRemote` is accepted for interface
   * conformance and has nothing to act on.
   */
  async release(_keepRemote = false): Promise<void> {
    await this.close();
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

// ───────────────────────────────────
// Dedicated Actor run — the isolated transport
// ───────────────────────────────────

const APIFY_API_BASE = "https://api.apify.com/v2";

/** `username/actor` in the form the Actor Run API wants inside a URL path. */
const ACTOR_API_PATH = PLAYWRIGHT_MCP_ACTOR.replace("/", "~");

/**
 * Deliberately the Actor's own standby memory (`actorStandby.memoryMbytes`)
 * rather than its `defaultRunOptions` 1024: a dedicated run should be the same
 * machine a standby replica would have been, so nothing about page rendering or
 * timing changes when the transport does. It also keeps the start charge at one
 * event ("one event per GB, minimum one").
 */
const RUN_MEMORY_MBYTES = 512;

/**
 * Wall-clock ceiling for one run. Generous next to a realistic flow (a Workday
 * account creation is minutes, not tens of minutes) because the run is aborted
 * explicitly in `release()`; this only bounds the case where that never
 * happens — a crashed CLI, a killed Inngest worker.
 */
const RUN_TIMEOUT_SECS = 900;

/**
 * Spend ceiling for one run, enforced by Apify rather than by us. At this
 * Actor's $0.10-per-charged-item price and its two charged items per tool call,
 * $12 is ~60 tool calls: far above the ~20 a real account-creation flow makes,
 * far below the $170 default that a runaway loop would otherwise be free to
 * spend. If a flow ever legitimately needs more than this, that is a bug in the
 * flow worth being interrupted by.
 */
const RUN_MAX_TOTAL_CHARGE_USD = 12;

/** The Actor's own documented defaults, passed explicitly so a change to them upstream cannot silently move the viewport under a form flow. No proxy: standby runs get no input at all (`shouldPassActorInput: false`), and matching that keeps the exit IP behaviour identical to what this pipeline has been tested against. */
const RUN_INPUT = { headless: true, viewportWidth: 1280, viewportHeight: 720 } as const;

const CONTAINER_READY_TIMEOUT_MS = 120_000;
const CONTAINER_POLL_INTERVAL_MS = 750;
const CONTAINER_PROBE_TIMEOUT_MS = 8_000;
const RUN_API_TIMEOUT_MS = 30_000;

/**
 * Idle-timer management, and the measurement that shaped it.
 *
 * A dedicated run kills itself when it stops hearing from us. What counts as
 * "hearing from us" was measured, not assumed, because the obvious answer is
 * wrong: a run pinged on its health endpoint (`GET /`) every 20s and given no
 * MCP traffic **still exited after 70s** (2026-08-17). Plain HTTP on the health
 * path does not reset the timer. What does is a request on `/mcp`, so the
 * keepalive is a `tools/list` — an MCP request that pushes no dataset item and
 * is therefore free, unlike the $0.10-a-piece items a tool call writes.
 *
 * The keepalive only fires when the session has actually gone quiet: a flow in
 * mid-stride is already resetting the timer with every tool call, and injecting
 * an unnecessary request alongside one in flight is a race not worth having for
 * no benefit.
 */
const KEEPALIVE_INTERVAL_MS = 20_000;
const KEEPALIVE_IDLE_MS = 30_000;

/** Run statuses from which no further tool call can ever succeed. */
const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  "SUCCEEDED",
  "FAILED",
  "ABORTING",
  "ABORTED",
  "TIMING-OUT",
  "TIMED-OUT",
]);

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

type RunSummary = { id: string; containerUrl: string };

/**
 * An Actor run started by us, driven directly at its own container.
 *
 * This is the isolation the module header argues for: the standby balancer is
 * not involved, so there is no other replica for a call to land on and no other
 * caller who can land on ours.
 */
export class DedicatedActorRun implements PlaywrightSession {
  readonly isolated = true;
  readonly disposesBrowser = true;
  readonly label: string;

  /** Kept alive against the container's idle timer; cleared in `release()`. */
  private keepalive: NodeJS.Timeout | undefined;
  private released = false;
  /** Last MCP request on this session — a tool call or a keepalive. */
  private lastActivityAt = Date.now();
  private inFlight = 0;

  private constructor(
    private readonly client: Client,
    private readonly runId: string,
    private readonly containerUrl: string,
    private readonly token: string
  ) {
    // The run id, never the container URL — the URL is unauthenticated, so it
    // is a credential and logs are not where credentials go. The id is enough
    // to find the run in the Apify console.
    this.label = `dedicated Actor run ${runId}`;
    this.keepalive = setInterval(() => void this.ping(), KEEPALIVE_INTERVAL_MS);
    // Never the reason a finished CLI stays alive.
    this.keepalive.unref();
  }

  /** Starts a run, waits for its MCP server, and completes the handshake. */
  static async start(token = process.env.APIFY_API_TOKEN): Promise<DedicatedActorRun> {
    if (!token) {
      throw new ApifyMcpError(
        "APIFY_API_TOKEN env var is required (get one from apify.com/settings/integrations)"
      );
    }

    const run = await startRun(token);
    try {
      await waitForContainer(run, token);

      const client = new Client({ name: "actinno", version: "0.1.0" }, { capabilities: {} });
      // No Authorization header: a run's container URL carries no auth of its
      // own (verified — an unauthenticated GET is answered), and sending the
      // account token to a third-party Actor's process would hand it a
      // credential it has no business holding. The hosted-MCP path has to send
      // it because that endpoint is Apify's own.
      const transport = new StreamableHTTPClientTransport(new URL(`${run.containerUrl}/mcp`));
      await client.connect(transport);

      return new DedicatedActorRun(client, run.id, run.containerUrl, token);
    } catch (err) {
      // Anything that fails after the run exists must not leave it billing.
      await abortRun(run.id, token);
      if (err instanceof ApifyMcpError) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      throw new ApifyMcpError(
        `MCP handshake with dedicated run ${run.id} failed: ${reason}`
      );
    }
  }

  async callPlaywrightTool<T = unknown>(
    tool: string,
    input: Record<string, unknown> = {},
    // Accepted for interface conformance. There is no `call-actor` proxy in
    // this path to hand a wait budget to; `REQUEST_TIMEOUT_MS` is the bound.
    _waitSecs?: number
  ): Promise<T> {
    let result: McpToolResult;
    this.inFlight++;
    this.lastActivityAt = Date.now();
    try {
      result = (await this.client.callTool(
        { name: tool, arguments: input },
        undefined,
        { timeout: REQUEST_TIMEOUT_MS }
      )) as McpToolResult;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // Ask the platform whether the container is gone rather than guessing
      // from the message. `undefined` (not `false`) when it is still alive, so
      // an in-message "Session not found" — a container that restarted its
      // process while the run kept going — is still classified by the regex.
      const gone = await this.runIsGone();
      throw new ApifyMcpError(
        gone
          ? `"${tool}" failed because ${this.label} is no longer running: ${reason}. ` +
            `The dedicated browser died with it.`
          : `"${tool}" failed on ${this.label}: ${reason}`,
        tool,
        gone || undefined
      );
    } finally {
      this.inFlight--;
      this.lastActivityAt = Date.now();
    }

    const text = flattenContent(result);
    if (result.isError) {
      throw new ApifyMcpError(
        `"${tool}" returned an error: ${truncate(text) || "(no message)"}`,
        tool
      );
    }
    const payload = parseToolPayload<T>(text, tool);
    assertSessionAlive(payload, tool);
    return payload;
  }

  async release(keepRemote = false): Promise<void> {
    if (this.keepalive) {
      clearInterval(this.keepalive);
      this.keepalive = undefined;
    }
    if (this.released) return;
    this.released = true;

    try {
      await this.client.close();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`[apify] closing the transport to ${this.label} failed (ignored): ${reason}`);
    }

    if (keepRemote) {
      console.warn(
        `[apify] leaving ${this.label} alive for inspection — ` +
          `https://console.apify.com/view/runs/${this.runId} — ` +
          `it exits by itself after ~90s with no traffic`
      );
      return;
    }
    await abortRun(this.runId, this.token);
  }

  /**
   * Free MCP request whose only job is to reset the container's idle timer.
   * Skipped whenever the flow is keeping the session busy on its own.
   */
  private async ping(): Promise<void> {
    if (this.released || this.inFlight > 0) return;
    if (Date.now() - this.lastActivityAt < KEEPALIVE_IDLE_MS) return;
    try {
      await this.client.listTools(undefined, { timeout: CONTAINER_PROBE_TIMEOUT_MS });
      this.lastActivityAt = Date.now();
    } catch {
      // A missed ping proves nothing on its own — the next tool call is the
      // honest test, and it classifies the failure properly.
    }
  }

  /**
   * Whether the run has reached a state from which nothing can succeed.
   * Deliberately answers `false` when the API cannot be reached: claiming the
   * browser is dead is what triggers a caller's restart, and a network blip on
   * *our* side is not evidence for that.
   */
  private async runIsGone(): Promise<boolean> {
    const status = await fetchRunStatus(this.runId, this.token);
    return status !== undefined && TERMINAL_RUN_STATUSES.has(status);
  }
}

export type OpenSessionOptions = {
  token?: string;
  /**
   * Set false to force the shared standby pool. Exists so the fallback path
   * stays reachable and testable, not because it is ever the better choice.
   */
  dedicated?: boolean;
};

/**
 * The way flow code should get a browser: a dedicated run when one can be
 * started, the shared standby pool when one cannot.
 *
 * The fallback is loud on purpose. It is strictly worse — it reintroduces the
 * replica-routing failure this module exists to escape — but it is also the
 * behaviour this pipeline had before, and silently refusing to run at all when
 * the Run API is briefly unavailable would trade a flaky flow for no flow.
 */
export async function openPlaywrightSession(
  options: OpenSessionOptions = {}
): Promise<PlaywrightSession> {
  const { token = process.env.APIFY_API_TOKEN, dedicated = true } = options;

  if (dedicated) {
    try {
      const run = await DedicatedActorRun.start(token);
      console.log(
        `[apify] ${run.label} — isolated browser, no standby balancer in front of it`
      );
      return run;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(
        `[apify] could not start a dedicated Actor run (${reason}) — falling back to the ` +
          `SHARED standby pool, where a mid-flow call can be routed to a replica that never ` +
          `saw this session ("Session not found"). Expect this flow to be less reliable.`
      );
    }
  }
  return await ApifyMcpSession.open(token);
}

/** POSTs the run start. The response is Apify's, so nothing in it is assumed. */
async function startRun(token: string): Promise<RunSummary> {
  const params = new URLSearchParams({
    memory: String(RUN_MEMORY_MBYTES),
    timeout: String(RUN_TIMEOUT_SECS),
    maxTotalChargeUsd: String(RUN_MAX_TOTAL_CHARGE_USD),
  });

  let res: Response;
  try {
    res = await fetch(`${APIFY_API_BASE}/acts/${ACTOR_API_PATH}/runs?${params}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(RUN_INPUT),
      signal: AbortSignal.timeout(RUN_API_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ApifyMcpError(`Could not reach the Apify Run API: ${reason}`);
  }

  const body = await res.text().catch(() => "");
  if (!res.ok) {
    throw new ApifyMcpError(
      `Apify refused to start a ${PLAYWRIGHT_MCP_ACTOR} run: HTTP ${res.status} ${truncate(body)}`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new ApifyMcpError(`Apify Run API returned non-JSON: ${truncate(body)}`);
  }
  const data = (parsed as { data?: unknown }).data;
  const id = (data as { id?: unknown } | undefined)?.id;
  const containerUrl = (data as { containerUrl?: unknown } | undefined)?.containerUrl;
  if (typeof id !== "string" || typeof containerUrl !== "string" || containerUrl === "") {
    // Report which fields were bad without the raw body — it may legitimately
    // contain a real containerUrl even when `id` is the field that's missing,
    // and that URL is a bearer credential that must never reach a log line.
    throw new ApifyMcpError(
      `Apify Run API returned no usable run id / containerUrl (id: ${typeof id}, ` +
        `containerUrl: ${typeof containerUrl === "string" ? "empty string" : typeof containerUrl})`
    );
  }
  // Trailing slash would double up against the "/mcp" and "/" paths below.
  return { id, containerUrl: containerUrl.replace(/\/+$/, "") };
}

/**
 * Waits for the run's own HTTP server to answer. Polls the health endpoint
 * rather than the run's `status`: `RUNNING` means the container was scheduled,
 * not that uvicorn is listening, and connecting a millisecond early is a
 * failure that looks exactly like the Actor being broken.
 */
async function waitForContainer(run: RunSummary, token: string): Promise<void> {
  const deadline = Date.now() + CONTAINER_READY_TIMEOUT_MS;
  let attempts = 0;
  let lastReason = "no probe completed";

  while (Date.now() < deadline) {
    attempts++;
    try {
      const res = await fetch(`${run.containerUrl}/`, {
        signal: AbortSignal.timeout(CONTAINER_PROBE_TIMEOUT_MS),
      });
      await res.text().catch(() => "");
      if (res.ok) return;
      lastReason = `HTTP ${res.status}`;
    } catch (err) {
      lastReason = err instanceof Error ? err.message : String(err);
    }

    // Cheap, and it turns "the Actor failed to boot" from a two-minute wait
    // into a few seconds — the run's status is the only place that failure is
    // ever reported, since a dead container just refuses connections.
    if (attempts % 5 === 0) {
      const status = await fetchRunStatus(run.id, token);
      if (status !== undefined && TERMINAL_RUN_STATUSES.has(status)) {
        throw new ApifyMcpError(
          `Dedicated run ${run.id} reached ${status} before its MCP server answered ` +
            `(last probe: ${lastReason})`
        );
      }
    }
    await delay(CONTAINER_POLL_INTERVAL_MS);
  }

  throw new ApifyMcpError(
    `Dedicated run ${run.id} did not serve its MCP endpoint within ` +
      `${Math.round(CONTAINER_READY_TIMEOUT_MS / 1000)}s (last probe: ${lastReason})`
  );
}

/** Current run status, or undefined when the platform could not be asked. */
async function fetchRunStatus(runId: string, token: string): Promise<string | undefined> {
  try {
    const res = await fetch(`${APIFY_API_BASE}/actor-runs/${runId}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(RUN_API_TIMEOUT_MS),
    });
    const body = await res.text().catch(() => "");
    if (!res.ok) return undefined;
    const status = (JSON.parse(body) as { data?: { status?: unknown } }).data?.status;
    return typeof status === "string" ? status : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Stops a run and its billing. Never throws: this is called from teardown and
 * from failure paths, where the caller's own error is the one worth keeping.
 * A run that survives a failed abort still idles out in ~90s.
 */
async function abortRun(runId: string, token: string): Promise<void> {
  try {
    const res = await fetch(`${APIFY_API_BASE}/actor-runs/${runId}/abort`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(RUN_API_TIMEOUT_MS),
    });
    const body = await res.text().catch(() => "");
    if (!res.ok) {
      console.warn(`[apify] abort of run ${runId} failed: HTTP ${res.status} ${truncate(body, 200)}`);
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[apify] abort of run ${runId} failed (ignored): ${reason}`);
  }
}

/**
 * `call-actor` hands back the Actor tool's return value as a JSON string.
 * Parsing failure is a real error rather than something to paper over: every
 * Playwright tool in this Actor returns a JSON object, so non-JSON here means
 * the Actor surfaced a plain-text failure (timeout, run aborted, quota).
 */
function parseToolPayload<T>(text: string, qualifiedTool: string): T {
  if (!text) {
    throw new ApifyMcpError(`"${qualifiedTool}" returned an empty payload`, qualifiedTool);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApifyMcpError(
      `"${qualifiedTool}" returned a non-JSON payload: ${truncate(text)}`,
      qualifiedTool
    );
  }
}

/**
 * The dead session again, reported *in band*: as a well-formed payload carrying
 * an `error` string rather than as an `isError` result. Every observation so far
 * has come back through the `isError` path, but the two paths are the Actor's
 * choice and not ours, and the in-band one is the more dangerous of the two —
 * `navigate`'s result is unvalidated, so `{error: "Session not found"}` would
 * otherwise be returned as a `NavigateResult` with an undefined `url`.
 *
 * Scoped to this one error on purpose. Any *other* in-band `error` field stays
 * the caller's business exactly as before: turning all of them into exceptions
 * here would be a much wider behavioural change than a session-recovery fix
 * should smuggle in.
 */
function assertSessionAlive(payload: unknown, qualifiedTool: string): void {
  if (!payload || typeof payload !== "object") return;
  const inBand = (payload as { error?: unknown }).error;
  if (typeof inBand === "string" && SESSION_LOST_RE.test(inBand)) {
    throw new ApifyMcpError(`"${qualifiedTool}" failed: ${truncate(inBand)}`, qualifiedTool);
  }
}

// ───────────────────────────────────
// Typed conveniences for the Playwright Actor's tools.
// Only the handful ACT-005 needs — the Actor exposes 17. Fetch the full list
// at runtime with `session.fetchActorMcpTools(PLAYWRIGHT_MCP_ACTOR)`.
// ───────────────────────────────────

export type NavigateResult = { url: string; title: string };

/**
 * Playwright's `page.goto` lifecycle values, which the Actor's `navigate` tool
 * passes straight through as `wait_until` (verified against its input schema:
 * a plain string with a `"domcontentloaded"` default, no enum).
 *
 * The choice is a real tradeoff, not a detail:
 *  - `domcontentloaded` returns as soon as the HTML is parsed. Fast and it can
 *    never hang, but on a client-rendered SPA it returns while the page is
 *    still an empty shell — a subsequent `evaluate` then reads a page with no
 *    text, no title and no interactive elements.
 *  - `networkidle` waits for the network to go quiet, which is the closest
 *    generic proxy for "the framework finished fetching and mounting". It is
 *    also the one that can cost the full navigation timeout on any site that
 *    polls or beacons continuously, and Playwright itself discourages it.
 *
 * Callers should therefore default to `domcontentloaded` and escalate only
 * when the cheap path demonstrably produced an unrendered page.
 */
export type NavigateWaitUntil = "load" | "domcontentloaded" | "networkidle" | "commit";

export class PlaywrightBrowser {
  constructor(private readonly session: PlaywrightSession) {}

  /** Navigation gets the full 45s budget — a cold standby start is slow. */
  async navigate(
    url: string,
    waitUntil: NavigateWaitUntil = "domcontentloaded"
  ): Promise<NavigateResult> {
    return await this.session.callPlaywrightTool<NavigateResult>(
      "navigate",
      { url, wait_until: waitUntil },
      MAX_WAIT_SECS
    );
  }

  /**
   * Runs JavaScript in the page and returns whatever it produces. The Actor
   * wraps the script in a function body, so use `return` for a value.
   *
   * Unlike the Actor's other tools, which return their payload at the top level
   * (`navigate` → `{url, title}`, `get_text` → `{text}`), `evaluate` nests the
   * script's return value under a `result` key. Unwrapped here so callers see
   * exactly what their script returned.
   */
  async evaluate<T>(script: string): Promise<T> {
    const wrapped = await this.session.callPlaywrightTool<{ result?: T }>(
      "evaluate",
      { script },
      MAX_WAIT_SECS
    );
    if (!wrapped || typeof wrapped !== "object" || !("result" in wrapped)) {
      throw new ApifyMcpError(
        `evaluate returned no "result" key — got ${truncate(JSON.stringify(wrapped))}`,
        "evaluate"
      );
    }
    return wrapped.result as T;
  }

  async getText(selector?: string): Promise<{ text: string }> {
    return await this.session.callPlaywrightTool("get_text", {
      selector: selector ?? null,
    });
  }

  async click(target: { selector?: string; text?: string }): Promise<unknown> {
    return await this.session.callPlaywrightTool("click", {
      selector: target.selector ?? null,
      text: target.text ?? null,
    });
  }

  async typeText(selector: string, text: string, pressEnter = false): Promise<unknown> {
    return await this.session.callPlaywrightTool("type_text", {
      selector,
      text,
      clear: true,
      press_enter: pressEnter,
    });
  }

  async waitFor(selector: string, state = "visible", timeout = 10_000): Promise<unknown> {
    return await this.session.callPlaywrightTool(
      "wait_for",
      { selector, state, timeout },
      MAX_WAIT_SECS
    );
  }

  /**
   * `waitFor` for the case where the selector never appearing is an *answer*
   * rather than a failure — "give the page a chance to show X, then carry on
   * either way". Returns undefined when the wait succeeded, or the failure
   * message when it did not.
   *
   * Separate from `waitFor` rather than a flag on it because the two have
   * genuinely different contracts: waiting for a field you are about to type
   * into must throw when it never arrives, and swallowing that would be a bug.
   */
  async waitForQuietly(
    selector: string,
    state = "visible",
    timeout = 10_000
  ): Promise<string | undefined> {
    try {
      await this.waitFor(selector, state, timeout);
      return undefined;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  /**
   * Best-effort browser teardown. Never throws: a failed close must not mask
   * the result of the work that just succeeded, and the Actor recycles the
   * browser on the next `navigate` regardless.
   */
  async closeQuietly(): Promise<string | undefined> {
    try {
      await this.session.callPlaywrightTool("close_browser", {});
      return undefined;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }
}
