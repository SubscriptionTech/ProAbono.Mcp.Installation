/**
 * Code generation for In-Site Step 2 -- the Subscription Workflow round trip.
 *
 * A workflow is a hosted ProAbono form that changes something: subscribe, change plan, restart,
 * register a payment method, pay an invoice. The application never builds those forms. It decides
 * **which one opens, for whom, and what happens when the customer comes back** -- which is exactly
 * the three pieces generated here: the query, the two ways of opening it, and the one return route.
 *
 * Everything follows `subscription-workflows.md`; the contract carries the `Links` array but says
 * nothing about what the queries mean. Five rules are carried into every stack, because each is a
 * way the round trip is wrong without failing:
 *
 *  1. **A query is read from `Links` by its `rel`, never fabricated.** It is encrypted server-side
 *     and appears *only when the object's state and the fetch's parameters make that workflow
 *     applicable* -- so its absence is an answer about the account, not an error to route around.
 *  2. **The parameters the workflow needs are passed on the fetch.** Ask for a Customer without
 *     naming an offer and the `insite-subscribe` query is simply not in the response.
 *  3. **A query is never persisted.** They expire; a stored one opens nothing, later.
 *  4. **`idc`, `refo` and `idsub` on the way back are untrusted.** They come from the browser. The
 *     return route acts on the session's user and on nothing else.
 *  5. **The return route re-reads rights first, and branches afterwards.** The redirect says that
 *     something changed, not what the customer may now do -- only the Usage API knows that. And
 *     `terminate` is not an immediate loss of access: it takes effect at period end and can still
 *     be cancelled, so nothing is revoked there.
 */
import type { Stack } from "./hosted-pages.js";

/** The objects a query can be read from, and what each `rel` opens. Straight from the corpus. */
export interface QueryEntry {
  readonly object: "Customer" | "Subscription" | "Offer" | "Invoice";
  readonly rel: string;
  readonly opens: string;
  readonly useWhen: string;
  /** What the fetch must carry for the query to be in the response at all. */
  readonly fetchWith: string;
}

export const QUERY_CATALOGUE: readonly QueryEntry[] = [
  {
    object: "Customer",
    rel: "insite-collection-offers",
    opens: "The catalogue, so the customer can subscribe.",
    useWhen: "Post sign-up, or when adding a second subscription.",
    fetchWith: "ReferenceCustomer",
  },
  {
    object: "Customer",
    rel: "insite-subscribe",
    opens: "The subscription workflow on one named plan.",
    useWhen: "You already know which plan they chose.",
    fetchWith: "ReferenceCustomer + ReferenceOffer",
  },
  {
    object: "Customer",
    rel: "insite-collection-upgrade",
    opens: "The catalogue, to change the current plan.",
    useWhen: "The customer wants to upgrade and has not picked a plan yet.",
    fetchWith: "ReferenceCustomer",
  },
  {
    object: "Customer",
    rel: "insite-register",
    opens: "A form collecting contact details and a payment method.",
    useWhen: "You need a verified payment method before billing later.",
    fetchWith: "ReferenceCustomer",
  },
  {
    object: "Subscription",
    rel: "insite-subscribe",
    opens: "Subscription to a draft or custom subscription.",
    useWhen: "Sales prepared a custom subscription for this customer.",
    fetchWith: "ReferenceCustomer (then the subscription's own IdSubscription)",
  },
  {
    object: "Subscription",
    rel: "insite-upgrade",
    opens: "Change of plan for that subscription.",
    useWhen: "Driving one specific upgrade.",
    fetchWith: "ReferenceCustomer + ReferenceOffer for a named target",
  },
  {
    object: "Subscription",
    rel: "insite-restart",
    opens: "Restart of a suspended subscription.",
    useWhen: "Win-back after an interruption.",
    fetchWith: "ReferenceCustomer",
  },
  {
    object: "Invoice",
    rel: "insite-charge",
    opens: "Payment of a due invoice.",
    useWhen: "Chasing one unpaid invoice.",
    fetchWith: "the invoice's own identifier or full number",
  },
  {
    object: "Offer",
    rel: "insite-subscribe",
    opens: "Subscription to that plan, for a customer you passed.",
    useWhen: "Private-plan links.",
    fetchWith: "ReferenceOffer + ReferenceCustomer",
  },
];

/**
 * What the portal owns and no query reaches.
 *
 * Asked for a dedicated in-app button for one of these, the answer is to open the Customer Portal,
 * not to look for a query that does not exist.
 */
export const PORTAL_ONLY_ACTIONS: readonly string[] = [
  "Change options — the updatable options of a subscription.",
  "Terminate a subscription — unless termination fees apply, it is not a workflow at all.",
  "Change or remove the registered payment method.",
];

