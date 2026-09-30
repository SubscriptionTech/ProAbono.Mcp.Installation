# Security policy

## Supported versions

Only the latest published version of `@proabono/mcp-installation` receives fixes. Older versions are
not patched; upgrade instead.

## Reporting a vulnerability

Report privately to **mcp@proabono.com**. Do not open a public issue, and do not include a working
exploit against a production account.

Tell us what you can: the server version (`get_server_info` reports it), the tool or code path
involved, what an attacker gains, and the steps that reproduce it. We acknowledge within three
working days and keep you informed until the fix is published.

Never send us a live credential. If a key of yours is exposed, rotate it in your ProAbono BackOffice
first, then report.

## What this server is

It runs locally, over stdio, under the identity of whoever launches it. It has no environment
boundary of its own: the credentials in its environment are the boundary. It reads seven environment
variables, and never logs, returns, embeds in an error message or inlines into generated code any
value it reads. Generated code references the variable names.

No tool destroys billing history: deleting a customer, a subscription or an invoice is out of scope
in any account, and ProAbono's customer-suspension, invalidation and link-revocation endpoints exist
and are deliberately not exposed. `anonymize_customer` is the one tool whose effect cannot be undone:
it erases a customer's personal data and keeps the invoices and the subscription history, which is
what a GDPR erasure asks of a billing system.

A finding that a tool leaks a secret value, that generated code embeds one, or that a tool does
something its line in the README's *Tools* section does not say is in scope. So is a supply-chain finding about the
published tarball. A misconfigured ProAbono account of your own is not.
