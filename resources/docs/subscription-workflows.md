---
name: proabono-subscription-workflows
description: Connect sign-up to a ProAbono subscription workflow, open a specific workflow through encrypted queries, and handle the redirection back into the app.
when_to_use: Implementing sign-up, first subscription, plan change, restart, invoice payment, or reacting to the end of a hosted workflow.
---

# Subscription workflows and redirections

A **Customer Workflow** is a multi-step ProAbono form that changes something: subscribe, change
plan, change options, restart a suspended subscription, register a payment method, pay an invoice.
Every workflow ends with a payment step, whose outcome may be an immediate payment, a registered
payment method, a payment due later, or nothing to pay at all.

You never build these forms. You decide **which one opens, for whom, and what happens afterwards**.

## Choosing a sign-up flow

Three shapes cover almost every product. Pick one before writing code — they differ in how many API
calls you make and in where the pricing table sits.

### A. Free trial / freemium — two API calls, no hosted page at sign-up

Sign-up completes, a free subscription starts immediately, no billing address and no payment method
are asked for. Frictionless; the paid upgrade happens later, in the portal.

```http
POST /v1/Customer
Content-Type: application/json

{
  "ReferenceSegment": "demo-eur",
  "ReferenceCustomer": "cust-42",
  "Name": "John Doe",
  "Language": "en"
}
```

Then, once the customer exists, start the free subscription. This assumes the free offer already
exists in the catalog:

```http
POST /v1/Subscription
Content-Type: application/json

{
  "ReferenceCustomer": "cust-42",
  "ReferenceOffer": "offer-free-14days",
  "TryStart": true
}
```

`TryStart: true` asks ProAbono to start the subscription immediately if it can — which it can,
because the offer is free and needs no payment method.

```js
// Called at the end of your own account-creation transaction.
async function provisionFreeTrial(user) {
  const customerRef = `cust-${user.id}`;

  await proabono("POST", "/v1/Customer", {
    ReferenceSegment: process.env.PROABONO_SEGMENT_REF,
    ReferenceCustomer: customerRef,
    Name: user.displayName,
    Language: user.language,
  });

  await proabono("POST", "/v1/Subscription", {
    ReferenceCustomer: customerRef,
    ReferenceOffer: process.env.PROABONO_FREE_OFFER_REF,
    TryStart: true,
  });

  // Rights are not readable until the subscription has actually started.
  // Fetch them now, or on the user's first request — see rights-management.md.
}
```

> Sequence matters: the Customer must exist before the Subscription call. And ProAbono returns **no
> Usages at all** until a subscription has started — a brand-new user read too early looks
> indistinguishable from a user with no rights. Provision before you gate.

### B. Choose a plan, then sign up, then subscribe

The visitor picks a plan on your public pricing page and is sent to sign-up carrying that choice.

1. **Configure**: in *Settings → Pricing Pages*, set the anonymous "Choose offer" button to open
   your sign-up page.
2. **Show the anonymous pricing table** (no `customer_ref` — see `in-site-installation.md`):

   ```html
   <script src="https://portal.proabono.com/Get/portal.js"></script>
   <div id="proabono_portal">loading...</div>
   <script>
     ProAbonoPortal.open({ business_id: 42, segment_ref: "demo-eur" });
   </script>
   ```

   When a plan is chosen, the visitor arrives at your sign-up page with a **`refo`** query parameter
   holding the chosen offer reference.

3. **Create the customer, passing that choice through** as `ReferenceOffer`:

   ```http
   POST /v1/Customer
   Content-Type: application/json

   {
     "ReferenceSegment": "demo-eur",
     "ReferenceCustomer": "cust-42",
     "Name": "John Doe",
     "Language": "en",
     "ReferenceOffer": "offer-premium"
   }
   ```

   Because you named an offer, the response's `Links` array now contains a query for the matching
   subscription workflow:

   ```json
   {
     "…": "…",
     "Links": [{ "rel": "insite-subscribe", "query": "{SubscribeQuery}" }]
   }
   ```

4. **Open that workflow** on the post-sign-up page:

   ```html
   <script>
     ProAbonoPortal.open({
       business_id: 42,
       segment_ref: "demo-eur",
       customer_ref: "cust-42",
       query: "{SubscribeQuery}",
       hash: "{SecurityHash}",
     });
   </script>
   ```

> `refo` arrives from the browser, so treat it as untrusted input: validate it against your known
> offer references before passing it to the API. A bad value should fall back to the catalog, not
> produce a 404 page at the end of sign-up.

### C. Sign up, then choose a plan

Sign-up completes first; the pricing table is then displayed to the now-identified customer, who
picks a plan and subscribes.

**Simple version — one step, no API call.** Render the pricing table *with* `customer_ref`:

