/**
 * The In-Site orchestrator, and the state that makes an installation resumable.
 *
 * `install_insite` is the flagship tool: it maps to no endpoint, and its value is the journey it
 * encodes -- detect, confirm, gate, then run the three steps in order. Four things about it are
 * decisions rather than implementation details:
 *
 *  - **It detects, then confirms.** Stack detection reads signals in the open project and states a
 *    hypothesis; it never silently picks. And detection serves one purpose only: choosing the
 *    In-Site code flavour. It never routes to a Widget or a plug-in, even where the detected stack
 *    would lend itself to one -- those are another product, not a later phase of this one.
 *  - **The prerequisites gate comes before any code.** An authenticated customer area, a usable
 *    catalogue, a provisioning strategy and a host page. Generating three steps of code for a
 *    project that cannot use any of it wastes the developer's time and hides the real problem.
 *  - **An offer with no Feature is as blocking as no offer at all.** The subscription succeeds and
 *    the application gets no rights back, which is indistinguishable from a broken integration.
 *  - **It writes the state and it resumes from it.** The three steps are generated through the same
 *    tools a developer can call by hand, and every one of them records its own entry, so a
 *    half-installed project reports as half installed rather than as untouched.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { STACKS, type Stack } from "../generate/hosted-pages.js";
import {
  STEP_KEYS,
  STEP_TITLES,
  emptyState,
  readState,
  secretsOf,
  stateInputs,
  statePathFor,
  writeState,
  type InstallationState,
  type StepKey,
  type StepStatus,
} from "../install/state.js";
import { text, type ToolContext, type ToolResult } from "./context.js";
import { guard } from "./guard.js";

interface Offer {
  readonly ReferenceOffer?: string;
  readonly TitleLocalized?: string;
  readonly Features?: readonly unknown[];
}

interface Feature {
  readonly ReferenceFeature?: string;
  readonly TitleLocalized?: string;
  readonly TypeFeature?: string;
}

/**
 * The signals that identify a stack, in the order they are tried.
 *
 * A project can carry several -- a PHP application with a `package.json` for its front-end build
 * is ordinary -- so the hypothesis is stated with what it was based on, and the developer confirms
 * it. `next` is looked for before `node-express`, because a Next.js project is also a Node one and
 * the more specific answer is the useful one.
 */
const STACK_SIGNALS: readonly { file: string; stack: Stack }[] = [
  { file: "next.config.js", stack: "next" },
  { file: "next.config.mjs", stack: "next" },
  { file: "next.config.ts", stack: "next" },
  { file: "composer.json", stack: "php" },
  { file: "wp-config.php", stack: "php" },
  { file: "Gemfile", stack: "ruby" },
  { file: "requirements.txt", stack: "python" },
  { file: "pyproject.toml", stack: "python" },
  { file: "package.json", stack: "node-express" },
];

interface Detection {
  readonly stack: Stack;
  readonly because: string;
  readonly confident: boolean;
}

/** Reads the project for stack signals. Never decides alone: the caller confirms. */
export function detectStack(projectRoot: string): Detection {
  const found = STACK_SIGNALS.filter((signal) => existsSync(join(projectRoot, signal.file)));

  // A .NET project is identified by extension rather than by a fixed name -- there is no
  // `csproj.json`. It is looked at only when no named signal matched, so a mixed repository is
  // not misread on a stray file.
  if (found.length === 0) {
    let entries: string[] = [];
    try {
      entries = readdirSync(projectRoot);
    } catch {
      entries = [];
    }

    const project = entries.find((entry) => entry.endsWith(".csproj") || entry.endsWith(".sln"));
    if (project !== undefined) {
      return { stack: "csharp", because: `${project} is in the project root`, confident: true };
    }

    // Go has no In-Site code flavour of its own, so the honest answer is the generic sketch --
    // and saying why, rather than letting a Go developer wonder what was detected.
    if (entries.includes("go.mod")) {
      return {
        stack: "generic",
        because:
          "go.mod is in the project root, and this server generates no Go flavour: the generic " +
          "sketch states the rules and the HTTP calls, which is what a Go project needs from it",
        confident: true,
      };
    }

    return {
      stack: "generic",
      because:
        "no package.json, composer.json, Gemfile, requirements.txt, pyproject.toml, .csproj, " +
        "go.mod or Next.js config was found in the project root",
      confident: false,
    };
  }

  const first = found[0] as { file: string; stack: Stack };
  const others = found.slice(1);

  return {
    stack: first.stack,
    because:
      others.length === 0
        ? `${first.file} is in the project root`
        : `${first.file} is in the project root (${others.map((signal) => signal.file).join(", ")} ` +
          `also present, which is why this is a hypothesis and not a conclusion)`,
    confident: others.length === 0,
  };
}

