/**
 * The installation state: `.proabono/installation.json` in the developer's own project.
 *
 * It is what makes an installation resumable across sessions, and it is the only thing this server
 * writes to disk. Four decisions govern it, and none of them is incidental:
 *
 *  - **It belongs to the project, not to the machine.** It is meant to be committed, so a
 *    colleague, or the same developer three weeks later, reads what was installed and what is
 *    still owed. Nothing in it is specific to one workstation.
 *  - **It holds no credential.** Not a key, not a secret, not an `Authorization` header, under any
 *    provisioning strategy. `assertNoCredential` enforces that on every write rather than trusting
 *    the caller, and the suite asserts it too: a file meant to be committed is exactly the wrong
 *    place to discover a leak.
 *  - **Every tool that generates a step records it**, not only the orchestrator. The alternative
 *    makes `installation_status` answer "nothing installed" for a project a developer installed by
 *    hand, tool by tool -- which is the one question that tool exists to answer.
 *  - **`generated` is not `done`.** A generator hands back code; it does not paste it. Recording a
 *    step as done the moment its code was returned would make the file claim something no tool
 *    observed, and `verify_insite_installation` would then contradict the file that is supposed to
 *    drive it.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { z } from "zod";

/** Where the state lives, relative to the project root. Fixed: a state nobody can find is none. */
export const STATE_PATH = join(".proabono", "installation.json");

/** The version of the file's own shape, so a later reader knows what it is looking at. */
export const STATE_VERSION = 1;

/** The four states of spec section 11, in the order an installation moves through them. */
export type StepStatus = "pending" | "generated" | "done" | "skipped";

/** The steps the state tracks. The three In-Site steps, plus the endpoint that keeps step 3 true. */
export const STEP_KEYS = [
  "customer_portal",
  "subscription_workflow",
  "usage_rights",
  "notification_endpoint",
] as const;

export type StepKey = (typeof STEP_KEYS)[number];

/** What each step is called where a human reads it. */
export const STEP_TITLES: Record<StepKey, string> = {
  customer_portal: "Step 1 — Customer Portal",
  subscription_workflow: "Step 2 — Subscription Workflow",
  usage_rights: "Step 3 — rights and usage via the Usage API",
  notification_endpoint: "The notification endpoint (wired into step 3)",
};

export interface GeneratedArtefact {
  /** What was generated, in the developer's words: "the portal embed", "the return route". */
  readonly what: string;
  /** Where it is meant to go: a route, a path, a page. Never a machine-absolute path. */
  readonly where?: string;
  readonly stack?: string;
}

export interface StepRecord {
  readonly status: StepStatus;
  readonly generated?: readonly GeneratedArtefact[];
  /** What a human must do in the ProAbono BackOffice. The Live API cannot perform any of it. */
  readonly pending_backoffice?: readonly string[];
  /** Why a step was skipped. Recorded only for `skipped`, and required there. */
  readonly reason?: string;
  /** When this record was last written, UTC. */
  readonly updated?: string;
}

export interface InstallationState {
  readonly version: number;
  /** The Segment every generated call and embed carries. A reference, never a credential. */
  readonly segment_ref?: string;
  /** `api_precreate` (recommended) or `on_load`. */
  readonly provisioning?: string;
  readonly host_page?: string;
  readonly stack?: string;
  readonly gated_features?: readonly string[];
  readonly offers?: readonly string[];
  readonly steps: Partial<Record<StepKey, StepRecord>>;
  readonly updated?: string;
}

/** The two inputs every step tool takes, so the state is written where the project actually is. */
export const stateInputs = {
  project_root: z
    .string()
    .optional()
    .describe(
      "Root of the developer's project, where `.proabono/installation.json` is written. Defaults " +
        "to the directory this server was launched in, which is the project for every MCP client " +
        "that starts the server inside it. Pass it when that is not the case.",
    ),
  record_state: z
    .boolean()
    .optional()
    .describe(
      "Record this step in `.proabono/installation.json`. Default true. Set false to generate " +
        "code without touching the developer's filesystem at all.",
    ),
};

export interface StateInputs {
  readonly project_root?: string;
  readonly record_state?: boolean;
}

/**
 * The four configured values that must never reach the file.
 *
 * Deliberately not every configured value: `apiBase`, `businessId` and `segmentRef` are not
 * credentials, and the Segment reference in particular is *recorded on purpose* -- it is what
 * every generated call carries. Handing the whole configuration to the check would refuse to write
 * the very field the state exists to keep.
 */
export function secretsOf(configuration: {
  readonly agentKey: string;
  readonly apiKey: string;
  readonly portalSecret: string;
  readonly webhookSecret: string;
}): readonly string[] {
  return [
    configuration.agentKey,
    configuration.apiKey,
    configuration.portalSecret,
    configuration.webhookSecret,
  ];
}

/** Anything that looks like a credential, checked against a value before it is written. */
const CREDENTIAL_KEY = /(secret|password|api[_-]?key|agent[_-]?key|authorization|token|bearer)/i;

