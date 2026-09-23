/**
 * The live lanes: the writes of this release exercised against a real ProAbono account.
 *
 * They run only when the seven variables are present in the environment, and they expect the
 * fixture account described in Spec-test-account.md, in the internal specs repository: a Business
 * used for nothing else, a Segment pool, three Features (one per type), and at least one Offer
 * carrying a Feature.
 *
 * Two lanes, deliberately separate. The first runs the journey -- customer, subscription
 * transitions, payment settings, Usage writes, balance and billing. The second covers
 * anonymization, on a customer created for that alone: the effect cannot be undone, so no other
 * assertion may ever depend on the customer it consumes.
 *
 * Both end on the default-Segment tripwire. `ReferenceSegment` is optional on every operation, so
 * a dropped reference does not raise an error -- it silently acts on the Business's default
 * Segment. Asserting that nothing appeared there is the only way to observe that bug.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { ProAbonoClient } from "../src/api/client.js";
import { loadConfiguration, type ProAbonoConfiguration } from "../src/config.js";

const CONFIGURED = [
  "PROABONO_API_BASE",
  "PROABONO_BUSINESS_ID",
  "PROABONO_SEGMENT_REF",
  "PROABONO_AGENT_KEY",
  "PROABONO_API_KEY",
  "PROABONO_PORTAL_SECRET",
  "PROABONO_WEBHOOK_SECRET",
].every((name) => (process.env[name] ?? "").trim().length > 0);

/** A unique prefix per run: `ReferenceCustomer` is unique per Segment and nothing can be deleted. */
const RUN = `mcp-${Date.now().toString(36)}`;

const live = CONFIGURED ? describe : describe.skip;

interface Usage {
  readonly ReferenceFeature?: string;
  readonly TypeFeature?: string;
  readonly QuantityCurrent?: number;
  readonly IsEnabled?: boolean;
}

live("live journey against the fixture account", () => {
  let configuration: ProAbonoConfiguration;
  let client: ProAbonoClient;
  let offerRef: string;
  let defaultSegmentBaseline: number;

  before(async () => {
    configuration = loadConfiguration();
    client = new ProAbonoClient(configuration);

    // Preflight: the fixture cannot be rebuilt by the suite, so a mismatch fails here, named,
    // rather than as a confusing failure three tests later.
    const offers = await client.listAll<{ ReferenceOffer?: string; Features?: unknown[] }>(
      "/v1/Offers",
      {},
    );
    const usable = offers.find((offer) => (offer.Features ?? []).length > 0);
    assert.ok(
      usable?.ReferenceOffer !== undefined,
      "The fixture account must expose at least one Offer carrying at least one Feature. " +
        "Offers and Features are authored in the BackOffice; see Spec-test-account.md in the internal specs.",
    );
    offerRef = usable.ReferenceOffer;

    defaultSegmentBaseline = await countInDefaultSegment(configuration);
  });

  it("upserts a customer through the one endpoint that creates and updates", async () => {
    const customerRef = `${RUN}-upsert`;

    const created = await client.post<{ Id?: number; ReferenceCustomer?: string }>("/v1/Customer", {
      body: {
        ReferenceCustomer: customerRef,
        ReferenceSegment: configuration.segmentRef,
        Email: `${RUN}@example.test`,
        Name: "MCP suite",
      },
    });
    assert.equal(created.ReferenceCustomer, customerRef);

    // The same call again, with a different name: an upsert, not a duplicate and not a failure.
    const updated = await client.post<{ Id?: number; Name?: string }>("/v1/Customer", {
      body: {
        ReferenceCustomer: customerRef,
        ReferenceSegment: configuration.segmentRef,
        Name: "MCP suite (updated)",
      },
    });
    assert.equal(updated.Id, created.Id, "the second call created a second customer");
    assert.equal(updated.Name, "MCP suite (updated)");
  });

  it("writes each payment setting without disturbing the other two", async () => {
    const customerRef = `${RUN}-settings`;
    await client.post("/v1/Customer", {
      body: { ReferenceCustomer: customerRef, ReferenceSegment: configuration.segmentRef },
    });

    await client.post("/v1/CustomerSettingsPayment", {
      query: { ReferenceCustomer: customerRef },
      body: { NoteInvoice: "PO.mcp-suite" },
    });
    await client.post("/v1/CustomerSettingsPayment", {
      query: { ReferenceCustomer: customerRef },
      body: { TypePayment: "ExternalBank" },
    });

    const settings = await client.get<{ NoteInvoice?: string; TypePayment?: string }>(
      "/v1/CustomerSettingsPayment",
      { ReferenceCustomer: customerRef },
    );

    // The second write must not have cleared what the first one set.
    assert.equal(settings.NoteInvoice, "PO.mcp-suite");
    assert.equal(settings.TypePayment, "ExternalBank");
  });

  it("runs the subscription, Usage, balance and billing journey", async () => {
    const customerRef = `${RUN}-journey`;

    await client.post("/v1/Customer", {
      body: {
        ReferenceCustomer: customerRef,
        ReferenceSegment: configuration.segmentRef,
        Email: `${RUN}-journey@example.test`,
      },
    });
    await client.post("/v1/CustomerAddressBilling", {
      query: { ReferenceCustomer: customerRef },
      body: { FirstName: "MCP", LastName: "Suite", City: "Paris", Country: "FR" },
    });

    const subscription = await client.post<{ Id?: number }>("/v1/Subscription", {
      query: { TryStart: true },
      body: { ReferenceCustomer: customerRef, ReferenceOffer: offerRef },
    });
    assert.ok(typeof subscription.Id === "number");

    const usages = await client.listAll<Usage>("/v1/Usages", { ReferenceCustomer: customerRef });
    assert.ok(
      usages.length > 0,
      "A started subscription on an offer carrying a Feature must return at least one Usage.",
    );

    // One Usage write per Feature type the fixture carries, each in its own mode.
    for (const usage of usages) {
      const stamp = new Date().toISOString();
      const body: Record<string, unknown> = {
        ReferenceCustomer: customerRef,
        ReferenceFeature: usage.ReferenceFeature,
        DateStamp: stamp,
      };

      if (usage.TypeFeature === "OnOff") body["IsEnabled"] = true;
      else if (usage.TypeFeature === "Limitation") body["QuantityCurrent"] = 2;
      else if (usage.TypeFeature === "Consumption") body["Increment"] = 1;
      else continue;

      // Quoted before it is applied, which is what the generated confirmation stands on.
      await client.post("/v1/Quoting/Usage", { body });
      await client.post("/v1/Usage", { body });
    }

    // Balance, then billing: the pair is only useful in that order.
    await client.post("/v1/BalanceLine", {
      body: { ReferenceCustomer: customerRef, Amount: 1000, Label: "MCP suite", Quantity: 1 },
    });
    const invoice = await client.post<{ Id?: number; Links?: { rel?: string; href?: string }[] }>(
      "/v1/Billing/Customer",
      { body: { ReferenceCustomer: customerRef, ForceOffline: true } },
    );
    assert.ok(typeof invoice.Id === "number", "billing a non-empty balance must issue an invoice");

    // Read back by identifier, and the PDF taken from Links rather than built from the number.
    const readBack = await client.get<{ Id?: number; Links?: { rel?: string; href?: string }[] }>(
      "/v1/Invoice/{id}",
      { id: invoice.Id },
    );
    assert.equal(readBack.Id, invoice.Id);
    assert.ok(
      (readBack.Links ?? []).some((link) => link.rel === "insite-related-invoice"),
      "the invoice must publish its PDF under the insite-related-invoice rel",
    );

    await client.post("/v1/Subscription/{IdSubscription}/Termination", {
      query: { IdSubscription: subscription.Id, Immediate: true },
    });
  });

  after(async () => {
    const found = await countInDefaultSegment(configuration);
    assert.equal(
      found,
      defaultSegmentBaseline,
      `${found - defaultSegmentBaseline} customer(s) appeared in the Business's default Segment. ` +
        `A ReferenceSegment was dropped somewhere: the call succeeded against the wrong Segment.`,
    );
  });
});