/** The five outcomes, all of them handled, not only the ones the merchant has today. */
export const OUTCOMES: readonly { value: string; means: string }[] = [
  { value: "nocharge", means: "Nothing was charged — a free operation, or payment due later." },
  { value: "paid", means: "A payment completed." },
  { value: "pending", means: "A payment is processing. It is not a failure, and not a success yet." },
  { value: "registered", means: "A payment method was registered; no payment was taken." },
  { value: "due", means: "Payment is expected from a customer who pays offline." },
];

/** The workflows a redirect can come back from. `portal` is not a workflow at all. */
export const FROM_VALUES: readonly { value: string; means: string }[] = [
  { value: "subscribe", means: "The customer subscribed." },
  { value: "upgrade", means: "The customer changed plan." },
  { value: "restart", means: "The customer restarted a suspended subscription." },
  { value: "options", means: "The customer changed the options of a subscription." },
  {
    value: "terminate",
    means:
      "The customer terminated a subscription — **effective at the end of the billing period, and " +
      "cancellable until then**. Revoke nothing here.",
  },
  { value: "permission", means: "The customer changed their registered payment method." },
  { value: "invoice", means: "The customer paid a due invoice." },
  { value: "portal", means: "Not a workflow: the redirect came out of the Customer Portal." },
];

/** The rules the generated code carries, repeated in the tool's output. */
export const WORKFLOW_RULES: readonly string[] = [
  "Read a query out of `Links` by its `rel`, and handle its absence. A query appears only when the object's state and your fetch parameters make that workflow applicable — never fabricate a URL.",
  "Pass the parameters the workflow needs **on the fetch**. Ask for a Customer without naming an offer and the `insite-subscribe` query is simply not in the response.",
  "Never store a query. They expire, and a stored one opens nothing later.",
  "Never trust `idc`, `refo` or `idsub` from the query string: they are browser-supplied. Act on the session's user.",
  "Re-read the session user's rights **before** branching. The redirect says something changed, not what the customer may now do.",
  "`terminate` is not an immediate loss of access — it takes effect at period end and can still be cancelled. Revoke nothing there; the Usage API already reflects the truth.",
  "Handle all five outcomes, including the ones this merchant has no case for today. The day a free plan or an offline payment appears, an integration that already covers `nocharge` and `due` keeps working.",
  "The customer reference passed to a hosted page comes from the session, with the security hash computed server-side — the same rule as In-Site step 1.",
];

/** The BackOffice action the MCP cannot perform, and without which nothing comes back. */
export function backOfficeRedirect(returnRoute: string): string {
  return (
    `Paste the return route's absolute URL — \`https://<your-host>${returnRoute}\` — under ` +
    `*Settings → Hosted Pages → Customer Workflows* in the ProAbono BackOffice. The Live API cannot ` +
    `set it, so it stays a pending prerequisite until a human does it. Until it is set, workflows ` +
    `still complete and the customer simply never comes back to the application — which looks like ` +
    `a dead end at the exact moment they have paid.`
  );
}

/** The checks a local server cannot run for want of a browser. */
export const WORKFLOW_MANUAL_CHECKS: readonly string[] = [
  "Open the workflow from the application and complete it: the browser must land on the return route.",
  "Tamper with `idc` in the return URL: the route must refresh the session user's rights, not the tampered one's.",
  "Complete a termination and confirm access is still granted until the period end.",
  "Open a `?pa_query=` link in an email client: it must open the same workflow.",
];

/**
 * The server-side module: fetch the object, read the query by `rel`, and build the e-mail link.
 *
 * One module per stack rather than a sketch, because the two mistakes it exists to prevent -- a
 * fabricated URL and a fetch that omits the parameter the workflow needs -- are both invisible in
 * a translated sketch.
 */
export function workflowModule(stack: Stack, rel: string, objectPath: string): string {
  switch (stack) {
    case "node-express":
    case "next":
      return nodeWorkflowModule(rel, objectPath);
    case "php":
      return phpWorkflowModule(rel, objectPath);
    case "python":
      return pythonWorkflowModule(rel, objectPath);
    case "ruby":
      return rubyWorkflowModule(rel, objectPath);
    case "csharp":
      return csharpWorkflowModule(rel, objectPath);
    case "generic":
      return genericWorkflowModule(rel, objectPath);
  }
}

/** The single return route: rights first, then the destination, for every `from` × `outcome`. */
export function returnRouteSnippet(stack: Stack, returnRoute: string): string {
  switch (stack) {
    case "node-express":
      return nodeReturnRoute(returnRoute);
    case "next":
      return nextReturnRoute(returnRoute);
    case "php":
      return phpReturnRoute(returnRoute);
    case "python":
      return pythonReturnRoute(returnRoute);
    case "ruby":
      return rubyReturnRoute(returnRoute);
    case "csharp":
      return csharpReturnRoute(returnRoute);
    case "generic":
      return genericReturnRoute(returnRoute);
  }
}