/**
 * Refuses to write a state carrying a credential, whatever the field is called.
 *
 * Both halves matter. A key named `portal_secret` is caught by its name even if the value is a
 * placeholder; a value that *is* one of the configured secrets is caught whatever it is called,
 * because a leak renamed is still a leak. The check runs on the way to disk, not at the call
 * sites, so a new caller cannot forget it.
 */
export function assertNoCredential(value: unknown, forbidden: readonly string[]): void {
  const walk = (node: unknown, path: string): void => {
    if (typeof node === "string") {
      for (const secret of forbidden) {
        if (secret.length > 0 && node.includes(secret)) {
          throw new Error(
            `The installation state is meant to be committed and must hold no credential, and ` +
              `${path || "a value"} carries one. Nothing was written.`,
          );
        }
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (typeof node === "object" && node !== null) {
      for (const [key, item] of Object.entries(node)) {
        if (CREDENTIAL_KEY.test(key)) {
          throw new Error(
            `The installation state is meant to be committed and must hold no credential. The ` +
              `field "${path ? `${path}.` : ""}${key}" names one. Nothing was written.`,
          );
        }
        walk(item, path ? `${path}.${key}` : key);
      }
    }
  };

  walk(value, "");
}

/** The absolute path of the state file for a project root, defaulting to the launch directory. */
export function statePathFor(projectRoot?: string): string {
  const root = projectRoot === undefined || projectRoot.length === 0 ? process.cwd() : projectRoot;
  return join(isAbsolute(root) ? root : resolve(root), STATE_PATH);
}

/** An installation nobody has started yet. Not an error: it is the honest answer for a new project. */
export function emptyState(): InstallationState {
  return { version: STATE_VERSION, steps: {} };
}

/**
 * Reads the state, or `undefined` when the project has none.
 *
 * A file that exists and does not parse is a different thing from no file at all, and is raised:
 * silently starting over would discard what a previous session recorded.
 */
export function readState(projectRoot?: string): InstallationState | undefined {
  const path = statePathFor(projectRoot);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as InstallationState;
    return { ...emptyState(), ...parsed, steps: parsed.steps ?? {} };
  } catch (error) {
    throw new Error(
      `${path} exists but is not readable JSON, so a previous session's record cannot be ` +
        `honoured: ${error instanceof Error ? error.message : String(error)}. Fix or delete the ` +
        `file rather than letting an installation start over on top of it.`,
    );
  }
}

/** Writes the state, creating `.proabono/` if it is not there. Refuses to carry a credential. */
export function writeState(
  state: InstallationState,
  forbidden: readonly string[],
  projectRoot?: string,
): string {
  assertNoCredential(state, forbidden);

  const path = statePathFor(projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ ...state, updated: nowUtc() }, null, 2)}\n`, "utf8");
  return path;
}

function nowUtc(): string {
  return new Date().toISOString();
}

export interface RecordContext {
  /** The configured Segment, recorded as a reference. Every generated call carries it. */
  readonly segmentRef?: string;
  /** The values that must never reach the file, whatever field they would land in. */
  readonly forbidden?: readonly string[];
  /** Fields of the installation as a whole, settled by the orchestrator or by a step tool. */
  readonly installation?: Partial<Omit<InstallationState, "version" | "steps">>;
}

/**
 * Records one step and returns the line the tool prints, or `undefined` when nothing was written.
 *
 * It never throws the installation away on a write failure: a generator that produced correct code
 * and could not write a bookkeeping file has still done its job, and saying so is more useful than
 * failing the call. What it must not do is claim a write that did not happen, which is why the
 * returned line names the error when there was one.
 */
export async function recordStep(
  inputs: StateInputs,
  step: StepKey,
  record: Omit<StepRecord, "updated">,
  context: RecordContext = {},
): Promise<string | undefined> {
  if (inputs.record_state === false) return undefined;

  try {
    const current = readState(inputs.project_root) ?? emptyState();
    const next: InstallationState = {
      ...current,
      ...(context.segmentRef === undefined ? {} : { segment_ref: context.segmentRef }),
      ...(context.installation ?? {}),
      version: STATE_VERSION,
      steps: { ...current.steps, [step]: { ...record, updated: nowUtc() } },
    };

    const path = writeState(next, context.forbidden ?? [], inputs.project_root);
    return (
      `---\n\n*Recorded in \`${path}\`: **${STEP_TITLES[step]}** is \`${record.status}\`. That ` +
      `file is meant to be committed — it is what \`installation_status\` reads, and what lets a ` +
      `later session resume. Pass \`record_state: false\` to generate without writing it.*`
    );
  } catch (error) {
    return (
      `---\n\n*The installation state was **not** written: ` +
      `${error instanceof Error ? error.message : String(error)}. The code above is unaffected; ` +
      `what is lost is the record that this step was generated.*`
    );
  }
}
