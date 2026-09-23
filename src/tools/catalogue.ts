/**
 * The Offers and Features group of spec section 4. Read-only, every one of them.
 *
 * `list_offers` and `list_offers_for_customer` are two tools over `GET /v1/Offers`, and the
 * duplication is deliberate: the question differs. One asks what the merchant sells, the other
 * what this customer can buy today -- and the second is the one that answers "what can they
 * upgrade to", which the first cannot answer at all.
 *
 * These tools never reason about which account or which environment the credentials open. They
 * report what comes back.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { json, type ToolContext, type ToolResult } from "./context.js";
import { guard } from "./guard.js";

/** An offer carrying no Feature grants no rights, which is indistinguishable from a broken wiring. */
function withoutFeatures(offers: readonly Record<string, unknown>[]): number {
  return offers.filter((offer) => {
    const features = offer["Features"];
    return !Array.isArray(features) || features.length === 0;
  }).length;
}

export function registerCatalogueTools(server: McpServer, context: ToolContext): void {
  const { client } = context;

  server.registerTool(
    "list_offers",
    {
      title: "List the offers of the account",
      description:
        "Lists the ProAbono offers the configured Segment exposes, with the Features each one " +
        "carries and its pricing. Read-only. This is the catalogue: what the merchant sells, to " +
        "anyone. Use it to show a pricing page, to pick the offer a subscription or a pricing table " +
        "targets, or to check the prerequisite that at least one offer exists and carries at least " +
        "one Feature. For what one named customer may take, or what a running subscription can move " +
        "to, use list_offers_for_customer instead. Reads every page, not just the first.",
      inputSchema: {
        visible_only: z.boolean().optional().describe("Only offers marked visible."),
      },
    },
    async ({ visible_only }): Promise<ToolResult> =>
      guard(async () => {
        const offers = await client.listAll<Record<string, unknown>>("/v1/Offers", {
          IsVisible: visible_only,
        });
        const bare = withoutFeatures(offers);

        return json({
          count: offers.length,
          offers,
          prerequisite_warning:
            offers.length === 0
              ? "This Segment exposes no offer. Offers are authored in the ProAbono BackOffice and " +
                "cannot be created through the API: an installation cannot proceed without one."
              : bare > 0
                ? `${bare} offer(s) carry no Feature. A subscription to such an offer returns no ` +
                  `Usage, which is indistinguishable from a broken integration. Attach at least one ` +
                  `Feature in the BackOffice.`
                : undefined,
        });
      }),
  );

  server.registerTool(
    "list_offers_for_customer",
    {
      title: "List the offers one customer may take",
      description:
        "Lists the ProAbono offers a named customer may take right now, which is not the same set " +
        "as the catalogue: it accounts for what they already hold. Read-only. Set upgrade_only, " +
        "with the subscription's identifier when the customer holds several, to get the upgrade and " +
        "downgrade options of a running subscription -- the answer to \"what can this customer move " +
        "to?\", which list_offers cannot give. Use list_offers for the public catalogue. Reads every " +
        "page.",
      inputSchema: {
        customer_ref: z.string().min(1).describe("Shared reference of the customer."),
        upgrade_only: z
          .boolean()
          .optional()
          .describe("Only the offers the customer's current subscription can move to."),
        subscription_id: z
          .number()
          .int()
          .optional()
          .describe("Which subscription the upgrade options are for, when the customer has several."),
        visible_only: z.boolean().optional().describe("Only offers marked visible."),
      },
    },
    async ({ customer_ref, upgrade_only, subscription_id, visible_only }): Promise<ToolResult> =>
      guard(async () => {
        const offers = await client.listAll<Record<string, unknown>>("/v1/Offers", {
          ReferenceCustomer: customer_ref,
          Upgrade: upgrade_only,
          IdSubscription: subscription_id,
          IsVisible: visible_only,
        });

        return json({
          count: offers.length,
          scope: upgrade_only === true ? "upgrade options" : "offers available to this customer",
          offers,
          note:
            offers.length === 0
              ? upgrade_only === true
                ? "No upgrade option came back. Either the customer has no running subscription, or " +
                  "the catalogue offers nothing its current offer can move to. Read " +
                  "list_subscriptions to tell the two apart."
                : "No offer is available to this customer. Read list_offers to see whether the " +
                  "Segment exposes any at all, and list_subscriptions to see what they already hold."
              : undefined,
        });
      }),
  );

  server.registerTool(
    "get_offer",
    {
      title: "Retrieve one offer",
      description:
        "Retrieves a single ProAbono offer by its reference, with its Features, pricing and the " +
        "Links it exposes. Read-only. Use it when the offer reference is already known.",
      inputSchema: {
        offer_ref: z.string().min(1).describe("The offer's shared reference (ReferenceOffer)."),
        customer_ref: z
          .string()
          .optional()
          .describe("When given, the Links include a direct subscribe link for that customer."),
      },
    },
    async ({ offer_ref, customer_ref }): Promise<ToolResult> =>
      guard(async () =>
        json(
          await client.get("/v1/Offer", {
            ReferenceOffer: offer_ref,
            ReferenceCustomer: customer_ref,
          }),
        ),
      ),
  );

  server.registerTool(
    "list_features",
    {
      title: "List the Features defined on the business",
      description:
        "Lists the ProAbono Features of the account: the definitions the business owns, each with " +
        "its type (OnOff, Limitation or Consumption). Read-only. These are what an application can " +
        "gate access on. A Feature is the definition; a customer's value for it is a Usage, read " +
        "with get_usages. Reads every page.",
      inputSchema: {
        visible_only: z.boolean().optional().describe("Only Features marked visible."),
      },
    },
    async ({ visible_only }): Promise<ToolResult> =>
      guard(async () => {
        const features = await client.listAll<Record<string, unknown>>("/v1/Features", {
          IsVisible: visible_only,
        });
        return json({ count: features.length, features });
      }),
  );
}
