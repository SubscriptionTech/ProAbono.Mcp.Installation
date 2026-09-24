/**
 * The generic pair: plan a journey, and generate code for a task in a named language.
 *
 * They are the widest surface in the server, and the one thing they must not do is contradict the
 * task-specific tools. Two decisions keep that true:
 *
 *  - **`plan_integration` renders `INSITE_STEPS`, the same sequence `install_insite` executes.**
 *    The overlap is real: one plans and runs, the other only plans. Shipping two descriptions of
 *    one installation would mean two answers to the same question, both maintainable and only one
 *    right -- so there is one description, in `generate/journeys.ts`, and both tools read it.
 *  - **`generate_integration_code` never replaces a task-specific generator.** Where one exists it
 *    says so and names it, because `install_customer_portal`, `generate_pricing_table`,
 *    `link_subscription_workflow`, `sync_usage_rights` and `scaffold_notification_endpoint` each
 *    carry rules a generic generator cannot know. What it generates is the part that is the same
 *    everywhere: an authenticated call that carries the Segment, reads collections whole, and
 *    inlines no secret.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  GENERATED_CODE_GUARDRAILS,
  apiClientSnippet,
  resolveLanguage,
} from "../generate/integration.js";
import { JOURNEYS, findJourney } from "../generate/journeys.js";
import { findEndpoints, type EndpointReference } from "../openapi/reference.js";
import { searchDocumentation } from "../docs/search.js";
import { text, type ToolContext, type ToolResult } from "./context.js";
import { guard } from "./guard.js";

/**
 * Tasks a task-specific generator already covers, and which tool to use instead.
 *
 * This is not a redirect: `generate_integration_code` still answers, with the API calls and the
 * client. It names the better tool because the better tool carries rules this one does not -- the
 * security hash, the cache expiry policy, the signature verification.
 */
const SPECIFIC_GENERATORS: readonly { matches: RegExp; tool: string; why: string }[] = [
  {
    matches: /portal|billing page|account page/i,
    tool: "install_customer_portal",
    why: "it carries the server-side security hash, which is what stops a visitor reading another customer's invoices",
  },
  {
    matches: /pricing|plan table|price table/i,
    tool: "generate_pricing_table",
    why: "it reads the account's real offers and knows which flavour needs a hash and which does not",
  },
  {
    matches: /workflow|redirect|return route|subscribe flow|sign.?up flow/i,
    tool: "link_subscription_workflow",
    why: "it reads the query out of Links by rel and generates the return route for all five outcomes",
  },
  {
    matches: /rights|entitlement|gate|usage cache|quota/i,
    tool: "sync_usage_rights",
    why: "it carries the cache expiry policy and the diagnosis of an empty Usages response",
  },
  {
    matches: /webhook|notification|event/i,
    tool: "scaffold_notification_endpoint",
    why: "it carries the signature verification, the validation handshake and the deduplication",
  },
];

