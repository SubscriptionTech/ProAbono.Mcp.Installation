/**
 * In-Site Step 3: synchronizing an application's rights with the ProAbono Usage API.
 *
 * The tool reads the account before generating, so the developer is handed their real Features and
 * their real types rather than a template to fill in -- and, when a customer reference is given, an
 * actual diagnosis of what that customer's Usages say, which is the check that separates "the
 * integration is wrong" from "this customer has not subscribed".
 *
 * It ships incomplete on purpose, and says so where it matters: `scaffold_notification_endpoint`
 * is not in this release, so there is no endpoint to wire the resynchronization onto. The maximum
 * TTL is what bounds a stale entry until it lands, and the generated output states that next to
 * the cache rather than leaving a developer to discover it.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { STACKS, type Stack } from "../generate/hosted-pages.js";
import {
  EMPTY_RESPONSE_CAUSES,
  GATING_RULES,
  MAX_TTL_SECONDS,
  MISSING_RESYNC,
  gateSnippet,
  rightsModule,
} from "../generate/usage-rights.js";
import { text, type ToolContext, type ToolResult } from "./context.js";
import { guard } from "./guard.js";

interface Feature {
  readonly ReferenceFeature?: string;
  readonly TitleLocalized?: string;
  readonly TypeFeature?: string;
}

interface Usage {
  readonly ReferenceFeature?: string;
  readonly TypeFeature?: string;
  readonly DatePeriodEnd?: string;
}

interface Subscription {
  readonly Id?: number;
  readonly Status?: string;
  readonly StateSubscription?: string;
  readonly ReferenceOffer?: string;
  readonly Features?: readonly unknown[];
}

/** The states in which a subscription actually grants rights. Anything else returns no Usage. */
function isRunning(subscription: Subscription): boolean {
  return subscription.Status === "Active";
}

