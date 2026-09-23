/**
 * The Usages and Rights group of spec section 4 -- reading a customer's rights, and writing back
 * what the application changed.
 *
 * **One mode per write, split by Feature type.** `POST /v1/Usage` accepts `Increment`,
 * `QuantityCurrent` and `IsEnabled`, and would take `Increment` for a `Limitation` Feature and
 * `QuantityCurrent` for a `Consumption` one. Neither is exposed:
 *
 *  - an absolute write is retry-safe, an `Increment` is not -- a repeated one double-counts. The
 *    `Limitation` write therefore never offers the unsafe mode;
 *  - the `Consumption` write has no safe mode to offer: a metered event carries no absolute total
 *    to send. Its description says a retry double-counts, and that the caller owns that.
 *
 * **`DateStamp` is mandatory**, in UTC, and the API does not support a future date. Each tool
 * defaults it to now and refuses one in the future here, rather than letting the API reject it
 * with a message that does not say what to do about it.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { failure, json, type ToolContext, type ToolResult } from "./context.js";
import { guard } from "./guard.js";

const customerRef = z.string().min(1).describe("Shared reference of the customer.");
const featureRef = z.string().min(1).describe("Shared reference of the Feature (ReferenceFeature).");
const idSubscription = z
  .number()
  .int()
  .optional()
  .describe("Which subscription the Usage belongs to. Needed when the customer has several running.");
const dateStamp = z
  .string()
  .optional()
  .describe(
    "When the change happened, ISO 8601 in UTC. Defaults to now. A future date is not supported.",
  );

/** A small clock skew is tolerated: a caller's "now" is routinely a second ahead of this one. */
const FUTURE_TOLERANCE_MS = 60_000;

/**
 * Discriminated on purpose. `DateStamp` is mandatory on every Usage write, so a shape that let
 * `stamp` be absent on the success branch would compile while sending a request without one.
 */
type StampResult = { readonly ok: true; readonly stamp: string } | { readonly ok: false; readonly error: string };

/**
 * Normalizes the caller's timestamp to a UTC instant, or says why it cannot be used.
 *
 * The API rejects a future `DateStamp`, and rejects it with a validation error that names the
 * field and not the fix. Catching it here is what turns that into an actionable answer.
 */
function resolveDateStamp(value: string | undefined): StampResult {
  if (value === undefined) return { ok: true, stamp: new Date().toISOString() };

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return {
      ok: false,
      error:
        `date_stamp "${value}" is not a date this server can read. Pass an ISO 8601 instant in ` +
        `UTC, e.g. "2026-09-23T14:05:00Z", or leave it out to stamp the change now.`,
    };
  }

  if (parsed.getTime() > Date.now() + FUTURE_TOLERANCE_MS) {
    return {
      ok: false,
      error:
        `date_stamp "${value}" is in the future. ProAbono does not support a future Usage date: a ` +
        `Usage is an event that has happened. Pass the instant the change actually occurred, or ` +
        `leave it out to stamp it now.`,
    };
  }

  return { ok: true, stamp: parsed.toISOString() };
}

