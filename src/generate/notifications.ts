/**
 * Code generation for the ProAbono notification (webhook) endpoint.
 *
 * Everything here follows `webhooks-processing.md`, which is the source of truth for the payloads,
 * the headers and the signature -- the API Live contract carries none of them (spec section 5).
 * Six rules are carried into every stack, because each one is a way the endpoint looks like it
 * works and does not:
 *
 *  1. **Verify every request.** The signature is `base64(sha256(x-proabono-key + secret))`,
 *     compared in constant time. Without it, anyone who learns the URL can tell the application
 *     that a subscription started.
 *  2. **The signature does not cover the body.** It proves the sender knows the secret and nothing
 *     more: the value is identical on every delivery of a webhook, and a captured request can be
 *     replayed verbatim. So the payload is never treated as authenticated data, and the handler
 *     re-reads state instead of parsing it.
 *  3. **The validation handshake is not an event.** ProAbono POSTs a verification code with no
 *     `TypeTrigger`; it is detected by that absence, logged so the code can be read, answered 200,
 *     and kept out of the event path. Until it succeeds the webhook is inactive and nothing is
 *     delivered at all.
 *  4. **Deduplicate on the body's `Id`**, never on `x-proabono-key`, which is the same value on
 *     every delivery. Delivery is at-least-once and the BackOffice can replay by hand.
 *  5. **Acknowledge fast, process after.** ProAbono waits for the 200, and inline work becomes
 *     delivery latency and then retries and duplicate work.
 *  6. **One global resynchronization per affected customer**, taken from `Customer.ReferenceCustomer`
 *     -- never `CustomerBuyer`, who pays but holds no rights. No per-event state machine: delivery
 *     is unordered, some events carry no usable state, and re-reading is correct however many
 *     events were missed, duplicated or reordered.
 */
import type { Stack } from "./hosted-pages.js";

/**
 * The events that change what a customer may do, and the only ones pointed at this endpoint.
 *
 * Taken verbatim from `webhooks-processing.md`. They are a *set* on purpose: the handler asks
 * whether the event is in it and runs one function, rather than branching per event -- which takes
 * longer to write, misses the rare ones, and breaks the first time the business model changes.
 */
export const RIGHTS_AFFECTING_EVENTS: readonly string[] = [
  "CustomerSuspended",
  "CustomerEnabled",
  "SubscriptionStarted",
  "SubscriptionUpgraded",
  "SubscriptionSuspendedAgent",
  "SubscriptionRestarted",
  "SubscriptionSuspendedPaymentInfoMissing",
  "SubscriptionSuspendedPaymentDue",
  "SubscriptionTerminated",
  "SubscriptionTerminatedForUpgrade",
  "SubscriptionTerminatedAtRenewal",
  "SubscriptionHistory",
  "SubscriptionDeleted",
  "SubscriptionUpdated",
  "SubscriptionFeaturesUpdated",
  "SubscriptionDateTermUpdated",
];

/**
 * Why payment and invoice events are deliberately *not* subscribed for rights.
 *
 * Stated in the generated code as well as here, so a developer does not "fix" the endpoint by
 * subscribing to everything -- which is how customers who are about to pay successfully get cut
 * off.
 */
export const EXCLUDED_EVENTS_REASON =
  "Payment, charging and invoice events are deliberately **not** pointed at this endpoint for " +
  "rights. ProAbono retries failed payments on its own, and a failed attempt does not mean the " +
  "customer lost access -- a suspension, when it comes, arrives as its own subscription event. " +
  "Reacting to a payment failure cuts off customers who are about to pay. Subscribe to them for " +
  "accounting, dunning mail or alerting if you need to, on a path that never touches entitlements.";

