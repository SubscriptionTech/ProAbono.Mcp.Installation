/**
 * Documentation and reference tools.
 *
 * Both answer strictly from the two sources of truth vendored into the build: the installation
 * documentation and the ProAbono API Live contract.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { searchDocumentation } from "../docs/search.js";
import { findEndpoints, findSchema, listEndpoints } from "../openapi/reference.js";
import { json, text } from "./context.js";

export function registerDocumentationTools(server: McpServer): void {
  server.registerTool(
    "search_documentation",
    {
      title: "Search the ProAbono installation documentation",
      description:
        "Answers a natural-language question about integrating ProAbono from the official " +
        "installation documentation: hosted pages, the security hash, subscription workflows, " +
        "rights and usage, webhooks, testing and troubleshooting. Use it before writing any " +
        "ProAbono integration code, and prefer it over recalling ProAbono behaviour. Returns the " +
        "matching documentation sections with their source file.",
      inputSchema: {
        question: z.string().min(3).describe("The question, in plain language."),
        limit: z.number().int().min(1).max(10).optional().describe("How many sections to return (default 5)."),
      },
    },
    async ({ question, limit }) => {
      const hits = searchDocumentation(question, limit ?? 5);

      if (hits.length === 0) {
        return text(
          `Nothing in the installation documentation matches "${question}". ` +
            `Rephrase with ProAbono vocabulary (Offer, Feature, Usage, Segment, Subscription, ` +
            `Customer Portal, subscription workflow, notification), or use get_api_reference for ` +
            `endpoint-level questions.`,
        );
      }

      return text(
        hits
          .map(
            (hit) =>
              `## ${hit.heading}\n_Source: ${hit.document}_\n\n${hit.excerpt}`,
          )
          .join("\n\n---\n\n"),
      );
    },
  );

  server.registerTool(
    "get_api_reference",
    {
      title: "Look up a ProAbono API Live endpoint or object",
      description:
        "Returns the exact contract of a ProAbono API Live endpoint (parameters, whether each is " +
        "required, request body schema, responses) or of a named object such as Customer, " +
        "Subscription, Offer, Feature or Usage. Use it before calling or generating a call to the " +
        "ProAbono API, so parameter names and shapes come from the contract rather than from memory.",
      inputSchema: {
        endpoint: z
          .string()
          .optional()
          .describe('An endpoint path or fragment, e.g. "/v1/Customer" or "subscription".'),
        object: z
          .string()
          .optional()
          .describe('A schema name, e.g. "Customer", "SubscriptionRequest", "Usage".'),
      },
    },
    async ({ endpoint, object }) => {
      if (object !== undefined && object.trim().length > 0) {
        const schema = findSchema(object);
        return schema === undefined
          ? text(
              `No object named "${object}" in the ProAbono Live contract. ` +
                `Call get_api_reference with no argument to list the endpoints, or search_documentation ` +
                `for the concept behind the name.`,
            )
          : json(schema);
      }

      if (endpoint !== undefined && endpoint.trim().length > 0) {
        const matches = findEndpoints(endpoint);
        return matches.length === 0
          ? text(`No endpoint in the ProAbono Live contract matches "${endpoint}".`)
          : json(matches);
      }

      return json(
        listEndpoints().map(({ method, path, summary }) => ({ method, path, summary })),
      );
    },
  );
}
