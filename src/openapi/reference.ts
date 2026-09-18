/**
 * Endpoint and schema lookup over the ProAbono API Live contract.
 *
 * Everything returned here comes from the vendored contract. Nothing is remembered, inferred or
 * completed from elsewhere: if the contract does not say it, this module does not answer it.
 */
import { loadContract, type OpenApiDocument, type OpenApiOperation } from "../corpus/index.js";

export interface ParameterReference {
  readonly name: string;
  readonly in: string;
  readonly required: boolean;
  readonly type: string | undefined;
  readonly description: string | undefined;
}

export interface EndpointReference {
  readonly method: string;
  readonly path: string;
  readonly summary: string | undefined;
  readonly description: string | undefined;
  readonly parameters: readonly ParameterReference[];
  readonly requestBodySchema: string | undefined;
  readonly responses: readonly string[];
}

function resolve(contract: OpenApiDocument, node: unknown): unknown {
  if (typeof node !== "object" || node === null) return node;
  const record = node as { $ref?: string };
  if (typeof record.$ref !== "string") return node;

  const segments = record.$ref.replace(/^#\//, "").split("/");
  let current: unknown = contract;
  for (const segment of segments) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function schemaName(node: unknown): string | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  const record = node as { $ref?: string };
  return typeof record.$ref === "string" ? record.$ref.split("/").pop() : undefined;
}

function describeParameters(
  contract: OpenApiDocument,
  operation: OpenApiOperation,
): ParameterReference[] {
  return (operation.parameters ?? []).flatMap((raw) => {
    const parameter = resolve(contract, raw) as
      | {
          name?: string;
          in?: string;
          required?: boolean;
          description?: string;
          schema?: { type?: string };
        }
      | undefined;
    if (parameter?.name === undefined) return [];
    return [
      {
        name: parameter.name,
        in: parameter.in ?? "query",
        required: parameter.required === true,
        type: parameter.schema?.type,
        description: parameter.description,
      },
    ];
  });
}

/** Every operation in the contract, in the order the contract declares them. */
export function listEndpoints(
  contract: OpenApiDocument = loadContract(),
): readonly EndpointReference[] {
  const endpoints: EndpointReference[] = [];

  for (const [path, operations] of Object.entries(contract.paths)) {
    for (const [method, operation] of Object.entries(operations)) {
      const body = (
        operation.requestBody as { content?: Record<string, { schema?: unknown }> } | undefined
      )?.content?.["application/json"]?.schema;

      endpoints.push({
        method: method.toUpperCase(),
        path,
        summary: operation.summary,
        description: operation.description,
        parameters: describeParameters(contract, operation),
        requestBodySchema: schemaName(body),
        responses: Object.keys(operation.responses ?? {}),
      });
    }
  }

  return endpoints;
}

/** Looks an endpoint up by path, or by any fragment of its path or summary. */
export function findEndpoints(query: string, limit = 5): readonly EndpointReference[] {
  const needle = query.trim().toLowerCase();
  const endpoints = listEndpoints();

  const exact = endpoints.filter(
    (endpoint) =>
      endpoint.path.toLowerCase() === needle ||
      `${endpoint.method.toLowerCase()} ${endpoint.path.toLowerCase()}` === needle,
  );
  if (exact.length > 0) return exact;

  return endpoints
    .filter(
      (endpoint) =>
        endpoint.path.toLowerCase().includes(needle) ||
        (endpoint.summary ?? "").toLowerCase().includes(needle),
    )
    .slice(0, limit);
}

/** A named schema from the contract, returned as the contract holds it. */
export function findSchema(
  name: string,
): { readonly name: string; readonly schema: unknown } | undefined {
  const contract = loadContract();
  const schemas = contract.components?.schemas ?? {};
  const key = Object.keys(schemas).find(
    (candidate) => candidate.toLowerCase() === name.trim().toLowerCase(),
  );
  return key === undefined ? undefined : { name: key, schema: schemas[key] };
}
