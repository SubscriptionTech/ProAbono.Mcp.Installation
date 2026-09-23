/**
 * Golden rules on the code this server hands a developer.
 *
 * Each of these is a way the hosted-page integration breaks silently -- a hash computed in the
 * browser, a customer reference taken from the request, a secret inlined in a snippet. They are
 * asserted on every stack, so a new stack cannot be added without meeting them.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  STACKS,
  hashSnippet,
  renderSnippet,
  templateSnippet,
} from "../src/generate/hosted-pages.js";
import {
  EMPTY_RESPONSE_CAUSES,
  MAX_TTL_SECONDS,
  MISSING_RESYNC,
  gateSnippet,
  rightsModule,
} from "../src/generate/usage-rights.js";
import { PORTAL_SECRET_SENTINEL, SENTINELS } from "./support.js";

/** Ways a snippet could read the customer reference from something the visitor controls. */
const REQUEST_DERIVED = [
  "req.query",
  "req.body",
  "req.params",
  "$_GET",
  "$_POST",
  "request.args",
  "searchParams.get",
  "params[",
];

describe("generated hosted-page code", () => {
  for (const stack of STACKS) {
    describe(stack, () => {
      it("reads the portal secret from configuration, never inlined", () => {
        const snippet = hashSnippet(stack);
        assert.ok(snippet.includes("PROABONO_PORTAL_SECRET"));
        assert.ok(!snippet.includes(PORTAL_SECRET_SENTINEL));
      });

      it("computes an HMAC-SHA256", () => {
        assert.match(hashSnippet(stack).toLowerCase(), /sha256|hmac/);
      });

      it("never derives the customer reference from the request", () => {
        const snippet = renderSnippet(stack, "/account/billing");
        for (const pattern of REQUEST_DERIVED) {
          assert.ok(!snippet.includes(pattern), `${stack} reads the reference from ${pattern}`);
        }
      });

      it("reads the business identifier and Segment from configuration", () => {
        const snippet = renderSnippet(stack, "/account/billing");
        assert.ok(snippet.includes("PROABONO_BUSINESS_ID"));
        assert.ok(snippet.includes("PROABONO_SEGMENT_REF"));
      });
    });
  }

  // hash_hmac is the one API in this set that takes the message before the key. Swapping them
  // produces a valid-looking hash that ProAbono always rejects.
  it("passes the message before the key in PHP, and only in PHP", () => {
    assert.match(hashSnippet("php"), /hash_hmac\('sha256', \$customerRef, getenv\('PROABONO_PORTAL_SECRET'\)\)/);
  });

  // Convert.ToHexString returns uppercase; the comparison is case-sensitive.
  it("emits lowercase hex in C#", () => {
    const snippet = hashSnippet("csharp");
    assert.ok(snippet.includes("ToLowerInvariant"));
    assert.ok(!snippet.includes("Convert.FromHexString"));
  });

  it("puts the identified template's customer reference and hash in place", () => {
    const template = templateSnippet({ identified: true });
    assert.ok(template.includes("customer_ref"));
    assert.ok(template.includes("hash"));
    assert.ok(template.includes('<script src="https://portal.proabono.com/Get/portal.js"></script>'));
    assert.ok(template.includes('<div id="proabono_portal">'));
  });

  it("gives the anonymous table neither a customer reference nor a hash", () => {
    const template = templateSnippet({ identified: false });
    assert.ok(!template.includes("customer_ref"));
    assert.ok(!template.includes("hash"));
  });

  it("never computes a hash in the browser", () => {
    for (const identified of [true, false]) {
      const template = templateSnippet({ identified });
      assert.ok(!/createHmac|hash_hmac|HMACSHA256/.test(template));
      assert.ok(!template.includes("PROABONO_PORTAL_SECRET"));
    }
  });

  it("passes the language only when asked for it", () => {
    assert.ok(!templateSnippet({ identified: true }).includes("customer_lang"));
    assert.ok(templateSnippet({ identified: true, passLanguage: true }).includes("customer_lang"));
  });
});

/**
 * Whether a generated module ever *reads* a field, as opposed to naming it in prose.
 *
 * The rules below forbid reading `IsIncluded` and branching on `ReferenceOffer` -- and every
 * generated module names both, in the comments and docstrings warning against them. Stripping
 * comments is not enough (a Python docstring is neither), and matching the bare name would fail on
 * the warning itself. What is actually forbidden is the access, so that is what is matched: the
 * field name behind a dot, or inside quotes. Every stack here reads a field one of those two ways,
 * and the prose names fields bare -- which the test below pins, so this cannot quietly stop biting.
 */
