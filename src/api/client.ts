/**
 * The ProAbono API Live client.
 *
 * Three behaviours here are load-bearing for everything the server does, and each is asserted
 * by the test suite rather than left to the caller:
 *
 *  - **Basic auth**: the Agent key is the username, the API key the password (contract:
 *    `securitySchemes.basicAuth`). Neither ever appears in a message this client raises.
 *  - **The Segment is never dropped.** `ReferenceSegment` is optional on every operation that
 *    takes it, and omitting it makes ProAbono act on the Business's default Segment — silently,
 *    with no error. The client therefore adds the configured Segment to every operation whose
 *    contract declares the parameter, unless the caller passed one explicitly.
 *  - **Paginated collections are read whole**, to `TotalItems`, never one page.
 */
import type { ProAbonoConfiguration } from "../config.js";
import { loadContract, type OpenApiDocument } from "../corpus/index.js";
import { ProAbonoApiError } from "./errors.js";

export type QueryValue = string | number | boolean | undefined;
export type Query = Record<string, QueryValue>;

export interface PaginatedResponse<T> {
  readonly Page?: number;
  readonly SizePage?: number;
  readonly Count?: number;
  readonly TotalItems?: number;
  readonly Items?: readonly T[];
}

/** Page size used when reading a collection whole. The contract caps `SizePage` at 1000. */
const PAGE_SIZE = 200;

/** A collection larger than this is a configuration mistake, not a catalogue. */
const MAX_PAGES = 100;

export class ProAbonoClient {
  private readonly configuration: ProAbonoConfiguration;
  private readonly contract: OpenApiDocument;
  private readonly fetchImplementation: typeof fetch;
  private readonly authorization: string;

  constructor(
    configuration: ProAbonoConfiguration,
    options: { contract?: OpenApiDocument; fetchImplementation?: typeof fetch } = {},
  ) {
    this.configuration = configuration;
    this.contract = options.contract ?? loadContract();
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.authorization = `Basic ${Buffer.from(
      `${configuration.agentKey}:${configuration.apiKey}`,
      "utf8",
    ).toString("base64")}`;
  }

  async get<T>(path: string, query: Query = {}): Promise<T> {
    return this.request<T>("get", path, { query });
  }

  async post<T>(path: string, options: { query?: Query; body?: unknown } = {}): Promise<T> {
    return this.request<T>("post", path, options);
  }

  /**
   * Reads a paginated collection to `TotalItems`.
   *
   * Reading one page and treating it as the whole collection is one of the mistakes the go-live
   * checklist calls out: it shows a merchant three offers when they have forty.
   */
  async listAll<T>(path: string, query: Query = {}): Promise<readonly T[]> {
    const items: T[] = [];
    let page = 1;

    for (;;) {
      const response = await this.request<PaginatedResponse<T> | undefined>("get", path, {
        query: { ...query, Page: page, SizePage: PAGE_SIZE },
      });

      // An empty collection comes back as `204 No Content` with no body at all -- not as a `200`
      // carrying `TotalItems: 0`. Reading `.Items` off that threw, which turned every legitimate
      // "this customer has nothing yet" into a crash: no subscriptions, no invoices, and above all
      // no Usages, which is the case the whole rights diagnosis is built to explain.
      const batch = response?.Items ?? [];
      items.push(...batch);

      const total = response?.TotalItems ?? items.length;
      if (items.length >= total || batch.length === 0) return items;

      page += 1;
      if (page > MAX_PAGES) {
        throw new Error(
          `Reading ${path} stopped after ${MAX_PAGES} pages with ${items.length} of ${total} items. ` +
            `Narrow the query.`,
        );
      }
    }
  }

  private async request<T>(
    method: "get" | "post",
    path: string,
    options: { query?: Query; body?: unknown },
  ): Promise<T> {
    const url = this.buildUrl(method, path, options.query ?? {});
    const response = await this.fetchImplementation(url, {
      method: method.toUpperCase(),
      headers: {
        Authorization: this.authorization,
        Accept: "application/json",
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });

    const text = await response.text();
    const payload: unknown = text.length === 0 ? undefined : safeParse(text);

    if (!response.ok) throw toApiError(response.status, payload, text);

    return payload as T;
  }

  /** Builds the request URL, adding the configured Segment wherever the contract accepts it. */
  private buildUrl(method: "get" | "post", path: string, query: Query): string {
    const resolved = path.replace(/\{(\w+)\}/g, (_match, name: string) => {
      const value = query[name];
      if (value === undefined) throw new Error(`Missing path parameter ${name} for ${path}`);
      delete query[name];
      return encodeURIComponent(String(value));
    });

    const url = new URL(`${this.configuration.apiBase}${resolved}`);
    const effective: Query = { ...query };

    if (effective["ReferenceSegment"] === undefined && this.acceptsSegment(method, path)) {
      effective["ReferenceSegment"] = this.configuration.segmentRef;
    }

    for (const [name, value] of Object.entries(effective)) {
      if (value !== undefined) url.searchParams.set(name, String(value));
    }

    return url.toString();
  }

  /** Whether the contract declares a `ReferenceSegment` query parameter on this operation. */
  private acceptsSegment(method: "get" | "post", path: string): boolean {
    const parameters = this.contract.paths[path]?.[method]?.parameters ?? [];
    return parameters.some((parameter) => {
      const resolvedName = this.parameterName(parameter);
      return resolvedName === "ReferenceSegment";
    });
  }

  private parameterName(parameter: unknown): string | undefined {
    if (typeof parameter !== "object" || parameter === null) return undefined;
    const record = parameter as { name?: string; $ref?: string };
    if (typeof record.name === "string") return record.name;
    if (typeof record.$ref === "string") {
      const key = record.$ref.split("/").pop();
      if (key === undefined) return undefined;
      return this.contract.components?.parameters?.[key]?.name;
    }
    return undefined;
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function toApiError(status: number, payload: unknown, raw: string): ProAbonoApiError {
  const first = Array.isArray(payload) ? payload[0] : payload;
  if (typeof first === "object" && first !== null) {
    const error = first as { Code?: string; Message?: string; Target?: string };
    return new ProAbonoApiError(
      status,
      error.Code,
      error.Message ?? raw.slice(0, 400),
      error.Target,
    );
  }
  return new ProAbonoApiError(status, undefined, raw.slice(0, 400) || "no response body");
}
