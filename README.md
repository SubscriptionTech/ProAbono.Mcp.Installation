# ProAbono MCP Installation

[![npm](https://img.shields.io/npm/v/@proabono/mcp-installation)](https://www.npmjs.com/package/@proabono/mcp-installation) [![Licence](https://img.shields.io/npm/l/@proabono/mcp-installation)](LICENSE)

A local [MCP](https://modelcontextprotocol.io) server that installs ProAbono into your site, from your IDE.

It gives your coding assistant the ProAbono documentation, the API Live contract and *your own* ProAbono configuration, so it can run the In-Site installation with you end to end, generate integration code already filled in with your real business identifier, Segment, offers and Features, read your account back to verify the result, and answer API questions from the real contract instead of guessing.

It runs locally, over stdio, against whatever account your credentials open. It has no environment concept of its own: your credentials are the only boundary.

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

All seven are in your ProAbono BackOffice, on one page: *Integration → MCP*. `PROABONO_API_BASE` must begin with `https://`, and `PROABONO_BUSINESS_ID` must be digits only.

**Put them in the `env` block of your MCP client entry, in a file git ignores.** That keeps each set of seven attached to one project and one ProAbono account — which is what you need once you have two sets, since sandbox and production are two accounts with different endpoints, identifiers and keys. Declare one entry per account, for example `proabono-sandbox` and `proabono-production`, each with its own `env`.

- `.vscode/mcp.json` and `.cursor/mcp.json` sit inside your repository: add them to `.gitignore` before pasting a value into them. Cursor also reads `~/.cursor/mcp.json`, outside every repository.
- Claude Code: `--scope user` keeps the entry outside the repository. A project `.mcp.json` is normally committed, so write `${PROABONO_API_KEY}` and the other six there instead of the values — Claude Code expands them from your environment.
- VS Code can also prompt for a value through the `inputs` section of `mcp.json`, which keeps it out of the file.
- Avoid shell exports: they hold one set per shell and per machine, and hand your production keys to every project you open.
- The server does not read a `.env` file. It reads its process environment only.

No value you supply is ever logged, returned by a tool, put in an error message, or inlined into generated code. Generated code references the variable names.

## First prompt

With the server added and the seven variables set, open your project and paste this into your assistant:

```text
Help me install ProAbono in this project.

1. Call get_server_info to confirm the server is reachable, and tell me which version you are talking to.
2. Call installation_status to see whether an installation was already started here.
3. Run install_insite: tell me which stack you detected and why, check the prerequisites with me, then take me through the three In-Site steps and the notification endpoint in order, placing the generated code where my signed-in user is known.
4. List what I still have to do by hand in the ProAbono BackOffice.
5. When the code is in place, run verify_insite_installation and walk me through the go-live checklist.

Answer every question about the ProAbono API from search_documentation and get_api_reference, never from memory.
```

When it works, step 1 answers with the server version and a configuration whose status is `complete`, listing the seven variable names — never a value. If the ProAbono tools are not there at all, the server refused to start: a variable is missing, and the error naming it is in your MCP client's log. `get_server_info` never reports an incomplete configuration, because the server does not start on one.

The generators return code and edit none of your files; your assistant places it. The one file the server writes is `.proabono/installation.json`, the installation state: it carries no credential, is meant to be committed so a later session resumes where this one stopped, and is not written when a tool is called with `record_state: false`.

Point your keys at a **Sandbox** account to run this. `verify_insite_installation` makes sure the customer it verifies against exists — it creates one under an `mcp-verify-` reference when you name none — and the tools that usually come next — `create_update_customer`, `create_subscription`, the Usage writes, `bill_customer` — create real data in whatever account your credentials open.

## Example prompts

Once the installation is under way, these are the questions a developer asks next. Your assistant picks the tools; the second column is the ones it usually reaches for.

| You ask | Tools it usually triggers |
|---|---|
| "Which offers does my Segment expose, and which Features do they carry?" | `list_offers`, `list_features` |
| "Generate a pricing table over my real offers for this page, identified so a signed-in customer can subscribe in place." | `generate_pricing_table` |
| "Someone else started the ProAbono installation in this project. Where does it stand, and what is left in the BackOffice?" | `installation_status` |
| "Wire the notification endpoint into this app, and tell me how to activate it in the BackOffice." | `scaffold_notification_endpoint` |
| "Plan the portal lifecycle for me: upgrade, downgrade, dunning." | `plan_integration` |
| "Create a customer, subscribe them to my first offer, and show me their Usages." | `create_update_customer`, `create_subscription`, `get_usages` |
| "What would it cost this customer to go from 5 to 10 seats, and is it allowed?" | `quote_usage_change` |
| "Which endpoint lists a customer's invoices, and what does it return? Write the call in Go." | `search_documentation`, `get_api_reference`, `generate_integration_code` |

## What it covers today

The version you installed is in [CHANGELOG.md](CHANGELOG.md), and `get_server_info` reports it:

- **The three In-Site steps**, end to end: the Customer Portal embed with its security hash, the Subscription Workflow round trip, and the Usage synchronization with its cache, its gate and its resynchronization.
- **The notification endpoint**, with signature verification, deduplication and the BackOffice procedure that activates it.
- **Verification**: steps 2 and 3 exercised against your account, the go-live rules checked against your own files, and the twelve-item checklist.
- **Catalogue and account introspection**: offers, Features, customers, subscriptions, Usages, invoices.
- **Writes across the lifecycle**: customers and their settings, billing addresses, subscriptions and each of their four transitions, Usage writes for all three Feature types, balance lines and billing.
- **Documentation and API reference**: natural-language search over the ProAbono corpus and the API Live contract.

Not in it, and planned: advanced In-Site options — CSS customization of the hosted pages, and further specific workflows.

Widget and plug-in installations (WordPress and similar) are out of scope by design: this server installs ProAbono **In-Site, by code**, whatever your stack would lend itself to.

Offers, Features, webhooks, pricing pages and the workflow redirect URL are configured in your ProAbono BackOffice, and the API cannot create them: the server reads them, names what is missing, and gives you the BackOffice path.

## Tools

*Writes* marks a tool that changes data in the account your credentials open. It runs as soon as your assistant calls it, with no confirmation step: your credentials are the only boundary.

**Documentation**

| Tool | What it does | Writes |
|---|---|---|
| `search_documentation` | Natural-language search across the ProAbono documentation and the API Live contract. | |
| `get_api_reference` | Parameters and schema for a given endpoint or object. | |

**Installation**

| Tool | What it does | Writes |
|---|---|---|
| `install_insite` | The whole In-Site installation, end to end: stack detection, the prerequisites gate, the three steps in order, and the progress recorded in `.proabono/installation.json`. | |
| `installation_status` | Where the installation stands: what is done, what was generated where, what is pending in the BackOffice, what was skipped. | |
| `install_customer_portal` | The Step 1 in-site embed, with the security hash, for your stack. | |
| `link_subscription_workflow` | Step 2: the encrypted query read from `Links`, both ways of opening a workflow, and the single return route covering all five outcomes. | |
| `sync_usage_rights` | The Step 3 rights module: the Usage read, the cache and its expiry, the gate, the write-back for a Feature your application changes, and the resynchronization. | |
| `scaffold_notification_endpoint` | The webhook endpoint: signature verification, the validation handshake, deduplication, a fast acknowledgement, and the BackOffice procedure that activates it. | |
| `verify_insite_installation` | Steps 2 and 3 exercised against your account — on the customer you name, created if missing, or on a new one — the go-live rules checked against your files, and the twelve-item checklist. | yes |

**Code generation**

| Tool | What it does | Writes |
|---|---|---|
| `generate_pricing_table` | A pricing table over your real offers. | |
| `plan_integration` | The ordered plan for a journey: installation, subscription funnel, portal lifecycle, usage metering, notifications. | |
| `generate_integration_code` | Code for a task in the language you name, from the contract and the documentation. | |

**Catalogue**

| Tool | What it does | Writes |
|---|---|---|
| `list_offers` | The offers your Segment exposes. | |
| `list_offers_for_customer` | The offers one customer may take, and the upgrade options of a running subscription. | |
| `get_offer` | A single offer by reference. | |
| `list_features` | The Features of your Business. | |

**Customers**

| Tool | What it does | Writes |
|---|---|---|
| `get_customer` | A customer by reference. | |
| `create_update_customer` | Create a customer, or update one that already carries the reference. One tool: the endpoint is an upsert. | yes |
| `get_billing_address` | The address invoices are issued against. | |
| `update_billing_address` | Update that address, changing only the fields you supply. | yes |
| `get_payment_settings` | Payment type, billing mode, grey-list flag, invoice note and next billing date, in one read. | |
| `set_next_billing_date` | Set the date of the customer's next billing. | yes |
| `set_invoice_note` | Set the note printed at the bottom of every upcoming invoice of the customer. | yes |
| `set_payment_method` | Record a manual payment method; `Card` and `DirectDebit` are driven by the payment gateway. | yes |
| `anonymize_customer` | **Irreversible.** The GDPR erasure path: it erases the personal data and keeps the invoices and the subscription history. ProAbono refuses it while the customer has an invoice due, and erases nothing. | yes |

**Subscriptions**

| Tool | What it does | Writes |
|---|---|---|
| `get_subscription`, `list_subscriptions` | What a customer is subscribed to. | |
| `create_subscription` | Subscribe a customer to an offer. | yes |
| `start_subscription` | Start a draft subscription, or restart a suspended one. | yes |
| `upgrade_subscription` | Move a subscription to another offer. | yes |
| `suspend_subscription` | Suspend it; `start_subscription` reverses that. | yes |
| `terminate_subscription` | Terminate it, at the end of the term by default. | yes |

**Usage and rights**

| Tool | What it does | Writes |
|---|---|---|
| `get_usages` | A customer's current Usages, as ProAbono sees them. | |
| `quote_usage_change` | Price an intended change, and check it is allowed, before applying it. | |
| `push_usage_increment` | Report consumption of a `Consumption` Feature. | yes |
| `push_usage_quantity` | Set the provisioned quantity of a `Limitation` Feature. | yes |
| `push_usage_enabling` | Switch an `OnOff` Feature. | yes |

**Invoicing and balance**

| Tool | What it does | Writes |
|---|---|---|
| `get_invoice` | A debit invoice, with its PDF URL when it publishes one — an invoice read right after it is issued may not publish one yet. | |
| `get_credit_note` | A credit note, with its `TypeCredit`, its reason and its PDF URL when it publishes one. | |
| `list_invoices` | A customer's billing documents, both kinds together. | |
| `create_balance_line` | A debit, or a credit when the amount is negative. | yes |
| `bill_customer` | Invoice whatever is sitting in the balance. | yes |

**Server**

| Tool | What it does | Writes |
|---|---|---|
| `get_server_info` | Version and configuration status, values excluded. | |

No tool in this server destroys billing history: deleting a customer, a subscription or an invoice is out of scope in any account, and ProAbono's customer-suspension, invalidation and link-revocation endpoints exist and are deliberately not exposed. `anonymize_customer` is the one tool whose effect cannot be undone, and it is not a destruction — it erases personal data and keeps the invoices and the subscription history, which is what a GDPR erasure asks of a billing system.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| The ProAbono tools do not appear in your assistant, and your MCP client's log says a configuration variable is missing | The server refused to start: a variable is missing or empty | Set every variable the message names in the `env` block of the entry, then restart the client |
| The log says `PROABONO_API_BASE must be an https:// endpoint` | The endpoint does not begin with `https://` | Use `https://api-{business_id}.proabono.com`, with your own business identifier |
| The log says `PROABONO_BUSINESS_ID must be the numeric business identifier` | The identifier holds something other than digits | Keep the digits only: no prefix, no quotes, no spaces |
| A tool answers `ProAbono API error 401` | The Agent key or the API key is wrong | Copy both again from your BackOffice |
| A tool answers `ProAbono API error 401`, and both keys are right | The endpoint and the keys come from two different accounts | Take all seven variables from the same account |

## Building from source

The published package is self-contained: the ProAbono API contract and documentation are copied into `dist/resources/` at build time, so nothing is fetched at run time.

A clone builds the same way, with no credential and no access to anything of ours:

```bash
npm ci && npm run build && npm test
```

Both sources the build vendors live in this repository, under `resources/`: the API Live contract in `resources/open-api/` and the documentation corpus in `resources/docs/`. The contract is a copy of the one ProAbono maintains internally. `npm run build` and `npm test` refresh it from there when that source is reachable, and use the committed copy when it is not — which is the case in CI and in any clone of this repository — and say which on every run. See `resources/open-api/index.md`.

## Support

Issues and questions: [mcp@proabono.com](mailto:mcp@proabono.com).

When reporting a problem, include the output of `get_server_info` — it reports the server version and which variables are configured, and never their values.

Beyond this server:

- [ProAbono documentation](https://docs.proabono.com)
- [API reference](https://doc-api.proabono.com)
- [Create a ProAbono account](https://via.proabono.com/Auth/Welcome)

## Licence

MIT. See [LICENSE](LICENSE).