/** The rules the generated endpoint carries, repeated in its comments and in the tool's output. */
export const WEBHOOK_RULES: readonly string[] = [
  "Verify the signature on every request, with a constant-time comparison: `base64(sha256(x-proabono-key + secret))`.",
  "The signature covers the header and the secret only, never the body -- so the payload is a signal that something changed, never a description of the new state.",
  "The validation handshake carries no `TypeTrigger`. Detect it by that absence, log the body so you can read the code, answer 200, and keep it off the event path.",
  "Deduplicate on the body's `Id`, never on `x-proabono-key`, which is identical on every delivery of the same webhook.",
  "Answer 200 fast and process out of band. ProAbono waits for the 200, and your processing time becomes the delivery latency.",
  "Return non-200 only when you genuinely want the delivery retried. An event you cannot interpret is acknowledged and dropped, or ProAbono redelivers it forever.",
  "Resolve your user from `Customer.ReferenceCustomer`, never from `CustomerBuyer`: the buyer pays, the customer holds the rights.",
  "Run one global resynchronization for that customer. Delivery is unordered and at-least-once, so no state machine driven by arrival order is correct.",
  "Serve the endpoint over HTTPS only. A leaked header pair is a permanent forgery capability until the secret is rotated.",
];

/** The BackOffice procedure the Live API cannot perform, and which nothing works without. */
export const BACKOFFICE_PROCEDURE: readonly string[] = [
  "Create the webhook in the ProAbono BackOffice, under *Integration → Webhooks*, pointing at the HTTPS URL of the endpoint below. The Live API cannot create it: this is a BackOffice action and it stays pending until a human performs it.",
  "Take the secret from *Integration → Webhooks → secure my webhooks* and put it in the environment as `PROABONO_WEBHOOK_SECRET`. Never in the source.",
  "Deploy the endpoint first, answering a bare 200. It must be reachable before the next step, or the verification code cannot be entered at all.",
  "Trigger *Send verification code*. ProAbono POSTs a JSON body carrying the code — with no `TypeTrigger`, which is how the endpoint tells it from an event. Read the code out of your log and type it into the BackOffice. The webhook is inactive, and delivers nothing, until this succeeds.",
  "Subscribe the rights-affecting events listed below, and only those, to this one endpoint.",
  "Check the deliveries afterwards under *Integration → Webhooks → Notifications History* — 60 days of event type, delivery time and the HTTP status your server returned, with a **Retry delivery** button. It is the first place to look when something did not happen.",
];

/** The checks a local server cannot run, handed to the developer instead of claimed. */
export const WEBHOOK_MANUAL_CHECKS: readonly string[] = [
  "POST to the endpoint with no signature header: it must answer 403, not 200.",
  "Replay a real delivery verbatim: the second one must be acknowledged with 200 and do the work once.",
  "Alter one byte of a valid signature: the request must be rejected.",
  "Change a customer's subscription in the BackOffice and confirm the application serves the new rights before the cache entry would have expired on its own.",
  "ProAbono does not deliver to a local address: expose the machine through a tunnel (ngrok or equivalent) and register the tunnel URL while developing.",
];

/** The endpoint, the verification, the deduplication and the worker, in the stack's idiom. */
export function notificationEndpoint(stack: Stack, path: string): string {
  switch (stack) {
    case "node-express":
      return nodeEndpoint(path);
    case "next":
      return nextEndpoint(path);
    case "php":
      return phpEndpoint(path);
    case "python":
      return pythonEndpoint(path);
    case "ruby":
      return rubyEndpoint(path);
    case "csharp":
      return csharpEndpoint(path);
    case "generic":
      return genericEndpoint(path);
  }
}

/** The event set, as a literal in the stack's idiom, used by the worker. */
function eventSetLines(open: string, quote: (event: string) => string, close: string): string[] {
  return [open, ...RIGHTS_AFFECTING_EVENTS.map((event) => `  ${quote(event)}`), close];
}

