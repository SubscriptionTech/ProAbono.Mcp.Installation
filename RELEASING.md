# Releasing

How `@proabono/mcp-installation` is published, to npm and to the MCP Registry. This is a maintainer
procedure — contributors never bump a version, see [CONTRIBUTING.md](CONTRIBUTING.md).

**A published version number is spent.** npm refuses to republish it, even after an unpublish, and
the MCP Registry refuses to change a published version's metadata. Everything below is written so
that what can fail, fails *before* npm accepts a tarball.

## What you need

- **Write access to this repository**, to push a tag.
- **The `NPM_TOKEN` secret**, already set on the repository: a granular npm token scoped to
  `@proabono/mcp-installation` with read and write permission. It has an expiry date — when it lapses
  the release fails at the publish step, before any upload. The package's npm publishing setting must
  allow automation tokens; the setting that requires two-factor authentication on *every* publish
  refuses a token-driven CI publish outright.
- **`mcp-publisher`** on your machine, and the Ed25519 signing key for the `com.proabono` namespace.
  The key never goes into a repository secret — the registry publish is deliberately manual and
  local.

Provenance does **not** come from the npm token. It comes from the `id-token: write` permission in
`.github/workflows/release.yml`. Removing that permission silently costs the attestation while the
publish still succeeds.

## 1. Bump the version

Four places must agree, and `tests/release.test.ts` fails if they do not: `package.json` `version`,
`server.json` `version` **and** `packages[0].version`, and `SERVER_VERSION` in `src/server.ts`.

```bash
npm version <x.y.z> --no-git-tag-version   # package.json + package-lock.json
```

Then edit `server.json` (both occurrences) and `src/server.ts` by hand, and add the entry to
[CHANGELOG.md](CHANGELOG.md) with its link references at the bottom of the file.

`--no-git-tag-version` matters: the tag is pushed deliberately in step 2, not created as a side
effect of the bump.

Verify and commit:

```bash
npm ci && npm run typecheck && npm run build && npm test
```

Push the commit to `main` and let CI go green on Node 20.x, 22.x and 24.x before tagging. A tag on a
commit CI has not seen is the one avoidable way to discover a problem during a release.

## 2. Push the tag

The tag **is** the release trigger. Nothing else starts one.

```bash
git tag v<x.y.z> && git push origin v<x.y.z>
```

`.github/workflows/release.yml` then, in order: compares the tag to `package.json` and aborts on a
mismatch → `npm ci` → `npm run typecheck` → `npm run build` → `npm test` →
`npm publish --provenance --access public` → `gh release create`.

Watch it:

```bash
gh run watch "$(gh run list --workflow Release --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
```

**If it fails before the publish step** — a bad token, a wrong scope, a blocked publishing setting —
nothing was uploaded and the version is intact. Fix the cause and use **Re-run failed jobs** on the
same run. Never re-tag: a second tag for the same version cannot help, and if npm *did* accept the
tarball the number is already gone.

**If `gh release create` fails after a successful publish**, npm is published and only the GitHub
release object is missing. Create it by hand; that is not worth a new version.

## 3. Publish to the MCP Registry

**After npm, never before.** The registry verifies that the published npm package carries an
`mcpName` matching the server name, so it must be able to see the new version. npm's read side lags
its write side by minutes — its own publish log says so. If the registry reports the package as
missing, wait and retry.

```bash
curl -s "https://registry.npmjs.org/@proabono%2Fmcp-installation" | grep -q '"<x.y.z>"' && echo visible
```

`mcp-publisher` reads `server.json` from the current directory, so run it from the repository root.

### The key is a PEM; `--private-key` wants hex

This is the one step that reliably wastes an hour. `mcp-publisher login dns --help` says
`Private key (hex)`, but the documented example line reads `--private-key <key>` and says nothing
about encoding. The signing key is stored as a **PKCS8 PEM** on the publishing machine. Handing the
base64 form to the flag fails with:

```
Error: invalid hex private key format: encoding/hex: invalid byte: U+004D 'M'
```

`M` is simply not a hex digit — hex has no letters past `F`. The message names the encoding, not the
fix.

This converts the PEM and logs in in one step, without the key ever reaching the terminal or the
shell history:

```bash
mcp-publisher login dns --domain proabono.com --private-key "$(node -e 'const c=require("crypto"),fs=require("fs");process.stdout.write(c.createPrivateKey(fs.readFileSync(process.argv[1])).export({format:"der",type:"pkcs8"}).subarray(-32).toString("hex"))' /path/to/your/key.pem)"

mcp-publisher publish
```

The last 32 bytes of the PKCS8 DER are the Ed25519 seed, which is what the flag expects.

To check a key before using it, derive its public half and compare with what DNS publishes — the
public key is not a secret, so this is safe to print:

```bash
node -e 'const c=require("crypto"),fs=require("fs");const k=c.createPrivateKey(fs.readFileSync(process.argv[1]));console.log(c.createPublicKey(k).export({format:"der",type:"spki"}).subarray(-32).toString("base64"))' /path/to/your/key.pem
dig +short TXT proabono.com | grep MCPv1
```

The derived value must equal the `p=` field of the `v=MCPv1; k=ed25519; p=…` record. Two things about
that record: it must sit on the **apex** `proabono.com`, not under a selector, and any stale record
left from a key rotation must be removed — a leftover is tried first and fails with a generic
signature error that does not say which record it used.

## 4. Verify

All three surfaces, after both publications:

```bash
curl -s "https://registry.npmjs.org/@proabono%2Fmcp-installation"
curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=com.proabono"
```

- **npm** — `dist-tags.latest` is the new version; its `repository.url` names this repository, and its
  `mcpName` is `com.proabono/mcp-installation`.
- **Provenance** — the version carries `dist.attestations` with predicate
  `https://slsa.dev/provenance/v1`. That is what the Provenance panel on npmjs.com renders. If it is
  absent, the publish succeeded without an attestation — a defect to fix before the *next* release,
  not something the published version can be repaired for.
- **MCP Registry** — the new version, with this repository's URL and its GitHub numeric id, and
  `isLatest: true`. Earlier versions keep whatever metadata they were published with, permanently.

## 5. Afterwards

Bump the submodule pointer in the parent repository,
`SubscriptionTech/Claude.Publiable.McpInstallation`, and commit it — the parent tracks `main` of this
repository and does not follow it on its own.

## Where the secrets live

Nothing in this repository records a key, a token or a path to one. The npm token, its expiry date
and the location of the registry signing key belong in the maintainer's password manager, not in a
public repository.