// ── The server-side query read ────────────────────────────────────────────────────────

function nodeWorkflowModule(rel: string, objectPath: string): string {
  return [
    "// proabono-workflow.js -- read an encrypted workflow query, and build the e-mail link.",
    "//",
    "// The query is produced server-side by ProAbono and is only present when the object's state",
    "// and THESE fetch parameters make the workflow applicable. Its absence is an answer.",
    "",
    "const AUTHORIZATION =",
    '  "Basic " +',
    "  Buffer.from(",
    "    `${process.env.PROABONO_AGENT_KEY}:${process.env.PROABONO_API_KEY}`,",
    '    "utf8",',
    '  ).toString("base64");',
    "",
    "async function fetchProAbonoObject(params) {",
    `  const url = new URL(\`\${process.env.PROABONO_API_BASE}${objectPath}\`);`,
    "  // The Segment is always passed: omitted, ProAbono answers for the Business's DEFAULT one,",
    "  // silently and with no error -- and a ReferenceCustomer is unique per Segment.",
    '  url.searchParams.set("ReferenceSegment", process.env.PROABONO_SEGMENT_REF);',
    "  for (const [name, value] of Object.entries(params)) {",
    "    if (value !== undefined) url.searchParams.set(name, String(value));",
    "  }",
    "",
    "  const response = await fetch(url, {",
    '    headers: { Authorization: AUTHORIZATION, Accept: "application/json" },',
    "  });",
    "  if (!response.ok) throw new Error(`ProAbono fetch ${response.status}`);",
    "  if (response.status === 204) return undefined; // nothing there, not a malformed answer",
    "",
    "  return response.json();",
    "}",
    "",
    "// Look a link up BY REL. Never build one: the href carries an encrypted query and cannot be",
    "// assembled, and a query that is absent means the workflow does not apply right now.",
    "function linkByRel(object, rel) {",
    "  return (object?.Links ?? []).find((link) => link.rel === rel);",
    "}",
    "",
    "export async function openWorkflowQuery(params) {",
    "  const object = await fetchProAbonoObject(params);",
    `  const link = linkByRel(object, "${rel}");`,
    "",
    "  if (!link?.query) {",
    "    // Not an error: this workflow does not apply to this object in this state. Check the",
    "    // parameters passed on the fetch above before looking anywhere else.",
    "    return undefined;",
    "  }",
    "",
    "  // NEVER persist this. Queries expire; a stored one opens nothing later.",
    "  return link.query;",
    "}",
    "",
    "// The e-mail / plain-link method: the installation URL comes from the object's insite-home",
    "// link, configured under Settings -> Hosted Pages. Appending pa_query opens the workflow.",
    "export async function workflowEmailLink(params) {",
    "  const object = await fetchProAbonoObject(params);",
    `  const query = linkByRel(object, "${rel}")?.query;`,
    '  const home = linkByRel(object, "insite-home")?.href;',
    "  if (!query || !home) return undefined;",
    "",
    "  const url = new URL(home);",
    '  url.searchParams.set("pa_query", query);',
    "  return url.toString();",
    "}",
  ].join("\n");
}

function phpWorkflowModule(rel: string, objectPath: string): string {
  return [
    "<?php",
    "// proabono_workflow.php -- read an encrypted workflow query, and build the e-mail link.",
    "",
    "function proabono_fetch_object(array $params): ?array",
    "{",
    "    // The Segment is always passed: omitted, ProAbono answers for the DEFAULT Segment,",
    "    // silently -- and a ReferenceCustomer is unique per Segment.",
    "    $params['ReferenceSegment'] = getenv('PROABONO_SEGMENT_REF');",
    `    $url = getenv('PROABONO_API_BASE') . '${objectPath}?' . http_build_query($params);`,
    "",
    "    $context = stream_context_create(['http' => [",
    "        'header' => 'Authorization: Basic ' . base64_encode(",
    "            getenv('PROABONO_AGENT_KEY') . ':' . getenv('PROABONO_API_KEY')",
    "        ) . \"\\r\\nAccept: application/json\\r\\n\",",
    "    ]]);",
    "",
    "    $raw = file_get_contents($url, false, $context);",
    "    if ($raw === false) { throw new RuntimeException('ProAbono fetch failed'); }",
    "    if ($raw === '') { return null; } // 204 No Content: nothing there",
    "",
    "    return json_decode($raw, true);",
    "}",
    "",
    "// Look a link up BY REL. Never build one: the href carries an encrypted query.",
    "function proabono_link_by_rel(?array $object, string $rel): ?array",
    "{",
    "    foreach ($object['Links'] ?? [] as $link) {",
    "        if (($link['rel'] ?? null) === $rel) { return $link; }",
    "    }",
    "    return null;",
    "}",
    "",
    "function proabono_workflow_query(array $params): ?string",
    "{",
    "    $object = proabono_fetch_object($params);",
    `    $link = proabono_link_by_rel($object, '${rel}');`,
    "",
    "    // Absent is not an error: the workflow does not apply to this object in this state.",
    "    // Check the parameters passed on the fetch before looking anywhere else.",
    "    // NEVER persist what comes back -- queries expire.",
    "    return $link['query'] ?? null;",
    "}",
    "",
    "function proabono_workflow_email_link(array $params): ?string",
    "{",
    "    $object = proabono_fetch_object($params);",
    `    $query = proabono_link_by_rel($object, '${rel}')['query'] ?? null;`,
    "    $home = proabono_link_by_rel($object, 'insite-home')['href'] ?? null;",
    "    if ($query === null || $home === null) { return null; }",
    "",
    "    return $home . (str_contains($home, '?') ? '&' : '?') . 'pa_query=' . rawurlencode($query);",
    "}",
  ].join("\n");
}

