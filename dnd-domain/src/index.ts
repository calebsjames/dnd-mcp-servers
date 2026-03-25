#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const KNOWLEDGE_DIR = join(__dirname, "../knowledge");

// Helper: Load all knowledge files
function loadKnowledgeFiles(): Map<string, string> {
  const files = new Map<string, string>();

  try {
    const fileNames = readdirSync(KNOWLEDGE_DIR).filter((f) => f.endsWith(".md"));

    for (const fileName of fileNames) {
      const filePath = join(KNOWLEDGE_DIR, fileName);
      const content = readFileSync(filePath, "utf-8");
      files.set(fileName, content);
    }
  } catch (error) {
    console.error("Error loading knowledge files:", error);
  }

  return files;
}

// Helper: Search knowledge base
function searchKnowledge(query: string, files: Map<string, string>): Array<{ file: string; matches: string[] }> {
  const results: Array<{ file: string; matches: string[] }> = [];
  const searchTerm = query.toLowerCase();

  for (const [fileName, content] of files.entries()) {
    const lines = content.split("\n");
    const matches: string[] = [];

    lines.forEach((line, index) => {
      if (line.toLowerCase().includes(searchTerm)) {
        const start = Math.max(0, index - 1);
        const end = Math.min(lines.length - 1, index + 1);
        const context = lines.slice(start, end + 1).join("\n");
        matches.push(context);
      }
    });

    if (matches.length > 0) {
      results.push({ file: fileName, matches });
    }
  }

  return results;
}

// Helper: Extract domain terms from glossary
function extractDomainTerms(content: string): Map<string, string> {
  const terms = new Map<string, string>();
  const lines = content.split("\n");

  let currentTerm: string | null = null;
  let currentDefinition: string[] = [];

  for (const line of lines) {
    const headerMatch = line.match(/^##\s+(.+)$/);
    const boldMatch = line.match(/^\*\*(.+?)\*\*:?\s*(.*)$/);

    if (headerMatch || boldMatch) {
      if (currentTerm && currentDefinition.length > 0) {
        terms.set(currentTerm.toLowerCase(), currentDefinition.join(" ").trim());
      }

      currentTerm = (headerMatch?.[1] || boldMatch?.[1])?.trim() || null;
      currentDefinition = boldMatch?.[2] ? [boldMatch[2]] : [];
    } else if (currentTerm && line.trim()) {
      currentDefinition.push(line.trim());
    }
  }

  if (currentTerm && currentDefinition.length > 0) {
    terms.set(currentTerm.toLowerCase(), currentDefinition.join(" ").trim());
  }

  return terms;
}

// MCP Server setup
const server = new Server(
  { name: "dnd-domain", version: "1.0.0" },
  { capabilities: { tools: {}, resources: {} } }
);

const knowledgeFiles = loadKnowledgeFiles();

// List available resources (knowledge documents)
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const resources = Array.from(knowledgeFiles.keys()).map((fileName) => ({
    uri: `dnd-domain://knowledge/${fileName}`,
    name: fileName.replace(".md", "").replace(/-/g, " "),
    mimeType: "text/markdown",
    description: `D&D 5e domain knowledge: ${fileName.replace(".md", "")}`,
  }));

  return { resources };
});

