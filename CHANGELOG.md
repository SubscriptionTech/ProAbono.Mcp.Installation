# Changelog

All notable changes to `@proabono/mcp-installation` are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1]

Corrections to the catalogue of `0.2.0`, which was never published — the two sections are one
release if `0.2.1` is the number that gets tagged.

### Fixed

- **`install_customer_portal` told developers to provision with `create_customer`**, which `0.2.0`
  removed. It names `create_update_customer`. A new assertion fails when any tool description or
  any generated output points at a retired name, which is how this was found and is what stops it
  recurring.
- **`sync_usage_rights` now names the functions it expects the project to supply** — the
  operational alert the rights module raises on a failed read, and the end-customer confirmation
  the gate asks before a billable change. Pasted without them the module raised a `ReferenceError`
  on exactly the path the last-known-good fallback exists to survive.
- **The generated rights module no longer sends `ReferenceSegment` on `/v1/Usages`.** The contract
  declares none on that operation — alone among the collections this server reads — and the server
  itself sends none there. Generated code passing one was extrapolating from the other collections.
- `set_invoice_note` no longer claims an empty string clears the note. The endpoint's behaviour on
  an empty value is not established, and the description now says only what is: the note is changed
  by this call and by no other.

### Added

- **The README's tool list is held by the suite.** It fails when a registered tool is missing from
  the `## Tools` section, and when that section names a tool the server does not register. The
  README is what npm renders and nothing derived it from `createServer`; it had drifted before.
- [RELEASING.md](RELEASING.md) gains a step for a release that removes or renames a tool: the three
  places a consumer reads a break, and which of them the suite already holds.

## [0.2.0]

**BREAKING.** Three tool names of `0.1.0` are removed and replaced by the five tools they were
standing in for. The break rides this release deliberately, while adoption is near zero, rather
than accumulating behind an alias. **No alias is kept**: a call to a removed name fails outright,
with the tool simply absent from the listing, which is what makes the replacement visible instead
of silently deprecated.

| Removed in `0.2.0` | Call instead | Why |
|---|---|---|
| `create_customer` | `create_update_customer` | `POST /v1/Customer` is an upsert on `ReferenceCustomer`. A tool described as "creates" is not reached for to update, and a create/update pair forces a guess about whether the reference already exists. |
| `update_customer` | `create_update_customer` | The same endpoint, and the same reason. |
| `change_subscription` (`action: "start"`) | `start_subscription` | One endpoint per transition, each with its own parameters and its own failure modes. An `action` enum made the model pick the transition out of a description instead of out of a tool name. |
| `change_subscription` (`action: "upgrade"`) | `upgrade_subscription` | As above. |
| `change_subscription` (`action: "suspend"`) | `suspend_subscription` | As above. |
| `change_subscription` (`action: "terminate"`) | `terminate_subscription` | As above. |

The arguments carry over unchanged, except that `subscription_id` is now the only shared one and
each transition takes just the parameters its own endpoint accepts. `upgrade_subscription` requires
`offer_ref` in its schema rather than rejecting the call at run time.

### Added

Twenty-three tools, bringing the catalogue to thirty-six. Every one of them is thin — one Live API
operation, in the developer's vocabulary — except `sync_usage_rights`, which generates code.

- **Rights synchronization (In-Site step 3)**: `sync_usage_rights` generates the Usage read, the
  rights cache and its expiry, the gate at a call site, and the write-back for a Feature the
  application changes — quoted and confirmed with the end customer when it is billable. It reads
  the account's real Features so the generated code names them, and, given a customer reference,
  diagnoses what that customer's Usages actually say. **Its resynchronization wiring is not
  generated**: it needs the notification endpoint, which this version does not scaffold, and the
  tool says so where it generates the cache rather than leaving it to be discovered.
- **Customer**: `get_billing_address`, `get_payment_settings`, `set_next_billing_date`,
  `set_invoice_note`, `set_payment_method`, `anonymize_customer`.
