# ProAbono MCP Installation

A local [MCP](https://modelcontextprotocol.io) server that installs ProAbono into your site, from your IDE.

It gives your coding assistant the ProAbono documentation, the API Live and *your own* ProAbono configuration, so it can answer API questions, generate integration code already filled in with your real business identifier and segment, read your account back to check the result, and create test data.

It runs locally, over stdio, against whatever account your key opens. It has no environment concept of its own: your credentials are the only boundary.

## Early version

**0.0.1 is a first release.** What it does today:

- **Step 1 — Customer Portal**: generates the in-site embed, security hash included.
- **Catalogue and account introspection**: offers, features, customers, subscriptions, usage.
- **Customer and subscription writes**: create and update customers, billing addresses, subscriptions.
- **Documentation and API reference**: natural-language search over the ProAbono corpus and the Live OpenAPI contract.

Not in this version, and planned: **Step 2 — Subscription Workflow** code generation, **Step 3 — Usage API** rights synchronization, the notification-endpoint scaffold, the `install_insite` orchestrator, installation-state tracking, and end-to-end installation verification.

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

## Tools

**Documentation**
- `search_documentation` — natural-language search across the ProAbono documentation and the Live OpenAPI contract.
- `get_api_reference` — parameters and schema for a given endpoint or object.

**Catalogue and account**
- `list_offers`, `get_offer` — the offers your segment exposes.
- `list_features` — the features of your business.
- `get_customer` — a customer by reference.
- `list_subscriptions` — a customer's subscriptions.
- `get_usages` — a customer's rights and consumption.

**Customers and subscriptions**
- `create_customer`, `update_customer` — create and update a customer in your segment.
- `update_billing_address` — set a customer's billing address.
- `create_subscription` — subscribe a customer to an offer.
- `change_subscription` — upgrade, downgrade or terminate.

**Hosted pages**
- `install_customer_portal` — the Step 1 in-site embed, with the security hash, for your stack.
- `generate_pricing_table` — a pricing table over your real offers.

**Server**
- `get_server_info` — version and configuration status, values excluded.

No tool in this server destroys or anonymizes anything. ProAbono's anonymization, invalidation, suspension and link-revocation endpoints exist and are deliberately not exposed, in any account.

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
