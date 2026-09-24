# Releasing

How `@proabono/mcp-installation` is published, to npm and to the MCP Registry. This is a maintainer
procedure — contributors open pull requests and never push, so they never bump a version, see
[CONTRIBUTING.md](CONTRIBUTING.md). Maintainers bump on **every** push, released or not: that rule
is restated below under [Never push without a patch increment](#never-push-without-a-patch-increment)
and owned by [CLAUDE.md](CLAUDE.md#release-identity).

**A published version number is spent.** npm refuses to republish it, even after an unpublish, and
the MCP Registry refuses to change a published version's metadata. Everything below is written so
that what can fail, fails *before* npm accepts a tarball.

## What you need

- **Write access to this repository**, to push a tag.
- **A trusted publisher configured on npmjs.com**, and it is the one thing to check before tagging.
  Publishing uses **trusted publishing**: the npm CLI authenticates from the OIDC token GitHub
  Actions mints, and npmjs.com must hold a trusted publisher for `@proabono/mcp-installation` naming
  **this** repository (`SubscriptionTech/ProAbono.Mcp.Installation`) and the workflow file
  `release.yml`. There is no npm token to hold, rotate or expire — and nothing to fall back on
  either.

  **It has never successfully published.** `0.1.0`, the last version on npm, was published by the
  earlier token-based workflow; the trusted-publishing change landed *after* that tag. The first run
  under it, `v0.2.5` on 2026-09-24, signed its provenance statement and then failed at the upload:

  ```
  npm error 404 Not Found - PUT https://registry.npmjs.org/@proabono%2fmcp-installation
  npm error 404 The requested resource '@proabono/mcp-installation@0.2.5' could not be found or
  npm error 404 you do not have permission to access it.
  ```

  A `404` on the `PUT` is npm's answer to an unauthenticated or unauthorised publish, not to a
  missing package — the package exists and is public. The OIDC half works (the provenance statement
  reached the transparency log), so what is left is the trusted publisher itself: absent, or naming
  another repository. `0.0.1` was published from the *workspace* repository, which is the obvious
  candidate for a stale entry. Check it under **Settings → Trusted publisher** on the npm package
  page before tagging, and re-run the failed job rather than re-tagging — nothing was uploaded and
  the version is intact.
- **An npm login as a maintainer of `@proabono`**, for step 5 only. Deprecating a superseded version
  is a metadata change on the published package, and it runs from your machine, not from CI:
  `npm whoami` must answer. Nothing else in this procedure needs it.
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

## Never push without a patch increment

This rule comes before the release procedure because it is what makes the procedure possible, and
it binds **every** push to `main`, not only a release. An ordinary commit publishes nothing and
still costs `+0.0.1`.

**A published version number is spent.** If `main` sits on a number already on npm, the next release
has nowhere to go: the tag cannot be pushed, the workflow would be refused, and the commits that
landed on the spent number belong to no version at all. That is not hypothetical — it happened
between `0.1.0` and `0.1.1`, and five pushes had to be re-attributed after the fact.

The check, run before `git push` and not after:

```bash
git tag -l "v$(node -p "require('./package.json').version")"
```

**Empty output is what you want.** A tag means the number is spent and the push is owed a bump.

The bump is one commit, and it touches every file carrying the version — `package.json`,
`package-lock.json`, `server.json` (**two** fields), `SERVER_VERSION` in `src/server.ts`, and a new
`CHANGELOG.md` section with its link reference. `tests/release.test.ts` enforces the first four;
nothing enforces prose, so a version written into `README.md` or a comment is on you. The full list,
the commands and the grep that catches stale prose are in
[CLAUDE.md](CLAUDE.md#release-identity) — that section is the rule, this one is the reminder at the
point of use.

```bash
npm version patch --no-git-tag-version   # package.json + package-lock.json
# then, by hand, in the same commit: server.json ×2, src/server.ts, CHANGELOG.md
npm test                                 # release.test.ts fails on any disagreement
```

## 1. Check the version to release

**A release does not bump anything.** The version on `main` is already ahead, because of the rule
above: every push carries a patch increment and opens its own `CHANGELOG.md` section. A release tags
the number `main` has reached. It follows that most patch numbers are never released, and that is
expected.

Confirm the four places still agree and the suite is green:

```bash
npm ci && npm run typecheck && npm run build && npm test
```

Then run the spent-number check above one more time. If it prints a tag, stop: `main` was pushed
without its increment. Bump a patch, open its CHANGELOG section, push that commit, and start this
step again.

The CHANGELOG section for the version being released already exists, written by the push that
created the number. Check its link reference at the bottom of the file resolves, and give the
section the release date if it does not carry one.

Let CI go green on Node 20.x, 22.x and 24.x on the commit you are about to tag. A tag on a commit CI
has not seen is the one avoidable way to discover a problem during a release.

### When the release removes or renames a tool

A break has to reach the three places a consumer actually reads, and only one of them is in the
tarball:

1. **The `CHANGELOG.md` section** names every removed tool and what to call instead. Written by the
   push that made the change, not invented here.
2. **The README's `## Tools` list** carries the new names and none of the retired ones. The suite
   holds this — it fails when the list and `createServer` disagree either way — so it needs no
   manual check, only a green run.
3. **The MCP Registry entry** (`server.json`) carries a `description` that is still true of the
   surface being published. Nothing enforces that one: read it.

A removed name is removed, not aliased. If an alias is ever kept, it is a deliberate decision
recorded in the CHANGELOG, and the retired-name assertion in `tests/tools.test.ts` is what has to be
changed to allow it — that assertion exists so a rename cannot be undone by a merge.

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

## 5. Deprecate every version the new one supersedes

**Once the new version is verified live — step 4, not before — every older version on npm is
deprecated.** At rest, exactly one version of this package is undeprecated: the one `latest` points
at. That is the invariant this step maintains, and it is what tells a developer who pinned an old
number that they are not on the supported version.

Never deprecate the version holding `latest`. npm prints a deprecation warning on install, so
deprecating `latest` warns *everyone*, which is the opposite of the intent.

```bash
npm deprecate @proabono/mcp-installation@"<old x.y.z>" \
  "Superseded: install @proabono/mcp-installation@latest instead."
```

Repeat per superseded version, or pass a semver range covering them all. Add a sentence to the
message when a version has a defect worth naming — a dead repository link, a missing attestation,
a bug — since the message is what a consumer sees at install time and it is the only channel to them.

Run it **by hand**. The release workflow is deliberately not given this job: it changes the metadata
of versions that are already public, and it belongs after a human has seen the new version actually
working, not inside the run that uploaded it.

Then confirm the invariant holds — every version but `latest` deprecated, `latest` clean:

```bash
curl -s "https://registry.npmjs.org/@proabono%2Fmcp-installation" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d),l=j["dist-tags"].latest;for(const [v,m] of Object.entries(j.versions))console.log(v===l?"latest ":"       ",v,"->",m.deprecated===undefined?"NOT deprecated":"deprecated");})'
```

npm's read side lags its write side by minutes, here as at step 3: `npm view … deprecated` can come
back empty right after the change. The `curl` above reads the registry document directly and is what
to trust.

A deprecation is reversible — `npm deprecate <pkg>@<version> ""` clears it. It is the only part of a
published version that can still be changed.

**The MCP Registry has no equivalent.** A published entry's metadata is frozen and older versions
simply stop being `isLatest`. Nothing to do there.

## 6. Afterwards

Bump the submodule pointer in the parent repository,
`SubscriptionTech/Claude.Publiable.McpInstallation`, and commit it — the parent tracks `main` of this
repository and does not follow it on its own.

## Where the secrets live

Nothing in this repository records a key, a token or a path to one, and npm publishing now needs no
secret at all. What remains is the Ed25519 key for the MCP Registry: its location, and any passphrase
it carries, belong in the maintainer's password manager, not in a public repository.
