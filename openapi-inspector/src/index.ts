#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

// dnd-api runs on port 3000 with Swagger at /api-json
const API_URL = process.env.API_URL || "http://localhost:3000";
const OPENAPI_PATH = process.env.OPENAPI_PATH || "/api-json";

interface OpenAPISpec {
  openapi: string;
  info: Record<string, unknown>;
  paths: Record<string, Record<string, unknown>>;
  components?: {
    schemas?: Record<string, unknown>;
  };
}

let cachedSpec: OpenAPISpec | null = null;
let lastFetchTime = 0;
const CACHE_TTL = 60000; // 1 minute

// Helper: Fetch OpenAPI spec
async function fetchOpenAPISpec(): Promise<OpenAPISpec> {
  const now = Date.now();
  if (cachedSpec && (now - lastFetchTime) < CACHE_TTL) return cachedSpec;

  const url = `${API_URL}${OPENAPI_PATH}`;
  console.error(`Fetching OpenAPI spec from: ${url}`);

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch OpenAPI spec: ${response.status} ${response.statusText}`);

  cachedSpec = await response.json() as OpenAPISpec;
  lastFetchTime = now;
  return cachedSpec;
}

// Helper: Find endpoint in spec
function findEndpoint(spec: OpenAPISpec, path: string, method: string) {
  const normalizedMethod = method.toLowerCase();

  if ((spec.paths[path] as Record<string, unknown>)?.[normalizedMethod]) {
    return { path, method: normalizedMethod, spec: (spec.paths[path] as Record<string, unknown>)[normalizedMethod] };
  }

  for (const [specPath, methods] of Object.entries(spec.paths)) {
    const methodMap = methods as Record<string, unknown>;
    if (methodMap[normalizedMethod]) {
      const pathPattern = specPath.replace(/\{[^}]+\}/g, "[^/]+");
      const regex = new RegExp(`^${pathPattern}$`);
      if (regex.test(path)) {
        return { path: specPath, method: normalizedMethod, spec: methodMap[normalizedMethod] };
      }
    }
  }

  return null;
}

// Helper: Resolve $ref
function resolveRef(spec: OpenAPISpec, ref: string): unknown {
  if (!ref.startsWith("#/")) throw new Error(`Only local refs are supported: ${ref}`);
  const parts = ref.slice(2).split("/");
  let current: unknown = spec;
  for (const part of parts) {
    current = (current as Record<string, unknown>)[part];
    if (current === undefined) throw new Error(`Cannot resolve ref: ${ref}`);
  }
  return current;
}

// Helper: Get schema details
function getSchemaDetails(spec: OpenAPISpec, schema: Record<string, unknown>): unknown {
  if (schema.$ref) return resolveRef(spec, schema.$ref as string);

  if (schema.type === "array" && schema.items) {
    const items = getSchemaDetails(spec, schema.items as Record<string, unknown>);
    return { type: "array", items };
  }

  if (schema.type === "object" && schema.properties) {
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema.properties as Record<string, unknown>)) {
      properties[key] = getSchemaDetails(spec, value as Record<string, unknown>);
    }
    return { type: "object", properties, required: schema.required || [] };
  }

  return schema;
}

// Tool: Get endpoint schema
async function getEndpointSchema(path: string, method: string): Promise<unknown> {
  const spec = await fetchOpenAPISpec();
  const endpoint = findEndpoint(spec, path, method);
  if (!endpoint) throw new Error(`Endpoint not found: ${method.toUpperCase()} ${path}`);

  const epSpec = endpoint.spec as Record<string, unknown>;
  const requestBody = (epSpec.requestBody as Record<string, unknown> | undefined)
    ?.content as Record<string, unknown> | undefined;
  const requestBodySchema = requestBody?.["application/json"] as Record<string, unknown> | undefined;
  const responses = (epSpec.responses as Record<string, unknown>) || {};

  return {
    path: endpoint.path,
    method: endpoint.method,
    summary: epSpec.summary,
    description: epSpec.description,
    parameters: epSpec.parameters || [],
    requestBody: requestBodySchema?.schema ? getSchemaDetails(spec, requestBodySchema.schema as Record<string, unknown>) : null,
    responses: Object.entries(responses).reduce((acc, [code, response]) => {
      const r = response as Record<string, unknown>;
      const content = r.content as Record<string, unknown> | undefined;
      const schema = content?.["application/json"] as Record<string, unknown> | undefined;
      acc[code] = {
        description: r.description,
        schema: schema?.schema ? getSchemaDetails(spec, schema.schema as Record<string, unknown>) : null,
      };
      return acc;
    }, {} as Record<string, unknown>),
  };
}

// Tool: Validate request
async function validateRequest(path: string, method: string, body: Record<string, unknown>): Promise<unknown> {
  const spec = await fetchOpenAPISpec();
  const endpoint = findEndpoint(spec, path, method);
  if (!endpoint) return { valid: false, errors: [`Endpoint not found: ${method.toUpperCase()} ${path}`] };

  const epSpec = endpoint.spec as Record<string, unknown>;
  const requestBody = (epSpec.requestBody as Record<string, unknown> | undefined)?.content as Record<string, unknown> | undefined;
  const requestBodySchema = (requestBody?.["application/json"] as Record<string, unknown> | undefined)?.schema;

  if (!requestBodySchema) return { valid: true, message: "Endpoint does not expect a request body" };

  const schema = getSchemaDetails(spec, requestBodySchema as Record<string, unknown>) as Record<string, unknown>;
  const errors: string[] = [];

  if (schema.type === "object") {
    const required = (schema.required as string[]) || [];
    for (const field of required) {
      if (!(field in body)) errors.push(`Missing required field: ${field}`);
    }
    const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
    for (const [field, value] of Object.entries(body)) {
      const fieldSchema = properties?.[field];
      if (!fieldSchema) { errors.push(`Unknown field: ${field}`); continue; }
      const actualType = Array.isArray(value) ? "array" : typeof value;
      const expectedType = fieldSchema.type as string;
      if (actualType !== expectedType) errors.push(`Field '${field}' has type '${actualType}' but expected '${expectedType}'`);
    }
  }

  return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined };
}

// Tool: Get enum values
async function getEnumValues(schemaName: string): Promise<unknown> {
  const spec = await fetchOpenAPISpec();
  if (!spec.components?.schemas) throw new Error("No schemas found in OpenAPI spec");

  const schema = spec.components.schemas[schemaName] as Record<string, unknown> | undefined;
  if (!schema) {
    const available = Object.keys(spec.components.schemas).join(", ");
    throw new Error(`Schema '${schemaName}' not found. Available schemas: ${available}`);
  }

  return {
    schemaName,
    enumValues: schema.enum || [],
    type: schema.type,
    description: schema.description,
  };
}

// Tool: Diff API versions
async function diffApiVersions(): Promise<unknown> {
  const previousSpec = cachedSpec;
  cachedSpec = null;
  const currentSpec = await fetchOpenAPISpec();

  if (!previousSpec) return { message: "No previous spec to compare. Spec has been cached for future comparisons." };

  const changes: unknown[] = [];

  for (const [path, methods] of Object.entries(currentSpec.paths)) {
    for (const [method, endpoint] of Object.entries(methods as Record<string, unknown>)) {
      const endpointSpec = endpoint as Record<string, unknown>;
      const prevEndpoint = (previousSpec.paths[path] as Record<string, unknown>)?.[method];

      if (!prevEndpoint) {
        changes.push({ type: "added", path, method, description: endpointSpec.summary || endpointSpec.description });
      } else {
        const currentReqBody = JSON.stringify((endpointSpec as Record<string, unknown>).requestBody);
        const prevReqBody = JSON.stringify((prevEndpoint as Record<string, unknown>).requestBody);
        if (currentReqBody !== prevReqBody) {
          changes.push({ type: "modified", path, method, change: "Request body schema changed" });
        }
      }
    }
  }

  for (const [path, methods] of Object.entries(previousSpec.paths)) {
    for (const method of Object.keys(methods as Record<string, unknown>)) {
      if (!(currentSpec.paths[path] as Record<string, unknown>)?.[method]) {
        changes.push({ type: "removed", path, method });
      }
    }
  }

  return { changesCount: changes.length, changes };
}

// Tool: Suggest TypeScript DTO interface
async function suggestFrontendDto(endpointPath: string, method: string): Promise<unknown> {
  const spec = await fetchOpenAPISpec();
  const endpoint = findEndpoint(spec, endpointPath, method);
  if (!endpoint) throw new Error(`Endpoint not found: ${method.toUpperCase()} ${endpointPath}`);

  const epSpec = endpoint.spec as Record<string, unknown>;
  const responses = epSpec.responses as Record<string, unknown> | undefined;
  const r200 = responses?.["200"] as Record<string, unknown> | undefined;
  const r201 = responses?.["201"] as Record<string, unknown> | undefined;
  const responseContent = (r200?.content || r201?.content) as Record<string, unknown> | undefined;
  const responseSchema = (responseContent?.["application/json"] as Record<string, unknown> | undefined)?.schema;

  if (!responseSchema) return { message: "No response schema found for this endpoint" };

  const schema = getSchemaDetails(spec, responseSchema as Record<string, unknown>);

  function getTypeString(s: Record<string, unknown>): string {
    if (s.type === "string") return "string";
    if (s.type === "number" || s.type === "integer") return "number";
    if (s.type === "boolean") return "boolean";
    if (s.type === "array") return `${getTypeString(s.items as Record<string, unknown>)}[]`;
    if (s.type === "object") return "Record<string, unknown>";
    if (s.enum) return (s.enum as unknown[]).map((v) => `"${v}"`).join(" | ");
    return "unknown";
  }

  function generateInterface(name: string, s: Record<string, unknown>, indent = 0): string {
    const indentStr = "  ".repeat(indent);
    if (s.type === "object") {
      const props = Object.entries((s.properties as Record<string, unknown>) || {})
        .map(([key, prop]) => {
          const optional = (s.required as string[] | undefined)?.includes(key) ? "" : "?";
          return `${indentStr}  ${key}${optional}: ${getTypeString(prop as Record<string, unknown>)};`;
        }).join("\n");
      return `${indentStr}export interface ${name} {\n${props}\n${indentStr}}`;
    } else if (s.type === "array") {
      return `${indentStr}export type ${name} = ${getTypeString(s.items as Record<string, unknown>)}[];`;
    } else {
      return `${indentStr}export type ${name} = ${getTypeString(s)};`;
    }
  }

  const dtoName = ((epSpec.summary as string | undefined)?.replace(/\s+/g, "") ?? "Api") + "Response";
  const interfaceCode = generateInterface(dtoName, schema as Record<string, unknown>);

  return {
    endpointPath: endpoint.path,
    method: endpoint.method,
    suggestedDto: interfaceCode,
    schema,
  };
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new Server(
  { name: "dnd-openapi-inspector", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools: Tool[] = [
    {
      name: "get_endpoint_schema",
      description: "Get request and response schema for a specific dnd-api endpoint from the live OpenAPI/Swagger spec.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "API path (e.g., '/character/{id}' or '/spell')" },
          method: { type: "string", description: "HTTP method (GET, POST, PATCH, PUT, DELETE)" },
        },
        required: ["path", "method"],
      },
    },
    {
      name: "validate_request",
      description: "Validate a request body against the dnd-api OpenAPI spec for an endpoint.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "API path" },
          method: { type: "string", description: "HTTP method" },
          body: { type: "object", description: "Request body to validate" },
        },
        required: ["path", "method", "body"],
      },
    },
    {
      name: "get_enum_values",
      description: "Get valid enum values for a schema from the dnd-api OpenAPI spec (e.g., CharacterClass, SpellSchool, DamageType).",
      inputSchema: {
        type: "object",
        properties: {
          schemaName: { type: "string", description: "Name of the schema (e.g., 'CharacterClass', 'SpellSchool', 'UserRole')" },
        },
        required: ["schemaName"],
      },
    },
    {
      name: "diff_api_versions",
      description: "Compare the current dnd-api spec with the previously cached version to see what endpoints or schemas changed.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "suggest_frontend_dto",
      description: "Generate a TypeScript interface from a dnd-api endpoint's response schema for use in dnd-ui.",
      inputSchema: {
        type: "object",
        properties: {
          endpointPath: { type: "string", description: "API endpoint path" },
          method: { type: "string", description: "HTTP method (usually GET)" },
        },
        required: ["endpointPath", "method"],
      },
    },
  ];
  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  if (!args) throw new Error("Missing arguments");

  try {
    let result: unknown;
    switch (name) {
      case "get_endpoint_schema":
        result = await getEndpointSchema(args.path as string, args.method as string);
        break;
      case "validate_request":
        result = await validateRequest(args.path as string, args.method as string, args.body as Record<string, unknown>);
        break;
      case "get_enum_values":
        result = await getEnumValues(args.schemaName as string);
        break;
      case "diff_api_versions":
        result = await diffApiVersions();
        break;
      case "suggest_frontend_dto":
        result = await suggestFrontendDto(args.endpointPath as string, args.method as string);
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
});

async function main() {
  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`DnD OpenAPI Inspector MCP Server running (API: ${API_URL}${OPENAPI_PATH})`);
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

main();