function pythonWorkflowModule(rel: string, objectPath: string): string {
  return [
    "# proabono_workflow.py -- read an encrypted workflow query, and build the e-mail link.",
    "",
    "import base64",
    "import json",
    "import os",
    "import urllib.parse",
    "import urllib.request",
    "",
    "",
    "def _authorization() -> str:",
    '    raw = f"{os.environ[\'PROABONO_AGENT_KEY\']}:{os.environ[\'PROABONO_API_KEY\']}"',
    '    return base64.b64encode(raw.encode()).decode("ascii")',
    "",
    "",
    "def _fetch_object(params: dict) -> dict | None:",
    "    # The Segment is always passed: omitted, ProAbono answers for the DEFAULT Segment,",
    "    # silently -- and a ReferenceCustomer is unique per Segment.",
    '    query = {**params, "ReferenceSegment": os.environ["PROABONO_SEGMENT_REF"]}',
    `    url = os.environ["PROABONO_API_BASE"] + "${objectPath}?" + urllib.parse.urlencode(query)`,
    "",
    "    request = urllib.request.Request(",
    "        url,",
    '        headers={"Authorization": f"Basic {_authorization()}", "Accept": "application/json"},',
    "    )",
    "    with urllib.request.urlopen(request, timeout=10) as response:",
    "        if response.status == 204:",
    "            return None  # nothing there, not a malformed answer",
    "        return json.loads(response.read())",
    "",
    "",
    "def _link_by_rel(obj: dict | None, rel: str) -> dict | None:",
    '    """Look a link up BY REL. Never build one: the href carries an encrypted query."""',
    '    for link in (obj or {}).get("Links") or []:',
    '        if link.get("rel") == rel:',
    "            return link",
    "    return None",
    "",
    "",
    "def workflow_query(**params) -> str | None:",
    "    obj = _fetch_object(params)",
    `    link = _link_by_rel(obj, "${rel}")`,
    "",
    "    # Absent is not an error: the workflow does not apply to this object in this state. Check",
    "    # the parameters passed on the fetch first. NEVER persist the result -- queries expire.",
    '    return (link or {}).get("query")',
    "",
    "",
    "def workflow_email_link(**params) -> str | None:",
    "    obj = _fetch_object(params)",
    `    query = (_link_by_rel(obj, "${rel}") or {}).get("query")`,
    '    home = (_link_by_rel(obj, "insite-home") or {}).get("href")',
    "    if not query or not home:",
    "        return None",
    "",
    '    separator = "&" if "?" in home else "?"',
    '    return f"{home}{separator}pa_query={urllib.parse.quote(query)}"',
    "",
  ].join("\n");
}