export function registerInstallTools(server: McpServer, context: ToolContext): void {
  const { client, configuration } = context;

  server.registerTool(
    "install_insite",
    {
      title: "Install ProAbono in this site, end to end (In-Site orchestrator)",
      description:
        "Orchestrates the whole In-Site installation: detects the stack from the open project and " +
        "states its hypothesis, settles the Segment, checks the four prerequisites before " +
        "generating anything -- an authenticated customer area, a catalogue whose offers carry " +
        "Features, how a ProAbono customer will exist for a signed-in user, and a page to host the " +
        "portal -- then runs the three steps in order, Customer Portal, Subscription Workflow, " +
        "rights synchronization, and records progress in .proabono/installation.json so a later " +
        "session resumes instead of starting over. Call it when a developer asks to install, set " +
        "up or integrate ProAbono. It installs ONE way, In-Site by code: it never offers a Widget " +
        "or a plug-in, whatever the stack. It generates code and returns it; it writes no source " +
        "file of yours.",
      inputSchema: {
        stack: z
          .enum(STACKS as unknown as [Stack, ...Stack[]])
          .optional()
          .describe(
            "The host project's stack. Given, it bypasses detection entirely. Left out, the " +
              "project is read for signals and the hypothesis is stated for the developer to " +
              "confirm.",
          ),
        target_page: z
          .string()
          .optional()
          .describe(
            'The page that will host the Customer Portal, e.g. "/account/billing". Ask the ' +
              "developer rather than guessing: it must be inside the authenticated area.",
          ),
        return_route: z
          .string()
          .optional()
          .describe('Path every workflow comes back to, e.g. "/billing/return".'),
        provisioning: z
          .enum(["api_precreate", "on_load"])
          .optional()
          .describe(
            "How a ProAbono customer comes to exist for a signed-in user. api_precreate " +
              "(recommended) creates it at sign-up or first login; on_load lets the portal create " +
              "it when it opens. Steps 2 and 3 both need the customer to exist, and ProAbono " +
              "returns no Usages until a subscription has started.",
          ),
        customer_area: z
          .boolean()
          .optional()
          .describe(
            "Whether the site already has an authenticated customer area. This is the entry " +
              "condition: hosted pages always render for an identified customer. Ask the " +
              "developer; do not assume it.",
          ),
        ...stateInputs,
      },
    },
    async ({
      stack,
      target_page,
      return_route,
      provisioning,
      customer_area,
      project_root,
      record_state,
    }): Promise<ToolResult> =>
      guard(async () => {
        const root = project_root ?? process.cwd();
        const detection = stack === undefined ? detectStack(root) : undefined;
        const chosenStack = stack ?? detection?.stack ?? "generic";
        const returnRoute = return_route ?? "/billing/return";
        const strategy = provisioning ?? "api_precreate";

        const existing = readState(project_root);

        // --- the prerequisites gate, before a single line is generated -------------------
        const offers = await client.listAll<Offer>("/v1/Offers", {});
        const features = await client.listAll<Feature>("/v1/Features", {});
        const usable = offers.filter((offer) => (offer.Features ?? []).length > 0);

        const blockers: string[] = [];
        if (customer_area === false) {
          blockers.push(
            "**No authenticated customer area.** This is the entry condition, not a preference: " +
              "every ProAbono hosted page renders for an identified customer, and the security " +
              "hash is computed over that customer's reference. Build the sign-in first — nothing " +
              "below can be installed around it.",
          );
        }
        if (offers.length === 0) {
          blockers.push(
            "**This Segment exposes no offer.** Nothing can be subscribed to. Offers are authored " +
              "in the ProAbono BackOffice; the Live API cannot create one, and no code here works " +
              "around it.",
          );
        } else if (usable.length === 0) {
          blockers.push(
            "**No offer carries a Feature.** This is as blocking as having no offer at all: a " +
              "subscription succeeds, the application reads the Usage API and gets nothing back, " +
              "and that is indistinguishable from a broken integration. Attach at least one " +
              "Feature to an offer in the BackOffice.",
          );
        }
        if (features.length === 0) {
          blockers.push(
            "**This business defines no Feature.** Rights can be gated on nothing. Features are " +
              "authored in the BackOffice.",
          );
        }

        const sections: string[] = [
          "# Installing ProAbono in this project — In-Site, end to end",
          "",
          "**What this does and does not do.** It installs ProAbono **In-Site, by code**: the " +
            "hosted Customer Portal placed in your own page, the Subscription Workflow opened from " +
            "your own application, and rights read from the Usage API. It does not install a " +
            "Widget and does not install a plug-in — those are out of scope whatever the stack " +
            "detected below. It acts on the account your credentials open, and neither checks nor " +
            "announces which one that is.",
          "",
          "## 1. Where this installation stands",
          "",
          ...resumeSection(existing, project_root),
          "",
          "## 2. The stack",
          "",
          stack !== undefined
            ? `\`${stack}\`, given explicitly — detection was not run.`
            : `**Hypothesis: \`${detection?.stack}\`** — ${detection?.because}. ` +
              (detection?.confident === true
                ? "Confirm it before the generated code is placed."
                : "**Confirm or correct it with the developer before going further**, and pass " +
                  "`stack` on the next call.") +
              " Detection picks the code flavour and nothing else: it never routes to a Widget or " +
              "a plug-in installation.",
          "",
          "## 3. The Segment",
          "",
          `\`${configuration.segmentRef}\`, from \`PROABONO_SEGMENT_REF\`. Every generated call and ` +
            `every embed carries it. It is worth being deliberate here: the reference is optional ` +
            `on almost every operation, and omitting it does not fail — it silently acts on the ` +
            `Business's default Segment, and a \`ReferenceCustomer\` is unique *per Segment*.`,
          "",
          "## 4. The prerequisites",
          "",
        ];

        if (blockers.length > 0) {
          sections.push(
            "**Installation stops here.** These are not warnings — nothing below can work until " +
              "they are settled, and generating code around them would hide the real problem:",
            "",
            ...blockers.map((blocker) => `- ${blocker}`),
            "",
            "Fix them, then call `install_insite` again. Nothing was generated and the " +
              "installation state was not advanced.",
          );
          return text(sections.join("\n"));
        }

        sections.push(
          `- **Authenticated customer area** — ${
            customer_area === true
              ? "confirmed by the developer."
              : "**not confirmed**. Ask before the portal is placed: the hosted pages always " +
                "render for an identified customer, and the reference comes from the session."
          }`,
          `- **Catalogue** — ${usable.length} of ${offers.length} offer(s) carry at least one ` +
            `Feature, and the business defines ${features.length}: ` +
            `${features
              .slice(0, 8)
              .map((feature) => `\`${feature.ReferenceFeature ?? "?"}\` (${feature.TypeFeature ?? "?"})`)
              .join(", ")}${features.length > 8 ? ", …" : ""}.`,
          ...(offers.length === usable.length
            ? []
            : [
                `  - Carrying no Feature, and therefore unusable for gating: ` +
                  `${offers
                    .filter((offer) => (offer.Features ?? []).length === 0)
                    .map((offer) => `\`${offer.ReferenceOffer ?? "?"}\``)
                    .join(", ")}.`,
              ]),
          `- **Customer provisioning** — \`${strategy}\`` +
            (strategy === "api_precreate"
              ? ", the recommended default: create the ProAbono customer at sign-up or first " +
                "login with `create_update_customer`. Steps 2 and 3 both need the customer to " +
                "exist, and ProAbono returns **no Usages at all** until a subscription has " +
                "started — so provisioning early is what makes rights readable."
              : ": the portal creates the customer when it opens. It works, and it leaves you " +
                "without the user ↔ customer mapping at the moment steps 2 and 3 need it. " +
                "`api_precreate` is the recommended path."),
          `- **Portal host page** — ${
            target_page === undefined
              ? "**not chosen**. Ask the developer which route inside the authenticated area " +
                "should host it; `install_customer_portal` can scaffold one, which is offered and " +
                "never imposed."
              : `\`${target_page}\`.`
          }`,
          "",
          "## 5. The three steps, in order",
          "",
          "Each is generated by its own tool, which is also what a developer calls by hand — the " +
            "orchestrator adds the order, the prerequisites and the record, not a second code path:",
          "",
          `1. **${STEP_TITLES.customer_portal}** — \`install_customer_portal\` with ` +
            `\`stack: "${chosenStack}"\`` +
            `${target_page === undefined ? " and the host page once it is chosen" : `, \`target_page: "${target_page}"\``}. ` +
            `It returns the server-side hash computation, the route and the snippet.`,
          `2. **${STEP_TITLES.subscription_workflow}** — \`link_subscription_workflow\` with ` +
            `\`stack: "${chosenStack}"\`, the workflow this sign-up opens, and ` +
            `\`return_route: "${returnRoute}"\`. It returns the query read, both openings and the ` +
            `single return route.`,
          `3. **${STEP_TITLES.usage_rights}** — \`sync_usage_rights\` with ` +
            `\`stack: "${chosenStack}"\` and the Features to gate on. It returns the rights module, ` +
            `the cache, the gate and the resynchronization.`,
          `4. **${STEP_TITLES.notification_endpoint}** — \`scaffold_notification_endpoint\` with ` +
            `\`stack: "${chosenStack}"\`. Without it the rights cache is bounded by its ceiling ` +
            `alone: a right revoked in ProAbono keeps being served until the entry expires.`,
          "",
          "Run them in that order. Step 1 establishes the customer reference the other two stand " +
            "on, and step 3's resynchronization has nothing to attach to until step 4 exists.",
          "",
          "## 6. What only a human can do",
          "",
          "The Live API cannot perform any of these, and the installation is not finished without " +
            "them. They are recorded as pending in the installation state:",
          "",
          `- Set the workflow redirect URL to \`<your-host>${returnRoute}\` under *Settings → ` +
            `Hosted Pages → Customer Workflows*.`,
          "- Create the notification webhook under *Integration → Webhooks*, and validate it with " +
            "*Send verification code*.",
          "- Configure the In-Site installation URL under *Settings → Hosted Pages*, which is what " +
            "every `insite-*` link and the `?pa_query=` method are built on.",
          "",
          "## 7. Verify, then go live",
          "",
          "`verify_insite_installation` exercises steps 2 and 3 against the account, checks the " +
            "generated code statically, and runs the twelve-item go-live checklist. Run it before " +
            "shipping, not after.",
        );

        // The state records the installation's own choices here. Each step records itself when it
        // runs, which is what keeps a hand-driven installation honest.
        const recorded = recordInstallation(
          { project_root, record_state },
          {
            stack: chosenStack,
            stackConfirmed: stack !== undefined,
            provisioning: strategy,
            hostPage: target_page,
            segmentRef: configuration.segmentRef,
            returnRoute,
          },
        );
        if (recorded !== undefined) sections.push("", recorded);

        // Never filtered: an empty entry here is a blank line, and Markdown needs them. Dropping
        // them turned the paragraph after the numbered steps into a continuation of item 4.
        return text(sections.join("\n"));
      }),
  );

  server.registerTool(
    "installation_status",
    {
      title: "Read back where the ProAbono installation stands",
      description:
        "Reads .proabono/installation.json in the developer's project and reports where the " +
        "In-Site installation stands: which steps are done, which were generated but not yet " +
        "confirmed in place, which were deliberately skipped, what was generated where, and which " +
        "BackOffice actions are still pending. Call it at the start of a session before " +
        "generating anything, and whenever a developer asks what is left to do. A project that " +
        "has never been installed is reported as such, which is an answer and not a failure.",
      inputSchema: {
        project_root: stateInputs.project_root,
      },
    },
    async ({ project_root }): Promise<ToolResult> =>
      guard(async () => {
        const path = statePathFor(project_root);
        const state = readState(project_root);

        if (state === undefined) {
          return text(
            [
              "# ProAbono installation — not started",
              "",
              `There is no \`${path}\`, so nothing has been installed in this project through this ` +
                `server — or the project root is not the directory this server was launched in, in ` +
                `which case pass \`project_root\`.`,
              "",
              "That is an answer, not a failure. Start with `install_insite`, which checks the " +
                "prerequisites before generating anything.",
            ].join("\n"),
          );
        }

        const lines = [
          "# ProAbono installation — where it stands",
          "",
          `Read from \`${path}\`${state.updated === undefined ? "" : `, last written ${state.updated}`}.`,
          "",
          "## The installation's own choices",
          "",
          `- Segment: ${state.segment_ref === undefined ? "**not recorded**" : `\`${state.segment_ref}\``}`,
          `- Stack: ${state.stack === undefined ? "**not recorded**" : `\`${state.stack}\``}`,
          `- Customer provisioning: ${state.provisioning === undefined ? "**not recorded**" : `\`${state.provisioning}\``}`,
          `- Portal host page: ${state.host_page === undefined ? "**not recorded**" : `\`${state.host_page}\``}`,
          ...(state.gated_features === undefined || state.gated_features.length === 0
            ? []
            : [`- Features gated on: ${state.gated_features.map((ref) => `\`${ref}\``).join(", ")}`]),
          "",
          "## The steps",
          "",
        ];

        const pending: string[] = [];

        for (const key of STEP_KEYS) {
          const record = state.steps[key];
          const status: StepStatus = record?.status ?? "pending";
          lines.push(`### ${STEP_TITLES[key]} — \`${status}\``, "");
          lines.push(statusMeaning(status));

          if (record?.reason !== undefined) lines.push("", `Reason: ${record.reason}`);
          if (record?.generated !== undefined && record.generated.length > 0) {
            lines.push(
              "",
              ...record.generated.map(
                (artefact) =>
                  `- ${artefact.what}${artefact.where === undefined ? "" : ` → \`${artefact.where}\``}` +
                  `${artefact.stack === undefined ? "" : ` (${artefact.stack})`}`,
              ),
            );
          }
          for (const action of record?.pending_backoffice ?? []) pending.push(action);
          lines.push("");
        }

        lines.push(
          "## Still pending in the ProAbono BackOffice",
          "",
          ...(pending.length === 0
            ? ["Nothing recorded. That is not the same as nothing being owed: a step that was " +
               "never generated records no pending action either."]
            : Array.from(new Set(pending)).map((action) => `- ${action}`)),
          "",
          "*The Live API cannot read any of these back, so they are reported from what was " +
            "recorded, never verified. `verify_insite_installation` says the same and explains why.*",
        );

        return text(lines.join("\n"));
      }),
  );

  /** Records the orchestrator's own choices. Returns the line to print, or a failure note. */
  function recordInstallation(
    inputs: { project_root?: string; record_state?: boolean },
    choices: {
      stack: Stack;
      /** False when the stack is this run's hypothesis rather than the developer's answer. */
      stackConfirmed: boolean;
      provisioning: string;
      hostPage?: string;
      segmentRef: string;
      returnRoute: string;
    },
  ): string | undefined {
    if (inputs.record_state === false) return undefined;

    try {
      const current = readState(inputs.project_root) ?? emptyState();
      const next: InstallationState = {
        ...current,
        segment_ref: choices.segmentRef,
        // A detected stack is a hypothesis this run has just asked the developer to confirm.
        // Writing it into a committed file as a settled choice would answer that question on
        // their behalf. It is recorded when they pass it, and by each step tool that generates
        // for it -- which is a fact about what was generated, not a guess.
        ...(choices.stackConfirmed ? { stack: choices.stack } : {}),
        provisioning: choices.provisioning,
        ...(choices.hostPage === undefined ? {} : { host_page: choices.hostPage }),
        steps: withPendingSteps(current, choices.returnRoute),
      };

      const path = writeState(next, secretsOf(configuration), inputs.project_root);
      return (
        `---\n\n*Recorded in \`${path}\`. It is meant to be committed: it is what ` +
        `\`installation_status\` reads and what lets a later session resume. Each step records ` +
        `itself as it is generated.*`
      );
    } catch (error) {
      return (
        `---\n\n*The installation state was **not** written: ` +
        `${error instanceof Error ? error.message : String(error)}.*`
      );
    }
  }
}

/**
 * Steps absent from the state are recorded as `pending`, so the file lists all four.
 *
 * They carry the BackOffice actions they will owe, because the orchestrator's own output tells the
 * developer those are "recorded as pending in the installation state" -- and a file that did not
 * carry them made `installation_status` answer "Nothing recorded" one call later.
 */
function withPendingSteps(
  current: InstallationState,
  returnRoute: string,
): InstallationState["steps"] {
  const owed: Partial<Record<StepKey, readonly string[]>> = {
    customer_portal: [
      "Configure the In-Site installation URL under Settings → Hosted Pages. Every insite-* link " +
        "and the ?pa_query= method are built on it.",
    ],
    subscription_workflow: [
      `Set the workflow redirect URL to <your-host>${returnRoute} under Settings → Hosted Pages → ` +
        `Customer Workflows.`,
    ],
    notification_endpoint: [
      "Create the webhook under Integration → Webhooks, validate it with Send verification code, " +
        "and subscribe the rights-affecting events to it.",
    ],
  };

  const steps: Record<string, unknown> = { ...current.steps };
  for (const key of STEP_KEYS) {
    if (steps[key] !== undefined) continue;
    const pending = owed[key];
    steps[key] = {
      status: "pending" satisfies StepStatus,
      ...(pending === undefined ? {} : { pending_backoffice: pending }),
    };
  }
  return steps as InstallationState["steps"];
}

function resumeSection(
  state: InstallationState | undefined,
  projectRoot: string | undefined,
): string[] {
  if (state === undefined) {
    return [
      `No \`${statePathFor(projectRoot)}\`: nothing has been installed here through this server. ` +
        `This run starts from the beginning.`,
    ];
  }

  const done = STEP_KEYS.filter((key) => state.steps[key]?.status === "done");
  const generated = STEP_KEYS.filter((key) => state.steps[key]?.status === "generated");
  const skipped = STEP_KEYS.filter((key) => state.steps[key]?.status === "skipped");
  const left = STEP_KEYS.filter(
    (key) => (state.steps[key]?.status ?? "pending") === "pending",
  );

  return [
    `A previous session left a state in \`${statePathFor(projectRoot)}\`. Resuming from it rather ` +
      `than starting over:`,
    "",
    `- Confirmed in place: ${done.length === 0 ? "none" : done.map((key) => STEP_TITLES[key]).join(", ")}`,
    `- Generated, placement not confirmed: ${generated.length === 0 ? "none" : generated.map((key) => STEP_TITLES[key]).join(", ")}`,
    `- Deliberately skipped: ${skipped.length === 0 ? "none" : skipped.map((key) => STEP_TITLES[key]).join(", ")}`,
    `- Not started: ${left.length === 0 ? "none" : left.map((key) => STEP_TITLES[key]).join(", ")}`,
    "",
    "`installation_status` gives the detail, including what was generated where.",
  ];
}

function statusMeaning(status: StepStatus): string {
  switch (status) {
    case "pending":
      return "Nothing has been generated for this step.";
    case "generated":
      return (
        "The code was generated and where it goes is recorded. **Nothing has confirmed it is " +
        "actually in place** — a generator hands back code, it does not paste it. " +
        "`verify_insite_installation` is what moves this to `done`."
      );
    case "done":
      return "Confirmed wired — by the developer, or by `verify_insite_installation`.";
    case "skipped":
      return "Deliberately not installed.";
  }
}
