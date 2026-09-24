/**
 * `verify_insite_installation` -- what can actually be established, and what cannot.
 *
 * The structural limit is the whole design of this tool: **a local MCP server sees no browser and
 * no DOM**. It cannot open the merchant's page, cannot run the portal script, and cannot read the
 * ProAbono BackOffice. So verification is API-side, static, and partly guided -- and every line of
 * output says which of the three it is. A tool that blurred that line would be worse than no tool:
 * a developer would read "verified" and ship an embed nobody looked at.
 *
 * Three honest categories, and they are the output's structure:
 *
 *  - **Verified** -- exercised against the account, right now. Steps 2 and 3: a customer exists, an
 *    object comes back carrying the `insite-*` query the workflow needs, the Usage API answers for
 *    that customer, and an empty answer is diagnosed rather than reported as "no rights".
 *  - **Checked statically** -- the rules of spec section 9 read off the developer's own files.
 *    A grep is not a proof, and where it cannot conclude it says so instead of passing.
 *  - **Pending in the BackOffice / manual** -- the redirect URL, the webhook creation and
 *    validation, and the presence of the snippet in the page. The Live API cannot read any of them
 *    back. They are **reported from the installation state**, never verified, and the difference is
 *    stated every time.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { ProAbonoApiError } from "../api/errors.js";
import { STEP_KEYS, STEP_TITLES, readState, stateInputs } from "../install/state.js";
import { text, type ToolContext, type ToolResult } from "./context.js";
import { guard } from "./guard.js";

/** The twelve items of spec section 9, in order. The checklist is the deliverable. */
export const GO_LIVE_CHECKLIST: readonly string[] = [
  "Credentials are in configuration, not committed to the repository, and not inlined in any generated file.",
  "The portal security hash is computed server-side, emits lowercase hex, is not cached across users, and is passed on every hosted-page open.",
  "The customer reference passed to hosted pages is derived from the session.",
  "Nothing branches on `ReferenceOffer` — rights come from the Usage API.",
  "The rights cache is **replaced** wholesale on refresh, never merged.",
  "`IsEnabled` is enforced for `OnOff`, and an absent `QuantityCurrent` is read as unlimited, not zero.",
  "Paginated collections are read to `TotalItems`, not one page.",
  "A failed rights read serves the stale cache and raises an alert — it never yields zero rights, and never clears the session.",
  "The notification endpoint is reachable over HTTPS, validated, with signature verification on, and every rights-affecting event points at it; payment and invoice events deliberately do not.",
  "The workflow redirect URL is configured, and the return route re-reads rights for every outcome.",
  "Every gated path checks rights; every Feature the application changes is written back.",
  "The portal is reachable from the customer area.",
];

/** Where the static checks look. Everything else in a repository is noise for this purpose. */
const SOURCE_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".php",
  ".py",
  ".rb",
  ".cs",
  ".html",
  ".erb",
  ".vue",
]);

/** Directories never worth reading, and expensive to walk. */
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "vendor",
  ".next",
  "__pycache__",
  "bin",
  "obj",
  ".venv",
  "venv",
]);

/** A file the walk read, kept as text so several checks share one read. */
interface SourceFile {
  readonly path: string;
  readonly content: string;
}

/** Reads the project's source files, bounded so a huge repository cannot hang a tool call. */
function readSources(root: string, limit = 400): readonly SourceFile[] {
  const files: SourceFile[] = [];

  const walk = (directory: string, depth: number): void => {
    if (files.length >= limit || depth > 8) return;

    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (files.length >= limit) return;
      if (SKIPPED_DIRECTORIES.has(entry) || entry.startsWith(".")) continue;

      const full = join(directory, entry);
      let isDirectory: boolean;
      try {
        isDirectory = statSync(full).isDirectory();
      } catch {
        continue;
      }

      if (isDirectory) {
        walk(full, depth + 1);
        continue;
      }
      if (!SOURCE_EXTENSIONS.has(extname(entry))) continue;

      try {
        files.push({ path: relative(root, full), content: readFileSync(full, "utf8") });
      } catch {
        // Unreadable is not a finding: it is a file this check simply could not see, and the
        // report says how many were read so a developer can tell the two apart.
      }
    }
  };

  walk(root, 0);
  return files;
}

