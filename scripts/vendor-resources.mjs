/**
 * Vendors the two sources of truth into the build output.
 *
 * The published package ships `dist/` and nothing else (publication plan, Phase A), so the
 * OpenAPI contract and the installation documentation cannot be read from `resources/` at run time.
 * They are copied into `dist/resources/` at build time instead: the YAML contract as JSON, so the
 * runtime needs no YAML parser, and the docs verbatim.
 *
 * Both sources are committed in this repository, so a clone builds anywhere, with no credential.
 *
 * The contract is a copy of the one maintained in `SubscriptionTech/Claude.SharedApi.ProAbonoLive`.
 * `scripts/refresh-contract.mjs` runs before this script and refreshes that copy when the upstream
 * is reachable -- it is attached to the workspace repository as `shared/ProAbonoLive`, one level
 * above this root. When it is not reachable, which is the case in CI and in any standalone clone,
 * the committed copy is used and the refresh says so rather than passing silently. See
 * `resources/open-api/index.md`.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const openApiSource = join(root, "resources/open-api/pa-live-openapi-3.0.3.yaml");
const docsSource = join(root, "resources/docs");
const target = resolve(root, process.argv[2] ?? "dist/resources");

mkdirSync(join(target, "docs"), { recursive: true });

const contract = parse(readFileSync(openApiSource, "utf8"));
writeFileSync(join(target, "openapi.json"), JSON.stringify(contract), "utf8");

const docs = readdirSync(docsSource).filter((name) => name.endsWith(".md"));
for (const name of docs) {
  writeFileSync(join(target, "docs", name), readFileSync(join(docsSource, name), "utf8"), "utf8");
}

process.stderr.write(
  `vendored: openapi.json (${Object.keys(contract.paths).length} paths), ${docs.length} documentation files\n`,
);