export function registerIntegrationTools(server: McpServer, context: ToolContext): void {
  const { configuration } = context;

  server.registerTool(
    "plan_integration",
    {
      title: "Plan a ProAbono integration journey, step by step",
      description:
        "Returns the ordered plan for a named journey — installing ProAbono In-Site, building a " +
        "subscription funnel, letting a customer manage their plan, metering usage, or reacting " +
        "to notifications — naming the tool that generates each step and what a human still owes " +
        "in the BackOffice. It plans and executes nothing. For the In-Site installation it " +
        "describes the same sequence install_insite runs, because both read one description of " +
        "it. Call it when a developer asks what the steps are, what order they go in, or what " +
        "they are in for, before any code is generated.",
      inputSchema: {
        journey: z
          .enum([
            "insite_installation",
            "subscription_funnel",
            "portal_lifecycle",
            "usage_metering",
            "notifications",
          ])
          .describe(
            "Which journey to plan. insite_installation: the whole installation. " +
              "subscription_funnel: sign-up to first subscription. portal_lifecycle: an existing " +
              "customer managing their plan. usage_metering: reporting and billing what a customer " +
              "uses. notifications: reacting to what happens in ProAbono.",
          ),
      },
    },
    async ({ journey }): Promise<ToolResult> =>
      guard(async () => {
        const chosen = findJourney(journey);
        if (chosen === undefined) {
          // Unreachable through the enum, and kept so a widened enum cannot silently answer wrong.
          return text(
            `No journey is named \`${journey}\`. The ones this server plans are: ` +
              `${JOURNEYS.map((entry) => `\`${entry.key}\``).join(", ")}.`,
          );
        }

        const owed = chosen.steps.filter((step) => step.owed !== undefined);

        return text(
          [
            `# ${chosen.title}`,
            "",
            chosen.summary,
            "",
            `Against the account your credentials open, Segment \`${configuration.segmentRef}\`. ` +
              `This tool plans; it changes nothing and generates no code.`,
            "",
            "## The steps, in order",
            "",
            ...chosen.steps.flatMap((step, index) => [
              `### ${index + 1}. ${step.title}`,
              "",
              step.what,
              ...(step.tool === undefined
                ? []
                : ["", `Generated by \`${step.tool}\`.`]),
              "",
            ]),
            "## What no API can do for you",
            "",
            ...(owed.length === 0
              ? ["Nothing in this journey needs a BackOffice action."]
              : owed.map((step) => `- **${step.title}** — ${step.owed}`)),
            "",
            "## Where the detail is",
            "",
            ...chosen.reading.map(
              (document) =>
                `- \`${document}\` — read it with \`search_documentation\`, which searches this ` +
                `corpus rather than the web.`,
            ),
          ].join("\n"),
        );
      }),
  );

  server.registerTool(
    "generate_integration_code",
    {
      title: "Generate ProAbono integration code for a task, in a given language",
      description:
        "Generates code for a ProAbono task in the language you name, from the API Live contract " +
        "and the installation documentation — no per-language SDK, because there is none. Returns " +
        "the authenticated client (Basic auth read from configuration, the Segment carried, " +
        "collections read to TotalItems, 204 handled), the operations the task actually needs with " +
        "their real parameters read from the contract, and the guardrails the code has to satisfy. " +
        "Use it for a task no task-specific generator covers; where one does — the portal, the " +
        "pricing table, the workflow round trip, the rights cache, the webhook endpoint — it says " +
        "so and names it, because those carry rules a generic generator cannot know.",
      inputSchema: {
        task: z
          .string()
          .min(3)
          .describe(
            'What the code has to do, in the developer\'s own words: "cancel a subscription at ' +
              'period end", "list a customer\'s unpaid invoices", "add seats when a user is ' +
              'invited".',
          ),
        language: z
          .string()
          .min(1)
          .describe(
            'The target language or framework: "typescript", "php", "python", "ruby", "csharp", ' +
              '"next.js"… An unrecognised one is answered with the HTTP calls themselves and said ' +
              "to be unrecognised, never with another language's code.",
          ),
      },
    },
    async ({ task, language }): Promise<ToolResult> =>
      guard(async () => {
        const { stack, recognised } = resolveLanguage(language);
        const endpoints = operationsFor(task);
        const specific = SPECIFIC_GENERATORS.find((entry) => entry.matches.test(task));
        const hits = searchDocumentation(task, 3);

        return text(
          [
            `# ${task} — in ${language}`,
            "",
            recognised
              ? `Generated for \`${stack}\`. Everything below reads its configuration from the ` +
                `environment: no key and no secret is written into the code.`
              : `**\`${language}\` is not one of the languages this server generates idiomatic code ` +
                `for** (node/express, next.js, php, python, ruby, csharp). What follows is the ` +
                `HTTP contract itself plus a language-neutral sketch — which is the honest answer, ` +
                `rather than another language's code with the keywords changed.`,
            "",
            ...(specific === undefined
              ? []
              : [
                  `> **\`${specific.tool}\` covers this task and this one does not replace it.** Use ` +
                    `it instead: ${specific.why}. What is below is the generic scaffolding, and it ` +
                    `carries none of that.`,
                  "",
                ]),
            "## 1. The operations this needs",
            "",
            ...(endpoints.length === 0
              ? [
                  "No operation in the contract matched that wording. Two possibilities, and they " +
                    "are different: the task is done through the hosted pages rather than the API " +
                    "— changing options, terminating from the portal and changing a payment method " +
                    "have no API entry point at all — or it needs an operation this server does " +
                    "not expose. Search the contract directly with `get_api_reference`.",
                ]
              : endpoints.flatMap((endpoint) => [
                  `### \`${endpoint.method} ${endpoint.path}\``,
                  "",
                  endpoint.summary ?? "(the contract gives no summary)",
                  "",
                  ...(endpoint.parameters.length === 0
                    ? ["It declares no query parameter."]
                    : [
                        "| Parameter | In | Required |",
                        "|---|---|---|",
                        ...endpoint.parameters.map(
                          (parameter) =>
                            `| \`${parameter.name}\` | ${parameter.in} | ${parameter.required ? "**yes**" : "no"} |`,
                        ),
                      ]),
                  ...(endpoint.requestBodySchema === undefined
                    ? []
                    : ["", `Body: \`${endpoint.requestBodySchema}\` — read it with \`get_api_reference\`.`]),
                  "",
                ])),
            "## 2. The authenticated client",
            "",
            "```",
            apiClientSnippet(stack),
            "```",
            "",
            "## 3. The rules this code has to satisfy",
            "",
            ...GENERATED_CODE_GUARDRAILS.map((rule) => `- ${rule}`),
            "",
            "## 4. What the documentation says about this",
            "",
            ...(hits.length === 0
              ? [
                  "Nothing in the corpus matched that wording. `search_documentation` searches the " +
                    "same corpus with different terms; do not fall back to the web, which is not a " +
                    "source of truth for this product.",
                ]
              : hits.map((hit) => `- **${hit.document} › ${hit.heading}** — ${hit.excerpt}`)),
          ].join("\n"),
        );
      }),
  );
}