export function registerUsageRightsTools(server: McpServer, context: ToolContext): void {
  const { client, configuration } = context;

  server.registerTool(
    "sync_usage_rights",
    {
      title: "Generate the rights synchronization (In-Site step 3)",
      description:
        "Generates the code that reads a customer's rights from the ProAbono Usage API, caches " +
        "them correctly and gates access on them -- step 3 of the In-Site installation, and the " +
        "one that decides what a signed-in user may actually do. Returns the rights module for the " +
        "stack, the gate at a call site, the write-back for a Feature the application changes " +
        "(quoted and confirmed with the end customer when it is billable), and the cache expiry " +
        "policy. Reads the account's real Features so the code names them. Give customer_ref to " +
        "also diagnose what that customer's Usages currently say, which is how an empty response is " +
        "told apart from a broken integration. Never gate on the offer reference: rights come from " +
        "the Usage API.",
      inputSchema: {
        stack: z
          .enum(STACKS as unknown as [Stack, ...Stack[]])
          .describe(
            "The host project's stack. Detect it from the open project (package.json, " +
              "composer.json, requirements.txt, Gemfile, .csproj) and confirm with the developer. " +
              "Use \"generic\" when none fits.",
          ),
        feature_refs: z
          .array(z.string())
          .optional()
          .describe(
            "The Features to gate on. Left out, every Feature of the business is listed with its " +
              "type so the developer can choose.",
          ),
        customer_ref: z
          .string()
          .optional()
          .describe(
            "A real customer to check the wiring against. Their Usages are read and an empty " +
              "answer is diagnosed against their subscriptions.",
          ),
      },
    },
    async ({ stack, feature_refs, customer_ref }): Promise<ToolResult> =>
      guard(async () => {
        const features = await client.listAll<Feature>("/v1/Features", {});
        const selected =
          feature_refs === undefined || feature_refs.length === 0
            ? features
            : features.filter((feature) =>
                feature_refs.includes(feature.ReferenceFeature ?? ""),
              );

        const unknownRefs = (feature_refs ?? []).filter(
          (reference) => !features.some((feature) => feature.ReferenceFeature === reference),
        );

        const sections: string[] = [
          `# Rights synchronization (${stack}) — In-Site step 3`,
          "",
          `Rights for Segment \`${configuration.segmentRef}\`, read from the Usage API. Everything ` +
            `below reads its configuration from the environment: no key and no secret is written ` +
            `into the code.`,
          "",
          "## 1. The Features you can gate on",
          "",
          ...featureListing(features, selected, unknownRefs),
          "",
          "## 2. The rights module",
          "",
          "```",
          rightsModule(stack),
          "```",
          "",
          "It calls **one function this code does not define**: the operational alert raised when a " +
            "rights read fails — `alertOperations` / `alert_operations`, or the logger already " +
            "injected in the C# version. Wire it to whatever the project already uses. Leaving it " +
            "undefined turns a recoverable read failure into a crash, which is the opposite of what " +
            "the fallback is for.",
          "",
          "## 3. The gate, and writing a change back",
          "",
          "```",
          gateSnippet(stack),
          "```",
          "",
          "The gate calls three more the project owns: the session it reads the customer reference " +
            "from, `confirmWithCustomer` — the confirmation shown to the **end customer**, not to " +
            "you, before a billable change — and the ProAbono write itself, which is the matching " +
            "Usage tool of this server.",
          "",
          "## 4. The cache expiry policy",
          "",
          `- An entry expires at **min(\`DatePeriodEnd\`, ${MAX_TTL_SECONDS}s)**. The period end is ` +
            `the real expiry; the ceiling caps the damage when nothing invalidates the entry.`,
          "- A customer's expiry is the **earliest `DatePeriodEnd`** across their Usages, so no " +
            "Usage — a `Consumption` counter in particular — is ever served past its own period.",
          `- No \`DatePeriodEnd\` at all, including on an empty response, falls back to the ` +
            `${MAX_TTL_SECONDS}s ceiling.`,
          "- Signals invalidate regardless of expiry: any Usage write you make, and a rights " +
            "re-read behind every redirect into a protected area.",
          "",
          "## 5. The rules this code carries, and why",
          "",
          ...GATING_RULES.map((rule) => `- ${rule}`),
          "",
          "## 6. Diagnosing an empty Usages response",
          "",
          "An empty response is ambiguous and must never be reported as \"no rights\". Three causes, " +
            "told apart by reading the customer's subscriptions and the offer behind them:",
          "",
          ...EMPTY_RESPONSE_CAUSES.map(
            (entry, index) => `${index + 1}. **${entry.cause}** ${entry.meaning}`,
          ),
        ];

        if (customer_ref !== undefined && customer_ref.length > 0) {
          sections.push("", ...(await diagnose(customer_ref)));
        }

        sections.push(
          "",
          "## 7. What this version does not generate",
          "",
          MISSING_RESYNC,
        );

        return text(sections.join("\n"));
      }),
  );

  /** Reads a real customer and says which of the three causes applies, rather than guessing. */
  async function diagnose(customerRef: string): Promise<string[]> {
    const lines = [`### Diagnosis for \`${customerRef}\``, ""];

    const usages = await client.listAll<Usage>("/v1/Usages", { ReferenceCustomer: customerRef });
    if (usages.length > 0) {
      const earliest = usages
        .map((usage) => usage.DatePeriodEnd)
        .filter((value): value is string => typeof value === "string")
        .sort()[0];

      lines.push(
        `${usages.length} Usage(s) came back — the wiring works for this customer.`,
        "",
        ...usages.map(
          (usage) =>
            `- \`${usage.ReferenceFeature ?? "?"}\` (${usage.TypeFeature ?? "?"})` +
            `${usage.DatePeriodEnd === undefined ? "" : `, period ends ${usage.DatePeriodEnd}`}`,
        ),
        "",
        earliest === undefined
          ? `No \`DatePeriodEnd\` on any of them, so this customer's cache entry would expire on ` +
            `the ${MAX_TTL_SECONDS}s ceiling.`
          : `The earliest \`DatePeriodEnd\` is ${earliest}, so that — or the ` +
            `${MAX_TTL_SECONDS}s ceiling, whichever comes first — is when this customer's cache ` +
            `entry expires.`,
      );
      return lines;
    }

    const subscriptions = await client.listAll<Subscription>("/v1/Subscriptions", {
      ReferenceCustomer: customerRef,
    });

    if (subscriptions.length === 0) {
      lines.push(
        "No Usage and no subscription: **cause 1**. This customer has never subscribed, so " +
          "ProAbono has no rights to report — which is correct, not a bug. Provision the customer " +
          "with `create_update_customer` at sign-up, and subscribe them before anything gates on " +
          "their rights.",
      );
      return lines;
    }

    const running = subscriptions.filter(isRunning);
    if (running.length === 0) {
      lines.push(
        `No Usage, and ${subscriptions.length} subscription(s) but none running: **cause 2**. ` +
          `Their states are ` +
          `${subscriptions.map((subscription) => subscription.StateSubscription ?? subscription.Status ?? "?").join(", ")}. ` +
          `This is a lifecycle state, not an integration bug: the application is right to grant ` +
          `nothing. A Draft subscription is started with \`start_subscription\`, a suspended one ` +
          `with the same tool.`,
      );
      return lines;
    }

    const bare = running.filter(
      (subscription) => (subscription.Features ?? []).length === 0,
    );
    if (bare.length > 0) {
      lines.push(
        `No Usage, and ${running.length} running subscription(s) whose offer carries **no ` +
          `Feature**: **cause 3**. This is a catalogue problem, and the one that looks exactly ` +
          `like a broken integration. Offer(s) concerned: ` +
          `${bare.map((subscription) => `\`${subscription.ReferenceOffer ?? "?"}\``).join(", ")}. ` +
          `Create at least one Feature in the ProAbono BackOffice and attach it to the offer — ` +
          `the Live API cannot do it, and no code here can work around it.`,
      );
      return lines;
    }

    lines.push(
      `No Usage, although ${running.length} running subscription(s) carry Features. This matches ` +
        `none of the three causes and is worth reporting: check that the subscription's Features ` +
        `are the ones you expect with \`get_subscription\`, and that the customer reference is ` +
        `the one the subscription is on.`,
    );
    return lines;
  }
}

