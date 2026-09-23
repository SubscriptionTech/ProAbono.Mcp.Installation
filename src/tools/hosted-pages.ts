/**
 * In-Site Step 1: placing the ProAbono hosted pages inside the merchant's own pages.
 *
 * Both tools read the account before generating, so the snippets carry the real Segment and the
 * real offers rather than placeholders -- but never a secret: the generated code reads every
 * secret from configuration, exactly as the server itself does.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  MANUAL_CHECKS,
  STACKS,
  hashSnippet,
  renderSnippet,
  templateSnippet,
  type Stack,
} from "../generate/hosted-pages.js";
import { text, type ToolContext, type ToolResult } from "./context.js";
import { guard } from "./guard.js";

const stackInput = z
  .enum(STACKS as unknown as [Stack, ...Stack[]])
  .describe(
    "The host project's stack. Detect it from the open project (package.json, composer.json, " +
      "requirements.txt, Gemfile, .csproj) and confirm with the developer. Use \"generic\" when none fits.",
  );

export function registerHostedPageTools(server: McpServer, context: ToolContext): void {
  const { client, configuration } = context;

  server.registerTool(
    "install_customer_portal",
    {
      title: "Install the ProAbono Customer Portal in a page",
      description:
        "Generates the code that embeds the ProAbono Customer Portal inside a page of the " +
        "merchant's own site -- current plan, invoices, payment method, billing address, usage -- " +
        "for the signed-in customer. This is step 1 of the In-Site installation. Returns the " +
        "server-side security hash computation, the route that renders the page, and the snippet to " +
        "place in the template. Requires an authenticated customer area: the hosted pages always " +
        "render for an identified customer.",
      inputSchema: {
        stack: stackInput,
        target_page: z
          .string()
          .min(1)
          .describe('Path of the page that will host the portal, e.g. "/account/billing".'),
        pass_language: z
          .boolean()
          .optional()
          .describe(
            "Pass the application's UI language to ProAbono. Only when the application is the " +
              "authority for it: it overwrites what the customer set in the portal.",
          ),
      },
    },
    async ({ stack, target_page, pass_language }): Promise<ToolResult> =>
      guard(async () => {
        const offers = await client.listAll<Record<string, unknown>>("/v1/Offers", {});
        const catalogue =
          offers.length === 0
            ? "No offer exists in this Segment. The portal renders, but the customer will have " +
              "nothing to subscribe to. Offers are authored in the ProAbono BackOffice.\n\n"
            : "";

        return text(
          [
            `# Customer Portal in \`${target_page}\` (${stack})`,
            "",
            catalogue +
              `The portal opens for the customer whose reference the page passes, in Segment ` +
              `\`${configuration.segmentRef}\`. Everything below reads its configuration from the ` +
              `environment: no key, no secret and no business identifier is written into the code.`,
            "",
            "## 1. The security hash, server-side",
            "",
            "Without it, any visitor can change the customer reference in the page and read another " +
              "customer's invoices, addresses and payment details. Compute it fresh per render, and " +
              "never in the browser.",
            "",
            "```",
            hashSnippet(stack),
            "```",
            "",
            "## 2. The route that renders the page",
            "",
            "```",
            renderSnippet(stack, target_page),
            "```",
            "",
            "## 3. The snippet in the template",
            "",
            "```html",
            templateSnippet({ identified: true, passLanguage: pass_language === true }),
            "```",
            "",
            "## 4. Before this works",
            "",
            "- A ProAbono customer must exist for the signed-in user. Provision it at sign-up or " +
              "first login with `create_update_customer` -- the recommended path, because the rights " +
              "read needs the customer to exist too. Passing an unknown reference creates the " +
              "customer on the fly instead, which works but leaves you without the mapping.",
            "- The link to this page must be reachable from the customer area.",
            "- `PROABONO_BUSINESS_ID`, `PROABONO_SEGMENT_REF` and `PROABONO_PORTAL_SECRET` must be in " +
              "the application's configuration, and out of version control.",
            "",
            "## 5. Checks a server cannot run for you",
            "",
            ...MANUAL_CHECKS.map((check) => `- ${check}`),
          ].join("\n"),
        );
      }),
  );

  server.registerTool(
    "generate_pricing_table",
    {
      title: "Generate the ProAbono pricing table embed",
      description:
        "Generates the embed that renders the ProAbono pricing table inside a page of the " +
        "merchant's site. Two flavours: anonymous for a public pricing page, or identified for a " +
        "signed-in customer, who can then subscribe in place -- which needs the customer reference " +
        "and the security hash. What happens when a plan is chosen is configured in the BackOffice, " +
        "not in this code.",
      inputSchema: {
        stack: stackInput,
        target_page: z
          .string()
          .min(1)
          .describe('Path of the page that will host the table, e.g. "/pricing".'),
        identified: z
          .boolean()
          .describe(
            "true for a signed-in customer who can subscribe in place; false for the public " +
              "anonymous table.",
          ),
      },
    },
    async ({ stack, target_page, identified }): Promise<ToolResult> =>
      guard(async () => {
        const offers = await client.listAll<{ ReferenceOffer?: string; TitleLocalized?: string }>(
          "/v1/Offers",
          { IsVisible: true },
        );

        const listing =
          offers.length === 0
            ? "This Segment exposes no visible offer, so the table will render empty. Offers are " +
              "authored in the ProAbono BackOffice."
            : offers
                .map((offer) => `- \`${offer.ReferenceOffer ?? "?"}\` — ${offer.TitleLocalized ?? ""}`)
                .join("\n");

        const sections = [
          `# Pricing table in \`${target_page}\` (${stack}, ${identified ? "identified" : "anonymous"})`,
          "",
          `Offers the table will show, from Segment \`${configuration.segmentRef}\`:`,
          "",
          listing,
          "",
        ];

        if (identified) {
          sections.push(
            "## 1. The security hash, server-side",
            "",
            "```",
            hashSnippet(stack),
            "```",
            "",
            "## 2. The route that renders the page",
            "",
            "```",
            renderSnippet(stack, target_page),
            "```",
            "",
            "## 3. The snippet in the template",
            "",
          );
        } else {
          sections.push(
            "The anonymous table needs no customer reference and therefore no hash. Read " +
              "`PROABONO_BUSINESS_ID` and `PROABONO_SEGMENT_REF` from configuration all the same: a " +
              "hardcoded business identifier is how a page ends up showing another account's catalogue.",
            "",
            "## The snippet in the template",
            "",
          );
        }

        sections.push(
          "```html",
          templateSnippet({ identified }),
          "```",
          "",
          "## Checks a server cannot run for you",
          "",
          // The anonymous table has no customer and no hash, so only the last two checks apply.
          ...(identified ? MANUAL_CHECKS : MANUAL_CHECKS.slice(3)).map((check) => `- ${check}`),
        );

        return text(sections.join("\n"));
      }),
  );
}
