/**
 * The tools as a client sees them: registered on a real server, called over an in-memory
 * transport, with a recorded fetch standing in for ProAbono.
 *
 * Most of what is asserted here is **request shape**, not response handling. A dropped
 * `ReferenceSegment` produces a perfectly valid response against the wrong Segment, and a partial
 * update that sends one field too many overwrites a setting nobody asked it to touch. Neither is
 * visible in what comes back, so only the request can catch them.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { ProAbonoClient } from "../src/api/client.js";
import { createServer } from "../src/server.js";
import { TEST_CONFIGURATION, assertNoSecret, recordFetch } from "./support.js";

/** Every tool this release registers. The list is the surface, and the surface is the contract. */
const REGISTERED = [
  "add_feature_consumption",
  "anonymize_customer",
  "bill_customer",
  "create_balance_line",
  "create_subscription",
  "create_update_customer",
  "generate_pricing_table",
  "get_api_reference",
  "get_billing_address",
  "get_credit_note",
  "get_customer",
  "get_invoice",
  "get_offer",
  "get_payment_settings",
  "get_server_info",
  "get_subscription",
  "get_usages",
  "install_customer_portal",
  "list_features",
  "list_invoices",
  "list_offers",
  "list_offers_for_customer",
  "list_subscriptions",
  "quote_usage_change",
  "search_documentation",
  "set_feature_current_quantity",
  "set_feature_enabled",
  "set_invoice_note",
  "set_next_billing_date",
  "set_payment_method",
  "start_subscription",
  "suspend_subscription",
  "sync_usage_rights",
  "terminate_subscription",
  "update_billing_address",
  "upgrade_subscription",
];

/**
 * The names `0.1.x` shipped and this release removed, renamed into the tools spec section 4 gives.
 *
 * Asserted rather than assumed: a merge that reinstates one of them would restore a surface the
 * release notes say is gone, and nothing else in the suite would notice.
 */
const RETIRED = ["create_customer", "update_customer", "change_subscription"];

/** Every tool that writes. Each must open its description with WRITE, which is how §8 routes. */
const WRITES = [
  "create_update_customer",
  "update_billing_address",
  "set_next_billing_date",
  "set_invoice_note",
  "set_payment_method",
  "anonymize_customer",
  "create_subscription",
  "start_subscription",
  "upgrade_subscription",
  "suspend_subscription",
  "terminate_subscription",
  "add_feature_consumption",
  "set_feature_current_quantity",
  "set_feature_enabled",
  "create_balance_line",
  "bill_customer",
];

