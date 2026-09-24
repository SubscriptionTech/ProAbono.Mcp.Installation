/**
 * In-Site Step 2: linking the application to a ProAbono Subscription Workflow, and back.
 *
 * The tool reads the account before generating, so the developer is handed the offers their
 * Segment actually sells rather than a placeholder, and is told plainly when the catalogue cannot
 * support the workflow they asked for -- an offer with no Feature subscribes correctly and returns
 * no rights, which is indistinguishable from a broken integration.
 *
 * What it generates is a **round trip**, and the return half is the one that is usually missing:
 * one route, rights re-read first, branching on `from` x `outcome` for the destination only.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { STACKS, templateSnippet, type Stack } from "../generate/hosted-pages.js";
import {
  OUTCOMES,
  PORTAL_ONLY_ACTIONS,
  QUERY_CATALOGUE,
  FROM_VALUES,
  WORKFLOW_MANUAL_CHECKS,
  WORKFLOW_RULES,
  backOfficeRedirect,
  returnRouteSnippet,
  workflowModule,
} from "../generate/workflows.js";
import { recordStep, secretsOf, stateInputs, type StateInputs } from "../install/state.js";
import { text, type ToolContext, type ToolResult } from "./context.js";
import { guard } from "./guard.js";

/** The six entry points a developer actually asks for. The enum and the table share this list. */
const WORKFLOW_KEYS = [
  "subscribe",
  "choose_offer",
  "upgrade",
  "restart",
  "register",
  "pay_invoice",
] as const;

type WorkflowKey = (typeof WORKFLOW_KEYS)[number];

/** The object a query is read from, and the Live API path it is fetched at. */
const OBJECT_PATHS: Record<"Customer" | "Subscription" | "Offer" | "Invoice", string> = {
  Customer: "/v1/Customer",
  Subscription: "/v1/Subscription",
  Offer: "/v1/Offer",
  Invoice: "/v1/Invoice",
};

interface Offer {
  readonly ReferenceOffer?: string;
  readonly TitleLocalized?: string;
  readonly Features?: readonly unknown[];
}

