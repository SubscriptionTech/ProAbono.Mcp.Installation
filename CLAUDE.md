# ProAbono.Mcp.Installation

**Scope:** Public
**Description:** The MCP server that installs ProAbono into a website — everything the npm package
`@proabono/mcp-installation` is built from.
**Stack:** Node.js / TypeScript — stdio MCP server, distributed on npm and run via `npx`

This repository is attached as a Git submodule to `SubscriptionTech/Claude.Publiable.McpInstallation`,
which holds the Claude rules, the project memory and the private notes. A session opened on that
parent sees both; a session opened on this folder alone sees only this file, which is why the rules
below are repeated here rather than referenced.

## Sources of truth

Only two sources are authoritative when building or changing the MCP server. Read them before
writing code, and never infer ProAbono behaviour from memory, from the web, or from older specs.

1. `resources/open-api/` — the ProAbono API Live contract (`pa-live-openapi-3.0.3.yaml`).
   Authoritative for endpoints, parameters, payloads, response shapes and authentication. It is a
   copy of the contract maintained in the private `Claude.SharedApi.ProAbonoLive` repository, which
   is the source of truth. `npm run build` and `npm test` refresh the copy from there when that
   repository is reachable, and use the committed copy when it is not, saying which on every run.
   Never edit it here — see [resources/open-api/index.md](resources/open-api/index.md).
2. `resources/docs/` — the ProAbono installation documentation. Authoritative for the installation
   procedure, the integration workflows and the guidance the MCP exposes to developers.

If the two disagree, or if something needed is in neither, ask the user instead of guessing.

## Specs

**This repository holds no specification.** The product specs, the build plans and the backlog are
private, in [Claude.Internal.McpInstallation](https://github.com/SubscriptionTech/Claude.Internal.McpInstallation).
Read them there before changing what a tool does, what it is named, or what it returns — the spec is
the source of truth about the product, and this repository is its implementation.

What this repository holds under `resources/` is not a spec: it is the two inputs the build vendors
into `dist/resources/` — the ProAbono API Live contract and the installation documentation corpus.
They are public because they ship inside the published package.

## Release identity

The version lives in four places that `tests/release.test.ts` forces to agree: `package.json`
`version`, `server.json` `version` and `packages[0].version`, and `SERVER_VERSION` in
`src/server.ts`. The same test checks that `package.json` and `server.json` name the same
repository. Never bump one of them alone, and never bump as part of a feature change — a version is
bumped as part of a release.

Pushing a `v*` tag *is* the release: `.github/workflows/release.yml` builds, tests and publishes to
npm with provenance. A published version number is spent and cannot be reused. The MCP Registry
publication stays manual, under DNS authentication, and must run **after** npm.

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
