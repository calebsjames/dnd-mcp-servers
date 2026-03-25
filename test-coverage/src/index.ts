#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { execSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { resolve, join, relative } from "path";

const FRONTEND_PATH = resolve(
  process.env.FRONTEND_PATH || "/Users/calebjames/workspace/foreward/dnd-ui"
);
const BACKEND_PATH = resolve(
  process.env.BACKEND_PATH || "/Users/calebjames/workspace/foreward/dnd-api"
);

// Coverage JSON types
interface CoverageSummaryMetric {
  total: number;
  covered: number;
  skipped: number;
  pct: number;
}

interface CoverageSummaryEntry {
  lines: CoverageSummaryMetric;
  statements: CoverageSummaryMetric;
  functions: CoverageSummaryMetric;
  branches: CoverageSummaryMetric;
}

interface CoverageSummaryJson {
  total: CoverageSummaryEntry;
  [filePath: string]: CoverageSummaryEntry;
}

interface CoverageFinalEntry {
  path: string;
  fnMap: Record<string, { name: string; decl: { start: { line: number; column: number }; end: { line: number; column: number } }; loc: { start: { line: number; column: number }; end: { line: number; column: number } } }>;
  f: Record<string, number>;
  statementMap: Record<string, { start: { line: number; column: number }; end: { line: number; column: number } }>;
  s: Record<string, number>;
  branchMap: Record<string, { type: string; loc: { start: { line: number; column: number }; end: { line: number; column: number } }; locations: { start: { line: number; column: number }; end: { line: number; column: number } }[] }>;
  b: Record<string, number[]>;
}

interface CoverageFinalJson {
  [filePath: string]: CoverageFinalEntry;
}

// Infer target from file path
function inferTarget(filePath: string): "frontend" | "backend" {
  if (filePath.includes(BACKEND_PATH) || filePath.includes("dnd-api")) return "backend";
  return "frontend";
}

// Tool implementations — Frontend (Vitest)

