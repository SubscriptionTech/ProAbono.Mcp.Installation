/**
 * The journeys this server can plan, and the one description of the In-Site installation.
 *
 * `INSITE_STEPS` exists so that `install_insite` and `plan_integration` **cannot** describe two
 * different installations. The overlap between them is real -- one plans and executes, the other
 * only plans -- and shipping it twice would mean two answers to the same question, both
 * maintainable, only one right. So the sequence lives here, once, and both tools render it.
 *
 * What a journey is *not*: a second code path. Every step names the tool that generates it, and
 * those are the same tools a developer calls by hand.
 */

export interface JourneyStep {
  readonly title: string;
  /** The tool that generates this step, when one does. */
  readonly tool?: string;
  readonly what: string;
  /** What a human must do, in the BackOffice or in the project, before the step is finished. */
  readonly owed?: string;
}

export interface Journey {
  readonly key: string;
  readonly title: string;
  readonly summary: string;
  readonly steps: readonly JourneyStep[];
  /** Which documents of the corpus carry the detail. Never invented: these files exist. */
  readonly reading: readonly string[];
}

/**
 * The In-Site installation, in the order it has to happen.
 *
 * Step 1 first because it establishes the customer reference the other two stand on; step 3's
 * resynchronization has nothing to attach to until the endpoint exists, which is why the endpoint
 * is part of the sequence rather than an optional extra.
 */
export const INSITE_STEPS: readonly JourneyStep[] = [
  {
    title: "Prerequisites",
    what:
      "An authenticated customer area, a catalogue whose offers carry at least one Feature, a " +
      "decision on how the ProAbono customer comes to exist for a signed-in user (`api_precreate` " +
      "is the recommended default), and a page to host the portal. An offer with no Feature is as " +
      "blocking as no offer at all: the subscription succeeds and the application gets no rights " +
      "back, which is indistinguishable from a broken integration.",
    owed: "Offers and Features are authored in the BackOffice; the Live API cannot create either.",
  },
  {
    title: "Step 1 — Customer Portal",
    tool: "install_customer_portal",
    what:
      "The In-Site embed placed in a page of the merchant's own site: the script, the container, " +
      "and the call carrying the business id, the Segment, the customer reference and the " +
      "security hash — with the hash computed server-side, per render, never in the browser.",
  },
  {
    title: "Step 2 — Subscription Workflow",
    tool: "link_subscription_workflow",
    what:
      "The server-side fetch that reads an encrypted query out of an object's `Links` by `rel`, " +
      "both ways of opening it — in the application and as a `?pa_query=` link — and the single " +
      "return route, which re-reads the session user's rights before branching on `from` × " +
      "`outcome`.",
    owed:
      "The workflow redirect URL, under *Settings → Hosted Pages → Customer Workflows*. Without " +
      "it the customer never comes back to the application.",
  },
  {
    title: "Step 3 — rights and usage via the Usage API",
    tool: "sync_usage_rights",
    what:
      "Reading a customer's rights, caching them with an honest expiry — min(`DatePeriodEnd`, a " +
      "stated ceiling) — gating access on the Usage rather than on the offer, and writing back " +
      "every Feature the application changes, quoted and confirmed with the end customer when the " +
      "change is billable.",
  },
  {
    title: "The notification endpoint",
    tool: "scaffold_notification_endpoint",
    what:
      "The endpoint that keeps step 3 true: signature verification, the validation handshake, " +
      "deduplication on the notification id, a fast acknowledgement, and one global " +
      "resynchronization per affected customer. Without it the cache ceiling is the only thing " +
      "bounding a right that was revoked in ProAbono.",
    owed:
      "Creating the webhook and **validating** it under *Integration → Webhooks*, then subscribing " +
      "the rights-affecting events to it.",
  },
  {
    title: "Verification",
    tool: "verify_insite_installation",
    what:
      "Steps 2 and 3 exercised against the account, the go-live rules checked statically against " +
      "the project's files, and what no API can read back reported as pending rather than " +
      "claimed. Ends with the twelve-item go-live checklist.",
  },
];