function nodeEndpoint(path: string): string {
  return [
    "// proabono-webhook.js -- the ProAbono notification endpoint.",
    "//",
    ...WEBHOOK_RULES.map((rule) => `// - ${rule}`),
    "",
    'import crypto from "node:crypto";',
    "",
    "// One global resync per affected customer, from the rights module of In-Site step 3.",
    'import { refreshEntitlements } from "./proabono-rights.js";',
    "",
    ...eventSetLines(
      "const RIGHTS_AFFECTING = new Set([",
      (event) => `"${event}",`,
      "]);",
    ),
    "",
    "function isValidProAbonoWebhook(req) {",
    '  const key = req.get("x-proabono-key");',
    '  const signature = req.get("x-proabono-signature");',
    "  const secret = process.env.PROABONO_WEBHOOK_SECRET;",
    "  if (!key || !signature || !secret) return false;",
    "",
    "  // key + secret, in that order, SHA-256 over the raw bytes, base64 of the digest.",
    "  const expected = crypto",
    '    .createHash("sha256")',
    '    .update(key + secret, "utf8")',
    '    .digest("base64");',
    "",
    "  // Constant-time: a plain === leaks the expected value one byte at a time.",
    '  const a = Buffer.from(signature, "utf8");',
    '  const b = Buffer.from(expected, "utf8");',
    "  return a.length === b.length && crypto.timingSafeEqual(a, b);",
    "}",
    "",
    `app.post("${path}", express.json({ limit: "256kb" }), async (req, res) => {`,
    "  // 1. Authenticate before anything else.",
    "  if (!isValidProAbonoWebhook(req)) {",
    '    logger.warn({ ip: req.ip }, "rejected unsigned ProAbono webhook");',
    "    return res.sendStatus(403); // not 200: this was not a real delivery",
    "  }",
    "",
    "  const body = req.body;",
    "",
    "  // 2. The validation handshake carries no TypeTrigger. Log it, acknowledge it, stop.",
    "  if (!body?.TypeTrigger) {",
    '    logger.info({ body }, "ProAbono webhook verification code");',
    "    return res.sendStatus(200);",
    "  }",
    "",
    "  // 3. At-least-once delivery plus manual replays: dedupe on the NOTIFICATION id.",
    "  //    x-proabono-key is the same value on every delivery and cannot distinguish two.",
    "  if (await seenNotification(body.Id)) return res.sendStatus(200);",
    '  await rememberNotification(body.Id, { ttl: "7d" });',
    "",
    "  // 4. Hand off. Anything slow or fallible belongs here, not above.",
    '  await queue.publish("proabono.event", body);',
    "",
    "  // 5. Acknowledge.",
    "  res.sendStatus(200);",
    "});",
    "",
    "// The worker -- the whole of it.",
    "export async function handleProAbonoEvent(body) {",
    "  if (!RIGHTS_AFFECTING.has(body.TypeTrigger)) return; // acknowledged, deliberately ignored",
    "",
    "  // Customer is on every event. Customer holds the rights; CustomerBuyer only pays.",
    "  const customerRef = body.Customer?.ReferenceCustomer;",
    "  if (!customerRef) return;",
    "",
    "  await refreshEntitlements(customerRef); // re-read and REPLACE; never patch from the payload",
    "}",
  ].join("\n");
}

function nextEndpoint(path: string): string {
  return [
    `// app${path}/route.js -- a Route Handler, which runs on the server. The secret never reaches`,
    "// the client bundle, and the raw body is read before anything parses it.",
    "//",
    ...WEBHOOK_RULES.map((rule) => `// - ${rule}`),
    "",
    'import crypto from "node:crypto";',
    'import { refreshEntitlements } from "@/lib/proabono-rights";',
    "",
    ...eventSetLines(
      "const RIGHTS_AFFECTING = new Set([",
      (event) => `"${event}",`,
      "]);",
    ),
    "",
    "function isValidSignature(headers) {",
    '  const key = headers.get("x-proabono-key");',
    '  const signature = headers.get("x-proabono-signature");',
    "  const secret = process.env.PROABONO_WEBHOOK_SECRET;",
    "  if (!key || !signature || !secret) return false;",
    "",
    "  const expected = crypto",
    '    .createHash("sha256")',
    '    .update(key + secret, "utf8")',
    '    .digest("base64");',
    "",
    '  const a = Buffer.from(signature, "utf8");',
    '  const b = Buffer.from(expected, "utf8");',
    "  return a.length === b.length && crypto.timingSafeEqual(a, b);",
    "}",
    "",
    "export async function POST(request) {",
    "  if (!isValidSignature(request.headers)) {",
    "    return new Response(null, { status: 403 }); // not 200: this was not a real delivery",
    "  }",
    "",
    "  const body = await request.json();",
    "",
    "  // The validation handshake carries no TypeTrigger: log the code, acknowledge, stop.",
    "  if (!body?.TypeTrigger) {",
    '    console.info("ProAbono webhook verification code", body);',
    "    return new Response(null, { status: 200 });",
    "  }",
    "",
    "  if (await seenNotification(body.Id)) return new Response(null, { status: 200 });",
    '  await rememberNotification(body.Id, { ttl: "7d" });',
    "",
    "  // Acknowledge fast; the work happens after the response, not before it.",
    '  await queue.publish("proabono.event", body);',
    "",
    "  return new Response(null, { status: 200 });",
    "}",
    "",
    "export async function handleProAbonoEvent(body) {",
    "  if (!RIGHTS_AFFECTING.has(body.TypeTrigger)) return;",
    "",
    "  // Customer, never CustomerBuyer: the buyer pays, the customer holds the rights.",
    "  const customerRef = body.Customer?.ReferenceCustomer;",
    "  if (!customerRef) return;",
    "",
    "  await refreshEntitlements(customerRef);",
    "}",
  ].join("\n");
}

