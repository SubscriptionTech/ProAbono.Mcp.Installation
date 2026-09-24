# ProAbono MCP Installation

A local [MCP](https://modelcontextprotocol.io) server that installs ProAbono into your site, from your IDE.

It gives your coding assistant the ProAbono documentation, the API Live and *your own* ProAbono configuration, so it can answer API questions, generate integration code already filled in with your real business identifier and segment, read your account back to check the result, and create test data.

It runs locally, over stdio, against whatever account your key opens. It has no environment concept of its own: your credentials are the only boundary.

## What it covers today

The version you installed is in [CHANGELOG.md](CHANGELOG.md), and `get_server_info` reports it:

- **The three In-Site steps**, end to end: the Customer Portal embed with its security hash, the Subscription Workflow round trip, and the rights synchronization with its cache, its gate and its resynchronization.
- **The notification endpoint**, with signature verification, deduplication and the BackOffice procedure that activates it.
- **Verification**: steps 2 and 3 exercised against your account, the go-live rules checked against your own files, and the twelve-item checklist.
- **Catalogue and account introspection**: offers, features, customers, subscriptions, usage, invoices.
- **Writes across the lifecycle**: customers and their settings, billing addresses, subscriptions and each of their four transitions, Usage writes for all three Feature types, balance lines and billing.
- **Documentation and API reference**: natural-language search over the ProAbono corpus and the Live OpenAPI contract.

Widget and plug-in installations (WordPress and similar) are out of scope by design: this server installs ProAbono **in-site, by code**.

## Install

### Claude Code

```bash
claude mcp add --transport stdio proabono --scope user -- npx -y @proabono/mcp-installation
```

### VS Code

In `.vscode/mcp.json`:

```json
{
  "servers": {
    "proabono": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@proabono/mcp-installation"]
    }
  }
}
```

### Cursor

In `.cursor/mcp.json` (or `~/.cursor/mcp.json` for every project):

```json
{
  "mcpServers": {
    "proabono": {
      "command": "npx",
      "args": ["-y", "@proabono/mcp-installation"]
    }
  }
}
```

Requires Node.js 20 or later.

## Configuration

The server reads seven environment variables and nothing else. It refuses to start if any is missing, naming the ones it needs.

| Variable | Holds |
|---|---|
| `PROABONO_API_BASE` | The API endpoint, `https://api-{business_id}.proabono.com` |
| `PROABONO_BUSINESS_ID` | Your numeric business identifier |
| `PROABONO_SEGMENT_REF` | The Segment your customers and offers belong to |
| `PROABONO_AGENT_KEY` | Basic auth username |
| `PROABONO_API_KEY` | Basic auth password |
| `PROABONO_PORTAL_SECRET` | HMAC key for the portal security hash |
| `PROABONO_WEBHOOK_SECRET` | Secret for the notification signature |

All seven are in your ProAbono BackOffice. Set them in the environment that launches your MCP client — your shell profile, or your OS user environment.

**Do not put them in a configuration file you commit.** Claude Code's `.mcp.json` expands `${PROABONO_API_KEY}`, and VS Code's `mcp.json` can prompt for them through its `inputs` section; both keep the values out of the file. Cursor supports neither, so on Cursor let the server inherit them from your environment rather than writing them into `env`.

No value you supply is ever logged, returned by a tool, put in an error message, or inlined into generated code. Generated code references the variable names.

## First prompt

With the server added and the seven variables set, paste this into your assistant:

```text
Help me install ProAbono in this project. Do the following:

1. Call get_server_info to confirm the server is reachable, and tell me which version you are talking to.
2. Review my project: the framework and language, where a signed-in user is identified, and how paid features are gated today.
3. Read my catalogue with list_offers and list_features, and tell me what my segment sells and which features gate access.
4. Generate the Customer Portal embed for my stack with install_customer_portal, and wire it into the page where my signed-in user is known.
5. Suggest the most relevant next steps.

Answer every question about the ProAbono API from search_documentation and get_api_reference, never from memory.
```

If the ProAbono tools are not there at all, the server refused to start: a variable is missing, and the error naming it is in your MCP client's log. `get_server_info` reports a complete configuration because it cannot run on anything else.

Point your keys at a **Sandbox** account to run this. Step 4 writes nothing, but what usually follows it does: `create_update_customer`, `create_subscription` and the Usage writes create real data in whatever account your keys open.

## Tools

**Documentation**
- `search_documentation` — natural-language search across the ProAbono documentation and the Live OpenAPI contract.
- `get_api_reference` — parameters and schema for a given endpoint or object.

**Installation**
- `install_insite` — the whole In-Site installation, end to end: stack detection, the prerequisites gate, the three steps in order, and the progress recorded in `.proabono/installation.json`.
- `installation_status` — where the installation stands: what is done, what was generated where, what is pending in the BackOffice, what was skipped.
- `install_customer_portal` — the Step 1 in-site embed, with the security hash, for your stack.
- `link_subscription_workflow` — Step 2: the encrypted query read from `Links`, both ways of opening a workflow, and the single return route covering all five outcomes.
- `sync_usage_rights` — the Step 3 rights module: the Usage read, the cache and its expiry, the gate, the write-back for a Feature your application changes, and the resynchronization.
- `scaffold_notification_endpoint` — the webhook endpoint: signature verification, the validation handshake, deduplication, a fast acknowledgement, and the BackOffice procedure that activates it.
- `verify_insite_installation` — steps 2 and 3 exercised against your account, the go-live rules checked against your files, and the twelve-item checklist.

**Code generation**
- `generate_pricing_table` — a pricing table over your real offers.
- `plan_integration` — the ordered plan for a journey: installation, subscription funnel, portal lifecycle, usage metering, notifications.
- `generate_integration_code` — code for a task in the language you name, from the contract and the documentation.

**Catalogue**
- `list_offers` — the offers your segment exposes.
- `list_offers_for_customer` — the offers one customer may take, and the upgrade options of a running subscription.
- `get_offer` — a single offer by reference.
- `list_features` — the features of your business.

**Customers**
- `get_customer` — a customer by reference.
- `create_update_customer` — create a customer, or update one that already carries the reference. One tool: the endpoint is an upsert.
- `get_billing_address`, `update_billing_address` — the address invoices are issued against.
- `get_payment_settings` — payment type, billing mode, grey-list flag, invoice note and next billing date, in one read.
- `set_next_billing_date`, `set_invoice_note`, `set_payment_method` — one setting each. `set_payment_method` records a manual method; `Card` and `DirectDebit` are driven by the payment gateway.
- `anonymize_customer` — **irreversible.** The GDPR erasure path: it erases the personal data and keeps the invoices and the subscription history.

**Subscriptions**
- `get_subscription`, `list_subscriptions` — what a customer is subscribed to.
- `create_subscription` — subscribe a customer to an offer.
- `start_subscription` — start a draft subscription, or restart a suspended one.
- `upgrade_subscription` — move a subscription to another offer.
- `suspend_subscription` — suspend it; `start_subscription` reverses that.
- `terminate_subscription` — terminate it, at the end of the term by default.

**Usage and rights**
- `get_usages` — a customer's rights and consumption.
- `quote_usage_change` — price an intended change, and check it is allowed, before applying it.
- `add_feature_consumption` — report consumption of a `Consumption` feature.
- `set_feature_current_quantity` — set the provisioned quantity of a `Limitation` feature.
- `set_feature_enabled` — switch an `OnOff` feature.

**Invoicing and balance**
- `get_invoice` — a debit invoice, with its PDF URL.
- `get_credit_note` — a credit note, with its `TypeCredit`, its reason and its PDF URL.
- `list_invoices` — a customer's billing documents, both kinds together.
- `create_balance_line` — a debit, or a credit when the amount is negative.
- `bill_customer` — invoice whatever is sitting in the balance.

**Server**
- `get_server_info` — version and configuration status, values excluded.

No tool in this server destroys billing history: deleting a customer, a subscription or an invoice is out of scope in any account, and ProAbono's customer-suspension, invalidation and link-revocation endpoints exist and are deliberately not exposed. `anonymize_customer` is the one tool whose effect cannot be undone, and it is not a destruction — it erases personal data and keeps the invoices and the subscription history, which is what a GDPR erasure asks of a billing system.

## Building from source

The published package is self-contained: the ProAbono API contract and documentation are copied into `dist/resources/` at build time, so nothing is fetched at run time.

A clone builds the same way, with no credential and no access to anything of ours:

```bash
npm ci && npm run build && npm test
```

Both sources the build vendors live in this repository, under `resources/`: the API contract in `resources/open-api/` and the documentation corpus in `resources/docs/`. The contract is a copy of the one ProAbono maintains internally, refreshed by hand — see `resources/open-api/index.md`.

## Support

Issues and questions: [mcp@proabono.com](mailto:mcp@proabono.com).

When reporting a problem, include the output of `get_server_info` — it reports the server version and which variables are configured, and never their values.

## Licence

MIT. See [LICENSE](LICENSE).
