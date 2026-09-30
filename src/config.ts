/**
 * The server's configuration, read from the environment and from nothing else.
 *
 * The seven variables are the vocabulary the ProAbono documentation already uses, so the
 * documentation, this server and the code it generates all name the same things (product spec §7).
 *
 * No value read here is ever logged, returned by a tool, put in an error message, or inlined
 * in generated code (product spec §8). Only the *names* leave this module.
 */

export type ConfigurationVariableName =
  | "PROABONO_API_BASE"
  | "PROABONO_BUSINESS_ID"
  | "PROABONO_SEGMENT_REF"
  | "PROABONO_AGENT_KEY"
  | "PROABONO_API_KEY"
  | "PROABONO_PORTAL_SECRET"
  | "PROABONO_WEBHOOK_SECRET";

interface ConfigurationVariable {
  readonly name: ConfigurationVariableName;
  /** What the variable holds, in the words of product spec §7. Safe to show: it describes, never reveals. */
  readonly holds: string;
}

export const CONFIGURATION_VARIABLES: readonly ConfigurationVariable[] = [
  { name: "PROABONO_API_BASE", holds: "The API endpoint, https://api-{business_id}.proabono.com" },
  { name: "PROABONO_BUSINESS_ID", holds: "The numeric business identifier, needed by every hosted-page open" },
  { name: "PROABONO_SEGMENT_REF", holds: "The Segment the customers and offers belong to" },
  { name: "PROABONO_AGENT_KEY", holds: "Basic auth username" },
  { name: "PROABONO_API_KEY", holds: "Basic auth password" },
  { name: "PROABONO_PORTAL_SECRET", holds: "HMAC key for the portal security hash" },
  { name: "PROABONO_WEBHOOK_SECRET", holds: "Secret for the notification signature" },
];

export interface ProAbonoConfiguration {
  readonly apiBase: string;
  readonly businessId: string;
  readonly segmentRef: string;
  readonly agentKey: string;
  readonly apiKey: string;
  readonly portalSecret: string;
  readonly webhookSecret: string;
}

/** A configuration that cannot be used. Its message names variables, never values. */
export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

function read(env: NodeJS.ProcessEnv, name: ConfigurationVariableName): string | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Reads the seven variables, or throws naming every one that is missing.
 *
 * It validates shape only. It never infers, checks or announces which ProAbono account —
 * or which environment — the credentials open: the credentials are the only boundary
 * (product spec §7, invariant 1).
 */
export function loadConfiguration(env: NodeJS.ProcessEnv = process.env): ProAbonoConfiguration {
  const missing = CONFIGURATION_VARIABLES.filter(({ name }) => read(env, name) === undefined);

  if (missing.length > 0) {
    const detail = missing.map(({ name, holds }) => `  ${name} — ${holds}`).join("\n");
    throw new ConfigurationError(
      `ProAbono MCP Installation cannot start: ${missing.length} configuration variable(s) missing.\n` +
        `${detail}\n` +
        `Set them in the environment of the MCP client that launches this server. ` +
        `Never commit them, and never pass them as command-line arguments.`,
    );
  }

  const value = (name: ConfigurationVariableName): string => read(env, name) as string;

  const businessId = value("PROABONO_BUSINESS_ID");
  if (!/^\d+$/.test(businessId)) {
    throw new ConfigurationError(
      "ProAbono MCP Installation cannot start: PROABONO_BUSINESS_ID must be the numeric business identifier.",
    );
  }

  const apiBase = value("PROABONO_API_BASE");
  if (!apiBase.startsWith("https://")) {
    throw new ConfigurationError(
      "ProAbono MCP Installation cannot start: PROABONO_API_BASE must be an https:// endpoint.",
    );
  }

  return {
    apiBase: apiBase.replace(/\/+$/, ""),
    businessId,
    segmentRef: value("PROABONO_SEGMENT_REF"),
    agentKey: value("PROABONO_AGENT_KEY"),
    apiKey: value("PROABONO_API_KEY"),
    portalSecret: value("PROABONO_PORTAL_SECRET"),
    webhookSecret: value("PROABONO_WEBHOOK_SECRET"),
  };
}