function rubyWorkflowModule(rel: string, objectPath: string): string {
  return [
    "# proabono_workflow.rb -- read an encrypted workflow query, and build the e-mail link.",
    "",
    "require 'json'",
    "require 'net/http'",
    "require 'uri'",
    "",
    "def proabono_fetch_object(params)",
    "  # The Segment is always passed: omitted, ProAbono answers for the DEFAULT Segment,",
    "  # silently -- and a ReferenceCustomer is unique per Segment.",
    `  uri = URI("#{ENV.fetch('PROABONO_API_BASE')}${objectPath}")`,
    "  uri.query = URI.encode_www_form(params.merge('ReferenceSegment' => ENV.fetch('PROABONO_SEGMENT_REF')))",
    "",
    "  response = Net::HTTP.get_response(uri, {",
    "    'Authorization' => 'Basic ' + [\"#{ENV.fetch('PROABONO_AGENT_KEY')}:#{ENV.fetch('PROABONO_API_KEY')}\"].pack('m0'),",
    "    'Accept' => 'application/json'",
    "  })",
    "  raise \"ProAbono fetch #{response.code}\" unless response.is_a?(Net::HTTPSuccess)",
    "  return nil if response.body.nil? || response.body.empty? # 204 No Content",
    "",
    "  JSON.parse(response.body)",
    "end",
    "",
    "# Look a link up BY REL. Never build one: the href carries an encrypted query.",
    "def proabono_link_by_rel(object, rel)",
    "  (object&.dig('Links') || []).find { |link| link['rel'] == rel }",
    "end",
    "",
    "def proabono_workflow_query(params)",
    "  object = proabono_fetch_object(params)",
    "",
    "  # Absent is not an error: the workflow does not apply to this object in this state. Check",
    "  # the parameters passed on the fetch first. NEVER persist the result -- queries expire.",
    `  proabono_link_by_rel(object, '${rel}')&.dig('query')`,
    "end",
    "",
    "def proabono_workflow_email_link(params)",
    "  object = proabono_fetch_object(params)",
    `  query = proabono_link_by_rel(object, '${rel}')&.dig('query')`,
    "  home = proabono_link_by_rel(object, 'insite-home')&.dig('href')",
    "  return nil if query.nil? || home.nil?",
    "",
    "  separator = home.include?('?') ? '&' : '?'",
    "  \"#{home}#{separator}pa_query=#{URI.encode_www_form_component(query)}\"",
    "end",
  ].join("\n");
}

function csharpWorkflowModule(rel: string, objectPath: string): string {
  return [
    "// ProAbonoWorkflow.cs -- read an encrypted workflow query, and build the e-mail link.",
    "",
    "using System.Net.Http.Headers;",
    "using System.Text;",
    "using System.Text.Json;",
    "",
    "public sealed class ProAbonoWorkflow",
    "{",
    "    private readonly HttpClient _http;",
    "",
    "    public ProAbonoWorkflow(HttpClient http)",
    "    {",
    "        _http = http;",
    "        var credentials = Encoding.UTF8.GetBytes(",
    '            $"{Environment.GetEnvironmentVariable("PROABONO_AGENT_KEY")}:" +',
    '            $"{Environment.GetEnvironmentVariable("PROABONO_API_KEY")}");',
    "        _http.DefaultRequestHeaders.Authorization =",
    '            new AuthenticationHeaderValue("Basic", Convert.ToBase64String(credentials));',
    "    }",
    "",
    "    private async Task<JsonElement?> FetchObjectAsync(IDictionary<string, string> parameters)",
    "    {",
    "        // The Segment is always passed: omitted, ProAbono answers for the DEFAULT Segment,",
    "        // silently -- and a ReferenceCustomer is unique per Segment.",
    '        parameters["ReferenceSegment"] = Environment.GetEnvironmentVariable("PROABONO_SEGMENT_REF")!;',
    '        var query = string.Join("&", parameters.Select(pair =>',
    '            $"{Uri.EscapeDataString(pair.Key)}={Uri.EscapeDataString(pair.Value)}"));',
    "",
    '        var baseUrl = Environment.GetEnvironmentVariable("PROABONO_API_BASE");',
    `        var response = await _http.GetAsync($"{baseUrl}${objectPath}?{query}");`,
    "        response.EnsureSuccessStatusCode();",
    "        if (response.StatusCode == System.Net.HttpStatusCode.NoContent) return null;",
    "",
    "        return JsonSerializer.Deserialize<JsonElement>(await response.Content.ReadAsStringAsync());",
    "    }",
    "",
    "    // Look a link up BY REL. Never build one: the href carries an encrypted query.",
    "    private static string? LinkValue(JsonElement? obj, string rel, string field)",
    "    {",
    '        if (obj is null || !obj.Value.TryGetProperty("Links", out var links)) return null;',
    "",
    "        foreach (var link in links.EnumerateArray())",
    "        {",
    '            if (link.TryGetProperty("rel", out var value) && value.GetString() == rel)',
    "                return link.TryGetProperty(field, out var found) ? found.GetString() : null;",
    "        }",
    "        return null;",
    "    }",
    "",
    "    public async Task<string?> QueryAsync(IDictionary<string, string> parameters)",
    "    {",
    "        var obj = await FetchObjectAsync(parameters);",
    "",
    "        // Absent is not an error: the workflow does not apply to this object in this state.",
    "        // Check the parameters passed on the fetch first. NEVER persist it -- queries expire.",
    `        return LinkValue(obj, "${rel}", "query");`,
    "    }",
    "",
    "    public async Task<string?> EmailLinkAsync(IDictionary<string, string> parameters)",
    "    {",
    "        var obj = await FetchObjectAsync(parameters);",
    `        var query = LinkValue(obj, "${rel}", "query");`,
    '        var home = LinkValue(obj, "insite-home", "href");',
    "        if (query is null || home is null) return null;",
    "",
    '        var separator = home.Contains(\'?\') ? "&" : "?";',
    '        return $"{home}{separator}pa_query={Uri.EscapeDataString(query)}";',
    "    }",
    "}",
  ].join("\n");
}