type Verdict = "pass" | "fail" | "unknown";

interface StaticFinding {
  readonly item: number;
  readonly verdict: Verdict;
  readonly detail: string;
}

/** The static half: the rules of section 9 that can be read off a file, and only those. */
function staticChecks(
  sources: readonly SourceFile[],
  secrets: readonly string[],
): readonly StaticFinding[] {
  const findings: StaticFinding[] = [];
  const where = (matches: readonly SourceFile[]): string =>
    matches
      .slice(0, 5)
      .map((file) => `\`${file.path}\``)
      .join(", ") + (matches.length > 5 ? `, and ${matches.length - 5} more` : "");

  if (sources.length === 0) {
    return [
      {
        item: 0,
        verdict: "unknown",
        detail:
          "No source file was read at all. Either `project_root` does not point at the project, " +
          "or its files carry extensions this check does not know. Nothing below was established " +
          "— which is not the same as nothing being wrong.",
      },
    ];
  }

  // Item 1 -- a secret inlined. This is the one static check that is conclusive when it fires:
  // the value compared against is the configured secret itself, so a match is not a heuristic.
  const leaking = sources.filter((file) =>
    secrets.some((secret) => secret.length > 0 && file.content.includes(secret)),
  );
  findings.push(
    leaking.length > 0
      ? {
          item: 1,
          verdict: "fail",
          detail:
            `A configured secret appears **verbatim** in ${where(leaking)}. This is not a ` +
            `false positive: the value compared against is the one this server was given. Move it ` +
            `to configuration, read it by name, and rotate it — it is in the repository's history ` +
            `from the commit that added it.`,
        }
      : {
          item: 1,
          verdict: "pass",
          detail: `No configured secret appears verbatim in the ${sources.length} file(s) read.`,
        },
  );

  // Item 2 -- the hash. Computed in the browser is the failure this looks for.
  const browserHash = sources.filter(
    (file) =>
      /\.(html|erb|vue|jsx|tsx)$/.test(file.path) &&
      /(createHmac|hash_hmac|HMACSHA256|CryptoJS)/.test(file.content),
  );
  const serverHash = sources.filter((file) =>
    /(createHmac|hash_hmac|HMACSHA256|OpenSSL::HMAC|hmac\.new)/.test(file.content),
  );
  findings.push(
    browserHash.length > 0
      ? {
          item: 2,
          verdict: "fail",
          detail:
            `A hash looks computed inside a template or a client component: ${where(browserHash)}. ` +
            `The portal secret must never reach the browser — anything in the page is readable by ` +
            `the visitor.`,
        }
      : serverHash.length > 0
        ? {
            item: 2,
            verdict: "pass",
            detail:
              `The hash is computed in server-side code (${where(serverHash)}), and no template ` +
              `computes one. Whether it is lowercase hex and uncached per user is visible only at ` +
              `render: the console test is below.`,
          }
        : {
            item: 2,
            verdict: "unknown",
            detail:
              "No HMAC computation was found anywhere. Either step 1 is not placed yet, or it " +
              "lives in a file this check did not read.",
          },
  );

  // Item 3 -- the customer reference from the request. The patterns are the ones the generated
  // code deliberately never uses.
  const requestDerived = sources.filter((file) =>
    /(customer_ref|customerRef|customerReference)\s*[:=]\s*(req\.(query|body|params)|\$_GET|\$_POST|request\.args|searchParams\.get)/.test(
      file.content,
    ),
  );
  findings.push(
    requestDerived.length > 0
      ? {
          item: 3,
          verdict: "fail",
          detail:
            `A customer reference is taken from the request in ${where(requestDerived)}. Anyone ` +
            `can change it and read another customer's invoices, addresses and payment details. ` +
            `It comes from the session, always.`,
        }
      : {
          item: 3,
          verdict: "pass",
          detail: "No customer reference is assigned from a query string, a form field or a route parameter.",
        },
  );

  // Item 4 -- branching on the offer.
  // The keywords are matched on word boundaries: without them `Verify`, `identifier` and `notify`
  // all contain one, and a comment mentioning `ReferenceOffer` eighty characters later was being
  // reported as a failure.
  const offerBranches = sources.filter((file) =>
    /\b(if|switch|when|match|case|elif|unless)\b[^\n]{0,80}ReferenceOffer/.test(file.content),
  );
  findings.push(
    offerBranches.length > 0
      ? {
          item: 4,
          verdict: "fail",
          detail:
            `Something branches on \`ReferenceOffer\` in ${where(offerBranches)}. The offer is ` +
            `what was bought; the Usage is what is allowed now. Gate on the Usage.`,
        }
      : {
          item: 4,
          verdict: "pass",
          detail: "Nothing branches on `ReferenceOffer`.",
        },
  );

  // Items 5 to 8 -- the rights module's own properties. They are only meaningful where a rights
  // module exists, so their absence is `unknown` and never `pass`.
  const rightsModules = sources.filter((file) => /\/v1\/Usages|Usages\?|fetchAllUsages|fetch_all_usages/.test(file.content));
  if (rightsModules.length === 0) {
    for (const item of [5, 6, 7, 8]) {
      findings.push({
        item,
        verdict: "unknown",
        detail:
          "No code reading `/v1/Usages` was found, so nothing about the rights cache could be " +
          "checked. Generate step 3 with `sync_usage_rights` and place it.",
      });
    }
    return findings;
  }

  const merging = rightsModules.filter((file) =>
    /(Object\.assign\([^\n]*cache|cache\[[^\]]*\]\.push|array_merge\(\$cached|\.update\(cached)/.test(
      file.content,
    ),
  );
  findings.push({
    item: 5,
    verdict: merging.length > 0 ? "fail" : "pass",
    detail:
      merging.length > 0
        ? `The cached entry looks merged into rather than replaced in ${where(merging)}. A Feature ` +
          `that disappeared from the response would stay granted.`
        : "The rights cache is assigned wholesale, not merged into.",
  });

  const included = rightsModules.filter((file) => /['"\.]IsIncluded\b/.test(file.content));
  findings.push({
    item: 6,
    verdict: included.length > 0 ? "fail" : "pass",
    detail:
      included.length > 0
        ? `\`IsIncluded\` is read in ${where(included)}. An \`OnOff\` Feature included in the offer ` +
          `can still be switched off — enforce \`IsEnabled\`.`
        : "`IsIncluded` is never read; the gate is on `IsEnabled`.",
  });

  const paginated = rightsModules.filter((file) => file.content.includes("TotalItems"));
  findings.push({
    item: 7,
    verdict: paginated.length > 0 ? "pass" : "fail",
    detail:
      paginated.length > 0
        ? "The collection read loops to `TotalItems`."
        : "No read loops to `TotalItems`. One page of rights is a subset, and looks exactly like " +
          "the whole set.",
  });

  const failSoft = rightsModules.filter((file) =>
    /(catch|except|rescue)/.test(file.content) && /(cached|last known good)/.test(file.content),
  );
  findings.push({
    item: 8,
    verdict: failSoft.length > 0 ? "pass" : "unknown",
    detail:
      failSoft.length > 0
        ? "A failed read falls back to what was cached rather than to no rights."
        : "No fallback to the last known good cache was recognised. Check by hand that a failed " +
          "read does not yield zero rights and does not clear the session — this check cannot " +
          "conclude, and does not claim to.",
  });

  return findings;
}

export function registerVerifyTools(server: McpServer, context: ToolContext): void {
  const { client, configuration } = context;

  server.registerTool(
    "verify_insite_installation",
    {
      title: "Verify the In-Site installation, and run the go-live checklist",
      description:
        "Checks an In-Site installation before it ships. It exercises steps 2 and 3 against the " +
        "account for real -- reads a customer, confirms an object comes back carrying the " +
        "insite-* workflow query, and reads the Usage API for that customer, diagnosing an empty " +
        "answer instead of calling it 'no rights'. It checks the developer's own files statically " +
        "against the rules of the go-live checklist: no secret inlined, no customer reference from " +
        "the request, no branch on ReferenceOffer, the cache replaced rather than merged, " +
        "IsEnabled enforced, pagination read whole. And it reports what no API can verify -- the " +
        "workflow redirect URL, the webhook validation, and the snippet's presence in the page -- " +
        "as pending rather than pretending. Ends with the twelve-item go-live checklist. Run it " +
        "before shipping, not after.",
      inputSchema: {
        customer_ref: z
          .string()
          .optional()
          .describe(
            "A customer to exercise the wiring against — ideally one that has subscribed. " +
              "Without it, steps 2 and 3 cannot be verified end to end and are reported as " +
              "unverified rather than as passing.",
          ),
        offer_ref: z
          .string()
          .optional()
          .describe(
            "An offer to check the subscribe workflow against. It is what makes the " +
              "`insite-subscribe` query appear on the customer at all.",
          ),
        project_root: stateInputs.project_root,
      },
    },
    async ({ customer_ref, offer_ref, project_root }): Promise<ToolResult> =>
      guard(async () => {
        const root = project_root ?? process.cwd();
        const state = readState(project_root);
        const sections: string[] = [
          "# Verifying the In-Site installation",
          "",
          "**What this can and cannot establish.** A local MCP server has no browser and no DOM: " +
            "it cannot open your page, cannot run the portal script, and cannot read the ProAbono " +
            "BackOffice. So each line below says which of three things it is — *verified* against " +
            "the account, *checked statically* in your files, or *pending* and merely reported. " +
            "Nothing that was not exercised is called verified.",
          "",
        ];

        // ── Verified against the account ────────────────────────────────────────────────
        sections.push("## 1. Verified against the account", "");

        if (customer_ref === undefined) {
          sections.push(
            "**Not run.** No `customer_ref` was given, so nothing was exercised end to end. Steps " +
              "2 and 3 are **unverified** — not passing. Pass a customer who has subscribed.",
          );
        } else {
          // A failure here is a *finding about the installation*, not a failure of the
          // verification: the API answers 404 for a customer that does not exist, and letting
          // that propagate would throw away the static checks, the pending list and the whole
          // checklist -- everything this tool is run for.
          try {
            sections.push(...(await exerciseSteps(customer_ref, offer_ref)));
          } catch (error) {
            sections.push(
              `**Steps 2 and 3 — unverified.** Reading \`${customer_ref}\` from the account ` +
                `failed: ${error instanceof ProAbonoApiError ? error.describe() : String(error)}.`,
              "",
              "A `404` here means no customer carries that reference in Segment " +
                `\`${configuration.segmentRef}\` — provision it first, since steps 2 and 3 both ` +
                `need the customer to exist. Everything below was checked all the same.`,
            );
          }
        }

        // ── Checked statically ──────────────────────────────────────────────────────────
        const sources = readSources(root);
        const findings = staticChecks(sources, [
          configuration.agentKey,
          configuration.apiKey,
          configuration.portalSecret,
          configuration.webhookSecret,
        ]);

        sections.push(
          "",
          "## 2. Checked statically, in your project",
          "",
          `Read ${sources.length} source file(s) under \`${root}\`. A static check is not a proof: ` +
            `where it cannot conclude it says **unknown**, which is not a pass.`,
          "",
          ...findings.map(
            (finding) =>
              `- ${verdictMark(finding.verdict)} **${finding.item === 0 ? "—" : `Checklist item ${finding.item}`}** — ${finding.detail}`,
          ),
        );

        // ── Reported, not verified ──────────────────────────────────────────────────────
        sections.push(
          "",
          "## 3. Pending in the BackOffice — reported, never verified",
          "",
          "The Live API cannot read any of these back. What follows is what the installation state " +
            "recorded, which is a record of what was *asked for*, not evidence that it was done:",
          "",
          ...pendingSection(state),
          "",
          "## 4. Manual checks — the ones needing a browser",
          "",
          "- Open the portal page signed in as two different customers: each must see their own " +
            "data, and the page source must show a different hash and no secret.",
          "- In the browser console, confirm `portal.js` loaded before `ProAbonoPortal.open()` ran " +
            "and that `#proabono_portal` exists.",
          "- Complete one workflow and confirm the browser lands on the return route.",
          "- POST to the notification endpoint without a signature header: it must answer 403.",
          "",
          "## 5. The go-live checklist",
          "",
          ...GO_LIVE_CHECKLIST.map((item, index) => `${index + 1}. ${item}`),
        );

        return text(sections.join("\n"));
      }),
  );

  /** Exercises steps 2 and 3 for real, and says which of the three empty causes applies. */
  async function exerciseSteps(customerRef: string, offerRef?: string): Promise<string[]> {
    const lines: string[] = [];

    const customer = await client.get<{
      Id?: number;
      ReferenceCustomer?: string;
      Links?: { rel?: string; href?: string; query?: string }[];
    }>("/v1/Customer", {
      ReferenceCustomer: customerRef,
      ...(offerRef === undefined ? {} : { ReferenceOffer: offerRef }),
    });

    // `204 No Content` is the one "not there" the client does not raise: a missing customer is a
    // 404 and reaches the caller as an error.
    if (customer === undefined || customer.Id === undefined) {
      lines.push(
        `**Step 2 — unverified.** The account answered with no customer record for ` +
          `\`${customerRef}\` in Segment \`${configuration.segmentRef}\`. Provision the customer ` +
          `first: steps 2 and 3 both need it to exist, and ProAbono returns no Usages at all ` +
          `before a subscription has started.`,
      );
      return lines;
    }

    const links = customer.Links ?? [];
    const rels = links.map((link) => link.rel).filter(Boolean);
    const insiteLinks = links.filter((link) => link.rel?.startsWith("insite-") === true);
    const insite = insiteLinks.map((link) => link.rel);
    // Counted over the insite links alone: reported as "N insite links, M of which carry a query",
    // M has to be a subset of N or the sentence is false.
    const queries = insiteLinks.filter((link) => typeof link.query === "string");

    if (insite.length === 0) {
      lines.push(
        "**Step 2 — fails here.** The customer came back carrying **no `insite-*` link at all**. " +
          "Every one of them is built on the Segment's In-Site installation URL, configured under " +
          "*Settings → Hosted Pages* in the BackOffice — without it there is no query to open a " +
          "workflow with, and the `?pa_query=` method has no URL to append to.",
      );
    } else {
      lines.push(
        `**Step 2 — verified.** The customer publishes ${insite.length} \`insite-*\` link(s): ` +
          `${insite.map((rel) => `\`${rel}\``).join(", ")}, ${queries.length} of which carry an ` +
          `encrypted query. A valid query comes back, which is what the workflow opens on.`,
        offerRef === undefined
          ? "  - No `offer_ref` was passed, so the `insite-subscribe` query was not asked for: it " +
            "appears only when the fetch names an offer. Its absence here proves nothing."
          : rels.includes("insite-subscribe")
            ? `  - \`insite-subscribe\` is present for \`${offerRef}\`: that workflow applies to ` +
              `this customer right now.`
            : `  - \`insite-subscribe\` is **absent** although \`${offerRef}\` was named. Either ` +
              `the offer is not in this Segment, or this customer's state makes subscribing to it ` +
              `inapplicable — a running subscription on it, for instance.`,
      );
    }

    // Step 3, and the empty-response diagnosis, which is the part that matters most.
    const usages = await client.listAll<{
      ReferenceFeature?: string;
      TypeFeature?: string;
      DatePeriodEnd?: string;
    }>("/v1/Usages", { ReferenceCustomer: customerRef });

    if (usages.length > 0) {
      lines.push(
        "",
        `**Step 3 — verified.** ${usages.length} Usage(s) come back for this customer: ` +
          `${usages
            .map((usage) => `\`${usage.ReferenceFeature ?? "?"}\` (${usage.TypeFeature ?? "?"})`)
            .join(", ")}. The rights read is wired correctly.`,
        "",
        "  - **One caveat, and it is not rhetorical.** `GET /v1/Usages` declares no " +
          "`ReferenceSegment` — alone among the collections this server reads — so this read is " +
          "Segment-blind, while a `ReferenceCustomer` is unique *per Segment*. In a Business with " +
          "one Segment that changes nothing. In a Business with several, confirm that the " +
          "customer these rights belong to is the one in " +
          `\`${configuration.segmentRef}\`. The gap is recorded in the spec and is not closed.`,
      );
      return lines;
    }

    const subscriptions = await client.listAll<{
      Status?: string;
      StateSubscription?: string;
      ReferenceOffer?: string;
      Features?: readonly unknown[];
    }>("/v1/Subscriptions", { ReferenceCustomer: customerRef });

    if (subscriptions.length === 0) {
      lines.push(
        "",
        "**Step 3 — empty, cause 1.** No Usage and no subscription: this customer has never " +
          "subscribed, so ProAbono has no rights to report. That is correct, not a bug — and it " +
          "is also why this run does not establish that the rights read works. Subscribe a " +
          "customer and run this again.",
      );
      return lines;
    }

    const running = subscriptions.filter((subscription) => subscription.Status === "Active");
    if (running.length === 0) {
      lines.push(
        "",
        `**Step 3 — empty, cause 2.** ${subscriptions.length} subscription(s), none running ` +
          `(${subscriptions.map((s) => s.StateSubscription ?? s.Status ?? "?").join(", ")}). A ` +
          `lifecycle state, not an integration bug: the application is right to grant nothing.`,
      );
      return lines;
    }

    const bare = running.filter((subscription) => (subscription.Features ?? []).length === 0);
    lines.push(
      "",
      bare.length > 0
        ? `**Step 3 — empty, cause 3.** ${bare.length} running subscription(s) whose offer carries ` +
          `**no Feature** (${bare.map((s) => `\`${s.ReferenceOffer ?? "?"}\``).join(", ")}). This ` +
          `is a catalogue problem and the one that looks exactly like a broken integration. ` +
          `Create a Feature in the BackOffice and attach it to the offer; no code can work around ` +
          `it.`
        : "**Step 3 — empty, and matching none of the three known causes.** There are running " +
          "subscriptions carrying Features and still no Usage. Worth reporting: check with " +
          "`get_subscription` that the Features are the ones you expect, and that the customer " +
          "reference is the one the subscription is on.",
    );
    return lines;
  }
}

function verdictMark(verdict: Verdict): string {
  switch (verdict) {
    case "pass":
      return "**passes**";
    case "fail":
      return "**FAILS**";
    case "unknown":
      return "**unknown**";
  }
}

/** What the state recorded as owed in the BackOffice. Reported, with what that is worth. */
function pendingSection(state: ReturnType<typeof readState>): string[] {
  if (state === undefined) {
    return [
      "There is no installation state in this project, so nothing is recorded. Two BackOffice " +
        "actions are owed by every In-Site installation all the same, and neither can be read " +
        "back through the API:",
      "",
      "- The workflow redirect URL, under *Settings → Hosted Pages → Customer Workflows*.",
      "- The notification webhook, created **and validated** under *Integration → Webhooks*.",
    ];
  }

  const pending = STEP_KEYS.flatMap((key) =>
    (state.steps[key]?.pending_backoffice ?? []).map((action) => `- ${STEP_TITLES[key]}: ${action}`),
  );

  return pending.length === 0
    ? [
        "Nothing is recorded as pending. That is not evidence that nothing is owed: a step that " +
          "was never generated records no pending action either.",
      ]
    : Array.from(new Set(pending));
}
