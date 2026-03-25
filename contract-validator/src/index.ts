#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import * as ts from "typescript";
import { readFileSync, existsSync } from "fs";
import { glob } from "glob";
import { resolve, basename } from "path";

// --- Configuration ---
// dnd-api runs on port 3000; dnd-ui is the frontend
const API_URL = process.env.API_URL || "http://localhost:3000";
const OPENAPI_PATH = process.env.OPENAPI_PATH || "/api-json";
const FRONTEND_PATH = process.env.FRONTEND_PATH || "dnd-ui";

// --- OpenAPI Spec Cache ---

interface OpenAPISpec {
  openapi: string;
  info: Record<string, unknown>;
  paths: Record<string, Record<string, unknown>>;
  components?: {
    schemas?: Record<string, Record<string, unknown>>;
  };
}

let cachedSpec: OpenAPISpec | null = null;
let lastFetchTime = 0;
const CACHE_TTL = 60000; // 1 minute

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

// --- TypeScript AST Helpers ---

function parseTypeScriptFile(filePath: string): ts.SourceFile {
  const fileContent = readFileSync(filePath, "utf-8");
  return ts.createSourceFile(filePath, fileContent, ts.ScriptTarget.Latest, true);
}

// --- Types ---

interface ExtractedApiCall {
  methodName: string;
  httpMethod: string;
  apiPath: string;
}

interface ExtractedField {
  name: string;
  type: string;
}

interface ExtractedTypeDecl {
  name: string;
  fields: ExtractedField[];
}

interface AdapterIssue {
  methodName: string;
  apiPath: string;
  httpMethod: string;
  status: "valid" | "path-not-found" | "method-mismatch";
  details?: string;
}

interface TypeMismatch {
  field: string;
  frontendType: string;
  backendType: string;
}

interface StaleMethod {
  name: string;
  path: string;
  httpMethod: string;
  issue: string;
}

interface StaleAdapter {
  file: string;
  staleMethods: StaleMethod[];
}

// --- Extract API calls from adapter file (dnd-ui uses apiClient not authenticatedApiClient) ---

