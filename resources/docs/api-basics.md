---
name: proabono-api-basics
description: Endpoint, Basic authentication, technical references, the Links/query mechanism, pagination and error shape of the ProAbono API. Assumed by every other file.
when_to_use: Before writing any server-side ProAbono call, or when a call returns 401/403, or when deciding how to identify customers, offers and features.
---

# ProAbono API — basics

## The two APIs

| API | Purpose |
| --- | --- |
| **API Live** | Everything needed for a normal integration: customers, subscriptions, usages, pricing, invoices. Start here — it is deliberately small. |
| **API BackOffice** | Administrative and less common operations. Only reach for it when the API Live has no equivalent. |

Unless a task explicitly says otherwise, you want the **API Live**.

## Endpoint

The base URL is per-environment and is shown in the BackOffice under *Integration → API*, in the
**Endpoint API** field. It has the shape:

```
https://api-{business_id}.proabono.com
```

Example used throughout these files: `https://api-42.proabono.com/v1/...`

There are **two separate environments**, sandbox and production, with **different `business_id`
values, different keys and different endpoints**. Nothing is shared between them — customers,
plans and subscriptions created in sandbox do not exist in production. Put the endpoint and the
keys in configuration, never in code.

## Authentication

HTTP **Basic**, over HTTPS only.

- **Username** = the *Agent key*
- **Password** = the *API key*

Both are found in the BackOffice under *Integration → API*. They are a service account, not tied
to a person.

```http
GET /v1/Usages?ReferenceCustomer=cust-42 HTTP/1.1
Host: api-42.proabono.com
Authorization: Basic {base64(agentKey + ":" + apiKey)}
Accept: application/json
```

Building the header:

```ts
const auth =
  "Basic " +
  Buffer.from(
    `${process.env.PROABONO_AGENT_KEY}:${process.env.PROABONO_API_KEY}`,
  ).toString("base64");
```

A minimal client worth writing once and reusing:

```js
const BASE = process.env.PROABONO_API_BASE; // e.g. https://api-42.proabono.com

async function proabono(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: auth,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const payload = res.status === 204 ? null : await res.json().catch(() => null);

  if (!res.ok) {
    // ProAbono returns a stable error code in `Code` — branch on that, never on `Message`.
    const err = new Error(`ProAbono ${method} ${path} -> ${res.status} ${payload?.Code ?? ""}`);
    err.status = res.status;
    err.code = payload?.Code ?? null;
    err.payload = payload;
    throw err;
  }
  return payload;
}
```

> **Server-to-server only.** The credentials are sent unencrypted inside the Basic header and they
> grant full access to every customer of the business. They must never reach a browser, a mobile
> app, a public repository or a client-side bundle. Anything the browser needs — the portal, a
> pricing table, a workflow — is opened with the public `business_id` plus an encrypted `query` and
> a per-customer `hash`. See `in-site-installation.md`.

## Technical references

ProAbono objects are addressed by a **technical reference**: a UTF-8 string you choose, so your
application can name ProAbono objects using identifiers it already has.

- Maximum **50 characters**.
- Excluded characters: `<` `>` `;` `"` `=` `?` `&`
- If you do not supply one at creation, ProAbono generates a UUID — workable, but then you must
  store it on your side. Prefer supplying your own.

| Reference | Identifies | Unique per | Typical value |
| --- | --- | --- | --- |
| `ReferenceSegment` | Segment | Business | `demo-eur` |
| `ReferenceCustomer` | Customer | Segment | `cust-42` |
| `ReferenceOffer` | Offer (plan) | Segment | `offer-premium` |
| `ReferenceFeature` | Feature | Business | `feat-team-members` |
| `ReferencePricingTable` | Pricing table | Segment | `pricing-public` |
| `ReferenceDiscount` | Discount | Segment | `promo-launch` |

**Recommended convention for `ReferenceCustomer`:** a short prefix plus your own primary key, e.g.
`cust-42` for user id 42. You then never store an extra column — the reference is derivable from
data you already have, in both directions.

> Changing a reference after the fact is possible but consequential. Changing a
> `ReferenceCustomer` can cut your app off from its customer or, worse, point it at a different
> customer's data. Changing a `ReferenceOffer` or `ReferenceFeature` breaks subscription flows and
> can revoke a feature for every user at once. Treat references as immutable once in production,
> and check with ProAbono support before changing a `ReferenceSegment`, which is API-only.

## `Links` and the `query` mechanism

Most API Live responses carry a `Links` array. This is how the server side hands work to the
browser side without exposing anything sensitive:

```json
{
  "Id": 133700,
  "ReferenceCustomer": "cust-42",
  "Links": [
    { "rel": "insite-home", "href": "https://my-app.com/billing" },
    { "rel": "insite-collection-offers", "query": "{OffersQuery}" },
    { "rel": "insite-subscribe", "query": "{SubscribeQuery}" },
    { "rel": "insite-register", "query": "{RegisterQuery}" }
  ]
}
```

