#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import Database from "better-sqlite3";
import { existsSync } from "fs";
import { resolve } from "path";

// ─── Types ───────────────────────────────────────────────────────────────────

interface ColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface ForeignKeyInfo {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string;
  on_update: string;
  on_delete: string;
}

interface IndexInfo {
  name: string;
  unique: number;
  origin: string;
  partial: number;
}

interface TableInfo {
  name: string;
  columns: ColumnInfo[];
  primaryKey: string[];
  foreignKeys: ForeignKeyInfo[];
  indexes: IndexInfo[];
  rowCount?: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getDbPath(): string {
  return process.env.DB_PATH || "";
}

function openDb(): Database.Database {
  const dbPath = getDbPath();
  if (!dbPath) throw new Error("DB_PATH environment variable is not set");
  const resolved = resolve(dbPath);
  if (!existsSync(resolved)) throw new Error(`Database file not found: ${resolved}`);
  return new Database(resolved, { readonly: true });
}

function getTableNames(db: Database.Database): string[] {
  const rows = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all() as { name: string }[];
  return rows.map((r) => r.name);
}

function getTableInfo(db: Database.Database, tableName: string): TableInfo {
  const columns = db.prepare(`PRAGMA table_info(${JSON.stringify(tableName)})`).all() as ColumnInfo[];
  const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${JSON.stringify(tableName)})`).all() as ForeignKeyInfo[];
  const indexList = db.prepare(`PRAGMA index_list(${JSON.stringify(tableName)})`).all() as IndexInfo[];
  const primaryKey = columns.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);

  let rowCount: number | undefined;
  try {
    const countRow = db.prepare(`SELECT COUNT(*) as count FROM ${JSON.stringify(tableName)}`).get() as { count: number };
    rowCount = countRow.count;
  } catch { /* ignore */ }

  return { name: tableName, columns, primaryKey, foreignKeys, indexes: indexList, rowCount };
}

// ─── Tool: list_entities ─────────────────────────────────────────────────────

function listEntities(): object {
  const db = openDb();
  try {
    const names = getTableNames(db);
    const summary = names.map((name) => {
      const cols = db.prepare(`PRAGMA table_info(${JSON.stringify(name)})`).all() as ColumnInfo[];
      const pk = cols.filter((c) => c.pk > 0).map((c) => c.name);
      const fkRows = db.prepare(`PRAGMA foreign_key_list(${JSON.stringify(name)})`).all() as ForeignKeyInfo[];
      return {
        table: name,
        columnCount: cols.length,
        primaryKey: pk,
        hasForeignKeys: fkRows.length > 0,
        referencedTables: [...new Set(fkRows.map((fk) => fk.table))],
      };
    });
    return {
      databasePath: getDbPath(),
      tableCount: names.length,
      tables: summary,
    };
  } finally {
    db.close();
  }
}

// ─── Tool: get_entity_schema ──────────────────────────────────────────────────

function getEntitySchema(tableName: string): object {
  const db = openDb();
  try {
    const names = getTableNames(db);
    if (!names.includes(tableName)) {
      throw new Error(`Table '${tableName}' not found. Available: ${names.join(", ")}`);
    }
    const info = getTableInfo(db, tableName);
    return {
      table: info.name,
      rowCount: info.rowCount,
      primaryKey: info.primaryKey,
      columns: info.columns.map((c) => ({
        name: c.name,
        type: c.type,
        nullable: c.notnull === 0,
        defaultValue: c.dflt_value,
        isPrimaryKey: c.pk > 0,
      })),
      foreignKeys: info.foreignKeys.map((fk) => ({
        column: fk.from,
        referencesTable: fk.table,
        referencesColumn: fk.to,
        onDelete: fk.on_delete,
        onUpdate: fk.on_update,
      })),
      indexes: info.indexes.map((idx) => ({
        name: idx.name,
        unique: idx.unique === 1,
      })),
    };
  } finally {
    db.close();
  }
}

// ─── Tool: get_entity_relationships ───────────────────────────────────────────

function getEntityRelationships(tableName?: string): object {
  const db = openDb();
  try {
    const names = getTableNames(db);

    // Build full relationship graph
    const relationships: {
      from: string;
      fromColumn: string;
      to: string;
      toColumn: string;
      onDelete: string;
    }[] = [];

    for (const name of names) {
      const fks = db.prepare(`PRAGMA foreign_key_list(${JSON.stringify(name)})`).all() as ForeignKeyInfo[];
      for (const fk of fks) {
        relationships.push({
          from: name,
          fromColumn: fk.from,
          to: fk.table,
          toColumn: fk.to,
          onDelete: fk.on_delete,
        });
      }
    }

    if (tableName) {
      if (!names.includes(tableName)) {
        throw new Error(`Table '${tableName}' not found. Available: ${names.join(", ")}`);
      }
      const outgoing = relationships.filter((r) => r.from === tableName);
      const incoming = relationships.filter((r) => r.to === tableName);
      return {
        table: tableName,
        outgoingRelationships: outgoing,
        incomingRelationships: incoming,
        relatedTables: [...new Set([...outgoing.map((r) => r.to), ...incoming.map((r) => r.from)])],
      };
    }

    // Full graph summary
    const tableRelMap: Record<string, { references: string[]; referencedBy: string[] }> = {};
    for (const name of names) tableRelMap[name] = { references: [], referencedBy: [] };
    for (const rel of relationships) {
      if (!tableRelMap[rel.from].references.includes(rel.to)) tableRelMap[rel.from].references.push(rel.to);
      if (!tableRelMap[rel.to].referencedBy.includes(rel.from)) tableRelMap[rel.to].referencedBy.push(rel.from);
    }

    return {
      totalRelationships: relationships.length,
      relationships,
      tableGraph: Object.entries(tableRelMap).map(([table, data]) => ({ table, ...data })),
    };
  } finally {
    db.close();
  }
}

// ─── Tool: validate_dto_against_entity ────────────────────────────────────────

function validateDtoAgainstEntity(tableName: string, dtoFields: string[]): object {
  const db = openDb();
  try {
    const names = getTableNames(db);
    if (!names.includes(tableName)) {
      throw new Error(`Table '${tableName}' not found. Available: ${names.join(", ")}`);
    }

    const cols = db.prepare(`PRAGMA table_info(${JSON.stringify(tableName)})`).all() as ColumnInfo[];
    const columnNames = cols.map((c) => c.name.toLowerCase());
    const dtoLower = dtoFields.map((f) => f.toLowerCase());

    // Fields in DTO but not in table (potential typos or deprecated columns)
    const notInTable = dtoFields.filter((f) => !columnNames.includes(f.toLowerCase()));

    // Required columns (NOT NULL, no default, not PK) missing from DTO
    const requiredCols = cols.filter((c) =>
      c.notnull === 1 && c.dflt_value === null && c.pk === 0
    );
    const missingRequired = requiredCols.filter((c) => !dtoLower.includes(c.name.toLowerCase()));

    // Non-nullable columns not in DTO (warning — might be set server-side)
    const nonNullableCols = cols.filter((c) => c.notnull === 1 && c.pk === 0);
    const missingNonNullable = nonNullableCols.filter((c) => !dtoLower.includes(c.name.toLowerCase()));

    const issues: { severity: string; field: string; message: string }[] = [];

    for (const f of notInTable) {
      issues.push({ severity: "warning", field: f, message: `DTO field '${f}' has no matching column in '${tableName}'` });
    }
    for (const c of missingRequired) {
      issues.push({ severity: "error", field: c.name, message: `Required column '${c.name}' (NOT NULL, no default) is missing from DTO` });
    }
    for (const c of missingNonNullable) {
      if (!missingRequired.find((r) => r.name === c.name)) {
        issues.push({ severity: "info", field: c.name, message: `Non-nullable column '${c.name}' is not in DTO (may be set server-side)` });
      }
    }

    return {
      table: tableName,
      dtoFields,
      columnCount: cols.length,
      issues,
      verdict: issues.filter((i) => i.severity === "error").length === 0 ? "valid" : "invalid",
    };
  } finally {
    db.close();
  }
}

// ─── Tool: suggest_dto_validation ────────────────────────────────────────────

function suggestDtoValidation(tableName: string): object {
  const db = openDb();
  try {
    const names = getTableNames(db);
    if (!names.includes(tableName)) {
      throw new Error(`Table '${tableName}' not found. Available: ${names.join(", ")}`);
    }

    const cols = db.prepare(`PRAGMA table_info(${JSON.stringify(tableName)})`).all() as ColumnInfo[];
    const fks = db.prepare(`PRAGMA foreign_key_list(${JSON.stringify(tableName)})`).all() as ForeignKeyInfo[];
    const fkFromCols = new Set(fks.map((fk) => fk.from.toLowerCase()));

    const suggestions = cols
      .filter((c) => c.pk === 0) // Skip primary key — usually auto-generated
      .map((c) => {
        const decorators: string[] = [];
        const isOptional = c.notnull === 0 || c.dflt_value !== null;
        if (isOptional) decorators.push("@IsOptional()");

        const typeLower = c.type.toLowerCase();
        const colLower = c.name.toLowerCase();

        if (fkFromCols.has(colLower)) {
          decorators.push("@IsUUID()");
        } else if (typeLower.includes("uuid") || colLower.endsWith("id") || colLower.endsWith("uuid")) {
          decorators.push("@IsUUID()");
        } else if (typeLower.includes("int") || typeLower.includes("integer")) {
          decorators.push("@IsInt()");
          if (colLower.includes("hp") || colLower.includes("health") || colLower.includes("points")) {
            decorators.push("@Min(0)");
          }
          if (colLower.includes("level")) {
            decorators.push("@Min(1)", "@Max(20)");
          }
          if (colLower.includes("spell_level") || colLower === "level" && tableName.toLowerCase().includes("spell")) {
            decorators.push("@Min(0)", "@Max(9)");
          }
          if (colLower.includes("ability") || colLower.includes("score") || colLower.includes("str") ||
              colLower.includes("dex") || colLower.includes("con") || colLower.includes("wis") ||
              colLower.includes("int") || colLower.includes("cha")) {
            decorators.push("@Min(1)", "@Max(30)");
          }
        } else if (typeLower.includes("real") || typeLower.includes("float") || typeLower.includes("numeric")) {
          decorators.push("@IsNumber()");
        } else if (typeLower.includes("bool") || typeLower.includes("boolean")) {
          decorators.push("@IsBoolean()");
        } else if (typeLower === "text" || typeLower.includes("varchar") || typeLower.includes("char")) {
          decorators.push("@IsString()", "@MaxLength(255)");
          if (colLower.includes("name") || colLower.includes("title")) {
            decorators.push("// Consider @MaxLength(100) for name fields");
          }
          if (colLower.includes("notes") || colLower.includes("description") || colLower.includes("bio")) {
            decorators.push("// Consider @MaxLength(2000) for text content fields");
          }
        } else if (typeLower.includes("json") || typeLower.includes("blob")) {
          decorators.push("// Use @IsObject() or @ValidateNested() with class-transformer");
        }

        return {
          column: c.name,
          sqlType: c.type,
          nullable: c.notnull === 0,
          defaultValue: c.dflt_value,
          suggestedDecorators: decorators,
          tsType: fkFromCols.has(colLower) ? "string" :
                  typeLower.includes("int") ? "number" :
                  typeLower.includes("real") || typeLower.includes("float") ? "number" :
                  typeLower.includes("bool") ? "boolean" : "string",
        };
      });

    return {
      table: tableName,
      suggestions,
      note: "These are starting-point suggestions. Add domain-specific constraints based on D&D rules (HP, level, ability scores, etc.)",
    };
  } finally {
    db.close();
  }
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new Server(
  { name: "dnd-database-schema", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools: Tool[] = [
    {
      name: "list_entities",
      description: "List all tables in the dnd-api SQLite database with column counts, primary keys, and foreign key summary.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_entity_schema",
      description: "Get full schema for a specific table: columns with types/nullability, primary key, foreign keys, indexes, and row count.",
      inputSchema: {
        type: "object",
        properties: {
          tableName: { type: "string", description: "Name of the SQLite table (e.g., 'character', 'spell', 'combat_log')" },
        },
        required: ["tableName"],
      },
    },
    {
      name: "get_entity_relationships",
      description: "Show foreign key relationships between tables. Pass tableName to get relationships for one table, or omit to get the full relationship graph.",
      inputSchema: {
        type: "object",
        properties: {
          tableName: { type: "string", description: "Optional: specific table to analyze relationships for" },
        },
      },
    },
    {
      name: "validate_dto_against_entity",
      description: "Check if DTO fields match a database table's columns. Identifies fields in the DTO that have no matching column, and required columns missing from the DTO.",
      inputSchema: {
        type: "object",
        properties: {
          tableName: { type: "string", description: "Database table name to validate against" },
          dtoFields: {
            type: "array",
            items: { type: "string" },
            description: "List of DTO property names to validate (e.g., ['characterName', 'level', 'hitPoints'])",
          },
        },
        required: ["tableName", "dtoFields"],
      },
    },
    {
      name: "suggest_dto_validation",
      description: "Suggest class-validator decorators for each column in a table. Includes D&D-specific range hints (HP min 0, level 1-20, ability scores 1-30).",
      inputSchema: {
        type: "object",
        properties: {
          tableName: { type: "string", description: "Database table to generate DTO suggestions for" },
        },
        required: ["tableName"],
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
      case "list_entities":
        result = listEntities();
        break;
      case "get_entity_schema":
        result = getEntitySchema(args?.tableName as string);
        break;
      case "get_entity_relationships":
        result = getEntityRelationships(args?.tableName as string | undefined);
        break;
      case "validate_dto_against_entity":
        result = validateDtoAgainstEntity(args?.tableName as string, args?.dtoFields as string[]);
        break;
      case "suggest_dto_validation":
        result = suggestDtoValidation(args?.tableName as string);
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
    console.error("DnD Database Schema MCP Server running");
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

main();
