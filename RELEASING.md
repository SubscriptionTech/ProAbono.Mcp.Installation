# Releasing

How `@proabono/mcp-installation` is published, to npm and to the MCP Registry. This is a maintainer
procedure — contributors open pull requests and never push, so they never bump a version, see
[CONTRIBUTING.md](CONTRIBUTING.md). Maintainers bump on every push, which is a separate rule from
this one: see [CLAUDE.md](CLAUDE.md#release-identity).

**A published version number is spent.** npm refuses to republish it, even after an unpublish, and
the MCP Registry refuses to change a published version's metadata. Everything below is written so
that what can fail, fails *before* npm accepts a tarball.

## What you need

- **Write access to this repository**, to push a tag.
- **Nothing else for npm.** Publishing uses **trusted publishing**: npmjs.com holds a trusted
  publisher for `@proabono/mcp-installation` naming this repository and the workflow file
  `release.yml`, and the npm CLI authenticates from the OIDC token that GitHub Actions mints. There
  is no npm token to hold, rotate or expire.
- **`mcp-publisher`** on your machine, and the Ed25519 signing key for the `com.proabono` namespace.
  The key never goes into a repository secret — the registry publish is deliberately manual and
  local.

Both the publish credential **and** the provenance attestation come from the `id-token: write`
permission in `.github/workflows/release.yml`. Remove it and the release has no credential at all.

Two things break trusted publishing silently, so check them before blaming anything else:

- **Renaming the workflow file.** The trusted publisher on npmjs.com names `release.yml` explicitly.
  Rename it here without renaming it there and the publish is rejected as an untrusted caller.
- **Lowering `node-version`.** Trusted publishing requires npm 11.5.1 or later and Node 22.14.0 or
  later. `release.yml` pins `24.x`. The `release path` job in `ci.yml` asserts the npm floor on every
  push, so this one is caught before a release rather than during it.

## 1. Check the version to release

**A release does not bump anything.** The version on `main` is already ahead: every push to this
repository carries a patch increment and opens its own `CHANGELOG.md` section, which is the rule in
[CLAUDE.md](CLAUDE.md#release-identity). A release tags the number `main` has reached. It follows
that most patch numbers are never released, and that is expected.

Four places must agree, and `tests/release.test.ts` fails if they do not: `package.json` `version`,
`server.json` `version` **and** `packages[0].version`, and `SERVER_VERSION` in `src/server.ts`. The
test suite is what confirms it:

```bash
npm ci && npm run typecheck && npm run build && npm test
```

Then confirm the number is still free — a tag for it means it is already released and spent:

```bash
git tag -l "v$(node -p "require('./package.json').version")"
```

Empty output is what you want. If it prints a tag, `main` was pushed without its increment: bump a
patch, open its CHANGELOG section, push that commit, and start this step again.

The CHANGELOG section for the version being released already exists, written by the push that
created the number. Check its link reference at the bottom of the file resolves, and give the
section the release date if it does not carry one.

Let CI go green on Node 20.x, 22.x and 24.x on the commit you are about to tag. A tag on a commit CI
has not seen is the one avoidable way to discover a problem during a release.

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

**If it fails at or before the publish step** — a trusted publisher naming a different workflow file,
a missing `id-token: write`, a failing test — nothing was uploaded and the version is intact. Fix the
cause and use **Re-run failed jobs** on the same run. Never re-tag: a second tag for the same version
cannot help, and if npm *did* accept the tarball the number is already gone.

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

Nothing in this repository records a key, a token or a path to one, and npm publishing now needs no
secret at all. What remains is the Ed25519 key for the MCP Registry: its location, and any passphrase
it carries, belong in the maintainer's password manager, not in a public repository.
