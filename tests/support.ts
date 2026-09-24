/**
 * Shared test fixtures.
 *
 * The configuration used here is deliberately fake, and every secret in it is a recognisable
 * sentinel: several tests assert that no sentinel ever appears in what a tool returns.
 */
import type { ProAbonoConfiguration } from "../src/config.js";

export const AGENT_KEY_SENTINEL = "agent-key-SENTINEL-must-never-appear";
export const API_KEY_SENTINEL = "api-key-SENTINEL-must-never-appear";
export const PORTAL_SECRET_SENTINEL = "portal-secret-SENTINEL-must-never-appear";
export const WEBHOOK_SECRET_SENTINEL = "webhook-secret-SENTINEL-must-never-appear";

export const SENTINELS: readonly string[] = [
  AGENT_KEY_SENTINEL,
  API_KEY_SENTINEL,
  PORTAL_SECRET_SENTINEL,
  WEBHOOK_SECRET_SENTINEL,
];

export const TEST_CONFIGURATION: ProAbonoConfiguration = {
  apiBase: "https://api-42.proabono.com",
  businessId: "42",
  segmentRef: "ci-live",
  agentKey: AGENT_KEY_SENTINEL,
  apiKey: API_KEY_SENTINEL,
  portalSecret: PORTAL_SECRET_SENTINEL,
  webhookSecret: WEBHOOK_SECRET_SENTINEL,
};

export interface RecordedRequest {
  readonly url: URL;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

export interface FetchRecorder {
  readonly requests: RecordedRequest[];
  readonly fetch: typeof fetch;
}

/**
 * A fetch that records what was sent and replays canned responses.
 *
 * Request shape is what most of these tests assert: a dropped `ReferenceSegment` produces a
 * perfectly valid response against the wrong Segment, so asserting on responses cannot see it.
 */
export function recordFetch(
  responses: readonly { status?: number; body?: unknown }[],
): FetchRecorder {
  const requests: RecordedRequest[] = [];
  let index = 0;

  const implementation = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>),
    );
    const rawBody = init?.body;
    requests.push({
      url,
      method: init?.method ?? "GET",
      headers,
      body: typeof rawBody === "string" ? JSON.parse(rawBody) : undefined,
    });

    const canned = responses[Math.min(index, responses.length - 1)];
    index += 1;

    const status = canned?.status ?? 200;

    // ProAbono answers an EMPTY collection with `204 No Content` and no body at all -- not with a
    // `200` carrying `TotalItems: 0`. A recorder that always produced a JSON body could not
    // express that, which is why the crash it caused reached a live account before a test saw it.
    if (status === 204 || canned?.body === undefined) {
      return new Response(null, { status: status === 200 ? 204 : status });
    }

    return new Response(JSON.stringify(canned.body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;

  return { requests, fetch: implementation };
}

/** Asserts that no secret from the test configuration appears anywhere in the text. */
export function assertNoSecret(text: string): void {
  for (const sentinel of SENTINELS) {
    if (text.includes(sentinel)) {
      throw new Error(`A secret leaked into tool output: ${sentinel}`);
    }
  }
}
