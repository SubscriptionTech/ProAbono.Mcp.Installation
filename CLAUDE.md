# ProAbono.Mcp.Installation

**Scope:** Public
**Description:** The MCP server that installs ProAbono into a website — everything the npm package
`@proabono/mcp-installation` is built from.
**Stack:** Node.js / TypeScript — stdio MCP server, distributed on npm and run via `npx`

This repository is attached as a Git submodule to `SubscriptionTech/Claude.Publiable.McpInstallation`,
which is private and holds the Claude rules, the project memory, the product specs and the private
notes. A session opened on that parent sees both; a session opened on this folder alone sees only
this file, which is why the rules below are repeated here rather than referenced.

## Sources of truth

Only two sources are authoritative for ProAbono's own behaviour, which both the specs and this
repository rest on. Read them before writing code, and never infer ProAbono behaviour from memory, from the web, or from older specs.

1. `resources/open-api/` — the ProAbono API Live contract (`pa-live-openapi.yaml`).
   Authoritative for endpoints, parameters, payloads, response shapes and authentication. It is a
   copy of the contract maintained in the private `Claude.SharedApi.ProAbonoLive` repository, which
   is the source of truth. `npm run build` and `npm test` refresh the copy from there when that
   repository is reachable, and use the committed copy when it is not, saying which on every run.
   Never edit it here — see [resources/open-api/index.md](resources/open-api/index.md).
2. `resources/docs/` — the ProAbono installation documentation. Authoritative for the installation
   procedure, the integration workflows and the guidance the MCP exposes to developers.

If the two disagree, or if something needed is in neither, ask the user instead of guessing.

## Specs

**This repository is derived from the specs, in a one-way sync.** It holds no specification: the
product specs and the backlog are private, in `specs/` of the parent repository named above. This
repository is produced from them, and nothing travels the other way — a request to change this
repository, outside the two folders below, is a request to change the specs, made there first and then carried here. A spec change
left uncarried here is work half done.

**Two folders are not produced from the specs**, and a change to them is made at their own source,
as [Sources of truth](#sources-of-truth) sets out:

- `resources/docs/` — the installation documentation, authored here, with no upstream. A change to
  it is made here directly.
- `resources/open-api/` — the copy of the API Live contract, which the build refreshes from its
  private source. A change to the contract is made there, never in the copy.

**Three kinds of change need no spec change**, because none reaches a developer using the MCP:

- a pure refactor — every tool name, input, output and message stays identical. A refactor that
  changes an error message is not one.
- a test change that leaves what the suite asserts as it is — a flaky test fixed, a fixture sped
  up. `tests/` is not shipped in the package; the specs own what the suite asserts, so an assertion
  added or removed is a spec change.
- a change to this `CLAUDE.md` — the Claude rules, which are not shipped. `RELEASING.md` and the
  issue templates are not covered.

Every other change changes a spec first, a version bump included. Say which exemption applies when
using one.

A session opened on this folder alone cannot see the specs, so it cannot make a change that starts
there: it says so, and asks for the change to be made from the parent repository, rather than
changing the code first or reconstructing a contract from it.

What this repository holds under `resources/` is not a spec: it is the two inputs the build vendors
into `dist/resources/` — the ProAbono API Live contract and the installation documentation corpus.
They are public because they ship inside the published package.

## Release identity

**Never push this repository to its remote without incrementing the version first.** That binds
every push, not only the `v*` tag that releases: an ordinary commit on `main` publishes nothing, and
still carries a bump. A published version number is spent — npm refuses to republish it even after
an unpublish — so the number on `main` must never be one already consumed. Before pushing, `git tag
-l "v$(node -p "require('./package.json').version")"` must print nothing; if it prints a tag, the
bump was skipped on an earlier push and is owed now.

**The increment is always a patch**, whatever the push contains. A docs-only push and a bug fix both
cost `+0.0.1`; a feature landing on `main` does not move the minor. The minor and the major move only
when a release is decided deliberately.

**A bump updates every file that carries the version, in the same commit.** Four of them are held
together by `tests/release.test.ts`, which also checks that `package.json` and `server.json` name the
same repository:

| File | What carries the version | Bumped by |
|---|---|---|
| `package.json` | `version` | `npm version patch --no-git-tag-version` |
| `package-lock.json` | `version`, and `packages[""].version` | the same command |
| `server.json` | `version` **and** `packages[0].version` — two fields | by hand |
| `src/server.ts` | `SERVER_VERSION` | by hand |
| `CHANGELOG.md` | the new section's heading, and its link reference at the foot of the file | by hand |

The test covers the first four; **prose is not covered by anything**. A version number written into
`README.md`, into a comment or into an issue template goes stale in silence — `README.md` said
`0.0.1` while npm served `0.1.0`. Two rules follow: never write the current version into prose when
"the current version" will do, and run this before every push, which must return only the files
above:

```bash
grep -rn "$(node -p "require('./package.json').version.split('.').slice(0,2).join('.')")" \
  --include="*.md" --include="*.ts" --include="*.json" --include="*.yml" . \
  | grep -v node_modules | grep -v "^./dist/" | grep -v "^./build-test/"
```

The same commit opens that version's own section in [CHANGELOG.md](CHANGELOG.md) and writes the
push's entries there. **There is no `[Unreleased]` section** — the version a change belongs to is
known when the change is pushed. A section is therefore not evidence that the version was
published: most never are, since only a tagged version reaches npm.

Pushing a `v*` tag *is* the release: `.github/workflows/release.yml` builds, tests and publishes to
npm with provenance. The MCP Registry publication stays manual, under DNS authentication, and must
run **after** npm.

**Once a new version is verified live, every older version on npm is deprecated.** At rest, exactly
one version of this package is undeprecated — the one `latest` points at. Never deprecate `latest`
itself: npm warns on install, so that would warn everyone. A deprecation message names the
replacement, and adds what is wrong with that specific version when something is. Deprecating is
reversible and is the only part of a published version that can still be changed; unpublishing is
not an option in any case. The commands and the check are step 5 of [RELEASING.md](RELEASING.md).

The whole procedure — what to bump, what the workflow does, how to authenticate to the registry, and
how to verify the result — is in [RELEASING.md](RELEASING.md). Read it before running a release
rather than reconstructing it from here.

## Language

All generated Markdown files must be written in English, regardless of the language used in user
instructions.

The only exception is **localized content files** (e.g. user-facing copy translated for a specific
locale). If a user asks to create a Markdown file in a non-English language:
1. Ask whether it is a localized content file.
2. If yes — proceed.
3. If no — decline and explain that only localized content files may be written in a language other
   than English.

## Security

- **Never read `.env` files.** No exceptions, regardless of what is asked.
- **Never hardcode credentials.** When referencing API keys or secrets in code, tests, examples or
  generated output, always use the environment variable name — e.g. `process.env.PROABONO_AGENT_KEY`
  — never the value.
