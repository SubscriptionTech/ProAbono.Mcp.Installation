/**
 * Refreshes the vendored API Live contract from its source of truth, when that source is reachable.
 *
 * `resources/open-api/pa-live-openapi.yaml` is a copy, renamed on the way in: upstream the file
 * carries the OpenAPI version it is written against, `pa-live-openapi-3.0.3.yaml`, and here it does
 * not, so a version bump upstream never renames a path this repository refers to. It is authored in
 * `SubscriptionTech/Claude.SharedApi.ProAbonoLive`, which is attached to the *workspace* repository
 * as `shared/ProAbonoLive` -- one level above this repository's root. It is not attached here, and
 * it is private, so most of the places this build runs cannot see it:
 *
 *   - CI checks out with `submodules: false`;
 *   - an outside contributor has no access to a private repository;
 *   - anyone who cloned this repository on its own has no workspace around it.
 *
 * In all of those the copy under `resources/` is the only contract there is, and it is committed
 * precisely so the build works with no credential. So a missing source is **not** an error here.
 *
 * It is, however, never silent. A skip says so on stderr, naming the path it looked for, because
 * the failure this script must not have is refreshing nothing while the person running it believes
 * it refreshed. Set PROABONO_LIVE_DIR to point at a checkout held somewhere else.
 *
 * Line endings do not matter: `.gitattributes` normalises this file to LF, so copying a CRLF
 * working copy over it changes `git status` but produces no content diff.
 */
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The upstream file is named after the OpenAPI version it is written against; the copy is not.
const SOURCE_CONTRACT = "pa-live-openapi-3.0.3.yaml";
const CONTRACT = "pa-live-openapi.yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "resources/open-api", CONTRACT);

const upstreamDir = process.env.PROABONO_LIVE_DIR
  ? resolve(process.env.PROABONO_LIVE_DIR)
  : resolve(root, "../shared/ProAbonoLive");
const source = join(upstreamDir, "open-api", SOURCE_CONTRACT);

const say = (message) => process.stderr.write(`contract: ${message}\n`);

if (!existsSync(source)) {
  say(`not refreshed -- no source of truth at ${source}`);
  say(`using the committed copy at resources/open-api/${CONTRACT}`);
  say(`set PROABONO_LIVE_DIR if your checkout of Claude.SharedApi.ProAbonoLive is elsewhere`);
  process.exit(0);
}

// Compared with line endings normalised, so a CRLF working copy upstream never reads as a change.
const normalise = (path) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

if (normalise(source) === normalise(target)) {
  say(`already in sync with ${source}`);
  process.exit(0);
}

copyFileSync(source, target);
say(`refreshed from ${source}, copied to resources/open-api/${CONTRACT}`);
say(`commit resources/open-api/${CONTRACT} on its own, naming the upstream commit it came from`);