function genericWorkflowModule(rel: string, objectPath: string): string {
  return [
    `# Reading the workflow query, in whatever language the project uses.`,
    "#",
    `# 1. FETCH the object: GET {PROABONO_API_BASE}${objectPath}, Basic auth from`,
    "#    PROABONO_AGENT_KEY:PROABONO_API_KEY, and ALWAYS ReferenceSegment from",
    "#    PROABONO_SEGMENT_REF -- omitted, ProAbono answers for the Business's DEFAULT Segment with",
    "#    no error, and a ReferenceCustomer is unique per Segment.",
    "#",
    "#    Pass the parameters THIS workflow needs on that fetch. They are what makes the query",
    "#    exist: ask for a Customer without naming an offer and the subscribe query is simply not",
    "#    in the response.",
    "#",
    `# 2. READ the link whose rel is "${rel}" out of the response's Links array, and take its`,
    "#    `query` field. Look it up by rel. Never assemble a URL: the href carries an encrypted",
    "#    query that cannot be reconstructed, and a wrong one fails at the end of a sign-up.",
    "#",
    "# 3. ABSENT is an answer, not a failure: the workflow does not apply to this object in this",
    "#    state, or the fetch did not carry what it needed. Say so; do not fall back to a URL.",
    "#",
    "# 4. NEVER persist a query. They expire.",
    "#",
    "# 5. For an e-mail or a plain link, read the insite-home link's href -- it is the installation",
    "#    URL configured under Settings -> Hosted Pages -- and append ?pa_query=<the query>.",
  ].join("\n");
}

// ── The single return route ───────────────────────────────────────────────────────────

/** The destination table, identical in every stack: what `from` × `outcome` means for the UI. */
function destinationComment(): string[] {
  return [
    "// from x outcome decides only WHERE the customer lands. What they may do comes from the",
    "// rights that were just re-read -- never from these two values.",
  ];
}

function nodeReturnRoute(returnRoute: string): string {
  return [
    `// GET ${returnRoute} -- the ONE route every workflow comes back to.`,
    'import { refreshEntitlements } from "./proabono-rights.js";',
    "",
    `app.get("${returnRoute}", requireAuth, async (req, res) => {`,
    "  const { from, outcome } = req.query;",
    "",
    "  // Rights may have changed. Re-read them for the SESSION user. idc, refo and idsub are in",
    "  // the query string, are browser-supplied, and decide nothing here -- not even who to refresh.",
    "  await refreshEntitlements(`cust-${req.user.id}`);",
    "",
    ...destinationComment(),
    "  res.redirect(destinationFor(from, outcome));",
    "});",
    "",
    "function destinationFor(from, outcome) {",
    "  // 'terminate' is NOT an immediate loss of access: it takes effect at period end and can",
    "  // still be cancelled. Revoke nothing here; the Usage API already reflects the truth.",
    '  if (from === "terminate") return "/account/billing?notice=termination-scheduled";',
    "",
    "  switch (outcome) {",
    '    case "paid":',
    '      return "/account/billing?notice=payment-received";',
    '    case "pending":',
    "      // Processing: not a failure and not a success. Say so rather than granting or refusing.",
    '      return "/account/billing?notice=payment-processing";',
    '    case "registered":',
    '      return "/account/billing?notice=payment-method-saved";',
    '    case "due":',
    "      // The customer pays offline. They owe something and have lost nothing.",
    '      return "/account/billing?notice=payment-due";',
    '    case "nocharge":',
    "      // Free operation, or payment due later. Most free-plan sign-ups land here.",
    '      return "/welcome";',
    "    default:",
    "      // An outcome this code has never seen. Land somewhere sane; the rights are already true.",
    '      return "/account/billing";',
    "  }",
    "}",
  ].join("\n");
}

function nextReturnRoute(returnRoute: string): string {
  return [
    `// app${returnRoute}/route.js -- a Route Handler: the rights refresh runs on the server.`,
    'import { redirect } from "next/navigation";',
    'import { getSession } from "@/lib/session";',
    'import { refreshEntitlements } from "@/lib/proabono-rights";',
    "",
    "export async function GET(request) {",
    "  const session = await getSession();",
    "  if (!session) redirect(\"/login\");",
    "",
    "  const { searchParams } = new URL(request.url);",
    '  const from = searchParams.get("from");',
    '  const outcome = searchParams.get("outcome");',
    "",
    "  // Re-read for the SESSION user. idc, refo and idsub are browser-supplied and decide nothing.",
    "  await refreshEntitlements(`cust-${session.userId}`);",
    "",
    ...destinationComment(),
    "  redirect(destinationFor(from, outcome));",
    "}",
    "",
    "function destinationFor(from, outcome) {",
    "  // 'terminate' is NOT an immediate loss of access: it takes effect at period end.",
    '  if (from === "terminate") return "/account/billing?notice=termination-scheduled";',
    "",
    "  switch (outcome) {",
    '    case "paid":',
    '      return "/account/billing?notice=payment-received";',
    '    case "pending":',
    '      return "/account/billing?notice=payment-processing";',
    '    case "registered":',
    '      return "/account/billing?notice=payment-method-saved";',
    '    case "due":',
    '      return "/account/billing?notice=payment-due";',
    '    case "nocharge":',
    '      return "/welcome";',
    "    default:",
    '      return "/account/billing";',
    "  }",
    "}",
  ].join("\n");
}