live("live anonymization, on a customer created for it alone", () => {
  let configuration: ProAbonoConfiguration;
  let client: ProAbonoClient;

  before(() => {
    configuration = loadConfiguration();
    client = new ProAbonoClient(configuration);
  });

  // Anonymization cannot be undone, so this customer exists for this test and is used nowhere
  // else. What is asserted is the half that matters: the personal data goes, the invoices stay.
  it("erases the personal data and keeps the billing history", async () => {
    const customerRef = `${RUN}-gdpr`;

    await client.post("/v1/Customer", {
      body: {
        ReferenceCustomer: customerRef,
        ReferenceSegment: configuration.segmentRef,
        Email: `${RUN}-gdpr@example.test`,
        Name: "To be erased",
      },
    });
    await client.post("/v1/BalanceLine", {
      body: { ReferenceCustomer: customerRef, Amount: 500, Label: "GDPR lane", Quantity: 1 },
    });
    await client.post("/v1/Billing/Customer", {
      body: { ReferenceCustomer: customerRef, ForceOffline: true },
    });

    const before_ = await client.listAll<{ Id?: number }>("/v1/Invoices", {
      ReferenceCustomer: customerRef,
    });
    assert.ok(before_.length > 0, "the lane needs an invoice to prove one survives");

    await client.post("/v1/Customer/Anonymization", { query: { ReferenceCustomer: customerRef } });

    const anonymized = await client.get<{ Name?: string; Email?: string }>("/v1/Customer", {
      ReferenceCustomer: customerRef,
    });
    assert.notEqual(anonymized.Name, "To be erased", "the name survived anonymization");
    assert.ok(
      anonymized.Email === undefined || anonymized.Email === null || !anonymized.Email.includes(RUN),
      "the email survived anonymization",
    );

    const after_ = await client.listAll<{ Id?: number }>("/v1/Invoices", {
      ReferenceCustomer: customerRef,
    });
    assert.equal(
      after_.length,
      before_.length,
      "anonymization destroyed billing history, which it must never do",
    );
  });
});

/** Counts customers in the default Segment, by deliberately omitting `ReferenceSegment`. */
async function countInDefaultSegment(configuration: ProAbonoConfiguration): Promise<number> {
  const response = await fetch(`${configuration.apiBase}/v1/Customers?SizePage=0`, {
    headers: {
      Authorization: `Basic ${Buffer.from(
        `${configuration.agentKey}:${configuration.apiKey}`,
        "utf8",
      ).toString("base64")}`,
      Accept: "application/json",
    },
  });

  const payload = (await response.json()) as { TotalItems?: number };
  return payload.TotalItems ?? 0;
}