/** The Features the developer chooses from, with the type that decides which write applies. */
function featureListing(
  all: readonly Feature[],
  selected: readonly Feature[],
  unknownRefs: readonly string[],
): string[] {
  if (all.length === 0) {
    return [
      "This business defines no Feature. Rights cannot be gated on anything, and a subscription " +
        "to an offer carrying no Feature returns no Usage — which is indistinguishable from a " +
        "broken integration. Features are authored in the ProAbono BackOffice; the Live API " +
        "cannot create them.",
    ];
  }

  const lines = selected.map((feature) => {
    const type = feature.TypeFeature ?? "?";
    const write =
      type === "OnOff"
        ? "`set_feature_enabled`"
        : type === "Limitation"
          ? "`set_feature_current_quantity`"
          : type === "Consumption"
            ? "`add_feature_consumption`"
            : "no write (informational)";

    return (
      `- \`${feature.ReferenceFeature ?? "?"}\` — ${feature.TitleLocalized ?? ""} ` +
      `(**${type}**), written back with ${write}`
    );
  });

  if (unknownRefs.length > 0) {
    lines.push(
      "",
      `Not found on this business, and therefore not gated: ` +
        `${unknownRefs.map((reference) => `\`${reference}\``).join(", ")}. ` +
        `Check the reference, or create the Feature in the BackOffice.`,
    );
  }

  return lines;
}
