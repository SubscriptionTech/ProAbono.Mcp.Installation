/**
 * The release identity, held in three files that cannot disagree.
 *
 * `package.json` is what npm publishes, `server.json` is what the MCP Registry serves, and
 * `SERVER_VERSION` is what the client displays and `get_server_info` reports. A bump that misses
 * one of them ships a server announcing a version nobody can install -- the failure this file
 * exists to catch, before a release rather than after it.
 *
 * The repository URL is checked here for the same reason. Both files carry it, neither is derived
 * from the other, and both are frozen at publication: npm takes it from the tarball and the MCP
 * Registry refuses to change a published version's metadata. A move that updates one and forgets
 * the other is only visible once the version is spent.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { SERVER_NAME, SERVER_VERSION } from "../src/server.js";

const root = new URL("../../", import.meta.url);
const read = (name: string): Record<string, any> =>
  JSON.parse(readFileSync(new URL(name, root), "utf8"));

const pkg = read("package.json");
const registry = read("server.json");

describe("the release identity", () => {
  it("reports the published version in the handshake", () => {
    assert.equal(SERVER_VERSION, pkg.version);
  });

  it("names the npm binary", () => {
    assert.ok(Object.keys(pkg.bin).includes(SERVER_NAME));
  });

  it("registers the npm package the registry entry points at", () => {
    assert.equal(registry.packages.length, 1);
    assert.equal(registry.packages[0].identifier, pkg.name);
    assert.equal(registry.packages[0].registryType, "npm");
    assert.equal(registry.packages[0].transport.type, "stdio");
  });

  it("carries the same registry name on both sides", () => {
    assert.equal(registry.name, pkg.mcpName);
  });

  it("points both sides at the same repository", () => {
    // `package.json` writes `git+https://...git`, `server.json` writes the plain browse URL. The
    // two spellings are the same repository, and that is what must not drift.
    const canonical = (url: string) => url.replace(/^git\+/, "").replace(/\.git$/, "");

    assert.equal(canonical(registry.repository.url), canonical(pkg.repository.url));
    assert.match(canonical(pkg.repository.url), /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/);
    assert.equal(registry.repository.source, "github");
    // The registry stores GitHub's numeric repository id, which survives a rename; a name put here
    // by mistake resolves to a different repository than the URL.
    assert.match(registry.repository.id, /^[0-9]+$/);
  });

  it("versions the registry entry and its package together", () => {
    assert.equal(registry.version, pkg.version);
    assert.equal(registry.packages[0].version, pkg.version);
  });

  it("declares every environment variable the server requires, and no value", () => {
    const declared = registry.packages[0].environmentVariables.map((variable: any) => variable.name);
    assert.deepEqual(declared.slice().sort(), [
      "PROABONO_AGENT_KEY",
      "PROABONO_API_BASE",
      "PROABONO_API_KEY",
      "PROABONO_BUSINESS_ID",
      "PROABONO_PORTAL_SECRET",
      "PROABONO_SEGMENT_REF",
      "PROABONO_WEBHOOK_SECRET",
    ]);
    for (const variable of registry.packages[0].environmentVariables) {
      assert.equal(variable.isRequired, true);
      assert.ok(!("value" in variable) && !("default" in variable));
    }
  });
});