async function connect(responses: readonly { status?: number; body?: unknown }[]) {
  const recorder = recordFetch(responses);
  const server = createServer(TEST_CONFIGURATION, {
    client: new ProAbonoClient(TEST_CONFIGURATION, { fetchImplementation: recorder.fetch }),
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  return { client, recorder };
}

function textOf(result: unknown): string {
  const content = (result as { content: { type: string; text?: string }[] }).content;
  return content.map((block) => block.text ?? "").join("\n");
}

function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

describe("the exposed tool surface", () => {
  it("registers the tools of this release, and nothing that destroys billing history", async () => {
    const { client } = await connect([{ body: {} }]);
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();

    assert.deepEqual(names, REGISTERED);

    // Anonymization is in scope and is not a destruction: it keeps invoices and history. Deleting
    // a customer, a subscription or an invoice is out of scope in any account, as is suspending a
    // customer, revoking their links and invalidating them.
    for (const forbidden of ["delete", "revoke", "invalidat", "suspend_customer"]) {
      assert.ok(!names.some((name) => name.includes(forbidden)), `${forbidden} must not be exposed`);
    }
  });

  it("has removed every retired name, with no alias left behind", async () => {
    const { client } = await connect([{ body: {} }]);
    const names = (await client.listTools()).tools.map((tool) => tool.name);

    for (const retired of RETIRED) {
      assert.ok(
        !names.includes(retired),
        `${retired} was retired into the tools of spec §4 and must not be registered. ` +
          `Reinstating it restores a surface the release notes say is gone.`,
      );
    }
  });

  // A removed tool named in a description or in generated output sends the model, or the
  // developer reading the snippet, to a tool that no longer exists. The rename is only finished
  // when nothing points at the old names any more.
  it("points nothing at a retired name, in a description or in generated output", async () => {
    const { client } = await connect([
      { body: { TotalItems: 1, Items: [{ ReferenceOffer: "offer-pro", Features: [{ Id: 1 }] }] } },
    ]);

    const descriptions = (await client.listTools()).tools
      .map((tool) => `${tool.name}: ${tool.description ?? ""}`)
      .join("\n");

    const generated = [
      await client.callTool({
        name: "install_customer_portal",
        arguments: { stack: "node-express", target_page: "/account/billing" },
      }),
      await client.callTool({
        name: "generate_pricing_table",
        arguments: { stack: "php", target_page: "/pricing", identified: true },
      }),
      await client.callTool({ name: "sync_usage_rights", arguments: { stack: "python" } }),
    ]
      .map(textOf)
      .join("\n");

    for (const retired of RETIRED) {
      // `create_update_customer` contains `update_customer`, so match on a word boundary both
      // sides: the replacement must not be mistaken for the name it replaced.
      const pattern = new RegExp(`(^|[^a-z_])${retired}([^a-z_]|$)`);
      assert.ok(!pattern.test(descriptions), `a description still names ${retired}`);
      assert.ok(!pattern.test(generated), `generated output still tells a developer to use ${retired}`);
    }
  });

  it("marks every write tool as a write in its description", async () => {
    const { client } = await connect([{ body: {} }]);
    const tools = (await client.listTools()).tools;

    for (const name of WRITES) {
      const tool = tools.find((candidate) => candidate.name === name);
      assert.ok(tool !== undefined, `${name} is not registered`);
      assert.match(tool.description ?? "", /^WRITE/, `${name} does not announce itself as a write`);
    }

    // The one tool that cannot be undone says so, in its description and not only in its name.
    const anonymize = tools.find((tool) => tool.name === "anonymize_customer")!;
    assert.match(anonymize.description ?? "", /IRREVERSIBLE/);
    assert.match(anonymize.description ?? "", /no de-anonymization|offers none/i);
  });

  it("gives every tool a description a model can route on", async () => {
    const { client } = await connect([{ body: {} }]);

    for (const tool of (await client.listTools()).tools) {
      assert.ok(
        (tool.description ?? "").length > 80,
        `${tool.name} has no description to route on; §8 makes descriptions the routing mechanism`,
      );
    }
  });

  /**
   * The README is the published tool list, and nothing derives it from `createServer`.
   *
   * It is what npm renders and what a developer reads before installing, so it drifts silently —
   * it drifted once already, naming `0.0.1` while npm served `0.1.0`. A tool added without a
   * README line is invisible; a tool listed but not registered sends the reader to something that
   * no longer answers.
   */
  it("is listed in the README, tool for tool", async () => {
    const { client } = await connect([{ body: {} }]);
    const registered = (await client.listTools()).tools.map((tool) => tool.name);
    const whole = readFileSync(new URL("../../README.md", import.meta.url), "utf8");

    // Only the `## Tools` section. The "What it covers today" prose above it deliberately names tools
    // that are *not* in this version, which is exactly what a reader needs and what a check over
    // the whole file would flag.
    const start = whole.indexOf("\n## Tools\n");
    assert.notEqual(start, -1, "the README has no `## Tools` section to check");
    const rest = whole.slice(start + 1);
    const end = rest.indexOf("\n## ", 1);
    const readme = end === -1 ? rest : rest.slice(0, end);

    for (const name of registered) {
      assert.ok(readme.includes(`\`${name}\``), `the README's tool list does not name ${name}`);
    }

    // Backticked snake_case words that read as a tool name, so `customer_ref` and `pa_query` are
    // not mistaken for one.
    const verbs =
      /^(add|anonymize|bill|change|create|generate|get|install|link|list|plan|quote|scaffold|search|set|start|suspend|sync|terminate|update|upgrade|verify)_/;
    const ghosts = [...readme.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)]
      .map((match) => match[1]!)
      .filter((name) => verbs.test(name) && !registered.includes(name));

    assert.deepEqual(
      [...new Set(ghosts)],
      [],
      "the README names tools this server does not register",
    );
  });

  it("reports its configuration by name and never by value", async () => {
    const { client } = await connect([{ body: {} }]);
    const result = await client.callTool({ name: "get_server_info", arguments: {} });
    const answer = textOf(result);

    assertNoSecret(answer);
    assert.ok(answer.includes("PROABONO_PORTAL_SECRET"));
  });

  it("leaks no credential through any tool answer, including an error", async () => {
    // Every tool that can be called with no account-specific fixture, plus a forced API failure:
    // the error path is where a client's own message is most likely to carry the Authorization it
    // was built with.
    const calls: { name: string; arguments: Record<string, unknown> }[] = [
      { name: "get_server_info", arguments: {} },
      { name: "get_customer", arguments: { customer_ref: "cust-1" } },
      { name: "get_billing_address", arguments: { customer_ref: "cust-1" } },
      { name: "get_payment_settings", arguments: { customer_ref: "cust-1" } },
      { name: "list_invoices", arguments: { customer_ref: "cust-1" } },
      { name: "install_customer_portal", arguments: { stack: "php", target_page: "/billing" } },
      { name: "sync_usage_rights", arguments: { stack: "python" } },
      { name: "anonymize_customer", arguments: { customer_ref: "cust-1" } },
    ];

    for (const call of calls) {
      const { client } = await connect([{ status: 500, body: { Message: "boom" } }]);
      assertNoSecret(textOf(await client.callTool(call)));
    }
  });
});

describe("the customer writes", () => {
  it("upserts a customer in the configured Segment through one tool", async () => {
    const { client, recorder } = await connect([{ body: { Id: 1, ReferenceCustomer: "cust-1" } }]);

    await client.callTool({
      name: "create_update_customer",
      arguments: { customer_ref: "cust-1", email: "john@doe.com" },
    });

    const request = recorder.requests[0]!;
    assert.equal(request.url.pathname, "/v1/Customer");
    assert.equal(request.method, "POST");
    assert.equal((request.body as { ReferenceSegment: string }).ReferenceSegment, "ci-live");
  });

  it("updates a billing address on the customer it names", async () => {
    const { client, recorder } = await connect([{ body: {} }]);

    await client.callTool({
      name: "update_billing_address",
      arguments: { customer_ref: "cust-1", city: "Paris", country: "FR" },
    });

    const request = recorder.requests[0]!;
    assert.equal(request.url.pathname, "/v1/CustomerAddressBilling");
    assert.equal(request.url.searchParams.get("ReferenceCustomer"), "cust-1");
    assert.deepEqual(request.body, { City: "Paris", Country: "FR" });
  });

  // `POST /v1/CustomerSettingsPayment` is a partial update and three tools write to it. A tool
  // that sent a field it was not asked about would silently undo another tool's write, and the
  // response would look exactly the same.
  it("sends one field per payment-settings write, and nothing else", async () => {
    const cases: { name: string; arguments: Record<string, unknown>; body: unknown }[] = [
      {
        name: "set_next_billing_date",
        arguments: { customer_ref: "cust-1", date_next_billing: "2026-10-01T00:00:00Z" },
        body: { DateNextBilling: "2026-10-01T00:00:00Z" },
      },
      {
        name: "set_invoice_note",
        arguments: { customer_ref: "cust-1", note: "PO.42" },
        body: { NoteInvoice: "PO.42" },
      },
      {
        name: "set_payment_method",
        arguments: { customer_ref: "cust-1", payment_method: "ExternalBank" },
        body: { TypePayment: "ExternalBank" },
      },
    ];

    for (const testCase of cases) {
      const { client, recorder } = await connect([{ body: {} }]);
      await client.callTool({ name: testCase.name, arguments: testCase.arguments });

      const request = recorder.requests[0]!;
      assert.equal(request.url.pathname, "/v1/CustomerSettingsPayment");
      assert.equal(request.url.searchParams.get("ReferenceCustomer"), "cust-1");
      assert.deepEqual(request.body, testCase.body, `${testCase.name} sent more than its own field`);
    }
  });

  it("offers no automated payment method, which the endpoint would refuse", async () => {
    const { client, recorder } = await connect([{ body: {} }]);

    for (const refused of ["Card", "DirectDebit"]) {
      const result = await client.callTool({
        name: "set_payment_method",
        arguments: { customer_ref: "cust-1", payment_method: refused },
      });
      assert.ok(isError(result), `${refused} must not be accepted`);
    }
    assert.equal(recorder.requests.length, 0);
  });

  it("anonymizes the customer it names, and says the effect is final", async () => {
    const { client, recorder } = await connect([{ body: { Name: "## cleared ##" } }]);

    const result = await client.callTool({
      name: "anonymize_customer",
      arguments: { customer_ref: "cust-1" },
    });

    const request = recorder.requests[0]!;
    assert.equal(request.url.pathname, "/v1/Customer/Anonymization");
    assert.equal(request.method, "POST");
    assert.equal(request.url.searchParams.get("ReferenceCustomer"), "cust-1");
    assert.match(textOf(result), /cannot be restored/);
    assert.match(textOf(result), /invoices/);
  });
});

describe("the subscription transitions", () => {
  // One endpoint per transition. The shipped 0.1.0 routed all four through one tool and an
  // `action` enum, which made the model pick the value out of a description instead of a name.
  it("sends each transition to its own endpoint", async () => {
    const cases: { name: string; arguments: Record<string, unknown>; path: string }[] = [
      {
        name: "start_subscription",
        arguments: { subscription_id: 140960 },
        path: "/v1/Subscription/140960/Start",
      },
      {
        name: "upgrade_subscription",
        arguments: { subscription_id: 140960, offer_ref: "offer-pro" },
        path: "/v1/Subscription/140960/Upgrade",
      },
      {
        name: "suspend_subscription",
        arguments: { subscription_id: 140960 },
        path: "/v1/Subscription/140960/Suspension",
      },
      {
        name: "terminate_subscription",
        arguments: { subscription_id: 140960 },
        path: "/v1/Subscription/140960/Termination",
      },
    ];

    for (const testCase of cases) {
      const { client, recorder } = await connect([{ body: {} }]);
      await client.callTool({ name: testCase.name, arguments: testCase.arguments });

      const request = recorder.requests[0]!;
      assert.equal(request.url.pathname, testCase.path, `${testCase.name} hit the wrong endpoint`);
      assert.equal(request.method, "POST");
    }
  });

  it("requires the target offer of an upgrade in the schema, not in a check", async () => {
    const { client, recorder } = await connect([{ body: {} }]);

    const result = await client.callTool({
      name: "upgrade_subscription",
      arguments: { subscription_id: 140960 },
    });

    assert.ok(isError(result));
    assert.equal(recorder.requests.length, 0);
  });

  it("names start_subscription as the way back from a suspension", async () => {
    const { client } = await connect([{ body: {} }]);
    const tools = (await client.listTools()).tools;

    const start = tools.find((tool) => tool.name === "start_subscription")!;
    assert.match(start.description ?? "", /suspend/i);

    // Terminating is not an immediate loss of access, and an application that revokes on the call
    // is wrong. The description is the only place that can say so.
    const terminate = tools.find((tool) => tool.name === "terminate_subscription")!;
    assert.match(terminate.description ?? "", /end of the current term/i);
  });

  it("reaches one subscription through the customer who holds it", async () => {
    const { client, recorder } = await connect([
      { body: { TotalItems: 2, Items: [{ Id: 1 }, { Id: 140960, Status: "Active" }] } },
    ]);

    const result = await client.callTool({
      name: "get_subscription",
      arguments: { customer_ref: "cust-1", subscription_id: 140960 },
    });

    assert.equal(recorder.requests[0]!.url.pathname, "/v1/Subscriptions");
    assert.match(textOf(result), /140960/);
  });

  it("says so when the identifier belongs to no subscription of that customer", async () => {
    const { client } = await connect([{ body: { TotalItems: 1, Items: [{ Id: 1 }] } }]);

    const result = await client.callTool({
      name: "get_subscription",
      arguments: { customer_ref: "cust-1", subscription_id: 999 },
    });

    assert.ok(isError(result));
    assert.match(textOf(result), /no subscription 999/);
  });
});

describe("the Usage writes", () => {
  // Each write carries one mode and one only. `POST /v1/Usage` would accept two at once and the
  // request would then mean two different things; the split by Feature type is what keeps the
  // retry-unsafe mode off the Features that have a safe one.
  it("sends one mode per write, and no other", async () => {
    const cases: {
      name: string;
      arguments: Record<string, unknown>;
      expected: string;
      forbidden: readonly string[];
    }[] = [
      {
        name: "add_feature_consumption",
        arguments: { customer_ref: "cust-1", feature_ref: "feat-sms", increment: 57 },
        expected: "Increment",
        forbidden: ["QuantityCurrent", "IsEnabled"],
      },
      {
        name: "set_feature_current_quantity",
        arguments: { customer_ref: "cust-1", feature_ref: "feat-users", quantity_current: 17 },
        expected: "QuantityCurrent",
        forbidden: ["Increment", "IsEnabled"],
      },
      {
        name: "set_feature_enabled",
        arguments: { customer_ref: "cust-1", feature_ref: "feat-mod", is_enabled: true },
        expected: "IsEnabled",
        forbidden: ["Increment", "QuantityCurrent"],
      },
    ];

    for (const testCase of cases) {
      const { client, recorder } = await connect([{ body: {} }]);
      await client.callTool({ name: testCase.name, arguments: testCase.arguments });

      const request = recorder.requests[0]!;
      const body = request.body as Record<string, unknown>;

      assert.equal(request.url.pathname, "/v1/Usage");
      assert.ok(testCase.expected in body, `${testCase.name} did not send ${testCase.expected}`);
      for (const mode of testCase.forbidden) {
        assert.ok(!(mode in body), `${testCase.name} also sent ${mode}`);
      }
      assert.ok(typeof body["DateStamp"] === "string", "DateStamp is mandatory");
    }
  });

  it("stamps the change now when no date is given, in UTC", async () => {
    const { client, recorder } = await connect([{ body: {} }]);

    await client.callTool({
      name: "add_feature_consumption",
      arguments: { customer_ref: "cust-1", feature_ref: "feat-sms", increment: 1 },
    });

    const stamp = (recorder.requests[0]!.body as { DateStamp: string }).DateStamp;
    assert.match(stamp, /Z$/, "DateStamp must be a UTC instant");
    assert.ok(Math.abs(Date.parse(stamp) - Date.now()) < 60_000);
  });

  it("refuses a future date rather than letting the API reject it", async () => {
    const { client, recorder } = await connect([{ body: {} }]);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();

    const result = await client.callTool({
      name: "add_feature_consumption",
      arguments: { customer_ref: "cust-1", feature_ref: "feat-sms", increment: 1, date_stamp: tomorrow },
    });

    assert.ok(isError(result));
    assert.match(textOf(result), /future/);
    assert.equal(recorder.requests.length, 0);
  });

  it("says that a repeated consumption double-counts, and that an absolute write does not", async () => {
    const { client } = await connect([{ body: {} }]);
    const tools = (await client.listTools()).tools;

    const consumption = tools.find((tool) => tool.name === "add_feature_consumption")!;
    assert.match(consumption.description ?? "", /double-count/i);

    const limitation = tools.find((tool) => tool.name === "set_feature_current_quantity")!;
    assert.match(limitation.description ?? "", /provisioned/i);
    assert.match(limitation.description ?? "", /twice is harmless|retry/i);
  });

  it("quotes exactly one intended change at a time", async () => {
    const { client, recorder } = await connect([{ body: { AmountTotal: 5038 } }]);

    const rejected = await client.callTool({
      name: "quote_usage_change",
      arguments: { customer_ref: "cust-1", feature_ref: "feat-users", increment: 4, is_enabled: true },
    });
    assert.ok(isError(rejected));
    assert.equal(recorder.requests.length, 0);

    await client.callTool({
      name: "quote_usage_change",
      arguments: { customer_ref: "cust-1", feature_ref: "feat-users", increment: 4 },
    });
    assert.equal(recorder.requests[0]!.url.pathname, "/v1/Quoting/Usage");
  });

  it("explains the three Usage rejections instead of repeating their code", async () => {
    const codes: [string, RegExp][] = [
      ["Error.Api.Usage.NoneMatching", /carries that Feature/i],
      ["Error.Customer.PaymentSettings.Missing", /payment method/i],
      ["Error.Customer.Billing.CappingReached", /outstanding payments/i],
    ];

    for (const [code, expected] of codes) {
      const { client } = await connect([{ status: 400, body: { Code: code, Message: code } }]);
      const result = await client.callTool({
        name: "add_feature_consumption",
        arguments: { customer_ref: "cust-1", feature_ref: "feat-sms", increment: 1 },
      });

      assert.ok(isError(result));
      assert.match(textOf(result), expected);
    }
  });
});

describe("the invoicing tools", () => {
  const PDF = "https://demo.proabono.com/portal-inv-pdf/encrypted";
  const links = [{ rel: "insite-related-invoice", href: PDF, type: "application/pdf" }];

  it("takes the PDF URL from Links, never from the invoice number", async () => {
    const { client } = await connect([
      { body: { Id: 1, FullNumber: "S-7.00001673", AmountTotal: 10, Links: links } },
    ]);

    const result = await client.callTool({ name: "get_invoice", arguments: { invoice_id: 1 } });
    assert.ok(textOf(result).includes(PDF));
  });

  it("says a document publishes no PDF rather than building a URL for it", async () => {
    const { client } = await connect([{ body: { Id: 1, Status: "Draft", Links: [] } }]);

    const result = await client.callTool({ name: "get_invoice", arguments: { invoice_id: 1 } });
    assert.match(textOf(result), /cannot be reconstructed/);
  });

  it("reports a credit note handed to get_invoice rather than returning it", async () => {
    const { client } = await connect([
      { body: { Id: 2, FullNumber: "S-7.42", TypeCredit: "Refund", Reason: "goodwill", Links: links } },
    ]);

    const result = await client.callTool({ name: "get_invoice", arguments: { invoice_id: 2 } });
    assert.ok(isError(result));
    assert.match(textOf(result), /credit note/);
    assert.match(textOf(result), /get_credit_note/);
  });

  it("reports a debit invoice handed to get_credit_note rather than returning it", async () => {
    const { client } = await connect([{ body: { Id: 1, FullNumber: "S-7.1", Links: links } }]);

    const result = await client.callTool({ name: "get_credit_note", arguments: { invoice_id: 1 } });
    assert.ok(isError(result));
    assert.match(textOf(result), /debit invoice/);
    assert.match(textOf(result), /get_invoice/);
  });

  it("returns a credit note with its TypeCredit, its Reason and its PDF", async () => {
    const { client } = await connect([
      { body: { Id: 2, TypeCredit: "Voiding", Reason: "issued by mistake", Links: links } },
    ]);

    const result = await client.callTool({ name: "get_credit_note", arguments: { invoice_id: 2 } });
    const answer = textOf(result);

    assert.ok(!isError(result));
    assert.match(answer, /Voiding/);
    assert.match(answer, /issued by mistake/);
    assert.ok(answer.includes(PDF));
  });

  it("insists on one way of naming a document", async () => {
    const { client, recorder } = await connect([{ body: {} }]);

    for (const args of [{}, { invoice_id: 1, full_number: "S-7.1" }]) {
      const result = await client.callTool({ name: "get_invoice", arguments: args });
      assert.ok(isError(result));
    }
    assert.equal(recorder.requests.length, 0);
  });

  it("lists both kinds of document together and counts each", async () => {
    const { client } = await connect([
      {
        body: {
          TotalItems: 2,
          Items: [{ Id: 1 }, { Id: 2, TypeCredit: "Refund" }],
        },
      },
    ]);

    const answer = textOf(
      await client.callTool({ name: "list_invoices", arguments: { customer_ref: "cust-1" } }),
    );

    assert.match(answer, /"count": 2/);
    assert.match(answer, /"debit_invoices": 1/);
    assert.match(answer, /"credit_notes": 1/);
  });

  it("bills the balance and hands back the invoice's PDF", async () => {
    const { client, recorder } = await connect([{ body: { Id: 9, Links: links } }]);

    const result = await client.callTool({
      name: "bill_customer",
      arguments: { customer_ref: "cust-1", note: "thanks" },
    });

    const request = recorder.requests[0]!;
    assert.equal(request.url.pathname, "/v1/Billing/Customer");
    assert.deepEqual(request.body, { ReferenceCustomer: "cust-1", NoteLocalized: "thanks" });
    assert.ok(textOf(result).includes(PDF));
  });

  it("creates a balance line, and refuses a date that is both one-off and a period", async () => {
    const { client, recorder } = await connect([{ body: { AmountTotal: 60000 } }]);

    await client.callTool({
      name: "create_balance_line",
      arguments: { customer_ref: "cust-1", amount: -5000, label: "goodwill" },
    });
    assert.equal(recorder.requests[0]!.url.pathname, "/v1/BalanceLine");
    assert.equal((recorder.requests[0]!.body as { Amount: number }).Amount, -5000);

    const result = await client.callTool({
      name: "create_balance_line",
      arguments: {
        customer_ref: "cust-1",
        amount: 100,
        date: "2026-01-01T00:00:00Z",
        period_start: "2026-01-01T00:00:00Z",
      },
    });
    assert.ok(isError(result));
    assert.equal(recorder.requests.length, 1);
  });
});

describe("the catalogue reads", () => {
  it("asks for this customer's offers, and not the whole catalogue", async () => {
    const { client, recorder } = await connect([{ body: { TotalItems: 0, Items: [] } }]);

    await client.callTool({
      name: "list_offers_for_customer",
      arguments: { customer_ref: "cust-1", upgrade_only: true, subscription_id: 140960 },
    });

    const url = recorder.requests[0]!.url;
    assert.equal(url.pathname, "/v1/Offers");
    assert.equal(url.searchParams.get("ReferenceCustomer"), "cust-1");
    assert.equal(url.searchParams.get("Upgrade"), "true");
    assert.equal(url.searchParams.get("IdSubscription"), "140960");
  });

  it("does not pass a customer on the plain catalogue read", async () => {
    const { client, recorder } = await connect([{ body: { TotalItems: 0, Items: [] } }]);

    await client.callTool({ name: "list_offers", arguments: {} });
    assert.equal(recorder.requests[0]!.url.searchParams.get("ReferenceCustomer"), null);
  });

  it("flags an offer that carries no Feature", async () => {
    const { client } = await connect([
      { body: { TotalItems: 1, Items: [{ ReferenceOffer: "offer-empty", Features: [] }] } },
    ]);

    const result = await client.callTool({ name: "list_offers", arguments: {} });
    assert.match(textOf(result), /carry no Feature/);
  });

  it("reads a customer's rights and diagnoses an empty answer", async () => {
    const { client } = await connect([{ body: { TotalItems: 0, Items: [] } }]);

    const result = await client.callTool({
      name: "get_usages",
      arguments: { customer_ref: "cust-1" },
    });

    assert.match(textOf(result), /No Usage came back/);
  });

  it("answers a documentation question from the corpus", async () => {
    const { client } = await connect([{ body: {} }]);

    const result = await client.callTool({
      name: "search_documentation",
      arguments: { question: "where does the security hash come from" },
    });

    assert.match(textOf(result), /in-site-installation\.md/);
  });
});

// The Segment is optional on every operation that takes it, and omitting it acts on the Business's
// default Segment with no error at all. Only the request can show that it was carried.
describe("the Segment", () => {
  it("is carried on every operation whose contract declares it", async () => {
    const cases: { name: string; arguments: Record<string, unknown> }[] = [
      { name: "list_offers", arguments: {} },
      { name: "list_offers_for_customer", arguments: { customer_ref: "cust-1" } },
      { name: "get_offer", arguments: { offer_ref: "offer-pro" } },
      { name: "list_features", arguments: {} },
      { name: "list_subscriptions", arguments: { customer_ref: "cust-1" } },
      { name: "list_invoices", arguments: { customer_ref: "cust-1" } },
      { name: "get_invoice", arguments: { full_number: "S-7.1" } },
    ];

    for (const testCase of cases) {
      const { client, recorder } = await connect([{ body: { TotalItems: 0, Items: [] } }]);
      await client.callTool({ name: testCase.name, arguments: testCase.arguments });

      assert.equal(
        recorder.requests[0]!.url.searchParams.get("ReferenceSegment"),
        "ci-live",
        `${testCase.name} dropped the Segment, and would act on the Business's default one`,
      );
    }
  });

  it("is carried in the body where the customer upsert takes it", async () => {
    const { client, recorder } = await connect([{ body: {} }]);

    await client.callTool({
      name: "create_update_customer",
      arguments: { customer_ref: "cust-1" },
    });

    assert.equal((recorder.requests[0]!.body as { ReferenceSegment: string }).ReferenceSegment, "ci-live");
  });
});

describe("the generator tools", () => {
  it("generates the portal install without leaking a secret", async () => {
    const { client } = await connect([
      { body: { TotalItems: 1, Items: [{ ReferenceOffer: "offer-pro", Features: [{ Id: 1 }] }] } },
    ]);

    const result = await client.callTool({
      name: "install_customer_portal",
      arguments: { stack: "node-express", target_page: "/account/billing" },
    });
    const answer = textOf(result);

    assertNoSecret(answer);
    assert.ok(answer.includes("PROABONO_PORTAL_SECRET"));
    assert.ok(answer.includes("portal.proabono.com/Get/portal.js"));
    assert.ok(answer.includes("ci-live"));
  });

  it("warns when the catalogue cannot support an installation", async () => {
    const { client } = await connect([{ body: { TotalItems: 0, Items: [] } }]);

    const result = await client.callTool({
      name: "generate_pricing_table",
      arguments: { stack: "php", target_page: "/pricing", identified: false },
    });

    assert.match(textOf(result), /no visible offer/i);
  });

  it("omits the hash from an anonymous pricing table", async () => {
    const { client } = await connect([
      { body: { TotalItems: 1, Items: [{ ReferenceOffer: "offer-pro", TitleLocalized: "Pro" }] } },
    ]);

    const result = await client.callTool({
      name: "generate_pricing_table",
      arguments: { stack: "node-express", target_page: "/pricing", identified: false },
    });

    assert.ok(!textOf(result).includes("hash:"));
  });

  it("names the account's real Features, with the write each type takes", async () => {
    const { client } = await connect([
      {
        body: {
          TotalItems: 3,
          Items: [
            { ReferenceFeature: "feat-mod", TitleLocalized: "Module A", TypeFeature: "OnOff" },
            { ReferenceFeature: "feat-users", TitleLocalized: "Seats", TypeFeature: "Limitation" },
            { ReferenceFeature: "feat-sms", TitleLocalized: "Messages", TypeFeature: "Consumption" },
          ],
        },
      },
    ]);

    const answer = textOf(
      await client.callTool({ name: "sync_usage_rights", arguments: { stack: "node-express" } }),
    );

    assertNoSecret(answer);
    assert.match(answer, /feat-mod.*set_feature_enabled/s);
    assert.match(answer, /feat-users.*set_feature_current_quantity/s);
    assert.match(answer, /feat-sms.*add_feature_consumption/s);
  });

  // The rights module and the gate both call functions the project owns and this code does not
  // define. Pasted without them the module raises a ReferenceError on the very path the fallback
  // exists to survive, so the output has to name them rather than leave them to be discovered.
  it("names the functions the generated code expects the project to supply", async () => {
    const { client } = await connect([{ body: { TotalItems: 0, Items: [] } }]);

    const answer = textOf(
      await client.callTool({ name: "sync_usage_rights", arguments: { stack: "node-express" } }),
    );

    assert.match(answer, /does not define/i);
    assert.match(answer, /alertOperations|alert_operations/);
    assert.match(answer, /confirmWithCustomer/);
  });

  it("says the resynchronization wiring is not generated by this version", async () => {
    const { client } = await connect([{ body: { TotalItems: 0, Items: [] } }]);

    const answer = textOf(
      await client.callTool({ name: "sync_usage_rights", arguments: { stack: "generic" } }),
    );

    assert.match(answer, /not.{0,4}\*{0,2} generated by this version/i);
    assert.match(answer, /maximum TTL|ceiling/i);
  });

  // The whole point of the tool: an empty Usages response has three causes and they are told
  // apart by reading the account, not by guessing.
  it("diagnoses an empty Usages response against the real account", async () => {
    // 1. Features (for the listing), 2. Usages (empty), 3. Subscriptions.
    const neverSubscribed = await connect([
      { body: { TotalItems: 0, Items: [] } },
      { body: { TotalItems: 0, Items: [] } },
      { body: { TotalItems: 0, Items: [] } },
    ]);
    assert.match(
      textOf(
        await neverSubscribed.client.callTool({
          name: "sync_usage_rights",
          arguments: { stack: "generic", customer_ref: "cust-1" },
        }),
      ),
      /\*\*cause 1\*\*/,
    );

    const notRunning = await connect([
      { body: { TotalItems: 0, Items: [] } },
      { body: { TotalItems: 0, Items: [] } },
      { body: { TotalItems: 1, Items: [{ Id: 1, Status: "Terminated", StateSubscription: "Closed" }] } },
    ]);
    assert.match(
      textOf(
        await notRunning.client.callTool({
          name: "sync_usage_rights",
          arguments: { stack: "generic", customer_ref: "cust-1" },
        }),
      ),
      /\*\*cause 2\*\*/,
    );

    const emptyOffer = await connect([
      { body: { TotalItems: 0, Items: [] } },
      { body: { TotalItems: 0, Items: [] } },
      {
        body: {
          TotalItems: 1,
          Items: [{ Id: 1, Status: "Active", ReferenceOffer: "offer-bare", Features: [] }],
        },
      },
    ]);
    assert.match(
      textOf(
        await emptyOffer.client.callTool({
          name: "sync_usage_rights",
          arguments: { stack: "generic", customer_ref: "cust-1" },
        }),
      ),
      /\*\*cause 3\*\*/,
    );
  });

  it("reports the earliest DatePeriodEnd as the cache expiry for a real customer", async () => {
    const { client } = await connect([
      { body: { TotalItems: 0, Items: [] } },
      {
        body: {
          TotalItems: 2,
          Items: [
            { ReferenceFeature: "feat-a", TypeFeature: "OnOff", DatePeriodEnd: "2026-12-01T00:00:00.00Z" },
            { ReferenceFeature: "feat-b", TypeFeature: "Limitation", DatePeriodEnd: "2026-10-01T00:00:00.00Z" },
          ],
        },
      },
    ]);

    const answer = textOf(
      await client.callTool({
        name: "sync_usage_rights",
        arguments: { stack: "python", customer_ref: "cust-1" },
      }),
    );

    assert.match(answer, /earliest `DatePeriodEnd` is 2026-10-01/);
  });
});

/**
 * The empty collection, which is `204 No Content` and not `200 { TotalItems: 0 }`.
 *
 * This shipped broken in `0.1.0` and survived the whole catalogue release: the recorder always
 * produced a JSON body, so every offline test exercised a shape the API does not send for an empty
 * collection. Reading `.Items` off nothing threw a TypeError, which turned the most ordinary state
 * in the product -- a customer who has nothing yet -- into a crash. A live run found it in one
 * call.
 *
 * The rights diagnosis is the case that matters most: `sync_usage_rights` exists to tell the three
 * causes of an empty `Usages` response apart, and it could not reach any of them, because reading
 * the empty response is what crashed.
 */
describe("an empty collection", () => {
  it("reads as zero items, not as a crash", async () => {
    const { client } = await connect([{ status: 204 }]);

    const answer = textOf(
      await client.callTool({ name: "list_subscriptions", arguments: { customer_ref: "cust-new" } }),
    );

    assert.match(answer, /"count": 0/);
  });

  it("lets get_usages diagnose a customer who has nothing yet", async () => {
    const { client } = await connect([{ status: 204 }]);

    const result = await client.callTool({
      name: "get_usages",
      arguments: { customer_ref: "cust-new" },
    });

    assert.ok(!isError(result));
    assert.match(textOf(result), /No Usage came back/);
  });

  it("lets sync_usage_rights reach cause 1 instead of crashing on the way", async () => {
    // Features, Usages, Subscriptions -- every one of them empty, which is a brand-new account
    // looked at by a brand-new customer.
    const { client } = await connect([{ status: 204 }]);

    const result = await client.callTool({
      name: "sync_usage_rights",
      arguments: { stack: "node-express", customer_ref: "cust-new" },
    });

    assert.ok(!isError(result));
    assert.match(textOf(result), /\*\*cause 1\*\*/);
  });

  it("reports an empty single record rather than returning no text at all", async () => {
    const { client } = await connect([{ status: 204 }]);

    const result = await client.callTool({
      name: "get_payment_settings",
      arguments: { customer_ref: "cust-new" },
    });

    // `JSON.stringify(undefined)` is `undefined`, not a string: unguarded, this put a text block
    // with no text on the wire.
    const blocks = (result as { content: { text?: string }[] }).content;
    assert.ok(blocks.every((block) => typeof block.text === "string" && block.text.length > 0));
    assert.match(textOf(result), /204 No Content/);
  });

  it("is handled by the generated code of every stack", async () => {
    const { client } = await connect([{ status: 204 }]);

    for (const stack of ["node-express", "php", "python", "ruby", "csharp", "generic"]) {
      const answer = textOf(
        await client.callTool({ name: "sync_usage_rights", arguments: { stack } }),
      );
      assert.match(answer, /204/, `the ${stack} module says nothing about a 204 empty collection`);
    }
  });
});
