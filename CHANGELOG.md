# Changelog

All notable changes to `@proabono/mcp-installation` are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/SubscriptionTech/ProAbono.Mcp.Installation/compare/v0.0.1...HEAD
[0.0.1]: https://github.com/SubscriptionTech/ProAbono.Mcp.Installation/releases/tag/v0.0.1
