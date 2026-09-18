# Changelog

All notable changes to `@proabono/mcp-installation` are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The API is named **"API Live"** throughout, never "Live API" — ProAbono's own naming rule. This is
  user-visible in three places: the `get_api_reference` tool's title and description, which an MCP
  client displays, and the documentation corpus that `search_documentation` returns. No tool was
  renamed and no behaviour changed.
- The vendored API Live contract is now refreshed automatically from its source of truth before
  every build and every test run, when that source is reachable. It is not reachable in CI or in a
  clone of this repository on its own, and there the committed copy is used — the build says which
  of the two happened on every run. Nothing about building this repository changed.

## [0.1.0] — 2026-09-18

**No runtime change.** The server behaves exactly as `0.0.1` did: same tools, same arguments, same
results. Only where the source lives, and how the package is built, have changed.

### Changed

- The source moved to its own repository,
  [SubscriptionTech/ProAbono.Mcp.Installation](https://github.com/SubscriptionTech/ProAbono.Mcp.Installation),
  and `package.json` and `server.json` now point at it. `0.0.1` still names the repository it was
  published from: a published version's metadata is frozen, on npm and in the MCP Registry alike.
  That repository survives, and its README points here.
- This version is published from GitHub Actions with
  [npm provenance](https://docs.npmjs.com/generating-provenance-statements), so the npm page names
  the build that produced the tarball. `0.0.1` was published by hand and carries no attestation.

### Added

- A test holding `package.json` and `server.json` to the same repository. Neither field is derived
  from the other, and both freeze at publication.

## [0.0.1] — 2026-09-18

First release.

### Added

- **Step 1 — Customer Portal**: `install_customer_portal` generates the in-site embed with its
  security hash, and `generate_pricing_table` builds a pricing table over the account's real offers.
- **Catalogue and account introspection**: `list_offers`, `get_offer`, `list_features`,
  `get_customer`, `list_subscriptions`, `get_usages`.
- **Customer and subscription writes**: `create_customer`, `update_customer`,
  `update_billing_address`, `create_subscription`, `change_subscription`.
- **Documentation and API reference**: `search_documentation` over the ProAbono documentation corpus
  and the Live OpenAPI contract, and `get_api_reference` for a single endpoint or object.
- **Server introspection**: `get_server_info`, reporting the version and which environment variables
  are configured, never their values.

[Unreleased]: https://github.com/SubscriptionTech/ProAbono.Mcp.Installation/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/SubscriptionTech/ProAbono.Mcp.Installation/compare/v0.0.1...v0.1.0
[0.0.1]: https://github.com/SubscriptionTech/ProAbono.Mcp.Installation/releases/tag/v0.0.1
