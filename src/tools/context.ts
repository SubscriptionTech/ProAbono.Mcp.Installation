/**
 * What every tool is handed: the configuration and the API client built from it.
 *
 * Tools never read `process.env` themselves — the configuration is loaded once, at startup, so a
 * missing variable stops the server rather than surfacing halfway through an installation.
 */
import type { ProAbonoClient } from "../api/client.js";
import type { ProAbonoConfiguration } from "../config.js";

export interface ToolContext {
  readonly configuration: ProAbonoConfiguration;
  readonly client: ProAbonoClient;
}

/** The shape the MCP SDK expects back from a tool: text blocks, plus an open set of extras. */
export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

/**
 * A tool answer carrying structured data.
 *
 * `undefined` is handled rather than stringified: the API answers `204 No Content` with an empty
 * body where there is nothing to return, and `JSON.stringify(undefined)` is `undefined`, not a
 * string -- which would put a `text` block with no text on the wire and break the client rather
 * than tell the developer the record is empty.
 */
export function json(value: unknown): ToolResult {
  const text =
    value === undefined
      ? JSON.stringify(
          {
            result: "empty",
            note:
              "The ProAbono API answered 204 No Content: the record or collection asked for holds " +
              "nothing. That is an answer, not a failure -- and not proof of a broken integration.",
          },
          null,
          2,
        )
      : JSON.stringify(value, null, 2);

  return { content: [{ type: "text", text }] };
}

/** A tool answer carrying prose or generated code. */
export function text(value: string): ToolResult {
  return { content: [{ type: "text", text: value }] };
}

/** A tool answer the model must treat as a failure, with the reason the developer needs. */
export function failure(value: string): ToolResult {
  return { content: [{ type: "text", text: value }], isError: true };
}