```html
<script src="https://portal.proabono.com/Get/portal.js"></script>
<div id="proabono_portal">loading...</div>
<script>
  ProAbonoPortal.open({
    business_id: 42,
    segment_ref: "demo-eur",
    customer_ref: "cust-42",
    customer_name: "John Doe", // optional
    customer_lang: "en", // optional
    hash: "{SecurityHash}", // optional in sandbox, required in production
  });
</script>
```

The customer is created on the fly if needed, sees the table, chooses, and subscribes. For most
products this is all that is required.

**Advanced version — create the customer explicitly first.** Use this when you need the Customer to
exist in ProAbono at a precise moment (to set metadata, to record the reference in your own tables,
to reconcile with a CRM), or when you want to control which catalog is shown:

```http
POST /v1/Customer
Content-Type: application/json

{
  "ReferenceSegment": "demo-eur",
  "ReferenceCustomer": "cust-42",
  "Name": "John Doe",
  "Language": "en"
}
```

Read `rel="insite-collection-offers"` from the response's `Links`, then open it:

```html
<script>
  ProAbonoPortal.open({
    business_id: 42,
    segment_ref: "demo-eur",
    customer_ref: "cust-42",
    query: "{OffersQuery}",
    hash: "{SecurityHash}",
  });
</script>
```

## Opening a specific workflow

Most actions are already reachable from the Customer Portal, and the portal's own buttons are the
best-tested path. Use explicit workflow opening only when you need a **dedicated** entry point
inside your application — for example sending a lead straight to a private plan, or pushing an
existing customer onto a custom subscription your sales team just created.

### How it works

Opening parameters are encrypted server-side into a **query**, so nothing sensitive is exposed and
nothing can be tampered with client-side. Queries appear in the `Links` array of objects returned by
the API Live — and **only when the object's state and your request parameters make that workflow
applicable**.

```http
GET /v1/Customer?ReferenceCustomer=cust-42&ReferenceOffer=offer-premium
```

```json
{
  "Id": 133700,
  "ReferenceCustomer": "cust-42",
  "Links": [
    { "rel": "insite-home", "href": "https://my-app.com/billing" },
    { "rel": "insite-subscribe", "query": "{SubscribeQuery}" },
    { "rel": "insite-collection-offers", "query": "{OffersQuery}" }
  ]
}
```

Two consequences worth internalizing: pass the extra parameters the workflow needs (an offer, a
subscription) **on the fetch**, or the query you want will simply be absent; and never store a
query, because it expires.

### Catalogue of queries

| Object | `rel` | Opens | Use when |
| --- | --- | --- | --- |
| Customer | `insite-collection-offers` | The catalog, so the customer can subscribe. | Post sign-up; or adding an extra subscription. |
| Customer | `insite-subscribe` | The subscription workflow on a **specified plan**. | You know which plan they chose. |
| Customer | `insite-collection-upgrade` | The catalog, to change the current plan. | The customer wants to upgrade. |
| Customer | `insite-register` | A form collecting contact info and payment method. | You must have a verified payment method before billing later. |
| Subscription | `insite-subscribe` | Subscription to a **draft/custom** subscription. | Sales prepared a custom subscription for this customer. |
| Subscription | `insite-upgrade` | Change of plan for that subscription — to the catalog, to a given plan, or to a given custom subscription, depending on what you passed. | Driving a specific upgrade. |
| Subscription | `insite-restart` | Restart of a suspended subscription. | Win-back after an interruption. |
| Subscription | `insite-register` | Contact info + payment method, **only if the subscription has a delayed start**. | Collecting payment details ahead of the start date. |
| Subscription | `insite-related-subscription` | The portal focused on that subscription. | The customer has several and one needs attention. |
| Invoice | `insite-charge` | Payment of a due invoice. | Chasing a specific unpaid invoice. |
| Offer | `insite-subscribe` | Subscription to that plan — anonymously, or for a customer you passed. | Private-plan links. Anonymous mode must be enabled in settings and is not recommended. |
| Offer | `insite-upgrade` | Change of a given subscription to that plan. | One-click upgrade links. |

### Method 1 — `pa_query` on your installation URL

Simplest, and the only one that works in an **email**, because the resulting link is a plain URL.
Requires an authenticated customer and a configured installation URL (*Settings → Hosted Pages*).

Fetch the object, read `rel="insite-home"` (it contains your installation URL), and append the query:

```
https://my-app.com/billing?pa_query={SubscribeQuery}
```

Redirect the customer there, or send them the link. The hosted pages open on the right workflow.

### Method 2 — `ProAbonoPortal.open({ query })`

Opens the workflow on **any** page of your application, not just the installation page. Identical to
the standard In-Site installation with a `query` parameter added — see `in-site-installation.md`.

The two methods are not exclusive; a rich integration uses both.

## Full workflow list and how each is reached

