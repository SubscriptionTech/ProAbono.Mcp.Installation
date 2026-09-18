# Contributing

Thank you for looking at this server. It is small on purpose: a stdio MCP server, published to npm
as [`@proabono/mcp-installation`](https://www.npmjs.com/package/@proabono/mcp-installation) and to
the MCP Registry as `com.proabono/mcp-installation`.

## Build and test

Node.js 20 or later. The three versions CI runs are 20.x, 22.x and 24.x — the ones `engines` claims.

```bash
npm ci            # install exactly what package-lock.json pins
npm run typecheck # tsc --noEmit, no output written
npm run build     # compile to dist/, then vendor resources/ into dist/resources/
npm test          # compile the suite to build-test/, vendor into it, then run it
```

`npm test` runs the full suite through `scripts/run-tests.mjs`. The lane that talks to the live
ProAbono API is skipped unless the fixture account's credentials are present in the environment, so
a fork's pull request runs green with no credential of ours.

Nothing is fetched at run time: the build copies the documentation corpus and the API contract into
`dist/resources/`, and the published tarball carries them.

## Where the behaviour comes from

Two inputs are authoritative. Read them before changing what a tool does or what it returns, and
never infer ProAbono behaviour from memory or from the web.

1. `resources/open-api/` — the ProAbono **API Live** contract. Authoritative for endpoints,
   parameters, payloads, response shapes and authentication.
2. `resources/docs/` — the ProAbono **installation documentation**. Authoritative for the
   installation procedure, the integration workflows and the guidance the server hands a developer.

If the two disagree, or if what you need is in neither, open an issue rather than guessing.

## Refreshing the API contract

`resources/open-api/pa-live-openapi-3.0.3.yaml` is a **copy**. It is authored in the private
`SubscriptionTech/Claude.SharedApi.ProAbonoLive` repository, which is the source of truth — an edit
made directly here is overwritten by the next refresh.

`npm run build` and `npm test` refresh the copy automatically when that upstream is reachable. It
will not be reachable for you: it is private, and reaching it needs the maintainer's workspace. The
script says so and the committed copy is used instead, which is why it is committed — you need no
credential to build. The details, and what the copy deliberately leaves behind, are in
[resources/open-api/index.md](resources/open-api/index.md).

## The specifications are private

What each tool must do, what it is named and what it returns are specified in
`SubscriptionTech/Claude.Internal.McpInstallation`, which is private. This repository is the
implementation of that specification, not the specification itself. A change to a tool's contract
starts there; if you cannot see it, open an issue describing the behaviour you expect and we will
reconcile the two.

## Pull requests

- One concern per pull request, with the reasoning in the message rather than in the diff.
- `npm run typecheck && npm run build && npm test` green locally before you push. CI runs the same
  three commands on the three Node versions.
- Do not bump the version. The release identity lives in four places that `tests/release.test.ts`
  forces to agree — `package.json`, `server.json` twice and `SERVER_VERSION` in `src/server.ts` —
  and it is bumped as part of a release, not as part of a change. Releasing is a maintainer
  procedure, described in [RELEASING.md](RELEASING.md).
- No credential, no account identifier and no key ever appears in a source file, a test fixture or
  an example. Reference the environment variable by name.

## Reporting a vulnerability

Not through an issue — see [SECURITY.md](SECURITY.md).