function phpReturnRoute(returnRoute: string): string {
  return [
    "<?php",
    `// Controller for ${returnRoute} -- the ONE route every workflow comes back to.`,
    "require_login();",
    "",
    "// Rights may have changed. Re-read them for the SESSION user. idc, refo and idsub are in the",
    "// query string, are browser-supplied, and decide nothing here -- not even who to refresh.",
    "proabono_refresh_entitlements('cust-' . current_user_id());",
    "",
    "$from = $_GET['from'] ?? null;",
    "$outcome = $_GET['outcome'] ?? null;",
    "",
    "// from x outcome decides only WHERE the customer lands. What they may do comes from the",
    "// rights that were just re-read.",
    "header('Location: ' . proabono_destination_for($from, $outcome));",
    "exit;",
    "",
    "function proabono_destination_for(?string $from, ?string $outcome): string",
    "{",
    "    // 'terminate' is NOT an immediate loss of access: it takes effect at period end and can",
    "    // still be cancelled. Revoke nothing here; the Usage API already reflects the truth.",
    "    if ($from === 'terminate') { return '/account/billing?notice=termination-scheduled'; }",
    "",
    "    return match ($outcome) {",
    "        'paid'       => '/account/billing?notice=payment-received',",
    "        // Processing: not a failure and not a success. Say so rather than granting or refusing.",
    "        'pending'    => '/account/billing?notice=payment-processing',",
    "        'registered' => '/account/billing?notice=payment-method-saved',",
    "        // The customer pays offline. They owe something and have lost nothing.",
    "        'due'        => '/account/billing?notice=payment-due',",
    "        // Free operation, or payment due later. Most free-plan sign-ups land here.",
    "        'nocharge'   => '/welcome',",
    "        // An outcome this code has never seen. The rights are already true either way.",
    "        default      => '/account/billing',",
    "    };",
    "}",
  ].join("\n");
}

function pythonReturnRoute(returnRoute: string): string {
  return [
    `# View for ${returnRoute} -- the ONE route every workflow comes back to.`,
    "from proabono_rights import refresh_entitlements",
    "",
    "",
    `@app.route("${returnRoute}")`,
    "@login_required",
    "def proabono_return():",
    '    from_ = request.args.get("from")',
    '    outcome = request.args.get("outcome")',
    "",
    "    # Rights may have changed. Re-read them for the SESSION user. idc, refo and idsub are in",
    "    # the query string, are browser-supplied, and decide nothing here.",
    '    refresh_entitlements(f"cust-{current_user.id}")',
    "",
    "    # from x outcome decides only WHERE the customer lands.",
    "    return redirect(_destination_for(from_, outcome))",
    "",
    "",
    "def _destination_for(from_: str | None, outcome: str | None) -> str:",
    "    # 'terminate' is NOT an immediate loss of access: it takes effect at period end and can",
    "    # still be cancelled. Revoke nothing here.",
    '    if from_ == "terminate":',
    '        return "/account/billing?notice=termination-scheduled"',
    "",
    "    return {",
    '        "paid": "/account/billing?notice=payment-received",',
    "        # Processing: not a failure and not a success.",
    '        "pending": "/account/billing?notice=payment-processing",',
    '        "registered": "/account/billing?notice=payment-method-saved",',
    "        # The customer pays offline. They owe something and have lost nothing.",
    '        "due": "/account/billing?notice=payment-due",',
    "        # Free operation, or payment due later.",
    '        "nocharge": "/welcome",',
    "        # An outcome this code has never seen. The rights are already true either way.",
    '    }.get(outcome, "/account/billing")',
    "",
  ].join("\n");
}