/**
 * The operations a task reaches, read out of the contract rather than remembered.
 *
 * The keyword map is a routing aid, not a source of truth: every entry resolves through
 * `findEndpoints`, so an operation that left the contract leaves this answer too, instead of being
 * described from memory.
 */
function operationsFor(task: string): readonly EndpointReference[] {
  const words = task.toLowerCase();
  const paths: string[] = [];

  const add = (path: string): void => {
    if (!paths.includes(path)) paths.push(path);
  };

  if (/customer/.test(words) && !/portal/.test(words)) add("/v1/Customer");
  if (/address|invoic(e|ing) address|billing address/.test(words)) add("/v1/CustomerAddressBilling");
  if (/payment method|payment setting|next billing|invoice note/.test(words))
    add("/v1/CustomerSettingsPayment");
  if (/anonymi|gdpr|erase|right to be forgotten/.test(words)) add("/v1/Customer/Anonymization");
  if (/subscri/.test(words)) add("/v1/Subscription");
  if (/upgrade|change plan/.test(words)) add("/v1/Subscription/{IdSubscription}/Upgrade");
  if (/suspend|pause/.test(words)) add("/v1/Subscription/{IdSubscription}/Suspension");
  if (/terminat|cancel/.test(words)) add("/v1/Subscription/{IdSubscription}/Termination");
  if (/start|restart|resume/.test(words)) add("/v1/Subscription/{IdSubscription}/Start");
  if (/offer|catalog|plan\b/.test(words)) add("/v1/Offers");
  if (/feature/.test(words)) add("/v1/Features");
  if (/usage|consumption|seat|quota|meter/.test(words)) add("/v1/Usages");
  if (/report|increment|write.*usage|seat/.test(words)) add("/v1/Usage");
  if (/quote|price|cost|how much/.test(words)) add("/v1/Quoting/Usage");
  if (/invoice|bill|receipt|pdf/.test(words)) add("/v1/Invoices");
  if (/balance|credit line|charge/.test(words)) add("/v1/BalanceLine");
  if (/bill(ing)? (the )?customer|issue an invoice/.test(words)) add("/v1/Billing/Customer");

  const resolved = paths.flatMap((path) => findEndpoints(path, 3));
  if (resolved.length > 0) return resolved.slice(0, 6);

  // Nothing matched the map: fall back to the contract's own search over the words themselves.
  return findEndpoints(task, 3);
}