| Workflow | What it does | Reachable from |
| --- | --- | --- |
| Choose a plan | Shows the catalog; the customer subscribes. | API: Customer `insite-collection-offers` · Portal: "Choose a plan" on an ended subscription |
| Subscribe to a plan | Subscription to a given plan. | API: Customer or Offer `insite-subscribe` |
| Subscribe to a custom subscription | Subscription to a prepared custom subscription. | API: Subscription `insite-subscribe` |
| Change plan | Catalog, to change an existing subscription's plan. | API: Customer or Subscription `insite-collection-upgrade` |
| Change to a plan | Direct change to a named plan. | API: Customer, Subscription or Offer `insite-upgrade` · Portal: "Change plan" |
| Change to a subscription | Change to a custom subscription. | API: Subscription `insite-upgrade` |
| Restart a subscription | Restarts a suspended subscription. | API: Subscription `insite-restart` · Portal: "Restart subscription" |
| Change options | Changes the updatable options of a subscription. | Portal only: "Change options" |
| Terminate subscription | Terminates a subscription. Not a workflow unless termination fees apply. | Portal only: "Terminate subscription" |
| Register billing info | Contact information + payment method. | API: Customer or Subscription `insite-register` |
| Register payment method | Payment method only. | Portal only: "Change" in the Payment tab |
| Pay invoice | Payment of a due invoice. | API: Invoice `insite-charge` · Portal: "Pay" in the Invoices tab |
| Anonymous subscription | Subscription by a non-identified visitor. **Not recommended.** | Static link in the catalog |

Note which rows are **portal-only**: changing options, terminating, and changing the payment method
have no API-driven entry point. If a task asks for a dedicated in-app button for one of those, the
answer is to open the Customer Portal, not to look for a missing query.

## Redirecting back into your application

When a workflow ends, ProAbono can redirect the customer to a URL of yours. Configure it in
*Settings → Hosted Pages → Customer Workflows*. This serves two purposes, and the second is the
important one:

1. Send new subscribers straight to a meaningful page instead of a dead-end "payment successful".
2. **Refresh the customer's rights at the exact moment they change.** Webhooks are asynchronous and
   can lag by minutes; the redirect is immediate. This is the fastest reliable signal you get.

### Parameters on the redirect URL

| Parameter | Meaning | Present |
| --- | --- | --- |
| `from` | Which workflow just completed. | Always |
| `outcome` | How it ended. | Always |
| `idc` | ProAbono's **internal** customer id. `ReferenceCustomer` is deliberately not used here. | Always |
| `refo` | Reference of the related offer. | When relevant |
| `idsub` | ProAbono's internal subscription id. | When relevant |

Values of `from`:

| Value | Meaning |
| --- | --- |
| `subscribe` | The customer subscribed. |
| `upgrade` | The customer changed plan. |
| `restart` | The customer restarted a suspended subscription. |
| `options` | The customer changed the options of a subscription. |
| `terminate` | The customer terminated a subscription. Effective at the end of the billing period — and cancellable until then. |
| `permission` | The customer changed their registered payment method. |
| `invoice` | The customer paid a due invoice. |
| `portal` | Not a workflow: the redirect came from the Customer Portal. |

Values of `outcome`:

| Value | Meaning |
| --- | --- |
| `nocharge` | Nothing was charged — free operation, or payment due later. |
| `paid` | A payment completed. |
| `pending` | A payment is processing. |
| `registered` | A payment method was registered; no payment taken. |
| `due` | Payment is expected from a customer paying offline. |

### How to handle the redirect

```js
// GET /billing/return
app.get("/billing/return", requireAuth, async (req, res) => {
  const { from, outcome } = req.query;

  // Rights may have changed. Re-read them from ProAbono for the SESSION user —
  // never trust idc/refo/idsub from the query string to decide who to refresh.
  await refreshEntitlements(`cust-${req.user.id}`);

  // 'terminate' is not an immediate loss of access: it takes effect at period end.
  // Do not revoke anything here — the Usages API already reflects the truth.

  res.redirect(destinationFor(from, outcome));
});
```

Three rules, each of which corresponds to a real failure mode:

1. **Re-read rights; never derive them from `from`/`outcome`.** The redirect tells you *that*
   something changed, not *what* the customer may now do. Only the Usages API knows that — see
   `rights-management.md`.
2. **Never trust the identifiers in the query string.** They are browser-supplied. Act on the
   session's user. `idc` is an internal id precisely so that the sharable `ReferenceCustomer` is not
   exposed, but that does not make it authentic.
3. **Configure every case, not only the ones you have today.** You may have no free plan and no
   deferred payment yet. When someone adds one, an integration that already covers `nocharge` and
   `due` keeps working unchanged.

### Redirections out of the Customer Portal

Separately, individual portal buttons — "Terminate", "Change plan", "Change options", "Choose an
offer", "Change payment method", "Remove payment method", and the pricing pages — can each be
redirected to your own page instead of running ProAbono's default. Use this only when you genuinely
need to replace a step with your own process; every one you take over is a flow you must now build
and maintain. These redirects carry `from=portal`, plus `idc`, and `refo`/`idsub` when relevant.