export function registerWorkflowTools(server: McpServer, context: ToolContext): void {
  const { client, configuration } = context;

  server.registerTool(
    "link_subscription_workflow",
    {
      title: "Link a ProAbono Subscription Workflow, and the way back (In-Site step 2)",
      description:
        "Generates the round trip of In-Site step 2: the server-side code that fetches a ProAbono " +
        "object and reads the encrypted workflow query out of its Links by rel, both ways of " +
        "opening it -- ProAbonoPortal.open({ query }) in the application and a ?pa_query= link for " +
        "e-mails -- and the single return route the customer comes back to, which re-reads the " +
        "session user's rights first and then branches on from x outcome for all five outcomes. " +
        "Reads the account's real offers. Also returns the BackOffice action no API can perform: " +
        "the redirect URL to configure. Use it for sign-up, plan change, restart, registering a " +
        "payment method or paying an invoice. Writes the installation state unless record_state is " +
        "false.",
      inputSchema: {
        stack: z
          .enum(STACKS as unknown as [Stack, ...Stack[]])
          .describe(
            "The host project's stack. Detect it from the open project (package.json, " +
              "composer.json, requirements.txt, Gemfile, .csproj) and confirm with the developer. " +
              'Use "generic" when none fits.',
          ),
        workflow: z
          .enum(WORKFLOW_KEYS)
          .describe(
            "Which workflow this entry point opens. subscribe: a named plan. choose_offer: the " +
              "catalogue, post sign-up. upgrade: change of plan. restart: a suspended " +
              "subscription. register: contact details and a payment method. pay_invoice: one due " +
              "invoice.",
          ),
        return_route: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Path the customer comes back to when a workflow ends, e.g. "/billing/return". ' +
              "Defaults to that. One route serves every workflow.",
          ),
        offer_ref: z
          .string()
          .optional()
          .describe(
            "The offer the workflow opens on, for subscribe and upgrade. Checked against the " +
              "account's catalogue, because a workflow on an unknown offer fails at the end of a " +
              "sign-up rather than at the start.",
          ),
        ...stateInputs,
      },
    },
    async ({
      stack,
      workflow,
      return_route,
      offer_ref,
      project_root,
      record_state,
    }): Promise<ToolResult> =>
      guard(async () => {
        const returnRoute = return_route ?? "/billing/return";
        const chosen = WORKFLOWS[workflow];
        const objectPath = OBJECT_PATHS[chosen.object];

        const offers = await client.listAll<Offer>("/v1/Offers", {});
        const catalogue = catalogueSection(offers, offer_ref, chosen.needsOffer);

        const record = await recordStep(
          { project_root, record_state } as StateInputs,
          "subscription_workflow",
          {
            status: "generated",
            generated: [
              { what: `workflow query (${chosen.rel})`, stack },
              { what: "return route", where: returnRoute, stack },
            ],
            pending_backoffice: [
              `Set the workflow redirect URL to <your-host>${returnRoute} under Settings → Hosted Pages → Customer Workflows.`,
            ],
          },
          {
            segmentRef: configuration.segmentRef,
            forbidden: secretsOf(configuration),
            installation: {
              stack,
              ...(offer_ref === undefined ? {} : { offers: [offer_ref] }),
            },
          },
        );

        return text(
          [
            `# Subscription Workflow — \`${workflow}\` (${stack}), In-Site step 2`,
            "",
            `It opens the **${chosen.opens}** from a query read on a **${chosen.object}**, by the ` +
              `\`${chosen.rel}\` \`rel\`. That query is encrypted server-side and is present *only ` +
              `when the object's state and the fetch's parameters make the workflow applicable* — ` +
              `fetch with **${chosen.fetchWith}** or it will simply not be there. Everything below ` +
              `reads its configuration from the environment: no key and no secret is written into ` +
              `the code.`,
            "",
            ...catalogue,
            "",
            "## 1. Reading the query, server-side",
            "",
            "```",
            workflowModule(stack, chosen.rel, objectPath),
            "```",
            "",
            "## 2. Opening it — in the application",
            "",
            "The same In-Site embed as step 1, with the query added. The customer reference comes " +
              "from the session and the hash is computed server-side, exactly as in " +
              "`install_customer_portal`:",
            "",
            "```html",
            templateSnippet({ identified: true, withQuery: true }),
            "```",
            "",
            "## 3. Opening it — from an e-mail or a plain link",
            "",
            "`workflowEmailLink` above builds it: the installation URL comes from the object's " +
              "`insite-home` link — configured under *Settings → Hosted Pages* — with `?pa_query=` " +
              "appended. It is the only method that works in an e-mail, because the result is a " +
              "plain URL. The two methods are not exclusive.",
            "",
            "## 4. The return route — one, for every workflow",
            "",
            "```",
            returnRouteSnippet(stack, returnRoute),
            "```",
            "",
            "It calls `refreshEntitlements`, which `sync_usage_rights` generates with the rights " +
              "module. The redirect is the **fastest reliable signal** that rights changed: " +
              "notifications are asynchronous and lag by minutes, this is immediate. Build both — " +
              "they cover different halves of the problem.",
            "",
            "### What comes back on that URL",
            "",
            "| `from` | Means |",
            "|---|---|",
            ...FROM_VALUES.map((entry) => `| \`${entry.value}\` | ${entry.means} |`),
            "",
            "| `outcome` | Means |",
            "|---|---|",
            ...OUTCOMES.map((entry) => `| \`${entry.value}\` | ${entry.means} |`),
            "",
            "`idc` is always there, `refo` and `idsub` when relevant — and all three are " +
              "browser-supplied. They are never what decides who to refresh.",
            "",
            "## 5. The BackOffice action — nothing comes back without it",
            "",
            backOfficeRedirect(returnRoute),
            "",
            "## 6. The rules this code carries, and why",
            "",
            ...WORKFLOW_RULES.map((rule) => `- ${rule}`),
            "",
            "## 7. What no query reaches",
            "",
            "These have no API-driven entry point at all. Asked for an in-app button for one of " +
              "them, open the Customer Portal — there is no missing query to find:",
            "",
            ...PORTAL_ONLY_ACTIONS.map((action) => `- ${action}`),
            "",
            "## 8. The other queries, and what each one needs on the fetch",
            "",
            "| Object | `rel` | Opens | Fetch with |",
            "|---|---|---|---|",
            ...QUERY_CATALOGUE.map(
              (entry) =>
                `| ${entry.object} | \`${entry.rel}\` | ${entry.opens} | ${entry.fetchWith} |`,
            ),
            "",
            "## 9. Checks a server cannot run for you",
            "",
            ...WORKFLOW_MANUAL_CHECKS.map((check) => `- ${check}`),
            ...(record === undefined ? [] : ["", record]),
          ].join("\n"),
        );
      }),
  );
}