function phpEndpoint(path: string): string {
  return [
    "<?php",
    `// proabono_webhook.php -- routed at ${path}.`,
    "//",
    ...WEBHOOK_RULES.map((rule) => `// - ${rule}`),
    "",
    ...eventSetLines(
      "const PROABONO_RIGHTS_AFFECTING = [",
      (event) => `'${event}',`,
      "];",
    ),
    "",
    "function proabono_webhook_is_valid(array $headers): bool",
    "{",
    "    $key = $headers['x-proabono-key'] ?? null;",
    "    $signature = $headers['x-proabono-signature'] ?? null;",
    "    $secret = getenv('PROABONO_WEBHOOK_SECRET');",
    "    if (!$key || !$signature || !$secret) { return false; }",
    "",
    "    // key . secret, in that order; raw SHA-256 bytes, then base64.",
    "    $expected = base64_encode(hash('sha256', $key . $secret, true));",
    "",
    "    // hash_equals is the constant-time comparison; == leaks the expected value.",
    "    return hash_equals($expected, $signature);",
    "}",
    "",
    "$headers = array_change_key_case(getallheaders(), CASE_LOWER);",
    "",
    "if (!proabono_webhook_is_valid($headers)) {",
    "    http_response_code(403); // not 200: this was not a real delivery",
    "    error_log('rejected unsigned ProAbono webhook');",
    "    exit;",
    "}",
    "",
    "$body = json_decode(file_get_contents('php://input'), true) ?: [];",
    "",
    "// The validation handshake carries no TypeTrigger. Log the code, acknowledge, stop.",
    "if (empty($body['TypeTrigger'])) {",
    "    error_log('ProAbono webhook verification code: ' . json_encode($body));",
    "    http_response_code(200);",
    "    exit;",
    "}",
    "",
    "// Dedupe on the NOTIFICATION id, never on x-proabono-key: that header is identical on",
    "// every delivery of this webhook and cannot tell two of them apart.",
    "if (proabono_seen_notification($body['Id'])) { http_response_code(200); exit; }",
    "proabono_remember_notification($body['Id'], 7 * 24 * 3600);",
    "",
    "// Acknowledge fast; queue the work. Anything slow or fallible belongs in the worker.",
    "proabono_enqueue('proabono.event', $body);",
    "http_response_code(200);",
    "",
    "// --- the worker -------------------------------------------------------------------",
    "",
    "function proabono_handle_event(array $body): void",
    "{",
    "    if (!in_array($body['TypeTrigger'], PROABONO_RIGHTS_AFFECTING, true)) { return; }",
    "",
    "    // Customer holds the rights; CustomerBuyer only pays.",
    "    $customerRef = $body['Customer']['ReferenceCustomer'] ?? null;",
    "    if (!$customerRef) { return; }",
    "",
    "    proabono_refresh_entitlements($customerRef); // re-read and REPLACE, never patch",
    "}",
  ].join("\n");
}

