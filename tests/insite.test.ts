/**
 * The In-Site orchestration surface: the state, the orchestrator, the workflow round trip, the
 * notification endpoint, the verification, and the generic pair.
 *
 * Two things here are not ordinary assertions and are worth naming.
 *
 * **The generated webhook code is executed, not read.** The signature verification is lifted out of
 * the generated Node module and run against a correct signature, a signature altered by one byte,
 * and a missing header. A regular expression over generated source proves the text says "sha256";
 * running it proves the algorithm is the one ProAbono actually computes, in the order it computes
 * it -- key then secret, raw digest, base64. That distinction is the whole value of the check.
 *
 * **Every test that calls a generator runs from a temporary directory.** Those tools write
 * `.proabono/installation.json` into the project they are run in, which is the point of them and
 * would otherwise be this repository. `node --test` gives each file its own process, so the
 * `process.chdir` below is local to this one.
 */
import assert from "node:assert/strict";
import crypto, { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { ProAbonoClient } from "../src/api/client.js";
import { notificationEndpoint, RIGHTS_AFFECTING_EVENTS } from "../src/generate/notifications.js";
import { INSITE_STEPS } from "../src/generate/journeys.js";
import { resolveLanguage } from "../src/generate/integration.js";
import { returnRouteSnippet, workflowModule } from "../src/generate/workflows.js";
import { STACKS } from "../src/generate/hosted-pages.js";
import {
  assertNoCredential,
  readState,
  secretsOf,
  statePathFor,
  writeState,
} from "../src/install/state.js";
import { detectStack } from "../src/tools/install.js";
import { createServer } from "../src/server.js";
import { TEST_CONFIGURATION, SENTINELS, recordFetch } from "./support.js";

/** A scratch project, thrown away at the end. Nothing here ever writes into the repository. */
const launchDirectory = process.cwd();
const workspace = mkdtempSync(join(tmpdir(), "proabono-insite-"));
process.chdir(workspace);

after(() => {
  // Windows refuses to remove a directory that is some process's working directory, and this
  // process's is inside it -- which is the whole point while the tests run.
  process.chdir(launchDirectory);
  rmSync(workspace, { recursive: true, force: true });
});

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

/** A fresh project directory, so one test's state file never reaches another's. */
function project(name: string): string {
  const root = join(workspace, name);
  mkdirSync(root, { recursive: true });
  return root;
}

// ── The installation state ────────────────────────────────────────────────────────────

describe("the installation state", () => {
  it("is written where the project is, and read back whole", () => {
    const root = project("round-trip");

    writeState(
      {
        version: 1,
        segment_ref: "ci-live",
        stack: "node-express",
        steps: {
          customer_portal: { status: "generated", generated: [{ what: "embed", where: "/billing" }] },
        },
      },
      secretsOf(TEST_CONFIGURATION),
      root,
    );

    const path = statePathFor(root);
    assert.ok(path.endsWith(join(".proabono", "installation.json")));

    const read = readState(root);
    assert.equal(read?.segment_ref, "ci-live");
    assert.equal(read?.steps.customer_portal?.status, "generated");
    assert.equal(read?.steps.customer_portal?.generated?.[0]?.where, "/billing");
  });

  it("answers `undefined` for a project that was never installed, rather than failing", () => {
    assert.equal(readState(project("never-installed")), undefined);
  });

  // A file that exists and does not parse is a different thing from no file at all. Starting over
  // on top of it would discard what a previous session recorded, silently.
  it("refuses to treat an unreadable file as a fresh start", () => {
    const root = project("corrupt");
    mkdirSync(join(root, ".proabono"), { recursive: true });
    writeFileSync(statePathFor(root), "{ this is not json", "utf8");

    assert.throws(() => readState(root), /not readable JSON/);
  });

  // The file is meant to be committed. This is the assertion that keeps that safe, and it has two
  // halves because a leak renamed is still a leak.
  it("refuses to write a credential, by value or by field name", () => {
    const secrets = secretsOf(TEST_CONFIGURATION);

    for (const sentinel of SENTINELS) {
      assert.throws(
        () => assertNoCredential({ steps: { a: { note: `key is ${sentinel}` } } }, secrets),
        /must hold no credential/,
        `the value ${sentinel} reached the state file`,
      );
    }

    for (const field of ["portal_secret", "apiKey", "agent_key", "authorization", "token", "password"]) {
      assert.throws(
        () => assertNoCredential({ [field]: "anything at all" }, secrets),
        /names one/,
        `a field called ${field} was accepted`,
      );
    }

    // And what it must NOT refuse: the Segment reference is recorded on purpose.
    assert.doesNotThrow(() =>
      assertNoCredential({ segment_ref: TEST_CONFIGURATION.segmentRef, stack: "php" }, secrets),
    );
  });

  it("holds no credential under either provisioning strategy, through the tools", async () => {
    for (const provisioning of ["api_precreate", "on_load"] as const) {
      const root = project(`provisioning-${provisioning}`);
      const { client } = await connect([
        { body: { TotalItems: 1, Items: [{ ReferenceOffer: "o-1", Features: [{}] }] } },
        { body: { TotalItems: 1, Items: [{ ReferenceFeature: "f-1", TypeFeature: "OnOff" }] } },
      ]);

      await client.callTool({
        name: "install_insite",
        arguments: { stack: "php", provisioning, customer_area: true, project_root: root },
      });

      const raw = readFileSync(statePathFor(root), "utf8");
      for (const sentinel of SENTINELS) {
        assert.ok(!raw.includes(sentinel), `a secret reached the state file (${provisioning})`);
      }
      assert.match(raw, /"provisioning": "/);
    }
  });

  it("is not written at all when the developer asks for no record", async () => {
    const root = project("no-record");
    const { client } = await connect([{ body: { TotalItems: 0, Items: [] } }]);

    await client.callTool({
      name: "scaffold_notification_endpoint",
      arguments: { stack: "node-express", project_root: root, record_state: false },
    });

    assert.equal(readState(root), undefined);
  });
});

// ── The orchestrator, and reading the state back ──────────────────────────────────────

describe("install_insite", () => {
  it("stops on a catalogue that cannot support an installation, and generates nothing", async () => {
    const root = project("no-catalogue");
    // Offers: one, carrying no Feature. Features: none.
    const { client } = await connect([
      { body: { TotalItems: 1, Items: [{ ReferenceOffer: "o-bare", Features: [] }] } },
      { status: 204 },
    ]);

    const answer = textOf(
      await client.callTool({
        name: "install_insite",
        arguments: { stack: "php", customer_area: true, project_root: root },
      }),
    );

    assert.match(answer, /Installation stops here/);
    assert.match(answer, /No offer carries a Feature/);
    assert.match(answer, /defines no Feature/);
    // Nothing was advanced: an installation that cannot work records no progress.
    assert.equal(readState(root), undefined);
  });

  it("names the three steps in order, and what only a human can do", async () => {
    const root = project("orchestrated");
    const { client } = await connect([
      { body: { TotalItems: 1, Items: [{ ReferenceOffer: "o-1", Features: [{}] }] } },
      { body: { TotalItems: 1, Items: [{ ReferenceFeature: "f-1", TypeFeature: "Limitation" }] } },
    ]);

    const answer = textOf(
      await client.callTool({
        name: "install_insite",
        arguments: {
          stack: "node-express",
          target_page: "/account/billing",
          customer_area: true,
          project_root: root,
        },
      }),
    );

    const order = ["install_customer_portal", "link_subscription_workflow", "sync_usage_rights"];
    let cursor = -1;
    for (const tool of order) {
      const at = answer.indexOf(tool);
      assert.ok(at > cursor, `${tool} is out of order in the plan`);
      cursor = at;
    }

    assert.match(answer, /Settings → Hosted Pages → Customer Workflows/);
    assert.match(answer, /Integration → Webhooks/);
    // Invariant 2: one installation method, whatever the stack.
    assert.match(answer, /never offers a Widget|does not install a Widget|never routes/i);
  });

  it("resumes from what a previous session left rather than starting over", async () => {
    const root = project("resume");
    writeState(
      {
        version: 1,
        steps: {
          customer_portal: { status: "done" },
          subscription_workflow: { status: "skipped", reason: "no funnel yet" },
        },
      },
      secretsOf(TEST_CONFIGURATION),
      root,
    );

    const { client } = await connect([
      { body: { TotalItems: 1, Items: [{ ReferenceOffer: "o-1", Features: [{}] }] } },
      { body: { TotalItems: 1, Items: [{ ReferenceFeature: "f-1", TypeFeature: "OnOff" }] } },
    ]);

    const answer = textOf(
      await client.callTool({
        name: "install_insite",
        arguments: { stack: "php", customer_area: true, project_root: root },
      }),
    );

    assert.match(answer, /Resuming from it/);
    assert.match(answer, /Confirmed in place: Step 1/);
    assert.match(answer, /Deliberately skipped: Step 2/);
  });

  it("states a stack hypothesis with what it was based on, and never decides alone", () => {
    const node = project("detect-node");
    writeFileSync(join(node, "package.json"), "{}", "utf8");
    assert.equal(detectStack(node).stack, "node-express");

    const next = project("detect-next");
    writeFileSync(join(next, "package.json"), "{}", "utf8");
    writeFileSync(join(next, "next.config.js"), "", "utf8");
    const detected = detectStack(next);
    // The more specific answer wins, and the ambiguity is reported rather than hidden.
    assert.equal(detected.stack, "next");
    assert.equal(detected.confident, false);
    assert.match(detected.because, /package\.json/);

    const empty = project("detect-empty");
    assert.equal(detectStack(empty).stack, "generic");
  });
});

describe("installation_status", () => {
  it("says so plainly for a project that has never been installed", async () => {
    const root = project("status-fresh");
    const { client } = await connect([{ status: 204 }]);

    const answer = textOf(
      await client.callTool({ name: "installation_status", arguments: { project_root: root } }),
    );

    assert.match(answer, /not started/i);
    assert.ok(!answer.includes("undefined"));
  });

  it("reports each step, and separates generated from done", async () => {
    const root = project("status-mixed");
    writeState(
      {
        version: 1,
        segment_ref: "ci-live",
        stack: "php",
        steps: {
          customer_portal: {
            status: "generated",
            generated: [{ what: "the embed", where: "/billing" }],
          },
          usage_rights: { status: "done" },
          notification_endpoint: {
            status: "pending",
            pending_backoffice: ["Create the webhook"],
          },
        },
      },
      secretsOf(TEST_CONFIGURATION),
      root,
    );

    const { client } = await connect([{ status: 204 }]);
    const answer = textOf(
      await client.callTool({ name: "installation_status", arguments: { project_root: root } }),
    );

    assert.match(answer, /Step 1 — Customer Portal — `generated`/);
    assert.match(answer, /Nothing has confirmed it is actually in place/);
    assert.match(answer, /Step 3 — rights and usage via the Usage API — `done`/);
    assert.match(answer, /Create the webhook/);
  });
});

// ── In-Site step 2 ────────────────────────────────────────────────────────────────────

describe("the generated Subscription Workflow", () => {
  for (const stack of STACKS) {
    it(`covers all five outcomes in ${stack}, and revokes nothing on terminate`, () => {
      const route = returnRouteSnippet(stack, "/billing/return");

      for (const outcome of ["nocharge", "paid", "pending", "registered", "due"]) {
        assert.ok(
          route.includes(outcome),
          `${stack}'s return route does not handle the ${outcome} outcome`,
        );
      }

      assert.match(route, /terminate/);
      assert.match(
        route,
        /period end/i,
        `${stack} does not say that a termination takes effect at period end`,
      );
    });

    it(`re-reads rights before branching in ${stack}`, () => {
      const route = returnRouteSnippet(stack, "/billing/return");
      const refresh = route.search(/refresh_?[Ee]ntitlements|RefreshAsync|RE-READ/);
      const branch = route.search(/destination[_ ]?[Ff]or|DestinationFor|branch/);

      assert.ok(refresh >= 0, `${stack} never refreshes the rights`);
      assert.ok(
        branch < 0 || refresh < branch,
        `${stack} branches on from x outcome before re-reading the rights`,
      );
    });

    it(`never trusts the identifiers on the way back in ${stack}`, () => {
      const route = returnRouteSnippet(stack, "/billing/return");
      assert.match(route, /idc/, `${stack} does not mention the untrusted identifiers at all`);
      // The session is what resolves the customer, and it must be visible in the code.
      assert.match(route, /session|current_user|currentUser|User\.FindFirst|req\.user|SESSION/);
    });

    it(`reads the query by rel and never fabricates a URL in ${stack}`, () => {
      const module = workflowModule(stack, "insite-subscribe", "/v1/Customer");
      assert.match(module, /insite-subscribe/);
      assert.match(module, /rel/i);
      assert.match(module, /expire/i, `${stack} does not say a query must not be persisted`);
      for (const sentinel of SENTINELS) assert.ok(!module.includes(sentinel));
    });

    // Every collection read but `/v1/Usages` carries the Segment: omitting it silently answers for
    // the Business's default one, and a ReferenceCustomer is unique per Segment.
    it(`carries the Segment on the object fetch in ${stack}`, () => {
      assert.match(
        workflowModule(stack, "insite-subscribe", "/v1/Customer"),
        /PROABONO_SEGMENT_REF|ReferenceSegment/,
        `${stack} fetches the object without a Segment`,
      );
    });
  }

  it("refuses to pretend an offer it was given exists", async () => {
    const { client } = await connect([
      { body: { TotalItems: 1, Items: [{ ReferenceOffer: "o-real", Features: [{}] }] } },
    ]);

    const answer = textOf(
      await client.callTool({
        name: "link_subscription_workflow",
        arguments: {
          stack: "node-express",
          workflow: "subscribe",
          offer_ref: "o-typo",
          record_state: false,
        },
      }),
    );

    assert.match(answer, /`o-typo` is \*\*not\*\* in this Segment's catalogue/);
    assert.match(answer, /end of a sign-up/);
  });

  it("says what the fetch must carry, or the query is simply absent", async () => {
    const { client } = await connect([
      { body: { TotalItems: 1, Items: [{ ReferenceOffer: "o-1", Features: [{}] }] } },
    ]);

    const answer = textOf(
      await client.callTool({
        name: "link_subscription_workflow",
        arguments: { stack: "python", workflow: "subscribe", record_state: false },
      }),
    );

    assert.match(answer, /ReferenceOffer/);
    assert.match(answer, /simply absent|not be there|simply not/i);
    assert.match(answer, /Settings → Hosted Pages → Customer Workflows/);
  });
});

// ── The notification endpoint ─────────────────────────────────────────────────────────

/**
 * Lifts a function out of generated source and makes it callable.
 *
 * Reading generated text with a regular expression proves what it says. Running it proves what it
 * does -- which for a signature is the only thing that matters, since a wrong operand order
 * produces a valid-looking value that ProAbono rejects every time.
 */
function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `no function ${name} in the generated module`);

  let depth = 0;
  for (let index = source.indexOf("{", start); index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`function ${name} is not balanced`);
}

describe("the generated notification endpoint", () => {
  const module = notificationEndpoint("node-express", "/webhooks/proabono");
  const KEY = "webhook-key-42";
  const SECRET = "the-webhook-secret";
  const valid = createHash("sha256").update(KEY + SECRET, "utf8").digest("base64");

  /** The generated verification, made callable with a stub request. */
  const verify = (headers: Record<string, string>): boolean => {
    const source = extractFunction(module, "isValidProAbonoWebhook");
    const factory = new Function(
      "crypto",
      "process",
      `${source}; return isValidProAbonoWebhook;`,
    ) as (crypto: unknown, process: unknown) => (request: unknown) => boolean;

    return factory(crypto, { env: { PROABONO_WEBHOOK_SECRET: SECRET } })({
      get: (name: string) => headers[name],
    });
  };

  it("accepts a signature ProAbono would actually have computed", () => {
    assert.equal(
      verify({ "x-proabono-key": KEY, "x-proabono-signature": valid }),
      true,
      "the generated verification rejects the value ProAbono computes: key + secret, sha256, base64",
    );
  });

  it("rejects a signature altered by one byte", () => {
    const tampered = `${valid.slice(0, -1)}${valid.endsWith("A") ? "B" : "A"}`;
    assert.equal(verify({ "x-proabono-key": KEY, "x-proabono-signature": tampered }), false);
  });

  it("rejects a request carrying no signature at all", () => {
    assert.equal(verify({ "x-proabono-key": KEY }), false);
    assert.equal(verify({}), false);
  });

  it("compares in constant time, in every stack that has a primitive for it", () => {
    for (const stack of STACKS) {
      const source = notificationEndpoint(stack, "/webhooks/proabono");
      assert.match(
        source,
        /timingSafeEqual|hash_equals|compare_digest|secure_compare|FixedTimeEquals|CONSTANT TIME/,
        `${stack} compares the signature with a plain equality, which leaks it byte by byte`,
      );
    }
  });

  it("deduplicates on the notification id and never on the webhook key", () => {
    for (const stack of STACKS) {
      const source = notificationEndpoint(stack, "/webhooks/proabono");
      assert.match(
        source,
        /body\.Id|body\['Id'\]|body\["Id"\]|notificationId|body's Id|NOTIFICATION id/i,
        `${stack} does not deduplicate on the notification id`,
      );
      assert.match(
        source,
        /x-proabono-key/,
        `${stack} never mentions the header it must not deduplicate on`,
      );
    }
  });

  it("answers the validation handshake apart from the event path, in every stack", () => {
    for (const stack of STACKS) {
      const source = notificationEndpoint(stack, "/webhooks/proabono");
      assert.match(
        source,
        /TypeTrigger/,
        `${stack} cannot tell the verification POST from an event`,
      );
      assert.match(source, /verification code/i, `${stack} does not log the verification code`);
    }
  });

  it("resyncs from Customer and never from CustomerBuyer, in every stack", () => {
    for (const stack of STACKS) {
      const source = notificationEndpoint(stack, "/webhooks/proabono");
      assert.match(source, /ReferenceCustomer/);
      assert.match(
        source,
        /CustomerBuyer/,
        `${stack} does not warn against resolving the user from the buyer`,
      );
    }
  });

  it("points every rights-affecting event at the endpoint, and no payment event", () => {
    // The set is the corpus's, verbatim. A payment or invoice event in it would cut off customers
    // who are about to pay successfully.
    assert.ok(RIGHTS_AFFECTING_EVENTS.includes("SubscriptionFeaturesUpdated"));
    assert.ok(RIGHTS_AFFECTING_EVENTS.includes("CustomerSuspended"));

    for (const excluded of [
      "InvoiceDebitPaid",
      "CustomerChargingFailed",
      "InvoiceDebitOverdue",
      "GatewayPermissionExpired",
      "SubscriptionRenewed",
    ]) {
      assert.ok(
        !RIGHTS_AFFECTING_EVENTS.includes(excluded),
        `${excluded} must not be on the entitlement path`,
      );
    }
  });

  it("inlines no secret, in any stack", () => {
    for (const stack of STACKS) {
      const source = notificationEndpoint(stack, "/webhooks/proabono");
      assert.match(source, /PROABONO_WEBHOOK_SECRET/);
      for (const sentinel of SENTINELS) assert.ok(!source.includes(sentinel));
    }
  });

  it("hands over the BackOffice procedure, because no API performs it", async () => {
    const { client } = await connect([{ status: 204 }]);
    const answer = textOf(
      await client.callTool({
        name: "scaffold_notification_endpoint",
        arguments: { stack: "ruby", record_state: false },
      }),
    );

    assert.match(answer, /Integration → Webhooks/);
    assert.match(answer, /Send verification code/);
    assert.match(answer, /inactive/i);
  });
});

// ── Verification ──────────────────────────────────────────────────────────────────────

describe("verify_insite_installation", () => {
  it("reports an inlined secret as a failure of checklist item 1", async () => {
    const root = project("leaky");
    writeFileSync(
      join(root, "config.js"),
      `export const portalSecret = "${TEST_CONFIGURATION.portalSecret}";\n`,
      "utf8",
    );

    const { client } = await connect([{ status: 204 }]);
    const answer = textOf(
      await client.callTool({
        name: "verify_insite_installation",
        arguments: { project_root: root },
      }),
    );

    assert.match(answer, /Checklist item 1\*\* — A configured secret appears \*\*verbatim\*\*/);
    assert.match(answer, /rotate it/);
  });

  it("reports a customer reference taken from the request", async () => {
    const root = project("request-derived");
    writeFileSync(
      join(root, "billing.js"),
      "const customerRef = req.query.customer;\n",
      "utf8",
    );

    const { client } = await connect([{ status: 204 }]);
    const answer = textOf(
      await client.callTool({
        name: "verify_insite_installation",
        arguments: { project_root: root },
      }),
    );

    assert.match(answer, /Checklist item 3\*\* — A customer reference is taken from the request/);
  });

  // A static check that cannot conclude must say so. Reporting "passes" for a rule it never saw
  // is how a developer ships an unverified installation believing it was checked.
  it("says unknown rather than passing when there is nothing to read", async () => {
    const root = project("empty-project");
    const { client } = await connect([{ status: 204 }]);

    const answer = textOf(
      await client.callTool({
        name: "verify_insite_installation",
        arguments: { project_root: root },
      }),
    );

    assert.match(answer, /\*\*unknown\*\*/);
    assert.match(answer, /No source file was read at all/);
  });

  it("does not call step 2 or 3 verified when no customer was given", async () => {
    const root = project("unverified");
    const { client } = await connect([{ status: 204 }]);

    const answer = textOf(
      await client.callTool({
        name: "verify_insite_installation",
        arguments: { project_root: root },
      }),
    );

    assert.match(answer, /\*\*Not run\.\*\*/);
    assert.match(answer, /unverified.{0,30}not passing/s);
  });

  it("diagnoses an empty Usages answer instead of reporting no rights", async () => {
    const root = project("empty-rights");
    const { client } = await connect([
      // 1. the customer, 2. its Usages (empty), 3. its subscriptions (empty)
      { body: { Id: 1, ReferenceCustomer: "cust-1", Links: [{ rel: "insite-home", href: "https://x" }] } },
      { status: 204 },
      { status: 204 },
    ]);

    const answer = textOf(
      await client.callTool({
        name: "verify_insite_installation",
        arguments: { customer_ref: "cust-1", project_root: root },
      }),
    );

    assert.match(answer, /cause 1/);
    assert.ok(!/no rights\b/i.test(answer.split("cause 1")[0] ?? ""));
  });

  it("carries the twelve go-live items, and the limits of what it checked", async () => {
    const root = project("checklist");
    const { client } = await connect([{ status: 204 }]);

    const answer = textOf(
      await client.callTool({
        name: "verify_insite_installation",
        arguments: { project_root: root },
      }),
    );

    assert.match(answer, /^12\. The portal is reachable from the customer area\./m);
    assert.match(answer, /no browser and no DOM/);
    assert.match(answer, /reported/i);
  });
});

/**
 * What a review found, pinned so it cannot come back.
 *
 * Each of these was a real defect in the first cut of this surface, and each is the kind that
 * passes a type-check and a happy-path test: a report thrown away by an error it was written to
 * report, a state file that contradicted the sentence describing it, a hypothesis recorded as a
 * decision, and a heuristic that fired on the word "Verify".
 */
describe("the defects a review found", () => {
  it("still reports the static checks when the customer does not exist", async () => {
    const root = project("customer-404");
    writeFileSync(join(root, "app.js"), "// nothing interesting\n", "utf8");

    // The API answers 404, which the client raises. Losing the whole report to it would throw
    // away everything this tool is run for.
    const { client } = await connect([{ status: 404, body: { Code: "Error.Customer.NotFound" } }]);

    const answer = textOf(
      await client.callTool({
        name: "verify_insite_installation",
        arguments: { customer_ref: "cust-nope", project_root: root },
      }),
    );

    assert.match(answer, /Steps 2 and 3 — unverified/);
    assert.match(answer, /404/);
    assert.match(answer, /Checked statically/);
    assert.match(answer, /^12\. The portal is reachable/m);
  });

  it("does not read a mention of ReferenceOffer as a branch on it", async () => {
    const root = project("mentions-offer");
    // "Verify" contains `if`; the first spelling of the check matched it and reported a failure.
    writeFileSync(
      join(root, "notes.js"),
      "// Verify with the team: nothing here may depend on ReferenceOffer.\n",
      "utf8",
    );

    const { client } = await connect([{ status: 204 }]);
    const answer = textOf(
      await client.callTool({
        name: "verify_insite_installation",
        arguments: { project_root: root },
      }),
    );

    assert.match(answer, /Checklist item 4\*\* — Nothing branches on/);
  });

  it("records the BackOffice actions its own output says are recorded", async () => {
    const root = project("pending-recorded");
    const { client } = await connect([
      { body: { TotalItems: 1, Items: [{ ReferenceOffer: "o-1", Features: [{}] }] } },
      { body: { TotalItems: 1, Items: [{ ReferenceFeature: "f-1", TypeFeature: "OnOff" }] } },
    ]);

    await client.callTool({
      name: "install_insite",
      arguments: {
        stack: "php",
        customer_area: true,
        return_route: "/billing/back",
        project_root: root,
      },
    });

    const { client: reader } = await connect([{ status: 204 }]);
    const status = textOf(
      await reader.callTool({ name: "installation_status", arguments: { project_root: root } }),
    );

    assert.match(status, /Customer Workflows/);
    assert.match(status, /\/billing\/back/);
    assert.match(status, /Send verification code/);
    assert.ok(
      !/Nothing recorded/.test(status),
      "the orchestrator said the BackOffice actions were recorded and the state file had none",
    );
  });

  it("does not record a detected stack as though the developer had confirmed it", async () => {
    const root = project("unconfirmed-stack");
    writeFileSync(join(root, "composer.json"), "{}", "utf8");

    const { client } = await connect([
      { body: { TotalItems: 1, Items: [{ ReferenceOffer: "o-1", Features: [{}] }] } },
      { body: { TotalItems: 1, Items: [{ ReferenceFeature: "f-1", TypeFeature: "OnOff" }] } },
    ]);

    // No `stack` argument: the answer states a hypothesis and asks for confirmation. Writing it
    // into a committed file as a settled choice would answer that question for the developer.
    const answer = textOf(
      await client.callTool({
        name: "install_insite",
        arguments: { customer_area: true, project_root: root },
      }),
    );

    assert.match(answer, /Hypothesis: `php`/);
    assert.equal(readState(root)?.stack, undefined);

    // Given explicitly, it is a decision and is recorded.
    const { client: confirmed } = await connect([
      { body: { TotalItems: 1, Items: [{ ReferenceOffer: "o-1", Features: [{}] }] } },
      { body: { TotalItems: 1, Items: [{ ReferenceFeature: "f-1", TypeFeature: "OnOff" }] } },
    ]);
    await confirmed.callTool({
      name: "install_insite",
      arguments: { stack: "php", customer_area: true, project_root: root },
    });
    assert.equal(readState(root)?.stack, "php");
  });

  it("detects a .NET project by its project file, and names Go rather than guessing", () => {
    const dotnet = project("detect-csharp");
    writeFileSync(join(dotnet, "Shop.csproj"), "<Project />", "utf8");
    const detected = detectStack(dotnet);
    assert.equal(detected.stack, "csharp");
    assert.match(detected.because, /Shop\.csproj/);

    // There is no Go flavour, so the generic sketch is the honest answer -- and it says why.
    const go = project("detect-go");
    writeFileSync(join(go, "go.mod"), "module x\n", "utf8");
    const golang = detectStack(go);
    assert.equal(golang.stack, "generic");
    assert.match(golang.because, /go\.mod/);
  });

  it("keeps the blank lines the orchestrator's Markdown depends on", async () => {
    const root = project("markdown");
    const { client } = await connect([
      { body: { TotalItems: 1, Items: [{ ReferenceOffer: "o-1", Features: [{}] }] } },
      { body: { TotalItems: 1, Items: [{ ReferenceFeature: "f-1", TypeFeature: "OnOff" }] } },
    ]);

    const answer = textOf(
      await client.callTool({
        name: "install_insite",
        arguments: { stack: "php", customer_area: true, project_root: root },
      }),
    );

    // Filtering empty entries out turned the paragraph after the numbered steps into a lazy
    // continuation of item 4, which renders as part of the list.
    assert.match(answer, /\n\nRun them in that order/);
    assert.match(answer, /\n\n## 6\. What only a human can do\n\n/);
  });

  it("counts the queries it reports among the insite links it reports them against", async () => {
    const root = project("query-count");
    const { client } = await connect([
      {
        body: {
          Id: 7,
          ReferenceCustomer: "cust-7",
          Links: [
            { rel: "self", href: "https://api/x" },
            { rel: "other", query: "not-an-insite-query" },
            { rel: "insite-home", href: "https://host/billing" },
            { rel: "insite-collection-offers", query: "an-insite-query" },
          ],
        },
      },
      { status: 204 },
      { status: 204 },
    ]);

    const answer = textOf(
      await client.callTool({
        name: "verify_insite_installation",
        arguments: { customer_ref: "cust-7", project_root: root },
      }),
    );

    // Two insite links, one of which carries a query. The `other` link carries one too and must
    // not be counted, or the sentence claims more queries than links.
    assert.match(answer, /2 `insite-\*` link\(s\).{0,120}1 of which carry an\s+encrypted query/s);
  });
});

// ── The generic pair ──────────────────────────────────────────────────────────────────

describe("the generic generators", () => {
  it("plans the same installation the orchestrator runs", async () => {
    const { client } = await connect([
      { body: { TotalItems: 1, Items: [{ ReferenceOffer: "o-1", Features: [{}] }] } },
      { body: { TotalItems: 1, Items: [{ ReferenceFeature: "f-1", TypeFeature: "OnOff" }] } },
    ]);

    const planned = textOf(
      await client.callTool({
        name: "plan_integration",
        arguments: { journey: "insite_installation" },
      }),
    );

    // Both render INSITE_STEPS, so the tools they name cannot diverge. This is the assertion that
    // keeps the two from becoming two answers to one question.
    for (const step of INSITE_STEPS) {
      if (step.tool === undefined) continue;
      assert.ok(planned.includes(step.tool), `the plan omits ${step.tool}`);
    }
    assert.match(planned, /generates no code/);
  });

  it("names the task-specific generator instead of quietly replacing it", async () => {
    const { client } = await connect([{ status: 204 }]);

    const answer = textOf(
      await client.callTool({
        name: "generate_integration_code",
        arguments: { task: "show the customer portal on the billing page", language: "php" },
      }),
    );

    assert.match(answer, /`install_customer_portal` covers this task/);
    assert.match(answer, /does not replace it/);
  });

  it("says so when it does not know the language, instead of guessing", async () => {
    const { client } = await connect([{ status: 204 }]);

    const answer = textOf(
      await client.callTool({
        name: "generate_integration_code",
        arguments: { task: "terminate a subscription at period end", language: "elixir" },
      }),
    );

    assert.match(answer, /not one of the languages/);
    assert.match(answer, /Termination/);
    assert.equal(resolveLanguage("elixir").recognised, false);
    assert.equal(resolveLanguage("Rails").stack, "ruby");
  });

  it("generates a client that carries the Segment, pages to the end, and inlines no secret", async () => {
    const { client } = await connect([{ status: 204 }]);

    for (const language of ["typescript", "php", "python", "ruby", "csharp"]) {
      const answer = textOf(
        await client.callTool({
          name: "generate_integration_code",
          arguments: { task: "list a customer's unpaid invoices", language },
        }),
      );

      assert.match(answer, /PROABONO_SEGMENT_REF/, `${language} drops the Segment`);
      assert.match(answer, /TotalItems/, `${language} reads one page`);
      assert.match(answer, /204/, `${language} parses an empty collection`);
      for (const sentinel of SENTINELS) {
        assert.ok(!answer.includes(sentinel), `${language} inlined a secret`);
      }
    }
  });

  it("reads the operations out of the contract rather than from memory", async () => {
    const { client } = await connect([{ status: 204 }]);

    const answer = textOf(
      await client.callTool({
        name: "generate_integration_code",
        arguments: { task: "report consumption for a metered feature", language: "python" },
      }),
    );

    // The path and its parameters come from the vendored contract, so a contract change moves
    // this answer instead of leaving it stale.
    assert.match(answer, /POST \/v1\/Usage/);
    assert.match(answer, /\| `ReferenceCustomer` \| query \|/);
  });
});
