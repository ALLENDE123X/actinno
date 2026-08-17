/**
 * ACT-005 — client for Apify's hosted MCP server (https://mcp.apify.com).
 *
 * Apify publishes some Actors as MCP servers ("Actors as MCP servers"). Instead
 * of talking to nexgendata/playwright-mcp-server's standby endpoint directly
 * (https://nexgendata--playwright-mcp-server.apify.actor/mcp) we go through
 * Apify's own MCP server and its `call-actor` tool, which proxies to that
 * Actor's standby instance. One auth path (`APIFY_API_TOKEN`), one transport,
 * for every Apify capability this repo uses.
 *
 * Shape below was verified live against mcp.apify.com v0.14.3 (2026-08-17),
 * not taken from docs:
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
 * IMPORTANT — browser state and concurrency. The Playwright Actor keeps a
 * single browser per standby instance, and that browser survives across
 * `call-actor` calls (verified: navigate to example.com, then `get_text` with
 * no arguments returned example.com's text). That is what makes
 * navigate → evaluate → click compose like a normal Playwright script. The
 * flip side is that the browser is a property of the Actor instance, NOT of the
 * MCP session: two concurrent callers can land on the same standby instance and
 * stomp on each other's page. That is fine for ACT-005, which drives one
 * listing at a time, but `inngest/job-application-pipeline.ts` fans out with
 * `concurrency: { limit: 5 }` — before ACT-007/ACT-008 run browser work in
 * parallel, this needs either per-run isolation (a dedicated Actor run per
 * application rather than shared standby) or a serialization lock.
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

/** Raised for any Apify/MCP transport or tool-level failure. Never wraps credentials. */
export class ApifyMcpError extends Error {
  readonly tool: string | undefined;

  constructor(message: string, tool?: string) {
    super(message);
    this.name = "ApifyMcpError";
    this.tool = tool;
  }
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
 * A live MCP session against Apify's hosted server. Open one per unit of work
 * and always `close()` it — the SDK's transport holds an open HTTP connection,
 * which keeps a short-lived process (the CLI) from exiting.
 */
export class ApifyMcpSession {
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
    return parseToolPayload<T>(text, qualified);
  }

  async close(): Promise<void> {
    await this.client.close();
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

// ───────────────────────────────────
// Typed conveniences for the Playwright Actor's tools.
// Only the handful ACT-005 needs — the Actor exposes 17. Fetch the full list
// at runtime with `session.fetchActorMcpTools(PLAYWRIGHT_MCP_ACTOR)`.
// ───────────────────────────────────

export type NavigateResult = { url: string; title: string };

export class PlaywrightBrowser {
  constructor(private readonly session: ApifyMcpSession) {}

  /** Navigation gets the full 45s budget — a cold standby start is slow. */
  async navigate(url: string, waitUntil = "domcontentloaded"): Promise<NavigateResult> {
    return await this.session.callActorTool<NavigateResult>(
      PLAYWRIGHT_MCP_ACTOR,
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
    const wrapped = await this.session.callActorTool<{ result?: T }>(
      PLAYWRIGHT_MCP_ACTOR,
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
    return await this.session.callActorTool(PLAYWRIGHT_MCP_ACTOR, "get_text", {
      selector: selector ?? null,
    });
  }

  async click(target: { selector?: string; text?: string }): Promise<unknown> {
    return await this.session.callActorTool(PLAYWRIGHT_MCP_ACTOR, "click", {
      selector: target.selector ?? null,
      text: target.text ?? null,
    });
  }

  async typeText(selector: string, text: string, pressEnter = false): Promise<unknown> {
    return await this.session.callActorTool(PLAYWRIGHT_MCP_ACTOR, "type_text", {
      selector,
      text,
      clear: true,
      press_enter: pressEnter,
    });
  }

  async waitFor(selector: string, state = "visible", timeout = 10_000): Promise<unknown> {
    return await this.session.callActorTool(
      PLAYWRIGHT_MCP_ACTOR,
      "wait_for",
      { selector, state, timeout },
      MAX_WAIT_SECS
    );
  }

  /**
   * Best-effort browser teardown. Never throws: a failed close must not mask
   * the result of the work that just succeeded, and the Actor recycles the
   * browser on the next `navigate` regardless.
   */
  async closeQuietly(): Promise<string | undefined> {
    try {
      await this.session.callActorTool(PLAYWRIGHT_MCP_ACTOR, "close_browser", {});
      return undefined;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }
}