function pythonEndpoint(path: string): string {
  return [
    `# proabono_webhook.py -- routed at ${path}.`,
    "#",
    ...WEBHOOK_RULES.map((rule) => `# - ${rule}`),
    "",
    "import base64",
    "import hashlib",
    "import hmac",
    "import json",
    "import logging",
    "import os",
    "",
    "from proabono_rights import refresh_entitlements",
    "",
    ...eventSetLines(
      "RIGHTS_AFFECTING = {",
      (event) => `"${event}",`,
      "}",
    ),
    "",
    "",
    "def is_valid_proabono_webhook(headers) -> bool:",
    '    key = headers.get("x-proabono-key")',
    '    signature = headers.get("x-proabono-signature")',
    '    secret = os.environ.get("PROABONO_WEBHOOK_SECRET")',
    "    if not key or not signature or not secret:",
    "        return False",
    "",
    "    # key + secret, in that order; raw SHA-256 digest, then base64.",
    '    digest = hashlib.sha256((key + secret).encode("utf-8")).digest()',
    '    expected = base64.b64encode(digest).decode("ascii")',
    "",
    "    # compare_digest is the constant-time comparison; == leaks the expected value.",
    "    return hmac.compare_digest(expected, signature)",
    "",
    "",
    `@app.route("${path}", methods=["POST"])`,
    "def proabono_webhook():",
    "    # 1. Authenticate before anything else.",
    "    if not is_valid_proabono_webhook(request.headers):",
    '        logging.warning("rejected unsigned ProAbono webhook")',
    '        return "", 403  # not 200: this was not a real delivery',
    "",
    "    body = request.get_json(silent=True) or {}",
    "",
    "    # 2. The validation handshake carries no TypeTrigger. Log the code, acknowledge, stop.",
    '    if not body.get("TypeTrigger"):',
    '        logging.info("ProAbono webhook verification code: %s", json.dumps(body))',
    '        return "", 200',
    "",
    "    # 3. Dedupe on the NOTIFICATION id: x-proabono-key is identical on every delivery.",
    '    if seen_notification(body["Id"]):',
    '        return "", 200',
    '    remember_notification(body["Id"], ttl_seconds=7 * 24 * 3600)',
    "",
    "    # 4. Hand off, then acknowledge. Nothing slow runs before the response.",
    '    enqueue("proabono.event", body)',
    '    return "", 200',
    "",
    "",
    "def handle_proabono_event(body: dict) -> None:",
    '    if body.get("TypeTrigger") not in RIGHTS_AFFECTING:',
    "        return  # acknowledged, deliberately ignored",
    "",
    "    # Customer holds the rights; CustomerBuyer only pays.",
    '    customer_ref = (body.get("Customer") or {}).get("ReferenceCustomer")',
    "    if not customer_ref:",
    "        return",
    "",
    "    refresh_entitlements(customer_ref)  # re-read and REPLACE, never patch from the payload",
    "",
  ].join("\n");
}