/** The journeys `plan_integration` answers for. Each one is a question a developer actually asks. */
export const JOURNEYS: readonly Journey[] = [
  {
    key: "insite_installation",
    title: "Install ProAbono in an existing site, In-Site",
    summary:
      "The whole installation, in the order it has to happen. `install_insite` plans **and runs** " +
      "this same sequence — the steps below are the ones it executes, not a second description of " +
      "them.",
    steps: INSITE_STEPS,
    reading: ["in-site-installation.md", "rights-management.md", "webhooks-processing.md"],
  },
  {
    key: "subscription_funnel",
    title: "Sign up a new customer and take their first subscription",
    summary:
      "The subscription journey of spec §3, end to end. Which of the three shapes fits is a " +
      "product decision, not a technical one: a free trial needs no hosted page at sign-up, a " +
      "pricing-table-first funnel carries the chosen offer through sign-up, and a sign-up-first " +
      "funnel shows the table to an identified customer.",
    steps: [
      {
        title: "Create the ProAbono customer",
        tool: "create_update_customer",
        what:
          "`POST /v1/Customer` is an upsert on `ReferenceCustomer`: the same call creates and " +
          "updates. Do it at the end of your own account-creation transaction, and carry the " +
          "chosen offer as `ReferenceOffer` when the visitor picked one — that is what makes the " +
          "`insite-subscribe` query appear in the response's `Links`.",
      },
      {
        title: "Open the subscription workflow",
        tool: "link_subscription_workflow",
        what:
          "Read the query from the customer's `Links` and open it, or show the identified pricing " +
          "table with `generate_pricing_table`. For a free plan, start the subscription directly " +
          "with `create_subscription` and `TryStart` instead — no hosted page is involved.",
      },
      {
        title: "Handle the way back",
        tool: "link_subscription_workflow",
        what:
          "One return route, rights re-read first, branching on `from` × `outcome` for the " +
          "destination only. It is the fastest reliable signal that rights changed: notifications " +
          "lag by minutes, the redirect is immediate.",
        owed: "The redirect URL in the BackOffice.",
      },
      {
        title: "Gate on the rights",
        tool: "sync_usage_rights",
        what:
          "ProAbono returns **no Usage at all** until a subscription has started, so a brand-new " +
          "user read too early is indistinguishable from one with no rights. Provision before you " +
          "gate, and diagnose an empty response rather than reporting 'no rights'.",
      },
    ],
    reading: ["subscription-workflows.md", "rights-management.md", "in-site-installation.md"],
  },
  {
    key: "portal_lifecycle",
    title: "Let an existing customer manage their subscription",
    summary:
      "The portal journey of spec §3: upgrade, downgrade, payment method, invoices, dunning. Most " +
      "of it is the Customer Portal's own buttons, which are the best-tested path — reach for a " +
      "dedicated workflow only where the application needs its own entry point.",
    steps: [
      {
        title: "Place the portal",
        tool: "install_customer_portal",
        what:
          "One page inside the authenticated area shows the current plan, the invoices, the " +
          "payment method, the billing address and the usage. Changing options, terminating and " +
          "changing the payment method have **no API entry point at all** — they are portal-only.",
      },
      {
        title: "Drive one specific change from the application",
        tool: "link_subscription_workflow",
        what:
          "An upgrade to a named plan, a restart of a suspended subscription, the payment of a " +
          "due invoice: each is a query on a specific object, read by `rel`, opened in place.",
      },
      {
        title: "Re-read rights whenever they can have changed",
        tool: "sync_usage_rights",
        what:
          "Behind the return route, behind every redirect into a protected area, and on every " +
          "rights-affecting notification. `terminate` is not an immediate loss of access: it takes " +
          "effect at period end and can still be cancelled.",
      },
    ],
    reading: ["in-site-installation.md", "subscription-workflows.md", "troubleshooting.md"],
  },
  {
    key: "usage_metering",
    title: "Report what a customer uses, and bill on it",
    summary:
      "Wherever the application changes something a Feature tracks. The Feature's type picks the " +
      "write, and each write sends its one value — that split is what makes a retry safe or not.",
    steps: [
      {
        title: "Know which Feature, and of which type",
        tool: "list_features",
        what:
          "`Consumption` is metered and takes an `Increment`; `Limitation` is a provisioned " +
          "quantity and takes an absolute `QuantityCurrent`; `OnOff` takes `IsEnabled`.",
      },
      {
        title: "Quote a billable change before applying it",
        tool: "quote_usage_change",
        what:
          "The amount due now and the new recurring cost, shown to the **end customer** for " +
          "confirmation. That confirmation is mandatory; the one this server does not ask is the " +
          "developer's.",
      },
      {
        title: "Write it back",
        tool: "add_feature_consumption",
        what:
          "`add_feature_consumption` for `Consumption`, `set_feature_current_quantity` for " +
          "`Limitation`, `set_feature_enabled` for `OnOff`. `DateStamp` is mandatory and in UTC; " +
          "a future date is unsupported. A repeated `Increment` double-counts — an absolute write " +
          "does not, which is why the `Limitation` write never offers the unsafe mode.",
      },
      {
        title: "Invalidate the cached rights",
        tool: "sync_usage_rights",
        what: "The value just changed, so the cached entry is wrong whatever its expiry says.",
      },
    ],
    reading: ["rights-management.md", "integrated-purchasing.md"],
  },
  {
    key: "notifications",
    title: "React to what happens in ProAbono",
    summary:
      "One endpoint, one resynchronization. The rule that makes it small: treat a notification as " +
      "a signal that something changed for a customer, never as a description of the new state.",
    steps: [
      {
        title: "Receive and verify",
        tool: "scaffold_notification_endpoint",
        what:
          "Signature checked in constant time, the validation handshake answered separately, " +
          "duplicates dropped on the body's `Id`, 200 returned fast and the work done out of band.",
        owed: "Creating and validating the webhook in the BackOffice.",
      },
      {
        title: "Resynchronize, do not parse",
        tool: "sync_usage_rights",
        what:
          "Re-read the affected customer's rights and replace the cache. Delivery is unordered and " +
          "at-least-once, and some events carry no usable state at all — re-reading is correct " +
          "however many were missed, duplicated or reordered.",
      },
      {
        title: "Keep payment events off the rights path",
        what:
          "ProAbono retries failed payments itself, and a failed attempt is not a loss of access — " +
          "a suspension arrives as its own subscription event. Subscribe to invoice and charging " +
          "events for accounting or dunning, on a path that never touches entitlements.",
      },
    ],
    reading: ["webhooks-processing.md", "rights-management.md"],
  },
];

export function findJourney(key: string): Journey | undefined {
  return JOURNEYS.find((journey) => journey.key === key);
}