- A **`query`** is an *encrypted* set of opening parameters. It is safe to put in a page or a URL:
  it cannot be read or tampered with client-side. You pass it to `ProAbonoPortal.open({ query })`
  or as a `pa_query` URL parameter. The full `rel` catalogue is in `subscription-workflows.md`.
- An **`href`** is a ready-to-use URL.
- Which `rel` values are present depends on the object's state **and on the query parameters you
  passed when fetching it**. Always look a link up by its `rel`, never by array position, and
  handle its absence rather than indexing blindly.

```js
const link = (obj, rel) => obj?.Links?.find((l) => l.rel === rel);

const subscribe = link(customer, "insite-subscribe");
if (!subscribe?.query) {
  // The customer is not in a state where this workflow applies — do not fabricate a URL.
  throw new Error("insite-subscribe not available for this customer");
}
```

> Encrypted links and queries are **not permalinks — they expire**. Never persist one in your
> database or in a long-lived session. Re-fetch the object from the API each time you need to open
> a page.

## Collections and pagination

List endpoints (plural: `/v1/Usages`, `/v1/Subscriptions`, …) return an envelope:

```json
{
  "Page": 1,
  "SizePage": 10,
  "Count": 3,
  "TotalItems": 3,
  "Items": ["…"]
}
```

`Count` is the number of items in this page; `TotalItems` the total across pages. **Do not assume
one page is the whole set** — a customer holding several subscriptions can exceed the default page
size. Either page until you have collected `TotalItems`, or narrow the query with filters such as
`ReferenceCustomer` and `ReferenceFeature`.

Singular endpoints (`/v1/Usage`, `/v1/Customer`) return the bare object, with no envelope.

## Amounts

Monetary amounts are integers in the currency's **minor unit** (cents for EUR/USD):
`"AmountTotal": 1626` with `"Currency": "EUR"` means €16.26.

Responses meant to be shown to a customer also carry pre-formatted, localized strings
(`PricingLocalized`, `LabelLocalized`). **Display those** rather than formatting the integer
yourself — ProAbono already applies the customer's language and currency conventions.

## Dates

ISO 8601, UTC, e.g. `2026-08-01T15:31:00.00Z`. Send UTC; never send a local time.

## Errors

Failures return a non-2xx HTTP status and a body carrying a **stable error code**:

```json
{
  "Code": "Error.Api.Customer.Unaccessible",
  "Message": "You cannot access that Customer"
}
```

Branch on `Code`. **Never branch on `Message`** — it is human-facing prose, subject to change and to
localization. `Message` is for your logs, not for your control flow, and not for your end users
either: it describes the integration's mistake, not the customer's.

| Status | Meaning |
| --- | --- |
| 401 | Authentication failed: wrong keys, keys from the other environment, or a malformed Basic header. |
| 403 | Authenticated, but refused. Either a business reason (no matching feature, no payment method, unpaid invoices…) or an access one — `Error.Api.Customer.Unaccessible` means the keys are valid but this customer is not theirs to read, which usually means wrong segment or wrong environment. `Code` says which. |
| 404 | The object does not exist in this environment or segment. |
| 429 | Rate limited. Back off and retry. |
| 5xx | Transient. Retry with exponential backoff; never treat as "the customer has no rights". |

The error codes you will actually branch on are listed where they occur — see
`rights-management.md` and `integrated-purchasing.md`.

> **Decide your failure mode deliberately.** If `GET /v1/Usages` fails, you have *no information* —
> not "no rights". Serve the last known good value from cache and log the incident. Silently
> downgrading every user to zero entitlements during a ProAbono outage is a far worse failure than
> briefly over-serving one. See the caching section of `rights-management.md`.

## Upsert semantics of `POST /v1/Customer`

`POST /v1/Customer` **creates or updates**: if a customer with that `ReferenceCustomer` already
exists in the segment, it is updated; otherwise it is created. This makes it safe to call on every
sign-in, and it is the normal way to keep name and language in sync *and* obtain fresh `Links` in
the same round trip.

```http
POST /v1/Customer
Content-Type: application/json

{
  "ReferenceSegment": "demo-eur",
  "ReferenceCustomer": "cust-42",
  "Name": "John Doe",
  "Email": "john@doe.com",
  "Language": "en"
}
```

- `Name` is **internal** — it is not the billing name printed on invoices, and it is never shown to
  the customer.
- `Email` is where invoices are sent. The customer can change it themselves in the portal, so once
  it is set, treat ProAbono as the owner of that value rather than overwriting it on every login
  with your app's login email.
- `Language` uses ISO 639 codes and drives the language of the hosted pages and of ProAbono's
  emails.
