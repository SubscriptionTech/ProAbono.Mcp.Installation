# API Live contract

`pa-live-openapi-3.0.3.yaml` — the ProAbono **API Live** contract. Authoritative for endpoints,
parameters, payloads, response shapes and authentication. Nothing in this project may infer API
behaviour from memory, from the web, or from an older spec when this file can answer.

## Where it comes from

It is a **copy**. The contract is authored and maintained in
[SubscriptionTech/Claude.SharedApi.ProAbonoLive](https://github.com/SubscriptionTech/Claude.SharedApi.ProAbonoLive),
alongside the resource documentation it is kept in sync with. That repository is the source of
truth; this file is what the build reads.

That repository is private, and **this one does not depend on it**: the copy is committed here and
the build vendors it into `dist/resources/openapi.json`, so a clone builds with no credential and CI
needs no cross-repository token.

Never edit this file to change the API. An edit here is overwritten by the next refresh, and it makes
the generated code disagree with the API the customer actually calls. Fix the contract upstream, then
refresh.

## Refreshing it

`npm run build` and `npm test` both run `scripts/refresh-contract.mjs` first, which copies the
contract over from the source of truth when it can reach it. There is nothing to do by hand.

It can reach it when this repository sits inside its workspace, which attaches
`Claude.SharedApi.ProAbonoLive` as `shared/ProAbonoLive` one level above this root. Set
`PROABONO_LIVE_DIR` to point somewhere else instead.

Everywhere else — CI, which checks out with `submodules: false`, an outside contributor, or anyone
who cloned this repository on its own — there is no source of truth to read and **the committed copy
is used as is**. That is not a failure: it is why the copy is committed. The script says which of the
two happened on every run, so a build never refreshes nothing while appearing to refresh:

```
contract: already in sync with <path>
contract: refreshed from <path>
contract: not refreshed -- no source of truth at <path>
```

The test suite reads the vendored result, so a contract that no longer parses, or that drops an
endpoint the tools rely on, fails there rather than in a customer's IDE. When a refresh does change
this file, commit it on its own, with the upstream commit it was taken from in the message.

Line endings are handled: `.gitattributes` normalises this file to LF, so copying a CRLF working copy
over it marks the file modified in `git status` and produces no content diff.

## What it does not carry

The upstream repository also holds the resource documentation, the enum reference and the
conventions that explain the contract — its `specs/convention.md`, its `specs/resources-index.md` and its
`resources/` folder. They are not copied here. When a question needs them rather than the schema,
read them upstream; do not guess from the YAML alone.