- **Subscription**: `get_subscription`.
- **Offers**: `list_offers_for_customer` — what one customer may take, and the upgrade options of a
  running subscription. `list_offers` no longer takes a customer reference; that question now has
  its own tool, and its own answer.
- **Usage**: `quote_usage_change`, `add_feature_consumption`, `set_feature_current_quantity`,
  `set_feature_enabled`. Each write carries one mode and one only, split by Feature type:
  `Increment` for `Consumption`, `QuantityCurrent` for `Limitation`, `IsEnabled` for `OnOff`. The
  retry-unsafe mode is never offered where a safe one exists.
- **Invoicing and balance**: `get_invoice`, `get_credit_note`, `list_invoices`,
  `create_balance_line`, `bill_customer`. `list_invoices` is one tool and returns both debit
  invoices and credit notes, because `GET /v1/Invoices` does and offers no filter.

`anonymize_customer` is the first and only tool in this server whose effect cannot be undone. It is
in scope because it destroys no billing history: it erases the personal data and keeps the invoices
and the subscription history, which is what a GDPR erasure asks of a billing system. Deleting a
customer, a subscription or an invoice remains out of scope in any account, as do customer
suspension, invalidation and link revocation.

### Changed

- **The vendored API Live contract gains `TypeCredit` and `Reason` on `Invoice`**, which is what
  makes `get_credit_note` possible: the absence of `TypeCredit` is what identifies a debit invoice,
  and there is no separate flag. The fix was made in the contract's source of truth, not in the
  vendored copy.
- `DateStamp` is defaulted to now and normalized to UTC on every Usage write and quote, and a date
  in the future is refused with an explanation rather than passed on for the API to reject.
- The tool modules are now organized by the group they belong to — customers, subscriptions,
  catalogue, usages, invoicing — instead of by read versus write. Nothing a client sees changed.

- The API is named **"API Live"** throughout, never "Live API" — ProAbono's own naming rule. This is
  user-visible in three places: the `get_api_reference` tool's title and description, which an MCP
  client displays, and the documentation corpus that `search_documentation` returns. No tool was
  renamed and no behaviour changed.
- The vendored API Live contract is now refreshed automatically from its source of truth before
  every build and every test run, when that source is reachable. It is not reachable in CI or in a
  clone of this repository on its own, and there the committed copy is used — the build says which
  of the two happened on every run. Nothing about building this repository changed.
- [RELEASING.md](RELEASING.md) and [CLAUDE.md](CLAUDE.md) now state the bump rule as its own step,
  ahead of the release procedure, and list **every** file carrying the version rather than only the
  four the test suite enforces. The rule itself is unchanged; it was stated in passing and was
  missed.
- **Deprecating superseded versions is now part of releasing.** Once a new version is verified live
  on npm, every older version is deprecated, so exactly one version — the one `latest` points at —
  is undeprecated at rest. `latest` itself is never deprecated: npm warns on install, which would
  warn everyone. Written as step 5 of [RELEASING.md](RELEASING.md) and in the *Release identity*
  section of [CLAUDE.md](CLAUDE.md). Applied retroactively to `0.0.1`, whose repository link points
  at a repository that is no longer public.
- The README no longer names a version in its "Early version" heading. It said `0.0.1` while npm
  served `0.1.0`: prose that repeats the version goes stale silently, since no test holds it.

Everything from "The API is named" down to this line was written against a `0.1.1` that was never
pushed and never published. The version a change belongs to is the one it is pushed under, so those
entries live here.

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

[0.2.1]: https://github.com/SubscriptionTech/ProAbono.Mcp.Installation/compare/v0.1.0...HEAD
[0.2.0]: https://github.com/SubscriptionTech/ProAbono.Mcp.Installation/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/SubscriptionTech/ProAbono.Mcp.Installation/compare/v0.0.1...v0.1.0
[0.0.1]: https://github.com/SubscriptionTech/ProAbono.Mcp.Installation/releases/tag/v0.0.1