interface WorkflowChoice {
  readonly object: "Customer" | "Subscription" | "Offer" | "Invoice";
  readonly rel: string;
  readonly opens: string;
  readonly fetchWith: string;
  readonly needsOffer: boolean;
}

/** Each entry point mapped to the object its query lives on, and to that query's `rel`. */
const WORKFLOWS: Record<WorkflowKey, WorkflowChoice> = {
  subscribe: {
    object: "Customer",
    rel: "insite-subscribe",
    opens: "subscription workflow on one named plan",
    fetchWith: "`ReferenceCustomer` **and** `ReferenceOffer`",
    needsOffer: true,
  },
  choose_offer: {
    object: "Customer",
    rel: "insite-collection-offers",
    opens: "catalogue, so the customer can subscribe",
    fetchWith: "`ReferenceCustomer`",
    needsOffer: false,
  },
  upgrade: {
    object: "Customer",
    rel: "insite-collection-upgrade",
    opens: "catalogue, to change the current plan",
    fetchWith: "`ReferenceCustomer`",
    needsOffer: false,
  },
  restart: {
    object: "Subscription",
    rel: "insite-restart",
    opens: "restart of a suspended subscription",
    fetchWith: "`ReferenceCustomer`, on the suspended subscription",
    needsOffer: false,
  },
  register: {
    object: "Customer",
    rel: "insite-register",
    opens: "form collecting contact details and a payment method",
    fetchWith: "`ReferenceCustomer`",
    needsOffer: false,
  },
  pay_invoice: {
    object: "Invoice",
    rel: "insite-charge",
    opens: "payment of one due invoice",
    fetchWith: "the invoice's identifier or full number",
    needsOffer: false,
  },
};

/** What the account can actually sell, and what is missing when it cannot. */
function catalogueSection(
  offers: readonly Offer[],
  offerRef: string | undefined,
  needsOffer: boolean,
): string[] {
  if (offers.length === 0) {
    return [
      "**This Segment exposes no offer.** The workflow will open on an empty catalogue, and no " +
        "customer can subscribe. Offers are authored in the ProAbono BackOffice; the Live API " +
        "cannot create one.",
    ];
  }

  const lines = [
    "Offers this Segment sells, read from the account:",
    "",
    ...offers.map((offer) => {
      const featureCount = (offer.Features ?? []).length;
      const warning =
        featureCount === 0
          ? " — **carries no Feature**: a subscription to it succeeds and the application gets no " +
            "rights back, which looks exactly like a broken integration"
          : ` — ${featureCount} Feature(s)`;
      return `- \`${offer.ReferenceOffer ?? "?"}\` ${offer.TitleLocalized ?? ""}${warning}`;
    }),
  ];

  if (offerRef !== undefined && !offers.some((offer) => offer.ReferenceOffer === offerRef)) {
    lines.push(
      "",
      `\`${offerRef}\` is **not** in this Segment's catalogue. A workflow opened on an unknown ` +
        `offer fails at the end of a sign-up, not at the start of it. Check the reference, or ` +
        `create the offer in the BackOffice.`,
    );
  }

  if (needsOffer && offerRef === undefined) {
    lines.push(
      "",
      "This workflow opens on **one named plan**, so the fetch must carry `ReferenceOffer`. " +
        "Without it the `insite-subscribe` query is simply absent from the response — pass " +
        "`offer_ref`, or use `choose_offer` to open the catalogue instead.",
    );
  }

  return lines;
}