function extractApiCalls(sourceFile: ts.SourceFile): ExtractedApiCall[] {
  const calls: ExtractedApiCall[] = [];

  function getEnclosingMethodName(node: ts.Node): string {
    let current: ts.Node | undefined = node.parent;
    while (current) {
      if (ts.isMethodDeclaration(current) && current.name) return current.name.getText(sourceFile);
      if (ts.isFunctionDeclaration(current) && current.name) return current.name.getText(sourceFile);
      if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) return current.name.getText(sourceFile);
      current = current.parent;
    }
    return "<unknown>";
  }

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const expr = node.expression;

      // dnd-ui uses: apiClient.GET(...), apiClient.POST(...), etc.
      // (unauthenticated — dnd-ui uses simple token in headers, not Firebase)
      if (
        ts.isPropertyAccessExpression(expr) &&
        ts.isIdentifier(expr.expression) &&
        (expr.expression.text === "apiClient" || expr.expression.text === "authenticatedApiClient")
      ) {
        const httpMethod = expr.name.text;

        if (["GET", "POST", "PATCH", "PUT", "DELETE"].includes(httpMethod)) {
          const firstArg = node.arguments[0];
          let apiPath = "<dynamic>";

          if (firstArg && ts.isStringLiteral(firstArg)) apiPath = firstArg.text;
          else if (firstArg && ts.isNoSubstitutionTemplateLiteral(firstArg)) apiPath = firstArg.text;

          calls.push({ methodName: getEnclosingMethodName(node), httpMethod, apiPath });
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return calls;
}

// --- Extract frontend TypeScript types/interfaces ---

function hasExportModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const modifiers = ts.getModifiers(node);
  return modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function extractFrontendTypes(sourceFile: ts.SourceFile): ExtractedTypeDecl[] {
  const types: ExtractedTypeDecl[] = [];

  function visit(node: ts.Node) {
    if (ts.isInterfaceDeclaration(node) && hasExportModifier(node)) {
      const name = node.name.getText(sourceFile);
      const fields: ExtractedField[] = [];
      for (const member of node.members) {
        if (ts.isPropertySignature(member) && member.name) {
          fields.push({ name: member.name.getText(sourceFile), type: member.type?.getText(sourceFile) ?? "unknown" });
        }
      }
      types.push({ name, fields });
    }

    if (ts.isTypeAliasDeclaration(node) && hasExportModifier(node)) {
      const name = node.name.getText(sourceFile);
      const fields: ExtractedField[] = [];
      if (ts.isTypeLiteralNode(node.type)) {
        for (const member of node.type.members) {
          if (ts.isPropertySignature(member) && member.name) {
            fields.push({ name: member.name.getText(sourceFile), type: member.type?.getText(sourceFile) ?? "unknown" });
          }
        }
      }
      types.push({ name, fields });
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return types;
}

// --- Check if path+method exists in spec ---

function checkPathInSpec(spec: OpenAPISpec, apiPath: string, httpMethod: string): { exists: boolean; pathFound: boolean } {
  const normalizedMethod = httpMethod.toLowerCase();

  if (spec.paths[apiPath]) {
    return { exists: !!spec.paths[apiPath][normalizedMethod], pathFound: true };
  }

  for (const specPath of Object.keys(spec.paths)) {
    const specSegments = specPath.split("/");
    const inputSegments = apiPath.split("/");
    if (specSegments.length !== inputSegments.length) continue;

    let match = true;
    for (let i = 0; i < specSegments.length; i++) {
      const specSeg = specSegments[i];
      const inputSeg = inputSegments[i];
      if (specSeg === inputSeg) continue;
      if (specSeg.startsWith("{") && specSeg.endsWith("}") && inputSeg.startsWith("{") && inputSeg.endsWith("}")) continue;
      if (specSeg.startsWith("{") && specSeg.endsWith("}")) continue;
      match = false;
      break;
    }

    if (match) return { exists: !!spec.paths[specPath][normalizedMethod], pathFound: true };
  }

  return { exists: false, pathFound: false };
}

// --- Map OpenAPI schema type to TypeScript type string ---

function openapiTypeToTs(schema: Record<string, unknown>): string {
  if (!schema) return "unknown";
  if (schema.$ref) return (schema.$ref as string).split("/").pop() ?? "unknown";
  if (schema.enum) return (schema.enum as unknown[]).map((v) => `"${v}"`).join(" | ");
  switch (schema.type) {
    case "string": return "string";
    case "number":
    case "integer": return "number";
    case "boolean": return "boolean";
    case "array": return `${openapiTypeToTs(schema.items as Record<string, unknown>)}[]`;
    case "object": return "object";
    default: return "unknown";
  }
}

// --- Tool: validate_adapter_against_api ---

async function validateAdapterAgainstApi(adapterPath: string): Promise<object> {
  const fullPath = resolve(adapterPath);
  if (!existsSync(fullPath)) throw new Error(`File not found: ${fullPath}`);

  const sourceFile = parseTypeScriptFile(fullPath);
  const apiCalls = extractApiCalls(sourceFile);
  const spec = await fetchOpenAPISpec();

  const issues: AdapterIssue[] = [];
  let validCount = 0;

  for (const call of apiCalls) {
    if (call.apiPath === "<dynamic>") {
      issues.push({ methodName: call.methodName, apiPath: call.apiPath, httpMethod: call.httpMethod, status: "path-not-found", details: "Dynamic path expression - cannot validate statically" });
      continue;
    }

    const result = checkPathInSpec(spec, call.apiPath, call.httpMethod);
    if (result.exists) {
      validCount++;
      issues.push({ methodName: call.methodName, apiPath: call.apiPath, httpMethod: call.httpMethod, status: "valid" });
    } else if (result.pathFound) {
      issues.push({ methodName: call.methodName, apiPath: call.apiPath, httpMethod: call.httpMethod, status: "method-mismatch", details: `Path exists but HTTP method ${call.httpMethod} is not defined` });
    } else {
      issues.push({ methodName: call.methodName, apiPath: call.apiPath, httpMethod: call.httpMethod, status: "path-not-found", details: `Path "${call.apiPath}" not found in OpenAPI spec` });
    }
  }

  return { adapterFile: fullPath, methodCount: apiCalls.length, validCount, issues };
}

// --- Tool: check_dto_sync ---

async function checkDtoSync(frontendDtoPath: string, backendEntityName: string): Promise<object> {
  const fullPath = resolve(frontendDtoPath);
  if (!existsSync(fullPath)) throw new Error(`File not found: ${fullPath}`);

  const sourceFile = parseTypeScriptFile(fullPath);
  const frontendTypes = extractFrontendTypes(sourceFile);
  const spec = await fetchOpenAPISpec();

  if (!spec.components?.schemas) throw new Error("No schemas found in OpenAPI spec components");

  const backendSchema = spec.components.schemas[backendEntityName];
  if (!backendSchema) {
    const available = Object.keys(spec.components.schemas).join(", ");
    throw new Error(`Schema "${backendEntityName}" not found. Available: ${available}`);
  }

  const backendProperties = (backendSchema.properties as Record<string, unknown>) || {};
  const backendFieldNames = Object.keys(backendProperties);

  const allFrontendFields = new Map<string, string>();
  for (const decl of frontendTypes) {
    for (const field of decl.fields) allFrontendFields.set(field.name, field.type);
  }
  const frontendFieldNames = Array.from(allFrontendFields.keys());

  const missingInFrontend = backendFieldNames.filter((f) => !frontendFieldNames.includes(f));
  const extraInFrontend = frontendFieldNames.filter((f) => !backendFieldNames.includes(f));

  const typeMismatches: TypeMismatch[] = [];
  for (const field of frontendFieldNames) {
    if (backendProperties[field]) {
      const feType = allFrontendFields.get(field) ?? "unknown";
      const beType = openapiTypeToTs(backendProperties[field] as Record<string, unknown>);
      if (feType.replace(/\s+/g, "") !== beType.replace(/\s+/g, "")) {
        typeMismatches.push({ field, frontendType: feType, backendType: beType });
      }
    }
  }

  return {
    frontendFile: fullPath,
    backendSchema: backendEntityName,
    frontendTypesFound: frontendTypes.map((t) => t.name),
    missingInFrontend,
    extraInFrontend,
    typeMismatches,
  };
}

// --- Tool: find_stale_adapters ---

async function findStaleAdapters(): Promise<object> {
  const adaptersDir = resolve(`${FRONTEND_PATH}/src/adapters`);
  if (!existsSync(adaptersDir)) throw new Error(`Adapters directory not found: ${adaptersDir}`);

  const adapterFiles = await glob(`${adaptersDir}/*.ts`, { ignore: ["**/node_modules/**", "**/dist/**"] });
  const filteredFiles = adapterFiles.filter((f) => {
    const name = basename(f);
    return name !== "apiClient.ts" && name !== "index.ts";
  });

  const spec = await fetchOpenAPISpec();
  const staleAdapters: StaleAdapter[] = [];
  let cleanCount = 0;

  for (const file of filteredFiles) {
    const sourceFile = parseTypeScriptFile(file);
    const apiCalls = extractApiCalls(sourceFile);
    const staleMethods: StaleMethod[] = [];

    for (const call of apiCalls) {
      if (call.apiPath === "<dynamic>") {
        staleMethods.push({ name: call.methodName, path: call.apiPath, httpMethod: call.httpMethod, issue: "Dynamic path expression - cannot validate statically" });
        continue;
      }
      const result = checkPathInSpec(spec, call.apiPath, call.httpMethod);
      if (!result.exists) {
        staleMethods.push({
          name: call.methodName, path: call.apiPath, httpMethod: call.httpMethod,
          issue: result.pathFound
            ? `Path exists but HTTP method ${call.httpMethod} is not defined`
            : `Path "${call.apiPath}" not found in OpenAPI spec`,
        });
      }
    }

    if (staleMethods.length > 0) staleAdapters.push({ file, staleMethods });
    else cleanCount++;
  }

  return { totalAdapters: filteredFiles.length, cleanAdapters: cleanCount, staleAdapters };
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new Server(
  { name: "dnd-contract-validator", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools: Tool[] = [
    {
      name: "validate_adapter_against_api",
      description:
        "Validate a dnd-ui adapter file's API calls against the live dnd-api OpenAPI spec. " +
        "Parses the adapter using TypeScript AST to find all apiClient.GET/POST/PATCH/PUT/DELETE calls " +
        "and checks if each path+method combination exists in the spec.",
      inputSchema: {
        type: "object",
        properties: {
          adapterPath: { type: "string", description: "Path to the dnd-ui adapter file (e.g., 'dnd-ui/src/adapters/characterAdapter.ts')" },
        },
        required: ["adapterPath"],
      },
    },
    {
      name: "check_dto_sync",
      description:
        "Compare a dnd-ui DTO/type file's fields against a dnd-api entity schema from the OpenAPI spec. " +
        "Reports fields missing in frontend, extra fields in frontend, and type mismatches.",
      inputSchema: {
        type: "object",
        properties: {
          frontendDtoPath: { type: "string", description: "Path to the dnd-ui DTO file (e.g., 'dnd-ui/src/dto/character.ts')" },
          backendEntityName: { type: "string", description: "Name of the backend schema in the OpenAPI spec (e.g., 'Character', 'CreateCharacterDto')" },
        },
        required: ["frontendDtoPath", "backendEntityName"],
      },
    },
    {
      name: "find_stale_adapters",
      description:
        "Scan all dnd-ui adapter files and report any that reference dnd-api paths not found in the live OpenAPI spec. " +
        "Useful for finding adapters that are out of sync after backend API changes.",
      inputSchema: { type: "object", properties: {} },
    },
  ];
  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result: object;
    switch (name) {
      case "validate_adapter_against_api":
        result = await validateAdapterAgainstApi((args as Record<string, unknown>)?.adapterPath as string);
        break;
      case "check_dto_sync":
        result = await checkDtoSync(
          (args as Record<string, unknown>)?.frontendDtoPath as string,
          (args as Record<string, unknown>)?.backendEntityName as string
        );
        break;
      case "find_stale_adapters":
        result = await findStaleAdapters();
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
    console.error(`DnD Contract Validator MCP Server running (API: ${API_URL}${OPENAPI_PATH}, Frontend: ${FRONTEND_PATH})`);
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

main();
