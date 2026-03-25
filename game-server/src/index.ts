#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

const API_BASE = process.env.DND_API_URL ?? "http://localhost:3000";
const SESSION_ID = process.env.SESSION_ID;

if (!SESSION_ID) {
  console.error("ERROR: SESSION_ID environment variable is required");
  process.exit(1);
}

interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface McpToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
  code?: string;
}

// Fetch tool definitions from the NestJS API
async function fetchToolDefinitions(): Promise<ToolDefinition[]> {
  const response = await fetch(`${API_BASE}/mcp/tools`);
  if (!response.ok) {
    throw new Error(`Failed to fetch tools: ${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<ToolDefinition[]>;
}

// Execute a tool via the NestJS API
async function executeTool(toolName: string, input: unknown): Promise<McpToolResult> {
  const response = await fetch(`${API_BASE}/mcp/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      toolName,
      input: input ?? {},
      sessionId: SESSION_ID,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    return {
      success: false,
      error: `API error ${response.status}: ${text}`,
      code: "API_ERROR",
    };
  }

  return response.json() as Promise<McpToolResult>;
}

// MCP Server setup
const server = new Server(
  { name: "dnd-game-server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

let cachedTools: ToolDefinition[] = [];

// List tools — fetched from the NestJS API
server.setRequestHandler(ListToolsRequestSchema, async () => {
  try {
    cachedTools = await fetchToolDefinitions();
    console.error(`Loaded ${cachedTools.length} game tools from API`);
  } catch (error) {
    console.error("Failed to fetch tools, using cached:", error);
  }

  const tools: Tool[] = cachedTools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: {
      type: "object" as const,
      ...t.input_schema,
    },
  }));

  return { tools };
});

// Handle tool calls — proxy to the NestJS API
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  console.error(`Tool call: ${name} with args: ${JSON.stringify(args)}`);

  try {
    const result = await executeTool(name, args ?? {});

    if (!result.success) {
      return {
        content: [{
          type: "text",
          text: `Tool error (${result.code ?? "UNKNOWN"}): ${result.error ?? "Unknown error"}`,
        }],
        isError: true,
      };
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify(result.data ?? result, null, 2),
      }],
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Tool execution failed: ${errorMessage}`);
    return {
      content: [{ type: "text", text: `Error: ${errorMessage}` }],
      isError: true,
    };
  }
});

async function main() {
  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`DnD Game MCP Server running — session: ${SESSION_ID}, API: ${API_BASE}`);
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

main();
