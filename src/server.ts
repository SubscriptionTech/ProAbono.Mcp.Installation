/**
 * Assembles the server: one place where every tool the developer can reach is registered.
 *
 * The exposed surface is deliberately short (spec section 8, least privilege). Nothing
 * destructive is here: the contract's anonymization, invalidation, suspension of a customer and
 * link revocation endpoints exist, and are not exposed, in any account.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { ProAbonoClient } from "./api/client.js";
import type { ProAbonoConfiguration } from "./config.js";
import type { ToolContext } from "./tools/context.js";
import { registerDocumentationTools } from "./tools/documentation.js";
import { registerHostedPageTools } from "./tools/hosted-pages.js";
import { registerInfoTool } from "./tools/info.js";
import { registerIntrospectionTools } from "./tools/introspection.js";
import { registerWriteTools } from "./tools/writes.js";

export const SERVER_NAME = "proabono-mcp-installation";
/**
 * Reported in the MCP handshake and by `get_server_info`, which is what a developer pastes into a
 * bug report. It must equal `version` in `package.json` and both versions in `server.json`, or the
 * server names a release that does not exist on npm; `tests/release.test.ts` fails when it drifts.
 */
export const SERVER_VERSION = "0.1.0";

export function createServer(
  configuration: ProAbonoConfiguration,
  options: { client?: ProAbonoClient } = {},
): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const context: ToolContext = {
    configuration,
    client: options.client ?? new ProAbonoClient(configuration),
  };

  registerInfoTool(server, SERVER_VERSION);
  registerDocumentationTools(server);
  registerIntrospectionTools(server, context);
  registerWriteTools(server, context);
  registerHostedPageTools(server, context);

  return server;
}