// Read specific resource
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri;
  const fileName = uri.replace("dnd-domain://knowledge/", "");

  const content = knowledgeFiles.get(fileName);
  if (!content) {
    throw new Error(`Resource not found: ${fileName}`);
  }

  return {
    contents: [{
      uri,
      mimeType: "text/markdown",
      text: content,
    }],
  };
});

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools: Tool[] = [
    {
      name: "explain_domain_term",
      description: "Get a D&D 5e-specific definition and explanation for a domain term (e.g., 'armor class', 'spell slot', 'concentration', 'saving throw')",
      inputSchema: {
        type: "object",
        properties: {
          term: {
            type: "string",
            description: "The D&D 5e term to explain",
          },
        },
        required: ["term"],
      },
    },
    {
      name: "search_knowledge",
      description: "Search across all D&D 5e domain knowledge documents for information about a topic",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search term or phrase (e.g., 'concentration', 'hit points', 'short rest')",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "validate_business_logic",
      description: "Check if a proposed business logic or UI workflow matches documented D&D 5e rules. Returns relevant rule sections.",
      inputSchema: {
        type: "object",
        properties: {
          description: {
            type: "string",
            description: "Description of the logic or workflow to validate (e.g., 'player can cast two concentration spells simultaneously')",
          },
        },
        required: ["description"],
      },
    },
    {
      name: "suggest_field_constraints",
      description: "Get domain-appropriate value ranges and constraints for a specific D&D 5e field",
      inputSchema: {
        type: "object",
        properties: {
          entityType: {
            type: "string",
            description: "Entity type (e.g., 'character', 'spell', 'item', 'monster')",
          },
          fieldName: {
            type: "string",
            description: "Field name (e.g., 'armorClass', 'spellLevel', 'abilityScore', 'hitPoints')",
          },
        },
        required: ["entityType", "fieldName"],
      },
    },
  ];

  return { tools };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (!args) {
    throw new Error("Missing arguments");
  }

  try {
    switch (name) {
      case "explain_domain_term": {
        const term = (args.term as string).toLowerCase();

        const terminologyContent = knowledgeFiles.get("dnd-terminology.md");
        if (!terminologyContent) {
          return {
            content: [{
              type: "text",
              text: "D&D terminology knowledge base not found. Please add dnd-terminology.md to the knowledge directory.",
            }],
          };
        }

        const terms = extractDomainTerms(terminologyContent);
        const definition = terms.get(term);

        if (definition) {
          return {
            content: [{
              type: "text",
              text: `**${args.term}**: ${definition}`,
            }],
          };
        } else {
          const searchResults = searchKnowledge(term, knowledgeFiles);
          if (searchResults.length > 0) {
            const result = searchResults[0];
            return {
              content: [{
                type: "text",
                text: `Term '${args.term}' found in ${result.file}:\n\n${result.matches.join("\n\n---\n\n")}`,
              }],
            };
          } else {
            return {
              content: [{
                type: "text",
                text: `Term '${args.term}' not found in knowledge base. Consider adding it to dnd-terminology.md.`,
              }],
            };
          }
        }
      }

      case "search_knowledge": {
        const query = args.query as string;
        const results = searchKnowledge(query, knowledgeFiles);

        if (results.length === 0) {
          return {
            content: [{
              type: "text",
              text: `No results found for: ${query}`,
            }],
          };
        }

        const formatted = results
          .map((r) => `## ${r.file}\n\n${r.matches.slice(0, 3).join("\n\n---\n\n")}`)
          .join("\n\n========\n\n");

        return {
          content: [{
            type: "text",
            text: `Found ${results.length} document(s) matching "${query}":\n\n${formatted}`,
          }],
        };
      }

      case "validate_business_logic": {
        const description = args.description as string;

        const rulesContent = knowledgeFiles.get("character-rules.md");
        const combatContent = knowledgeFiles.get("combat-rules.md");
        const spellContent = knowledgeFiles.get("spell-rules.md");

        const allContent = [rulesContent, combatContent, spellContent].filter(Boolean).join("\n\n");
        if (!allContent) {
          return {
            content: [{
              type: "text",
              text: "D&D rules documentation not found. Please add character-rules.md, combat-rules.md, and spell-rules.md.",
            }],
          };
        }

        const keywords = description.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
        const relevantSections: string[] = [];
        const lines = allContent.split("\n");

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].toLowerCase();
          if (keywords.some((k) => line.includes(k))) {
            const start = Math.max(0, i - 2);
            const end = Math.min(lines.length - 1, i + 3);
            relevantSections.push(lines.slice(start, end + 1).join("\n"));
          }
        }

        if (relevantSections.length === 0) {
          return {
            content: [{
              type: "text",
              text: `No directly matching rules found. Review character-rules.md, combat-rules.md, and spell-rules.md manually.\n\nYour logic: ${description}`,
            }],
          };
        }

        return {
          content: [{
            type: "text",
            text: `Found relevant D&D rules for: "${description}"\n\n${relevantSections.slice(0, 3).join("\n\n---\n\n")}\n\nValidate your logic against these documented rules.`,
          }],
        };
      }

      case "suggest_field_constraints": {
        const entityType = (args.entityType as string).toLowerCase();
        const fieldName = (args.fieldName as string).toLowerCase();

        // Common D&D 5e field constraints
        const constraints: Record<string, { type: string; min?: number; max?: number; values?: string[]; description: string }> = {
          "ability score": { type: "number", min: 1, max: 30, description: "Ability score (STR, DEX, CON, INT, WIS, CHA). Standard range 1–20, max 30 with magic." },
          "abilityScore": { type: "number", min: 1, max: 30, description: "Ability score value. Typical PC range 1–20, max 30." },
          "abilityscore": { type: "number", min: 1, max: 30, description: "Ability score value. Typical PC range 1–20, max 30." },
          "armorClass": { type: "number", min: 1, max: 30, description: "Armor Class (AC). Typical range 8–30, most enemies 10–22." },
          "armorclass": { type: "number", min: 1, max: 30, description: "Armor Class (AC). Typical range 8–30." },
          "hitpoints": { type: "number", min: 0, description: "Hit Points (HP). Min 0 (dead), no fixed max (varies by level/class/CON)." },
          "hitPoints": { type: "number", min: 0, description: "Hit Points. Min 0 (dead/unconscious), no maximum cap." },
          "spelllevel": { type: "number", min: 0, max: 9, description: "Spell level: 0 (cantrips) through 9 (9th-level spells)." },
          "spellLevel": { type: "number", min: 0, max: 9, description: "Spell level 0–9. 0 = cantrip, 1–9 = leveled spells." },
          "level": { type: "number", min: 1, max: 20, description: "Character level 1–20." },
          "proficiencybonus": { type: "number", min: 2, max: 6, description: "Proficiency bonus by level: +2 (L1-4), +3 (L5-8), +4 (L9-12), +5 (L13-16), +6 (L17-20)." },
          "savingthrow": { type: "number", min: -5, max: 15, description: "Saving throw bonus. Typically -5 to +15." },
          "initiative": { type: "number", min: -5, max: 15, description: "Initiative bonus (usually DEX modifier). Typically -5 to +15." },
          "speed": { type: "number", min: 0, max: 120, description: "Speed in feet per round. Standard 30 ft, range 0–120 ft." },
          "challengeRating": { type: "string", values: ["0", "1/8", "1/4", "1/2", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "20", "21", "22", "23", "24", "25", "26", "27", "28", "29", "30"], description: "Challenge Rating (CR). Values: 0, 1/8, 1/4, 1/2, 1–30." },
          "damagedice": { type: "string", values: ["d4", "d6", "d8", "d10", "d12", "d20"], description: "Damage dice type: d4, d6, d8, d10, d12, d20." },
          "currency": { type: "string", values: ["cp", "sp", "ep", "gp", "pp"], description: "Currency types: cp (copper), sp (silver), ep (electrum), gp (gold), pp (platinum). 100cp = 10sp = 1gp." },
          "alignment": { type: "string", values: ["Lawful Good", "Neutral Good", "Chaotic Good", "Lawful Neutral", "True Neutral", "Chaotic Neutral", "Lawful Evil", "Neutral Evil", "Chaotic Evil", "Unaligned"], description: "Character alignment." },
          "size": { type: "string", values: ["Tiny", "Small", "Medium", "Large", "Huge", "Gargantuan"], description: "Creature size category." },
          "weight": { type: "number", min: 0, description: "Item weight in pounds. Carrying capacity is STR score × 15 lbs." },
        };

        const normalizedField = fieldName.replace(/[-_\s]/g, "").toLowerCase();
        const matchedKey = Object.keys(constraints).find((k) =>
          normalizedField === k.toLowerCase().replace(/[-_\s]/g, "") ||
          normalizedField.includes(k.toLowerCase().replace(/[-_\s]/g, "")) ||
          k.toLowerCase().replace(/[-_\s]/g, "").includes(normalizedField)
        );

        if (matchedKey) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                field: fieldName,
                entityType,
                constraints: constraints[matchedKey],
              }, null, 2),
            }],
          };
        }

        // Fallback: search in knowledge base
        const searchResults = searchKnowledge(fieldName, knowledgeFiles);
        if (searchResults.length > 0) {
          return {
            content: [{
              type: "text",
              text: `Found information about '${fieldName}' in knowledge base:\n\n${searchResults[0].matches.join("\n\n")}`,
            }],
          };
        }

        return {
          content: [{
            type: "text",
            text: `No specific constraints found for field '${fieldName}' on entity '${entityType}'. Check dnd-terminology.md or the SRD for guidance.`,
          }],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
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
    console.error(`DnD Domain MCP Server running with ${knowledgeFiles.size} knowledge files`);
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

main();