function rubyEndpoint(path: string): string {
  return [
    `# proabono_webhook.rb -- routed at ${path}.`,
    "#",
    ...WEBHOOK_RULES.map((rule) => `# - ${rule}`),
    "",
    "require 'base64'",
    "require 'openssl'",
    "",
    ...eventSetLines(
      "PROABONO_RIGHTS_AFFECTING = [",
      (event) => `'${event}',`,
      "].freeze",
    ),
    "",
    "class ProAbonoWebhooksController < ApplicationController",
    "  # ProAbono signs a header, not a form: there is no CSRF token on this request.",
    "  skip_before_action :verify_authenticity_token",
    "",
    "  def create",
    "    # 1. Authenticate before anything else.",
    "    return head(:forbidden) unless valid_signature? # not 200: this was not a real delivery",
    "",
    "    body = JSON.parse(request.raw_post) rescue {}",
    "",
    "    # 2. The validation handshake carries no TypeTrigger. Log the code, acknowledge, stop.",
    "    if body['TypeTrigger'].to_s.empty?",
    "      Rails.logger.info(\"ProAbono webhook verification code: #{body.to_json}\")",
    "      return head(:ok)",
    "    end",
    "",
    "    # 3. Dedupe on the NOTIFICATION id: x-proabono-key is identical on every delivery.",
    "    return head(:ok) if seen_notification?(body['Id'])",
    "    remember_notification(body['Id'], ttl: 7.days)",
    "",
    "    # 4. Hand off, then acknowledge. Nothing slow runs before the response.",
    "    ProAbonoEventJob.perform_later(body)",
    "    head :ok",
    "  end",
    "",
    "  private",
    "",
    "  def valid_signature?",
    "    key = request.headers['x-proabono-key']",
    "    signature = request.headers['x-proabono-signature']",
    "    secret = ENV['PROABONO_WEBHOOK_SECRET']",
    "    return false if key.blank? || signature.blank? || secret.blank?",
    "",
    "    # key + secret, in that order; raw SHA-256 digest, then base64.",
    "    expected = Base64.strict_encode64(OpenSSL::Digest::SHA256.digest(key + secret))",
    "",
    "    # secure_compare is the constant-time comparison; == leaks the expected value.",
    "    ActiveSupport::SecurityUtils.secure_compare(expected, signature)",
    "  end",
    "end",
    "",
    "# --- the worker ---------------------------------------------------------------------",
    "",
    "class ProAbonoEventJob < ApplicationJob",
    "  def perform(body)",
    "    return unless PROABONO_RIGHTS_AFFECTING.include?(body['TypeTrigger'])",
    "",
    "    # Customer holds the rights; CustomerBuyer only pays.",
    "    customer_ref = body.dig('Customer', 'ReferenceCustomer')",
    "    return if customer_ref.blank?",
    "",
    "    refresh_entitlements(customer_ref) # re-read and REPLACE, never patch from the payload",
    "  end",
    "end",
  ].join("\n");
}

function csharpEndpoint(path: string): string {
  return [
    `// ProAbonoWebhookController.cs -- routed at ${path}.`,
    "//",
    ...WEBHOOK_RULES.map((rule) => `// - ${rule}`),
    "",
    "using System.Security.Cryptography;",
    "using System.Text;",
    "using System.Text.Json;",
    "",
    ...eventSetLines(
      "private static readonly HashSet<string> RightsAffecting = new()",
      (event) => `"${event}",`,
      "};",
    ).map((line, index) => (index === 1 ? "{\n" + line : line)),
    "",
    "[ApiController]",
    `[Route("${path.replace(/^\//, "")}")]`,
    "public class ProAbonoWebhookController : ControllerBase",
    "{",
    "    [HttpPost]",
    "    public async Task<IActionResult> Post()",
    "    {",
    "        // 1. Authenticate before anything else.",
    "        if (!IsValidSignature(Request.Headers))",
    "        {",
    '            _logger.LogWarning("rejected unsigned ProAbono webhook");',
    "            return StatusCode(403); // not 200: this was not a real delivery",
    "        }",
    "",
    "        using var reader = new StreamReader(Request.Body);",
    "        var raw = await reader.ReadToEndAsync();",
    "        var body = JsonSerializer.Deserialize<JsonElement>(raw);",
    "",
    "        // 2. The validation handshake carries no TypeTrigger. Log the code, acknowledge, stop.",
    '        if (!body.TryGetProperty("TypeTrigger", out var trigger) || trigger.GetString() is null)',
    "        {",
    '            _logger.LogInformation("ProAbono webhook verification code: {Body}", raw);',
    "            return Ok();",
    "        }",
    "",
    "        // 3. Dedupe on the NOTIFICATION id: x-proabono-key is identical on every delivery.",
    '        var notificationId = body.GetProperty("Id").GetString()!;',
    "        if (await _seen.ContainsAsync(notificationId)) return Ok();",
    "        await _seen.RememberAsync(notificationId, TimeSpan.FromDays(7));",
    "",
    "        // 4. Hand off, then acknowledge. Nothing slow runs before the response.",
    '        await _queue.PublishAsync("proabono.event", raw);',
    "        return Ok();",
    "    }",
    "",
    "    private bool IsValidSignature(IHeaderDictionary headers)",
    "    {",
    '        var key = headers["x-proabono-key"].ToString();',
    '        var signature = headers["x-proabono-signature"].ToString();',
    '        var secret = Environment.GetEnvironmentVariable("PROABONO_WEBHOOK_SECRET");',
    "        if (string.IsNullOrEmpty(key) || string.IsNullOrEmpty(signature) || string.IsNullOrEmpty(secret))",
    "            return false;",
    "",
    "        // key + secret, in that order; raw SHA-256 digest, then base64.",
    "        var digest = SHA256.HashData(Encoding.UTF8.GetBytes(key + secret));",
    "        var expected = Convert.ToBase64String(digest);",
    "",
    "        // Fixed-time comparison; == on strings leaks the expected value one byte at a time.",
    "        return CryptographicOperations.FixedTimeEquals(",
    "            Encoding.UTF8.GetBytes(expected),",
    "            Encoding.UTF8.GetBytes(signature));",
    "    }",
    "}",
    "",
    "// --- the worker ---------------------------------------------------------------------",
    "",
    "public async Task HandleProAbonoEventAsync(JsonElement body)",
    "{",
    '    var trigger = body.GetProperty("TypeTrigger").GetString();',
    "    if (trigger is null || !RightsAffecting.Contains(trigger)) return;",
    "",
    "    // Customer holds the rights; CustomerBuyer only pays.",
    '    if (!body.TryGetProperty("Customer", out var customer)) return;',
    '    var customerRef = customer.GetProperty("ReferenceCustomer").GetString();',
    "    if (string.IsNullOrEmpty(customerRef)) return;",
    "",
    "    await _rights.RefreshAsync(customerRef); // re-read and REPLACE, never patch from the payload",
    "}",
  ].join("\n");
}

