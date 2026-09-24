/**
 * The ProAbono notification endpoint -- the half of In-Site Step 3 that keeps a rights cache true.
 *
 * It is not a fourth installation step. The endpoint exists so that `sync_usage_rights` has
 * something to wire its resynchronization onto: one endpoint, one global resync per affected
 * customer. Without it the maximum TTL is the only thing bounding a stale entry, which means a
 * right revoked in ProAbono stays served until the ceiling expires.
 *
 * The payloads, the headers and the signature come from the documentation corpus. The API Live
 * contract carries none of them, and there is no notification OpenAPI (spec section 5) -- so
 * nothing here is inferred from the contract, and a header name is never guessed.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { STACKS, type Stack } from "../generate/hosted-pages.js";
import {
  BACKOFFICE_PROCEDURE,
  EXCLUDED_EVENTS_REASON,
  RIGHTS_AFFECTING_EVENTS,
  WEBHOOK_MANUAL_CHECKS,
  WEBHOOK_RULES,
  notificationEndpoint,
} from "../generate/notifications.js";
import { recordStep, secretsOf, stateInputs, type StateInputs } from "../install/state.js";
import { text, type ToolContext, type ToolResult } from "./context.js";
import { guard } from "./guard.js";

export function registerNotificationTools(server: McpServer, context: ToolContext): void {
  const { configuration } = context;

  server.registerTool(
    "scaffold_notification_endpoint",
    {
      title: "Scaffold the ProAbono notification (webhook) endpoint",
      description:
        "Generates the HTTP endpoint that receives ProAbono notifications: signature verification " +
        "in constant time, the validation handshake ProAbono sends before a webhook goes live, " +
        "deduplication on the notification id, a fast acknowledgement with the work done out of " +
        "band, and the worker that runs one global rights resynchronization for the affected " +
        "customer. Also returns the BackOffice procedure that creates and validates the webhook, " +
        "which no API can perform. This is what makes the rights cache of sync_usage_rights " +
        "correct rather than merely bounded by its maximum TTL. Writes the installation state " +
        "unless record_state is false.",
      inputSchema: {
        stack: z
          .enum(STACKS as unknown as [Stack, ...Stack[]])
          .describe(
            "The host project's stack. Detect it from the open project (package.json, " +
              "composer.json, requirements.txt, Gemfile, .csproj) and confirm with the developer. " +
              'Use "generic" when none fits.',
          ),
        endpoint_path: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Path the endpoint is served at, e.g. "/webhooks/proabono". Defaults to that. It must ' +
              "be reachable over HTTPS from the public internet: ProAbono does not deliver to a " +
              "local address.",
          ),
        ...stateInputs,
      },
    },
    async ({ stack, endpoint_path, project_root, record_state }): Promise<ToolResult> =>
      guard(async () => {
        const path = endpoint_path ?? "/webhooks/proabono";

        const record = await recordStep(
          { project_root, record_state } as StateInputs,
          "notification_endpoint",
          {
            status: "generated",
            generated: [{ what: "notification endpoint and worker", where: path, stack }],
            pending_backoffice: [
              "Create the webhook under Integration → Webhooks, pointing at the HTTPS URL of this endpoint.",
              "Validate it with Send verification code, reading the code out of the endpoint's log.",
              "Subscribe the rights-affecting events, and only those, to this endpoint.",
            ],
          },
          { segmentRef: configuration.segmentRef, forbidden: secretsOf(configuration) },
        );

        return text(
          [
            `# ProAbono notification endpoint at \`${path}\` (${stack})`,
            "",
            "The endpoint is a **signal receiver**, not a state feed. What it does with a " +
              "notification is re-read the affected customer's rights and replace what was cached — " +
              "never patch state out of the payload. Everything below reads its configuration from " +
              "the environment: `PROABONO_WEBHOOK_SECRET` is never written into the code.",
            "",
            "## 1. The endpoint, the verification and the worker",
            "",
            "```",
            notificationEndpoint(stack, path),
            "```",
            "",
            "It calls four functions the project owns: `seenNotification` / `rememberNotification` " +
              "(any short-lived store — Redis, a table with a TTL, anything that survives a " +
              "restart), the queue it hands the body to, and `refreshEntitlements`, which is the " +
              "resynchronization `sync_usage_rights` generates. A deduplication store that lives in " +
              "process memory works until the second instance starts.",
            "",
            "## 2. Why the endpoint is built this way",
            "",
            ...WEBHOOK_RULES.map((rule) => `- ${rule}`),
            "",
            "## 3. The events pointed at it",
            "",
            "All of these change what a customer may do, and all of them go to **this one " +
              "endpoint**, which runs **one** resynchronization. Per-event handling takes longer to " +
              "write, misses the rare ones, and breaks the first time the business model changes:",
            "",
            ...RIGHTS_AFFECTING_EVENTS.map((event) => `- \`${event}\``),
            "",
            EXCLUDED_EVENTS_REASON,
            "",
            "## 4. The BackOffice procedure — nothing works before it",
            "",
            "The Live API cannot create a webhook, cannot validate one, and cannot subscribe an " +
              "event. Until a human does this, the endpoint is correct and receives nothing:",
            "",
            ...BACKOFFICE_PROCEDURE.map((step, index) => `${index + 1}. ${step}`),
            "",
            "## 5. Checks a server cannot run for you",
            "",
            ...WEBHOOK_MANUAL_CHECKS.map((check) => `- ${check}`),
            ...(record === undefined ? [] : ["", record]),
          ].join("\n"),
        );
      }),
  );
}
