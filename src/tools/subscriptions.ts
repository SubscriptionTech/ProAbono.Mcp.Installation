/**
 * The Subscription group of spec section 4.
 *
 * **One tool per transition.** The Live API has one endpoint for each of start, upgrade,
 * suspension and termination, each with its own parameters and its own failure modes. The shipped
 * `0.1.0` carried them as a single `change_subscription` with a `start | upgrade | suspend |
 * terminate` action, which forced the model to pick the value out of a description instead of out
 * of a tool name -- and a tool name is the one routing signal it has (spec section 8). The four
 * tools below replace it; the old name is removed, not aliased.
 *
 * `get_subscription` is the one tool here the contract does not fit exactly: it carries no
 * "retrieve by IdSubscription" operation. What it offers is `GET /v1/Subscription`, keyed on the
 * customer. The tool therefore takes the customer reference, and narrows to one identifier through
 * the collection when asked -- see the comment on its handler.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { failure, json, type ToolContext, type ToolResult } from "./context.js";
import { guard } from "./guard.js";

const metadata = z
  .record(z.string(), z.string())
  .optional()
  .describe("Free key/value pairs stored on the record. At most 5 keys, 450 characters per value.");

const subscriptionId = z
  .number()
  .int()
  .describe("Internal identifier of the subscription (Id, from list_subscriptions).");

export function registerSubscriptionTools(server: McpServer, context: ToolContext): void {
  const { client } = context;

  server.registerTool(
    "get_subscription",
    {
      title: "Retrieve one subscription",
      description:
        "Retrieves one ProAbono subscription of a customer, with its state, its dates and the " +
        "Features it carries. Read-only. The customer reference is required: the Live API has no " +
        "retrieve-by-identifier operation for subscriptions, so a subscription is always reached " +
        "through the customer who holds it. Pass subscription_id as well when the customer has " +
        "several and a specific one is meant; without it, the customer's current subscription " +
        "comes back. Use list_subscriptions to see them all.",
      inputSchema: {
        customer_ref: z
          .string()
          .min(1)
          .describe("Shared reference of the customer holding the subscription."),
        subscription_id: z
          .number()
          .int()
          .optional()
          .describe("Narrow to this subscription of the customer, by internal identifier (Id)."),
        offer_ref: z
          .string()
          .optional()
          .describe("Narrow to the customer's subscription on this offer reference."),
      },
    },
    async ({ customer_ref, subscription_id, offer_ref }): Promise<ToolResult> =>
      guard(async () => {
        // `GET /v1/Subscription` is keyed on the customer and returns one subscription; it cannot
        // be asked for an identifier. Narrowing by Id therefore goes through the collection, which
        // is read whole -- picking from the first page would miss a customer's older subscriptions.
        if (subscription_id !== undefined) {
          const subscriptions = await client.listAll<{ Id?: number }>("/v1/Subscriptions", {
            ReferenceCustomer: customer_ref,
          });
          const found = subscriptions.find((candidate) => candidate.Id === subscription_id);

          if (found === undefined) {
            return failure(
              `Customer ${customer_ref} holds no subscription ${subscription_id}. ` +
                `They hold ${subscriptions.length} subscription(s): ` +
                `${subscriptions.map((candidate) => candidate.Id).join(", ") || "none"}. ` +
                `Check the identifier, or that it belongs to this customer.`,
            );
          }
          return json(found);
        }

        return json(
          await client.get("/v1/Subscription", {
            ReferenceCustomer: customer_ref,
            ReferenceOffer: offer_ref,
          }),
        );
      }),
  );

  server.registerTool(
    "list_subscriptions",
    {
      title: "List subscriptions",
      description:
        "Lists ProAbono subscriptions, optionally those of one customer, with their state and the " +
        "Features they carry. Read-only. Use it to see what a customer is actually subscribed to, " +
        "or to explain why a customer has no rights. Reads every page.",
      inputSchema: {
        customer_ref: z.string().optional().describe("Restrict to this customer's subscriptions."),
      },
    },
    async ({ customer_ref }): Promise<ToolResult> =>
      guard(async () => {
        const subscriptions = await client.listAll<Record<string, unknown>>("/v1/Subscriptions", {
          ReferenceCustomer: customer_ref,
        });
        return json({ count: subscriptions.length, subscriptions });
      }),
  );

  server.registerTool(
    "create_subscription",
    {
      title: "Subscribe a customer to an offer (write)",
      description:
        "WRITE. Creates a ProAbono subscription linking an existing customer to an offer. This is " +
        "the API path; a customer choosing a plan themselves goes through a hosted subscription " +
        "workflow instead. The subscription is created as a copy of the offer -- pass an override " +
        "only where the merchant genuinely departs from their own catalogue. Set start_now to " +
        "activate it immediately; a subscription left in Draft grants no rights. A draft one is " +
        "activated later with start_subscription.",
      inputSchema: {
        customer_ref: z.string().min(1).describe("Shared reference of the customer who receives it."),
        offer_ref: z.string().min(1).describe("Shared reference of the offer to subscribe to."),
        buyer_customer_ref: z
          .string()
          .optional()
          .describe("Shared reference of the customer who pays, when it is not the recipient."),
        start_now: z
          .boolean()
          .optional()
          .describe("Attempt to start the subscription immediately after creation."),
        bill_now: z.boolean().optional().describe("Trigger billing immediately after starting."),
        ensure_billable: z
          .boolean()
          .optional()
          .describe("Check the customer can be billed before creating the subscription."),
        metadata,
      },
    },
    async (input): Promise<ToolResult> =>
      guard(async () =>
        json(
          await client.post("/v1/Subscription", {
            query: {
              TryStart: input.start_now,
              BillNow: input.bill_now,
              EnsureBillable: input.ensure_billable,
            },
            body: {
              ReferenceCustomer: input.customer_ref,
              ReferenceOffer: input.offer_ref,
              ReferenceCustomerBuyer: input.buyer_customer_ref,
              Metadata: input.metadata,
            },
          }),
        ),
      ),
  );

  server.registerTool(
    "start_subscription",
    {
      title: "Start or restart a subscription (write)",
      description:
        "WRITE. Activates a ProAbono subscription that is in Draft, and restarts one that was " +
        "suspended -- it is the same transition, and this is the tool to reach for to unsuspend a " +
        "subscription; there is no separate resume or unsuspend operation. A subscription grants no " +
        "rights until it is started, so this is what turns a created subscription into usable " +
        "access. Re-read the customer's rights afterwards with get_usages.",
      inputSchema: {
        subscription_id: subscriptionId,
        bill_now: z
          .boolean()
          .optional()
          .describe("Trigger billing immediately after starting the subscription."),
        ensure_billable: z
          .boolean()
          .optional()
          .describe("Check the customer can be billed before starting."),
      },
    },
    async ({ subscription_id, bill_now, ensure_billable }): Promise<ToolResult> =>
      guard(async () =>
        json(
          await client.post("/v1/Subscription/{IdSubscription}/Start", {
            query: {
              IdSubscription: subscription_id,
              BillNow: bill_now,
              EnsureBillable: ensure_billable,
            },
          }),
        ),
      ),
  );

  server.registerTool(
    "upgrade_subscription",
    {
      title: "Move a subscription to another offer (write)",
      description:
        "WRITE. Moves a ProAbono subscription to another offer -- an upgrade or a downgrade, the " +
        "same operation either way. It terminates the current subscription and creates a new one on " +
        "the target offer, which means the returned identifier is a new one and the customer's " +
        "rights change: re-read them with get_usages afterwards, and stop using the old identifier. " +
        "By default the move takes effect at the end of the current term; set immediate to apply it " +
        "now.",
      inputSchema: {
        subscription_id: subscriptionId,
        offer_ref: z.string().min(1).describe("Shared reference of the offer to move to."),
        immediate: z
          .boolean()
          .optional()
          .describe("Apply the move now instead of at the end of the current term."),
        bill_now: z.boolean().optional().describe("Trigger billing immediately after the move."),
        ignore_engagement: z
          .boolean()
          .optional()
          .describe("Bypass the minimum-commitment check. Only where the merchant has decided to."),
      },
    },
    async ({ subscription_id, offer_ref, immediate, bill_now, ignore_engagement }): Promise<ToolResult> =>
      guard(async () =>
        json(
          await client.post("/v1/Subscription/{IdSubscription}/Upgrade", {
            query: {
              IdSubscription: subscription_id,
              ReferenceOffer: offer_ref,
              Immediate: immediate,
              BillNow: bill_now,
              IgnoreEngagement: ignore_engagement,
            },
          }),
        ),
      ),
  );

  server.registerTool(
    "suspend_subscription",
    {
      title: "Suspend a subscription (write)",
      description:
        "WRITE. Suspends a ProAbono subscription. A suspended subscription stops granting rights " +
        "and stops being billed, and is not terminated: start_subscription restarts it, which is " +
        "the difference from terminate_subscription. Re-read the customer's rights with get_usages " +
        "afterwards.",
      inputSchema: {
        subscription_id: subscriptionId,
      },
    },
    async ({ subscription_id }): Promise<ToolResult> =>
      guard(async () =>
        json(
          await client.post("/v1/Subscription/{IdSubscription}/Suspension", {
            query: { IdSubscription: subscription_id },
          }),
        ),
      ),
  );

  server.registerTool(
    "terminate_subscription",
    {
      title: "Terminate a subscription (write)",
      description:
        "WRITE. Terminates a ProAbono subscription. By default it takes effect at the end of the " +
        "current term, so it is not an immediate loss of access: the customer keeps their rights " +
        "until then, and an application that revokes access on the call is wrong. Set immediate to " +
        "end it now, or termination_date to schedule it for a chosen date. A terminated " +
        "subscription cannot be restarted -- suspend_subscription is the reversible one.",
      inputSchema: {
        subscription_id: subscriptionId,
        immediate: z
          .boolean()
          .optional()
          .describe("End the subscription now instead of at the end of the current term."),
        termination_date: z
          .string()
          .optional()
          .describe("Schedule the termination for this date, ISO 8601. Overrides the term end."),
      },
    },
    async ({ subscription_id, immediate, termination_date }): Promise<ToolResult> =>
      guard(async () =>
        json(
          await client.post("/v1/Subscription/{IdSubscription}/Termination", {
            query: {
              IdSubscription: subscription_id,
              Immediate: immediate,
              DateTermination: termination_date,
            },
          }),
        ),
      ),
  );
}