function genericEndpoint(path: string): string {
  return [
    `# The ProAbono notification endpoint at ${path}, in whatever language the project uses.`,
    "#",
    "# 1. SIGNATURE. Read x-proabono-key and x-proabono-signature. Compute",
    "#    base64(sha256(key + secret)) -- key first, raw digest bytes, then base64 -- with the",
    "#    secret from PROABONO_WEBHOOK_SECRET, never from source. Compare in CONSTANT TIME. Answer",
    "#    403 and stop when it does not match: a 200 there would tell a stranger their forged event",
    "#    was accepted.",
    "#",
    "#    What this proves and what it does not: it proves the sender knows the secret. It does NOT",
    "#    cover the request body, and the value is the SAME on every delivery of that webhook --",
    "#    closer to a bearer token than to a per-message signature. So a captured request can be",
    "#    replayed verbatim, and the payload is never authenticated data.",
    "#",
    "# 2. VALIDATION HANDSHAKE. A POST with no TypeTrigger is ProAbono's verification code, not an",
    "#    event. Log the body so the code can be read, answer 200, and go no further. Until that",
    "#    code is entered in the BackOffice the webhook is inactive and nothing is ever delivered.",
    "#",
    "# 3. DEDUPLICATION. Store the body's Id for a few days and drop a delivery already seen.",
    "#    Deduplicate on that Id, never on x-proabono-key. Delivery is at-least-once and the",
    "#    BackOffice can replay by hand.",
    "#",
    "# 4. ACKNOWLEDGE FAST. Enqueue the body and return 200. Work done before the response becomes",
    "#    the delivery latency, and a slow dependency turns into retries and duplicate work.",
    "#    Return non-200 only when you genuinely want a retry.",
    "#",
    "# 5. THE WORKER. If TypeTrigger is not in the rights-affecting set, return -- acknowledged and",
    "#    deliberately ignored. Otherwise take Customer.ReferenceCustomer (NEVER CustomerBuyer, who",
    "#    pays but holds no rights) and run ONE global resynchronization: re-read that customer's",
    "#    Usages and REPLACE the cache. No per-event branching: delivery is unordered, some events",
    "#    carry no usable state at all, and re-reading is correct however many were missed,",
    "#    duplicated or reordered.",
    "#",
    "# The rights-affecting set:",
    ...RIGHTS_AFFECTING_EVENTS.map((event) => `#   ${event}`),
  ].join("\n");
}
