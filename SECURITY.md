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

The server exposes no destructive operation. ProAbono's anonymization, invalidation, suspension and
link-revocation endpoints exist and are deliberately not exposed, in any account.

A finding that a tool leaks a secret value, that generated code embeds one, or that a tool reaches
an endpoint outside the list in the README is in scope. So is a supply-chain finding about the
published tarball. A misconfigured ProAbono account of your own is not.
