/**
 * Assembles the server: one place where every tool the developer can reach is registered.
 *
 * The exposed surface follows spec section 4, group by group, and the registration order is that
 * of the spec so the two can be read side by side. It is deliberately not the whole Live API: an
 * operation earns a tool when one of the two priority journeys reaches it.
 *
 * **Nothing here destroys billing history.** Deleting a customer, a subscription or an invoice is
 * out of scope in any account, and `/v1/Customer/Suspension`, `/v1/Customer/LinksRevokation` and
 * `/v1/Customer/Invalidation` are not exposed for want of an integration step that reaches them.
 * `anonymize_customer` is the one irreversible tool, and it is not a destruction: it erases the
 * personal data and keeps the invoices and the subscription history, which is what a GDPR erasure
 * asks of a billing system.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { ProAbonoClient } from "./api/client.js";
import type { ProAbonoConfiguration } from "./config.js";
import { registerCatalogueTools } from "./tools/catalogue.js";
import type { ToolContext } from "./tools/context.js";
import { registerCustomerTools } from "./tools/customers.js";
import { registerDocumentationTools } from "./tools/documentation.js";
import { registerHostedPageTools } from "./tools/hosted-pages.js";
import { registerInfoTool } from "./tools/info.js";
import { registerInvoicingTools } from "./tools/invoicing.js";
import { registerSubscriptionTools } from "./tools/subscriptions.js";
import { registerUsageRightsTools } from "./tools/usage-rights.js";
import { registerUsageTools } from "./tools/usages.js";

export const SERVER_NAME = "proabono-mcp-installation";
/**
 * Reported in the MCP handshake and by `get_server_info`, which is what a developer pastes into a
 * bug report. It must equal `version` in `package.json` and both versions in `server.json`, or the
 * server names a release that does not exist on npm; `tests/release.test.ts` fails when it drifts.
 */
export const SERVER_VERSION = "0.2.4";

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
  registerHostedPageTools(server, context);
  registerUsageRightsTools(server, context);
  registerDocumentationTools(server);
  registerCustomerTools(server, context);
  registerSubscriptionTools(server, context);
  registerCatalogueTools(server, context);
  registerUsageTools(server, context);
  registerInvoicingTools(server, context);

  return server;
}
