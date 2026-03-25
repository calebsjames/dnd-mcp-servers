#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { resolve } from "path";
import { existsSync } from "fs";

import { scanAllVueFiles, parseRouterFile, parseSidebarFile, parseGlobalComponents } from "./scanner.js";
import { ComponentGraph } from "./graph.js";
import { NavigationResolver } from "./navigation.js";
import type { FindComponentResult, SearchComponentResult, ComponentVariant } from "./types.js";

// ── Configuration ──

const FRONTEND_PATH = process.env.FRONTEND_PATH || "/Users/calebjames/workspace/foreward/dnd-ui";
const SRC_DIR = resolve(FRONTEND_PATH, "src");
const ROUTER_PATH = resolve(SRC_DIR, "router/index.ts");
const NAV_PATH = resolve(SRC_DIR, "components/AppNav.vue");
const HOMEPAGE_PATH = resolve(SRC_DIR, "App.vue");
const MAIN_TS_PATH = resolve(SRC_DIR, "main.ts");
const NAV_DATA_PATH = resolve(FRONTEND_PATH, ".claude/navigation-data.json");

// ── State ──

const graph = new ComponentGraph();
const navigation = new NavigationResolver(NAV_DATA_PATH);
let lastScanTime = 0;

// ── Initial Scan ──

async function performScan(): Promise<{ totalComponents: number; totalUsages: number; orphanCount: number; nameCollisions: number }> {
  const scanResults = await scanAllVueFiles(SRC_DIR);
  graph.build(scanResults);

  if (existsSync(MAIN_TS_PATH)) {
    const globals = parseGlobalComponents(MAIN_TS_PATH);
    graph.setGlobalComponents(globals);
  }

  const routes = parseRouterFile(ROUTER_PATH);
  const sidebarViews = parseSidebarFile(NAV_PATH, HOMEPAGE_PATH);
  navigation.updateFromScanner(routes, sidebarViews);
  navigation.autoPopulateModals(graph);

  lastScanTime = Date.now();
  return graph.getStats();
}

// ── MCP Server ──

const server = new Server(
  { name: "dnd-component-map", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ── Tool Definitions ──

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools: Tool[] = [
    {
      name: "find_component",
      description:
        "Find where a Vue component is defined, where it is used, and how many times. Returns definition file path, all usage locations, usage count, and navigation path if available.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              "Component name (PascalCase, e.g., 'CharacterSheet', 'SpellList', 'CombatTracker')",
          },
        },
        required: ["name"],
      },
    },
    {
      name: "get_navigation_path",
      description:
        "Get step-by-step Playwright instructions to navigate to a specific component, screen, or modal in the browser. Returns the component chain and actionable browser steps.",
      inputSchema: {
        type: "object",
        properties: {
          target: {
            type: "string",
            description:
              "Component name, view name, or modal name (e.g., 'CharacterSheetModal', 'Inventory', 'SpellSlotTracker')",
          },
        },
        required: ["target"],
      },
    },
    {
      name: "get_screen_components",
      description:
        "Get all components rendered on a given screen/view, including those inside modals and tabs. Returns a tree structure of the component hierarchy.",
      inputSchema: {
        type: "object",
        properties: {
          screenName: {
            type: "string",
            description:
              "View name or component name (e.g., 'Character Sheet', 'Combat Tracker')",
          },
          includeModals: {
            type: "boolean",
            description: "Whether to include components inside modals. Defaults to true.",
          },
        },
        required: ["screenName"],
      },
    },
    {
      name: "refresh_component_index",
      description:
        "Re-scan all .vue files and rebuild the component graph and navigation data. Use after files have been added, removed, or renamed.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "search_components",
      description:
        "Fuzzy search for components by name or file path. Returns matching components with their definitions and usage counts.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search term (fuzzy matched against component names and file paths)",
          },
          limit: {
            type: "number",
            description: "Maximum results to return. Defaults to 10.",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "update_navigation_entry",
      description:
        "Update or add a navigation entry in navigation-data.json. Use this to enrich modal triggers, add Playwright hints, or correct navigation paths discovered via browser testing.",
      inputSchema: {
        type: "object",
        properties: {
          section: {
            type: "string",
            enum: ["modals", "navigationPaths"],
            description: "Which section of navigation-data.json to update",
          },
          key: {
            type: "string",
            description: "The component or screen name being updated",
          },
          data: {
            type: "object",
            description: "The data to merge into the entry",
          },
        },
        required: ["section", "key", "data"],
      },
    },
  ];

  return { tools };
});

