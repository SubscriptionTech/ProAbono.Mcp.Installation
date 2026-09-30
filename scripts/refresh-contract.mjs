/**
 * Refreshes the vendored API Live contract from its source of truth, when that source is reachable.
 *
 * `resources/open-api/pa-live-openapi.yaml` is a copy, renamed on the way in. Upstream, each version of
 * the contract is a file of its own, named after that version (`info.version`), and the older ones
 * stay next to it; the refresh copies the highest version here under a name that never changes, so a
 * new version upstream never renames a path this repository refers to. The upstream file is found by
 * the shape of its name, never by a fixed name, so a new version needs no change here. It is authored in
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
import { copyFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Upstream, each version is a file named after it; the copy is not.
const SOURCE_PATTERN = /^pa-live-openapi-(\d+)\.(\d+)\.(\d+)\.yaml$/;
const CONTRACT = "pa-live-openapi.yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "resources/open-api", CONTRACT);

const upstreamDir = process.env.PROABONO_LIVE_DIR
  ? resolve(process.env.PROABONO_LIVE_DIR)
  : resolve(root, "../shared/ProAbonoLive");
const sourceDir = join(upstreamDir, "open-api");

// The highest version wins, compared number by number: 0.10.0 is above 0.9.0.
const byVersionDescending = (a, b) =>
  b.version[0] - a.version[0] || b.version[1] - a.version[1] || b.version[2] - a.version[2];
const [latest] = existsSync(sourceDir)
  ? readdirSync(sourceDir)
      .map((name) => ({ name, match: SOURCE_PATTERN.exec(name) }))
      .filter(({ match }) => match)
      .map(({ name, match }) => ({ name, version: match.slice(1, 4).map(Number) }))
      .sort(byVersionDescending)
  : [];
const source = latest ? join(sourceDir, latest.name) : null;

const say = (message) => process.stderr.write(`contract: ${message}\n`);

if (!source) {
  say(`not refreshed -- no source of truth at ${join(sourceDir, "pa-live-openapi-<x.y.z>.yaml")}`);
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
