/**
 * Access to the two sources of truth, as vendored into `dist/resources` by the build.
 *
 * Nothing else in the server may read `resources/` directly: that folder does not
 * exist in the published package.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface OpenApiOperation {
  readonly summary?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly parameters?: readonly unknown[];
  readonly requestBody?: unknown;
  readonly responses?: Record<string, unknown>;
}

export interface OpenApiDocument {
  readonly info: { readonly title: string; readonly version: string; readonly description?: string };
  readonly paths: Record<string, Record<string, OpenApiOperation>>;
  readonly components?: {
    readonly parameters?: Record<string, { readonly name?: string; readonly in?: string }>;
    readonly schemas?: Record<string, unknown>;
  };
}

export interface DocumentationFile {
  /** File name as it appears in the documentation corpus, e.g. `in-site-installation.md`. */
  readonly name: string;
  readonly content: string;
}

const resourcesDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "resources");

let contract: OpenApiDocument | undefined;
let documentation: readonly DocumentationFile[] | undefined;

/** The ProAbono API Live contract. Authoritative for endpoints, parameters and payloads. */
export function loadContract(): OpenApiDocument {
  if (contract === undefined) {
    contract = JSON.parse(readFileSync(join(resourcesDirectory, "openapi.json"), "utf8")) as OpenApiDocument;
  }
  return contract;
}

/** The installation documentation. Authoritative for the procedure and the hosted pages. */
export function loadDocumentation(): readonly DocumentationFile[] {
  if (documentation === undefined) {
    const directory = join(resourcesDirectory, "docs");
    documentation = readdirSync(directory)
      .filter((name) => name.endsWith(".md"))
      .sort()
      .map((name) => ({ name, content: readFileSync(join(directory, name), "utf8") }));
  }
  return documentation;
}