// ── Tool Handlers ──

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (!args) {
    throw new Error("Missing arguments");
  }

  try {
    if (lastScanTime === 0) {
      await performScan();
    }

    switch (name) {
      case "find_component": {
        const componentName = args.name as string;
        const entries = graph.getAllByName(componentName);

        if (entries.length === 0) {
          const matches = graph.search(componentName, 5);
          if (matches.length > 0) {
            return {
              content: [{
                type: "text",
                text: `Component '${componentName}' not found. Did you mean:\n${matches.map((m) => `  - ${m.name} (${m.definedIn}, used ${m.usageCount} times)`).join("\n")}`,
              }],
            };
          }
          return {
            content: [{ type: "text", text: `Component '${componentName}' not found in the component graph.` }],
            isError: true,
          };
        }

        const primary = entries[0];
        const navPath = navigation.resolveNavigationPath(componentName, graph);

        const result: FindComponentResult = {
          name: primary.name,
          definedIn: primary.definedIn,
          usedIn: primary.usedIn,
          usageCount: primary.usageCount,
          emits: primary.emits,
          tabs: primary.tabs,
          navigationPath: navPath || undefined,
        };

        if (entries.length > 1) {
          result.variants = entries.slice(1).map((e): ComponentVariant => ({
            definedIn: e.definedIn,
            usedIn: e.usedIn,
            usageCount: e.usageCount,
            emits: e.emits,
            tabs: e.tabs,
          }));
        }

        const allPaths = navigation.resolveAllPaths(componentName, graph);
        if (allPaths.length > 1) {
          result.allPaths = allPaths;
        }

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "get_navigation_path": {
        const target = args.target as string;
        const path = navigation.resolveNavigationPath(target, graph);

        if (!path) {
          return {
            content: [{
              type: "text",
              text: `No navigation path found for '${target}'. Try using find_component or search_components to locate it first.`,
            }],
          };
        }

        const allPaths = navigation.resolveAllPaths(target, graph);
        if (allPaths.length > 1) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                primaryPath: path,
                allPaths,
                note: `${target} is reachable via ${allPaths.length} different routes.`,
              }, null, 2),
            }],
          };
        }

        return {
          content: [{ type: "text", text: JSON.stringify(path, null, 2) }],
        };
      }

      case "get_screen_components": {
        const screenName = args.screenName as string;
        const includeModals = (args.includeModals as boolean) !== false;
        const result = navigation.getScreenComponents(screenName, graph, includeModals);

        if (!result) {
          return {
            content: [{
              type: "text",
              text: `Screen '${screenName}' not found. Available screens:\n${navigation.getData().sidebarViews.map((v) => `  - ${v.label}`).join("\n")}`,
            }],
          };
        }

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "refresh_component_index": {
        const stats = await performScan();
        return {
          content: [{
            type: "text",
            text: `Component index refreshed.\n` +
              `Total components: ${stats.totalComponents}\n` +
              `Total usage edges: ${stats.totalUsages}\n` +
              `Orphaned components (defined but never used): ${stats.orphanCount}\n` +
              `Name collisions detected: ${stats.nameCollisions}\n` +
              `Last scan: ${new Date(lastScanTime).toISOString()}`,
          }],
        };
      }

      case "search_components": {
        const query = args.query as string;
        const limit = (args.limit as number) || 10;
        const matches = graph.search(query, limit);

        if (matches.length === 0) {
          return {
            content: [{ type: "text", text: `No components matching '${query}' found.` }],
          };
        }

        const results: SearchComponentResult[] = matches.map((m) => ({
          name: m.name,
          definedIn: m.definedIn,
          usageCount: m.usageCount,
          usedIn: m.usedIn.map((u) => u.file),
          emits: m.emits,
          tabs: m.tabs,
        }));

        return {
          content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
        };
      }

      case "update_navigation_entry": {
        const section = args.section as string;
        const key = args.key as string;
        const data = args.data as Record<string, unknown>;

        navigation.updateEntry(section, key, data);

        return {
          content: [{
            type: "text",
            text: `Updated ${section}.${key} in navigation-data.json.`,
          }],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error: ${msg}` }],
      isError: true,
    };
  }
});

// ── Startup ──

async function main() {
  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("DnD Component Map MCP Server v1.0.0 running");
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

main();