function rubyReturnRoute(returnRoute: string): string {
  return [
    `# Controller action for ${returnRoute} -- the ONE route every workflow comes back to.`,
    "class ProAbonoReturnController < ApplicationController",
    "  before_action :authenticate_user!",
    "",
    "  def show",
    "    # Rights may have changed. Re-read them for the SESSION user. idc, refo and idsub are in",
    "    # the query string, are browser-supplied, and decide nothing here.",
    '    refresh_entitlements("cust-#{current_user.id}")',
    "",
    "    # from x outcome decides only WHERE the customer lands.",
    "    redirect_to destination_for(params[:from], params[:outcome])",
    "  end",
    "",
    "  private",
    "",
    "  def destination_for(from, outcome)",
    "    # 'terminate' is NOT an immediate loss of access: it takes effect at period end and can",
    "    # still be cancelled. Revoke nothing here.",
    "    return '/account/billing?notice=termination-scheduled' if from == 'terminate'",
    "",
    "    case outcome",
    "    when 'paid'       then '/account/billing?notice=payment-received'",
    "    # Processing: not a failure and not a success.",
    "    when 'pending'    then '/account/billing?notice=payment-processing'",
    "    when 'registered' then '/account/billing?notice=payment-method-saved'",
    "    # The customer pays offline. They owe something and have lost nothing.",
    "    when 'due'        then '/account/billing?notice=payment-due'",
    "    # Free operation, or payment due later.",
    "    when 'nocharge'   then '/welcome'",
    "    # An outcome this code has never seen. The rights are already true either way.",
    "    else '/account/billing'",
    "    end",
    "  end",
    "end",
  ].join("\n");
}

function csharpReturnRoute(returnRoute: string): string {
  return [
    `// The ONE route every workflow comes back to: ${returnRoute}`,
    "[Authorize]",
    "public class ProAbonoReturnModel : PageModel",
    "{",
    "    private readonly ProAbonoRightsService _rights;",
    "",
    "    public ProAbonoReturnModel(ProAbonoRightsService rights) => _rights = rights;",
    "",
    '    public async Task<IActionResult> OnGetAsync(string? from, string? outcome)',
    "    {",
    "        // Rights may have changed. Re-read them for the SIGNED-IN principal. idc, refo and",
    "        // idsub are in the query string, are browser-supplied, and decide nothing here.",
    '        var customerRef = $"cust-{User.FindFirstValue(ClaimTypes.NameIdentifier)}";',
    "        await _rights.RefreshAsync(customerRef);",
    "",
    "        // from x outcome decides only WHERE the customer lands.",
    "        return Redirect(DestinationFor(from, outcome));",
    "    }",
    "",
    "    private static string DestinationFor(string? from, string? outcome)",
    "    {",
    "        // 'terminate' is NOT an immediate loss of access: it takes effect at period end and",
    "        // can still be cancelled. Revoke nothing here.",
    '        if (from == "terminate") return "/account/billing?notice=termination-scheduled";',
    "",
    "        return outcome switch",
    "        {",
    '            "paid" => "/account/billing?notice=payment-received",',
    "            // Processing: not a failure and not a success.",
    '            "pending" => "/account/billing?notice=payment-processing",',
    '            "registered" => "/account/billing?notice=payment-method-saved",',
    "            // The customer pays offline. They owe something and have lost nothing.",
    '            "due" => "/account/billing?notice=payment-due",',
    "            // Free operation, or payment due later.",
    '            "nocharge" => "/welcome",',
    "            // An outcome this code has never seen. The rights are already true either way.",
    '            _ => "/account/billing",',
    "        };",
    "    }",
    "}",
  ].join("\n");
}

function genericReturnRoute(returnRoute: string): string {
  return [
    `# The ONE route every workflow comes back to: ${returnRoute}`,
    "#",
    "# 1. REQUIRE a signed-in user. This route is never anonymous.",
    "#",
    "# 2. RE-READ the rights of the SESSION's customer reference, before deciding anything. The",
    "#    redirect tells you that something changed, not what the customer may now do -- only the",
    "#    Usage API knows that. This is the fastest reliable signal you get: webhooks lag by",
    "#    minutes, the redirect is immediate.",
    "#",
    "# 3. NEVER trust idc, refo or idsub from the query string. They are browser-supplied. idc is",
    "#    an internal id precisely so the shareable ReferenceCustomer is not exposed -- that does",
    "#    not make it authentic. Act on the session's user.",
    "#",
    "# 4. THEN branch on from x outcome for the DESTINATION only:",
    "#    - from=terminate -> effective at period end, and cancellable until then. Revoke NOTHING.",
    "#    - outcome=paid       -> payment completed.",
    "#    - outcome=pending    -> processing: neither a failure nor a success yet.",
    "#    - outcome=registered -> a payment method was saved; nothing was taken.",
    "#    - outcome=due        -> the customer pays offline; they owe, and have lost nothing.",
    "#    - outcome=nocharge   -> free operation, or payment due later.",
    "#    - anything else      -> land somewhere sane. The rights are already true.",
    "#",
    "# 5. COVER all five outcomes even where this merchant has no case for one today. The day a",
    "#    free plan or an offline payment appears, an integration that already handles nocharge and",
    "#    due keeps working unchanged.",
  ].join("\n");
}