export function registerUsageTools(server: McpServer, context: ToolContext): void {
  const { client } = context;

  server.registerTool(
    "get_usages",
    {
      title: "Read a customer's rights",
      description:
        "Reads a customer's Usages: what that customer may do right now, as ProAbono sees it, one " +
        "entry per Feature carried by their running subscriptions. Read-only. This is the source an " +
        "application gates access on -- never the offer reference. An empty result is ambiguous: " +
        "check the customer's subscriptions with list_subscriptions before concluding they have no " +
        "rights.",
      inputSchema: {
        customer_ref: customerRef,
        feature_ref: z.string().optional().describe("Restrict to one Feature reference."),
      },
    },
    async ({ customer_ref, feature_ref }): Promise<ToolResult> =>
      guard(async () => {
        const usages = await client.listAll<Record<string, unknown>>("/v1/Usages", {
          ReferenceCustomer: customer_ref,
          ReferenceFeature: feature_ref,
        });

        return json({
          count: usages.length,
          usages,
          note:
            usages.length === 0
              ? "No Usage came back. That is not proof of an integration bug: the customer may never " +
                "have subscribed, may have no running subscription, or may be on an offer carrying no " +
                "Feature. Read list_subscriptions before concluding."
              : "An absent QuantityCurrent means unlimited, not zero. For an OnOff Feature, enforce " +
                "IsEnabled, not IsIncluded.",
        });
      }),
  );

  server.registerTool(
    "quote_usage_change",
    {
      title: "Price a Usage change before applying it",
      description:
        "Prices an intended Usage change without applying it, and checks that it is allowed: what " +
        "the customer would be charged now, and, with next_term, what their recurring cost would " +
        "become. Read-only -- nothing is written. Call it before add_feature_consumption, " +
        "set_feature_current_quantity or set_feature_enabled whenever the change is billable, and " +
        "show the amount to the end customer for confirmation before the write. Pass exactly one " +
        "of increment, quantity_current or is_enabled, matching the Feature's type.",
      inputSchema: {
        customer_ref: customerRef,
        feature_ref: featureRef,
        increment: z
          .number()
          .int()
          .optional()
          .describe("Quantity that would be added, for a Consumption or Limitation Feature."),
        quantity_current: z
          .number()
          .int()
          .optional()
          .describe("Absolute quantity it would be set to, for a Limitation Feature."),
        is_enabled: z
          .boolean()
          .optional()
          .describe("State it would be set to, for an OnOff Feature."),
        subscription_id: idSubscription,
        next_term: z
          .boolean()
          .optional()
          .describe("Also return the estimated recurring cost for the next billing period."),
        date_stamp: dateStamp,
      },
    },
    async (input): Promise<ToolResult> =>
      guard(async () => {
        const modes = [input.increment, input.quantity_current, input.is_enabled].filter(
          (value) => value !== undefined,
        );
        if (modes.length !== 1) {
          return failure(
            "Pass exactly one of increment, quantity_current or is_enabled -- one quote prices one " +
              "change. Which one depends on the Feature's type: increment for a Consumption " +
              "Feature, quantity_current for a Limitation one, is_enabled for an OnOff one. " +
              "list_features reports the type.",
          );
        }

        const stamped = resolveDateStamp(input.date_stamp);
        if (!stamped.ok) return failure(stamped.error);

        return json(
          await client.post("/v1/Quoting/Usage", {
            query: { NextTerm: input.next_term },
            body: {
              ReferenceCustomer: input.customer_ref,
              ReferenceFeature: input.feature_ref,
              IdSubscription: input.subscription_id,
              Increment: input.increment,
              QuantityCurrent: input.quantity_current,
              IsEnabled: input.is_enabled,
              DateStamp: stamped.stamp,
            },
          }),
        );
      }),
  );

  server.registerTool(
    "add_feature_consumption",
    {
      title: "Report consumption of a metered Feature (write)",
      description:
        "WRITE. Adds an increment to the current quantity of a Consumption Feature of a customer -- " +
        "the metered kind: messages sent, API calls made, gigabytes stored. Report what was just " +
        "consumed, not a running total: the value is added to what ProAbono already holds. " +
        "Consumption Features only; use set_feature_current_quantity for a Limitation Feature and " +
        "set_feature_enabled for an OnOff one. A repeated call double-counts -- there is no absolute " +
        "mode to fall back on for a metered event, so the caller is responsible for not sending the " +
        "same consumption twice, including on a retry after a timeout. Quote it first with " +
        "quote_usage_change when it is billable.",
      inputSchema: {
        customer_ref: customerRef,
        feature_ref: featureRef,
        increment: z
          .number()
          .int()
          .describe("Quantity consumed since the last report. Added to the current quantity."),
        subscription_id: idSubscription,
        date_stamp: dateStamp,
      },
    },
    async ({ customer_ref, feature_ref, increment, subscription_id, date_stamp }): Promise<ToolResult> =>
      guard(async () => {
        const stamped = resolveDateStamp(date_stamp);
        if (!stamped.ok) return failure(stamped.error);

        return json(
          await client.post("/v1/Usage", {
            // Increment and nothing else: sending QuantityCurrent alongside it would make the
            // request mean two different things at once.
            body: {
              ReferenceCustomer: customer_ref,
              ReferenceFeature: feature_ref,
              IdSubscription: subscription_id,
              Increment: increment,
              DateStamp: stamped.stamp,
            },
          }),
        );
      }),
  );

  server.registerTool(
    "set_feature_current_quantity",
    {
      title: "Set the quantity of a Limitation Feature (write)",
      description:
        "WRITE. Sets the current quantity of a Limitation Feature of a customer to an absolute " +
        "value -- seats, projects, users. Send the quantity the application has provisioned, the " +
        "seats bought and not the seats occupied: that is what ProAbono bills on. The value is " +
        "absolute, so sending it twice is harmless, which is why this write takes no increment. " +
        "Limitation Features only; use add_feature_consumption for a metered Feature and " +
        "set_feature_enabled for an OnOff one. Quote it first with quote_usage_change when it is " +
        "billable.",
      inputSchema: {
        customer_ref: customerRef,
        feature_ref: featureRef,
        quantity_current: z
          .number()
          .int()
          .describe("The absolute quantity now provisioned. Replaces the current value."),
        subscription_id: idSubscription,
        date_stamp: dateStamp,
      },
    },
    async ({
      customer_ref,
      feature_ref,
      quantity_current,
      subscription_id,
      date_stamp,
    }): Promise<ToolResult> =>
      guard(async () => {
        const stamped = resolveDateStamp(date_stamp);
        if (!stamped.ok) return failure(stamped.error);

        return json(
          await client.post("/v1/Usage", {
            body: {
              ReferenceCustomer: customer_ref,
              ReferenceFeature: feature_ref,
              IdSubscription: subscription_id,
              QuantityCurrent: quantity_current,
              DateStamp: stamped.stamp,
            },
          }),
        );
      }),
  );

  server.registerTool(
    "set_feature_enabled",
    {
      title: "Enable or disable an OnOff Feature (write)",
      description:
        "WRITE. Enables or disables an OnOff Feature in the active subscription of a customer -- an " +
        "option they switch on or off. OnOff Features only; use add_feature_consumption for a " +
        "metered Feature and set_feature_current_quantity for a Limitation one. The value is " +
        "absolute, so repeating the call is harmless. Note that what the application must then " +
        "enforce is IsEnabled, not IsIncluded: a Feature included in the offer can still be switched " +
        "off. Quote it first with quote_usage_change when enabling is billable.",
      inputSchema: {
        customer_ref: customerRef,
        feature_ref: featureRef,
        is_enabled: z.boolean().describe("true to enable the Feature, false to disable it."),
        subscription_id: idSubscription,
        date_stamp: dateStamp,
      },
    },
    async ({ customer_ref, feature_ref, is_enabled, subscription_id, date_stamp }): Promise<ToolResult> =>
      guard(async () => {
        const stamped = resolveDateStamp(date_stamp);
        if (!stamped.ok) return failure(stamped.error);

        return json(
          await client.post("/v1/Usage", {
            body: {
              ReferenceCustomer: customer_ref,
              ReferenceFeature: feature_ref,
              IdSubscription: subscription_id,
              IsEnabled: is_enabled,
              DateStamp: stamped.stamp,
            },
          }),
        );
      }),
  );
}