function reads(module: string, field: string): boolean {
  return new RegExp(`(\\.|['"])${field}\\b`).test(module);
}

/**
 * Golden rules on the rights-synchronization code (In-Site step 3).
 *
 * Every one of these is a way the gating is wrong while looking right: a page of rights taken for
 * the whole set, an unlimited quantity read as zero, a cache merged instead of replaced, a failed
 * read turned into "no rights". None of them raises an error anywhere.
 */
describe("generated rights-synchronization code", () => {
  for (const stack of STACKS) {
    describe(stack, () => {
      const module = rightsModule(stack);

      it("reads every credential from configuration, never inlined", () => {
        assert.ok(module.includes("PROABONO_API_BASE"));
        assert.ok(module.includes("PROABONO_AGENT_KEY") && module.includes("PROABONO_API_KEY"));
        for (const sentinel of SENTINELS) assert.ok(!module.includes(sentinel));
      });

      // `/v1/Usages` is the one collection the contract declares no `ReferenceSegment` on, and the
      // server sends none there either. Generated code that sent one would be passing a parameter
      // the contract does not carry, on the strength of what the other collections do.
      it("sends no Segment on /v1/Usages, which the contract does not declare one for", () => {
        assert.ok(
          !module.includes("PROABONO_SEGMENT_REF"),
          `${stack} passes a Segment the contract does not declare on this operation`,
        );
      });

      it("reads the collection to TotalItems, not one page", () => {
        assert.ok(module.includes("TotalItems"), `${stack} does not mention TotalItems`);
      });

      it("enforces IsEnabled and not IsIncluded", () => {
        assert.ok(module.includes("IsEnabled"));
        assert.ok(
          !reads(module, "IsIncluded"),
          `${stack} reads IsIncluded; an OnOff Feature included in the offer can still be off`,
        );
      });

      it("treats an absent quantity as unlimited and says so", () => {
        assert.match(module, /UNLIMITED|unlimited/);
        assert.ok(module.includes("QuantityCurrent"));
      });

      it("replaces the cache wholesale rather than merging it", () => {
        assert.match(module, /replace/i, `${stack} does not say the cache is replaced`);
        assert.ok(!/\bmerge\(/.test(module), `${stack} merges into the previous entry`);
      });

      it("bounds a cached entry by the earliest DatePeriodEnd and a ceiling", () => {
        assert.ok(module.includes("DatePeriodEnd"));
        assert.ok(
          module.includes(String(MAX_TTL_SECONDS)),
          `${stack} does not carry the ${MAX_TTL_SECONDS}s ceiling`,
        );
      });

      it("serves the last known good cache on a failed read", () => {
        assert.match(module, /last known good/);
      });

      it("never branches on the offer reference", () => {
        assert.ok(
          !reads(module, "ReferenceOffer"),
          `${stack} reads the offer reference; rights come from the Usage API`,
        );
        assert.ok(!reads(gateSnippet(stack), "ReferenceOffer"));
      });

      it("quotes a billable change and confirms it with the end customer", () => {
        const gate = gateSnippet(stack);
        assert.match(gate, /quote/i);
        assert.match(gate, /END CUSTOMER|end customer/);
      });

      it("invalidates the customer's entry after a write", () => {
        assert.match(gateSnippet(stack), /[Ii]nvalidate/);
      });

      // Without this, the two assertions above are vacuous for any stack whose idiom `reads` does
      // not recognise: they would pass on a module that does read the forbidden field. Every
      // module legitimately reads QuantityCurrent, so the check must see it in every idiom.
      it("is checked by an access test that can actually see a field read", () => {
        assert.ok(
          stack === "generic" || reads(module, "QuantityCurrent"),
          `the access check cannot see a field read in ${stack}'s idiom, so the IsIncluded and ` +
            `ReferenceOffer rules are not being enforced for it`,
        );
      });
    });
  }

  it("states the three causes of an empty Usages response", () => {
    assert.equal(EMPTY_RESPONSE_CAUSES.length, 3);
    assert.match(EMPTY_RESPONSE_CAUSES[2]!.meaning, /BackOffice/);
  });

  it("says the resynchronization wiring does not ship", () => {
    assert.match(MISSING_RESYNC, /not.{0,4}\*{0,2} generated by this version/i);
    assert.match(MISSING_RESYNC, /ReferenceCustomer/);
    assert.match(MISSING_RESYNC, /CustomerBuyer/);
  });
});