function getCoverageSummaryFrontend(): object {
  if (!existsSync(FRONTEND_PATH)) {
    throw new Error(`Frontend path does not exist: ${FRONTEND_PATH}`);
  }

  try {
    execSync("npx vitest run --coverage --reporter=json-summary", {
      cwd: FRONTEND_PATH,
      timeout: 120_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`Frontend coverage command exited with error (may still have coverage data): ${errMsg}`);
  }

  const summaryPath = join(FRONTEND_PATH, "coverage", "coverage-summary.json");
  if (!existsSync(summaryPath)) {
    throw new Error(
      `Frontend coverage summary not found at ${summaryPath}. The coverage command may have failed entirely.`
    );
  }

  const raw = readFileSync(summaryPath, "utf-8");
  const summary: CoverageSummaryJson = JSON.parse(raw);

  const files: { file: string; statements: number; branches: number; functions: number; lines: number }[] = [];

  for (const [filePath, entry] of Object.entries(summary)) {
    if (filePath === "total") continue;
    const relPath = relative(FRONTEND_PATH, filePath);
    files.push({
      file: relPath,
      statements: entry.statements.pct,
      branches: entry.branches.pct,
      functions: entry.functions.pct,
      lines: entry.lines.pct,
    });
  }

  files.sort((a, b) => a.lines - b.lines);
  const totals = summary.total;

  return {
    target: "frontend",
    totals: {
      statements: totals.statements.pct,
      branches: totals.branches.pct,
      functions: totals.functions.pct,
      lines: totals.lines.pct,
    },
    fileCount: files.length,
    files,
  };
}

// Tool implementations — Backend (Jest 30)

function getCoverageSummaryBackend(): object {
  if (!existsSync(BACKEND_PATH)) {
    throw new Error(`Backend path does not exist: ${BACKEND_PATH}`);
  }

  try {
    execSync("npm run test:cov -- --forceExit", {
      cwd: BACKEND_PATH,
      timeout: 180_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`Backend coverage command exited with error (may still have coverage data): ${errMsg}`);
  }

  const summaryPath = join(BACKEND_PATH, "coverage", "coverage-summary.json");
  if (!existsSync(summaryPath)) {
    throw new Error(
      `Backend coverage summary not found at ${summaryPath}. Run 'npm run test:cov' first or check jest configuration.`
    );
  }

  const raw = readFileSync(summaryPath, "utf-8");
  const summary: CoverageSummaryJson = JSON.parse(raw);

  const files: { file: string; statements: number; branches: number; functions: number; lines: number }[] = [];

  for (const [filePath, entry] of Object.entries(summary)) {
    if (filePath === "total") continue;
    const relPath = relative(BACKEND_PATH, filePath);
    files.push({
      file: relPath,
      statements: entry.statements.pct,
      branches: entry.branches.pct,
      functions: entry.functions.pct,
      lines: entry.lines.pct,
    });
  }

  files.sort((a, b) => a.lines - b.lines);
  const totals = summary.total;

  return {
    target: "backend",
    totals: {
      statements: totals.statements.pct,
      branches: totals.branches.pct,
      functions: totals.functions.pct,
      lines: totals.lines.pct,
    },
    fileCount: files.length,
    files,
  };
}

function getCoverageSummary(target?: string): object {
  if (target === "frontend") return getCoverageSummaryFrontend();
  if (target === "backend") return getCoverageSummaryBackend();
  // Both: run both and merge
  const fe = getCoverageSummaryFrontend() as Record<string, unknown>;
  const be = getCoverageSummaryBackend() as Record<string, unknown>;
  return { frontend: fe, backend: be };
}

function getUncoveredFunctions(filePath: string, target?: string): object {
  const resolvedTarget = target || inferTarget(filePath);
  const basePath = resolvedTarget === "backend" ? BACKEND_PATH : FRONTEND_PATH;

  if (!existsSync(basePath)) {
    throw new Error(`${resolvedTarget} path does not exist: ${basePath}`);
  }

  if (resolvedTarget === "backend") {
    try {
      execSync("npm run test:cov -- --forceExit", {
        cwd: BACKEND_PATH,
        timeout: 180_000,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`Backend coverage command exited with error: ${errMsg}`);
    }
  } else {
    try {
      execSync("npx vitest run --coverage --reporter=json", {
        cwd: FRONTEND_PATH,
        timeout: 120_000,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`Frontend coverage command exited with error: ${errMsg}`);
    }
  }

  const absoluteCoveragePath = resolve(basePath, filePath);
  const finalPath = join(basePath, "coverage", "coverage-final.json");
  if (!existsSync(finalPath)) {
    throw new Error(
      `Coverage final data not found at ${finalPath}. The coverage command may have failed entirely.`
    );
  }

  const raw = readFileSync(finalPath, "utf-8");
  const coverageData: CoverageFinalJson = JSON.parse(raw);

  let entry: CoverageFinalEntry | undefined;
  for (const [key, value] of Object.entries(coverageData)) {
    if (key === absoluteCoveragePath || key.endsWith(filePath) || relative(basePath, key) === filePath) {
      entry = value;
      break;
    }
  }

  if (!entry) {
    throw new Error(
      `File "${filePath}" not found in ${resolvedTarget} coverage data. Available files: ${Object.keys(coverageData)
        .map((k) => relative(basePath, k))
        .slice(0, 20)
        .join(", ")}${Object.keys(coverageData).length > 20 ? "..." : ""}`
    );
  }

  const uncoveredFunctions: string[] = [];
  for (const [fnId, count] of Object.entries(entry.f)) {
    if (count === 0) {
      const fnInfo = entry.fnMap[fnId];
      if (fnInfo) {
        uncoveredFunctions.push(fnInfo.name || `(anonymous@line:${fnInfo.loc.start.line})`);
      }
    }
  }

  return {
    file: filePath,
    target: resolvedTarget,
    uncoveredFunctions,
  };
}

function getCoverageForFile(filePath: string, target?: string): object {
  const resolvedTarget = target || inferTarget(filePath);
  const basePath = resolvedTarget === "backend" ? BACKEND_PATH : FRONTEND_PATH;

  if (!existsSync(basePath)) {
    throw new Error(`${resolvedTarget} path does not exist: ${basePath}`);
  }

  if (resolvedTarget === "backend") {
    try {
      execSync("npm run test:cov -- --forceExit", {
        cwd: BACKEND_PATH,
        timeout: 180_000,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`Backend coverage command exited with error: ${errMsg}`);
    }
  } else {
    try {
      execSync("npx vitest run --coverage --reporter=json", {
        cwd: FRONTEND_PATH,
        timeout: 120_000,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`Frontend coverage command exited with error: ${errMsg}`);
    }
  }

  const absoluteCoveragePath = resolve(basePath, filePath);
  const finalPath = join(basePath, "coverage", "coverage-final.json");
  if (!existsSync(finalPath)) {
    throw new Error(
      `Coverage final data not found at ${finalPath}. The coverage command may have failed entirely.`
    );
  }

  const raw = readFileSync(finalPath, "utf-8");
  const coverageData: CoverageFinalJson = JSON.parse(raw);

  let entry: CoverageFinalEntry | undefined;
  for (const [key, value] of Object.entries(coverageData)) {
    if (key === absoluteCoveragePath || key.endsWith(filePath) || relative(basePath, key) === filePath) {
      entry = value;
      break;
    }
  }

  if (!entry) {
    throw new Error(
      `File "${filePath}" not found in ${resolvedTarget} coverage data. Available files: ${Object.keys(coverageData)
        .map((k) => relative(basePath, k))
        .slice(0, 20)
        .join(", ")}${Object.keys(coverageData).length > 20 ? "..." : ""}`
    );
  }

  const functions: { name: string; covered: boolean }[] = [];
  for (const [fnId, count] of Object.entries(entry.f)) {
    const fnInfo = entry.fnMap[fnId];
    if (fnInfo) {
      functions.push({
        name: fnInfo.name || `(anonymous@line:${fnInfo.loc.start.line})`,
        covered: count > 0,
      });
    }
  }

  const uncoveredLineNumbers: number[] = [];
  for (const [stmtId, count] of Object.entries(entry.s)) {
    if (count === 0) {
      const stmtInfo = entry.statementMap[stmtId];
      if (stmtInfo) {
        for (let line = stmtInfo.start.line; line <= stmtInfo.end.line; line++) {
          if (!uncoveredLineNumbers.includes(line)) {
            uncoveredLineNumbers.push(line);
          }
        }
      }
    }
  }

  uncoveredLineNumbers.sort((a, b) => a - b);
  const uncoveredLines: number[][] = [];
  let rangeStart = -1;
  let rangeEnd = -1;

  for (const line of uncoveredLineNumbers) {
    if (rangeStart === -1) {
      rangeStart = line;
      rangeEnd = line;
    } else if (line === rangeEnd + 1) {
      rangeEnd = line;
    } else {
      uncoveredLines.push([rangeStart, rangeEnd]);
      rangeStart = line;
      rangeEnd = line;
    }
  }
  if (rangeStart !== -1) {
    uncoveredLines.push([rangeStart, rangeEnd]);
  }

  let totalBranches = 0;
  let coveredBranches = 0;
  for (const [, counts] of Object.entries(entry.b)) {
    for (const count of counts) {
      totalBranches++;
      if (count > 0) coveredBranches++;
    }
  }

  return {
    file: filePath,
    target: resolvedTarget,
    functions,
    uncoveredLines,
    branchCoverage: {
      total: totalBranches,
      covered: coveredBranches,
      percentage: totalBranches > 0
        ? Number(((coveredBranches / totalBranches) * 100).toFixed(2))
        : 100,
    },
  };
}

// MCP Server setup
const server = new Server(
  { name: "dnd-test-coverage", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools: Tool[] = [
    {
      name: "get_coverage_summary",
      description:
        "Run test coverage and return per-file summary sorted by lowest coverage. Supports frontend (Vitest), backend (Jest), or both. " +
        "Default (no target) runs both and returns separate sections.",
      inputSchema: {
        type: "object",
        properties: {
          target: {
            type: "string",
            enum: ["frontend", "backend", "both"],
            description: "Which repo to run coverage for. Omit to run both.",
          },
        },
      },
    },
    {
      name: "get_uncovered_functions",
      description:
        "Get the list of uncovered (zero-hit) function names for a specific file. " +
        "Target is auto-detected from file path (dnd-api = backend, otherwise frontend).",
      inputSchema: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description:
              "Relative path to the source file from the repo root (e.g., 'src/character/character.service.ts')",
          },
          target: {
            type: "string",
            enum: ["frontend", "backend"],
            description: "Override auto-detection of frontend vs backend.",
          },
        },
        required: ["filePath"],
      },
    },
    {
      name: "get_coverage_for_file",
      description:
        "Get detailed coverage data for a specific file: function coverage (name + covered boolean), uncovered line ranges, and branch coverage stats. " +
        "Target is auto-detected from file path.",
      inputSchema: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description:
              "Relative path to the source file from the repo root (e.g., 'src/character/character.service.ts')",
          },
          target: {
            type: "string",
            enum: ["frontend", "backend"],
            description: "Override auto-detection of frontend vs backend.",
          },
        },
        required: ["filePath"],
      },
    },
  ];

  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result: object;

    switch (name) {
      case "get_coverage_summary": {
        const target = args?.target as string | undefined;
        result = getCoverageSummary(target);
        break;
      }

      case "get_uncovered_functions": {
        const filePath = args?.filePath as string;
        if (!filePath) throw new Error("Missing required parameter: filePath");
        const target = args?.target as string | undefined;
        result = getUncoveredFunctions(filePath, target);
        break;
      }

      case "get_coverage_for_file": {
        const filePath = args?.filePath as string;
        if (!filePath) throw new Error("Missing required parameter: filePath");
        const target = args?.target as string | undefined;
        result = getCoverageForFile(filePath, target);
        break;
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
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
    console.error("DnD Test Coverage MCP Server v2 running (frontend + backend)");
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

main();
