#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname, join } from "path";

// ─── Types ───────────────────────────────────────────────────────────────────

type Repo = "frontend" | "backend";

interface UsageData {
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  toolUses?: number;
  durationMs?: number;
}

interface ParentReview {
  score: number;
  usefulBecause: string;
  couldImprove: string;
  reviewTimestamp: string;
  model?: string;
  usage?: UsageData;
}

interface SelfImprovement {
  instructionGaps: string;
  missingTools: string;
  suggestedAgents: string;
}

interface McpCallEntry {
  tool: string;
  durationMs?: number;
}

interface AgentLogEntry {
  agent: string;
  sessionId?: string | null;
  timestamp: string;
  task: string;
  model?: string;
  filesRead?: string[] | number;
  filesModified?: string[] | number;
  linesChanged?: number;
  findingsCount?: number;
  findings?: string[];
  escalated?: boolean;
  errorType?: string | null;
  humanInterventionRequired?: boolean;
  mcpToolsUsed?: Array<string | McpCallEntry>;
  outcome: string;
  notes?: string;
  selfImprovement?: SelfImprovement;
  parentReview?: ParentReview | null;
  _repo?: Repo;
}

interface ToolCallEvent {
  event: string;
  tool: string;
  outcome: string;
  session_id: string;
  timestamp: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractToolName(item: string | McpCallEntry): string {
  return typeof item === "string" ? item : item.tool;
}

function extractToolDuration(item: string | McpCallEntry): number | null {
  return typeof item === "string" ? null : (item.durationMs ?? null);
}

function computeCacheEfficiency(usages: UsageData[]): string | null {
  const reads = usages.reduce((s, u) => s + (u.cacheReadTokens ?? 0), 0);
  const creates = usages.reduce((s, u) => s + (u.cacheCreationTokens ?? 0), 0);
  const total = reads + creates;
  if (total === 0) return null;
  return `${((reads / total) * 100).toFixed(1)}%`;
}

// ─── Data Loaders ────────────────────────────────────────────────────────────

function readEntriesFromPath(logPath: string, repo: Repo): AgentLogEntry[] {
  if (!logPath || !existsSync(resolve(logPath))) return [];
  try {
    const parsed = JSON.parse(readFileSync(resolve(logPath), "utf-8"));
    let entries: AgentLogEntry[] = [];
    if (Array.isArray(parsed)) entries = parsed;
    else if (parsed?.entries && Array.isArray(parsed.entries)) entries = parsed.entries;
    return entries.map((e) => ({ ...e, _repo: repo }));
  } catch { /* ignore */ }
  return [];
}

function loadAgentLogs(repo?: Repo): AgentLogEntry[] {
  const frontendPath = process.env.FRONTEND_AGENT_LOG || "";
  const backendPath = process.env.BACKEND_AGENT_LOG || "";

  if (repo === "frontend") return readEntriesFromPath(frontendPath, "frontend");
  if (repo === "backend") return readEntriesFromPath(backendPath, "backend");

  // Both: merge and sort by timestamp
  const frontendEntries = readEntriesFromPath(frontendPath, "frontend");
  const backendEntries = readEntriesFromPath(backendPath, "backend");
  return [...frontendEntries, ...backendEntries].sort((a, b) =>
    (a.timestamp || "").localeCompare(b.timestamp || "")
  );
}

function loadToolCallLogs(repo?: Repo): ToolCallEvent[] {
  const paths: string[] = [];
  if (!repo || repo === "frontend") {
    const p = process.env.FRONTEND_AGENT_LOG || "";
    if (p) paths.push(join(dirname(resolve(p)), "hooks", "logs", "tool-calls.jsonl"));
  }
  if (!repo || repo === "backend") {
    const p = process.env.BACKEND_AGENT_LOG || "";
    if (p) paths.push(join(dirname(resolve(p)), "hooks", "logs", "tool-calls.jsonl"));
  }

  const events: ToolCallEvent[] = [];
  for (const toolCallsPath of paths) {
    if (!existsSync(toolCallsPath)) continue;
    try {
      const parsed = readFileSync(toolCallsPath, "utf-8")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as ToolCallEvent)
        .filter((e) => e.event === "tool_call");
      events.push(...parsed);
    } catch { /* ignore */ }
  }
  return events;
}

// ─── Tool: get_agent_scores ───────────────────────────────────────────────────

function getAgentScores(repo?: Repo): object {
  const source = loadAgentLogs(repo);

  const agentData: Record<string, {
    scores: number[];
    total: number;
    reviewed: number;
    totalTokens: number;
    linesChanged: number;
    durations: number[];
    models: Set<string>;
    repos: Set<string>;
  }> = {};

  for (const entry of source) {
    if (!agentData[entry.agent]) {
      agentData[entry.agent] = { scores: [], total: 0, reviewed: 0, totalTokens: 0, linesChanged: 0, durations: [], models: new Set(), repos: new Set() };
    }
    const d = agentData[entry.agent];
    d.total++;
    if (entry._repo) d.repos.add(entry._repo);
    if (entry.model) d.models.add(entry.model);
    if (entry.parentReview?.model) d.models.add(entry.parentReview.model);
    if (entry.linesChanged) d.linesChanged += entry.linesChanged;
    if (entry.parentReview?.score !== undefined) {
      d.scores.push(entry.parentReview.score);
      d.reviewed++;
    }
    if (entry.parentReview?.usage?.totalTokens) d.totalTokens += entry.parentReview.usage.totalTokens;
    if (entry.parentReview?.usage?.durationMs) d.durations.push(entry.parentReview.usage.durationMs);
  }

  const results = Object.entries(agentData).map(([agent, d]) => ({
    agent,
    repos: Array.from(d.repos),
    averageScore: d.scores.length > 0 ? Number((d.scores.reduce((a, b) => a + b, 0) / d.scores.length).toFixed(2)) : null,
    highScore: d.scores.length > 0 ? Math.max(...d.scores) : null,
    lowScore: d.scores.length > 0 ? Math.min(...d.scores) : null,
    totalInvocations: d.total,
    reviewedInvocations: d.reviewed,
    reviewRate: d.total > 0 ? `${((d.reviewed / d.total) * 100).toFixed(0)}%` : "0%",
    avgTokensPerInvocation: d.reviewed > 0 ? Math.round(d.totalTokens / d.reviewed) : null,
    avgDurationMs: d.durations.length > 0 ? Math.round(d.durations.reduce((a, b) => a + b, 0) / d.durations.length) : null,
    totalLinesChanged: d.linesChanged || null,
    modelsUsed: Array.from(d.models),
  })).sort((a, b) => (b.averageScore ?? 0) - (a.averageScore ?? 0));

  const totalEntries = source.length;
  const reviewedEntries = source.filter((e) => e.parentReview?.score !== undefined).length;
  const allScores = source.filter((e) => e.parentReview?.score !== undefined).map((e) => e.parentReview!.score);
  const overallAvg = allScores.length > 0 ? Number((allScores.reduce((a, b) => a + b, 0) / allScores.length).toFixed(2)) : null;
  const allUsages = source.map((e) => e.parentReview?.usage).filter((u): u is UsageData => u !== undefined);

  return {
    repo: repo ?? "both",
    totalEntries,
    reviewedEntries,
    overallAverageScore: overallAvg,
    reviewComplianceRate: totalEntries > 0 ? `${((reviewedEntries / totalEntries) * 100).toFixed(0)}%` : "0%",
    cacheEfficiency: computeCacheEfficiency(allUsages) ?? "no cache data",
    agentBreakdown: results,
  };
}

// ─── Tool: get_usage_frequency ───────────────────────────────────────────────

function getUsageFrequency(repo?: Repo): object {
  const source = loadAgentLogs(repo);

  const agentCounts: Record<string, { count: number; firstSeen: string; lastSeen: string; outcomes: Record<string, number>; repos: Set<string> }> = {};

  for (const entry of source) {
    if (!agentCounts[entry.agent]) {
      agentCounts[entry.agent] = { count: 0, firstSeen: entry.timestamp, lastSeen: entry.timestamp, outcomes: {}, repos: new Set() };
    }
    agentCounts[entry.agent].count++;
    agentCounts[entry.agent].lastSeen = entry.timestamp;
    if (entry._repo) agentCounts[entry.agent].repos.add(entry._repo);
    const outcome = entry.outcome || "unknown";
    agentCounts[entry.agent].outcomes[outcome] = (agentCounts[entry.agent].outcomes[outcome] || 0) + 1;
  }

  const results = Object.entries(agentCounts).map(([agent, data]) => ({
    agent,
    repos: Array.from(data.repos),
    invocations: data.count,
    firstUsed: data.firstSeen,
    lastUsed: data.lastSeen,
    outcomes: data.outcomes,
    successRate: data.outcomes["completed"] ? `${((data.outcomes["completed"] / data.count) * 100).toFixed(0)}%` : "0%",
  })).sort((a, b) => b.invocations - a.invocations);

  // Known agents across both repos
  const knownBackendAgents = [
    "orchestrator", "api-explorer", "security-explorer", "testing-explorer", "refactor-explorer",
    "controller-agent", "service-agent", "dto-agent", "entity-agent", "test-agent",
    "migration-agent", "module-agent", "security-agent", "documentation-agent",
    "character-module-agent", "combat-module-agent", "spell-module-agent", "meta-agent",
  ];
  const knownFrontendAgents = [
    "orchestrator", "codebase-explorer", "ui-explorer", "refactor-explorer",
    "component-agent", "service-standards", "adapter-standards", "composable-agent",
    "test-agent", "bug-hunter", "security-agent", "documentation-agent", "meta-agent",
  ];

  let knownAgents: string[];
  if (repo === "backend") knownAgents = knownBackendAgents;
  else if (repo === "frontend") knownAgents = knownFrontendAgents;
  else knownAgents = [...new Set([...knownBackendAgents, ...knownFrontendAgents])];

  const usedAgents = new Set(Object.keys(agentCounts));
  const neverUsed = knownAgents.filter((a) => !usedAgents.has(a));

  return {
    repo: repo ?? "both",
    totalInvocations: source.length,
    uniqueAgents: Object.keys(agentCounts).length,
    agentUsage: results,
    neverUsedAgents: neverUsed,
  };
}

// ─── Tool: get_common_failures ───────────────────────────────────────────────

function getCommonFailures(repo?: Repo): object {
  const source = loadAgentLogs(repo);

  const improvements: { agent: string; couldImprove: string; score: number; timestamp: string; repo?: string }[] = [];
  const escalations: { agent: string; task: string; timestamp: string; notes?: string; repo?: string }[] = [];

  for (const entry of source) {
    if (entry.parentReview?.couldImprove &&
      !["nothing", "n/a", ""].includes(entry.parentReview.couldImprove.toLowerCase().trim())) {
      improvements.push({ agent: entry.agent, couldImprove: entry.parentReview.couldImprove, score: entry.parentReview.score, timestamp: entry.parentReview.reviewTimestamp || entry.timestamp, repo: entry._repo });
    }
    if (entry.escalated) escalations.push({ agent: entry.agent, task: entry.task, timestamp: entry.timestamp, notes: entry.notes, repo: entry._repo });
  }

  const improvementsByAgent: Record<string, string[]> = {};
  for (const item of improvements) {
    if (!improvementsByAgent[item.agent]) improvementsByAgent[item.agent] = [];
    improvementsByAgent[item.agent].push(item.couldImprove);
  }

  const lowScoring = source
    .filter((e) => e.parentReview && e.parentReview.score <= 6)
    .map((e) => ({ agent: e.agent, repo: e._repo, score: e.parentReview!.score, task: e.task, couldImprove: e.parentReview!.couldImprove, errorType: e.errorType ?? null, timestamp: e.timestamp }));

  const errorTypeCounts: Record<string, number> = {};
  for (const entry of source) {
    if (entry.errorType) errorTypeCounts[entry.errorType] = (errorTypeCounts[entry.errorType] || 0) + 1;
  }
  const errorTypeDistribution = Object.entries(errorTypeCounts).sort(([, a], [, b]) => b - a).map(([type, count]) => ({ type, count }));

  const humanInterventions = source
    .filter((e) => e.humanInterventionRequired === true)
    .map((e) => ({ agent: e.agent, repo: e._repo, task: e.task, errorType: e.errorType ?? null, score: e.parentReview?.score ?? null, timestamp: e.timestamp }));

  const themeKeywords: Record<string, string[]> = {
    "missing-validation": ["validation", "validate", "constraint", "required"],
    "incomplete-output": ["incomplete", "missing", "partial", "forgot"],
    "wrong-pattern": ["pattern", "convention", "standard", "format"],
    "build-failure": ["build", "compile", "typescript", "error"],
    "test-failure": ["test", "spec", "assertion", "mock"],
    "security-gap": ["security", "auth", "xss", "injection"],
    "documentation-gap": ["docs", "documentation", "comment"],
    "dnd-domain": ["dnd", "spell", "combat", "character", "ability", "hit points", "armor class"],
  };
  const themeMatches: Record<string, number> = {};
  for (const item of improvements) {
    const lower = item.couldImprove.toLowerCase();
    for (const [theme, keywords] of Object.entries(themeKeywords)) {
      if (keywords.some((kw) => lower.includes(kw))) themeMatches[theme] = (themeMatches[theme] || 0) + 1;
    }
  }

  return {
    repo: repo ?? "both",
    totalImprovementNotes: improvements.length,
    totalEscalations: escalations.length,
    totalHumanInterventions: humanInterventions.length,
    humanInterventionRate: source.length > 0 ? `${((humanInterventions.length / source.length) * 100).toFixed(1)}%` : "0%",
    errorTypeDistribution,
    lowScoringEntries: lowScoring,
    improvementsByAgent,
    recurringThemes: Object.entries(themeMatches).sort(([, a], [, b]) => b - a).map(([theme, occurrences]) => ({ theme, occurrences })),
    escalations,
    humanInterventions,
  };
}

// ─── Tool: get_effectiveness_report ──────────────────────────────────────────

function getEffectivenessReport(repo?: Repo): object {
  const source = loadAgentLogs(repo);

  const weeklyScores: Record<string, number[]> = {};
  for (const entry of source) {
    if (entry.parentReview?.score !== undefined) {
      const date = new Date(entry.timestamp);
      const weekStart = new Date(date);
      weekStart.setDate(date.getDate() - date.getDay());
      const weekKey = weekStart.toISOString().split("T")[0];
      if (!weeklyScores[weekKey]) weeklyScores[weekKey] = [];
      weeklyScores[weekKey].push(entry.parentReview.score);
    }
  }
  const scoreTrend = Object.entries(weeklyScores).sort(([a], [b]) => a.localeCompare(b)).map(([week, scores]) => ({
    weekOf: week,
    averageScore: Number((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2)),
    invocations: scores.length,
  }));

  const fileModCounts: Record<string, number> = {};
  for (const entry of source) {
    if (Array.isArray(entry.filesModified)) {
      for (const file of entry.filesModified) fileModCounts[file as string] = (fileModCounts[file as string] || 0) + 1;
    }
  }
  const hotFiles = Object.entries(fileModCounts).sort(([, a], [, b]) => b - a).slice(0, 15).map(([file, count]) => ({ file, modifications: count }));

  const linesChangedByAgent: Record<string, number> = {};
  for (const entry of source) {
    if (entry.linesChanged && entry.linesChanged > 0) linesChangedByAgent[entry.agent] = (linesChangedByAgent[entry.agent] || 0) + entry.linesChanged;
  }
  const linesChangedRanking = Object.entries(linesChangedByAgent).sort(([, a], [, b]) => b - a).map(([agent, totalLinesChanged]) => ({ agent, totalLinesChanged }));

  const humanInterventionCount = source.filter((e) => e.humanInterventionRequired === true).length;
  const allUsages = source.map((e) => e.parentReview?.usage).filter((u): u is UsageData => u !== undefined);
  const totalTokensConsumed = allUsages.reduce((s, u) => s + (u.totalTokens ?? 0), 0);
  const totalCacheReadTokens = allUsages.reduce((s, u) => s + (u.cacheReadTokens ?? 0), 0);
  const totalCacheCreationTokens = allUsages.reduce((s, u) => s + (u.cacheCreationTokens ?? 0), 0);

  const agentHealth: Record<string, { invocations: number; avgScore: number | null; lastUsed: string; health: string; repos: string[] }> = {};
  for (const entry of source) {
    if (!agentHealth[entry.agent]) agentHealth[entry.agent] = { invocations: 0, avgScore: null, lastUsed: entry.timestamp, health: "unknown", repos: [] };
    agentHealth[entry.agent].invocations++;
    agentHealth[entry.agent].lastUsed = entry.timestamp;
    if (entry._repo && !agentHealth[entry.agent].repos.includes(entry._repo)) agentHealth[entry.agent].repos.push(entry._repo);
  }
  for (const agent of Object.keys(agentHealth)) {
    const agentEntries = source.filter((e) => e.agent === agent && e.parentReview?.score !== undefined);
    if (agentEntries.length > 0) {
      const avg = agentEntries.reduce((sum, e) => sum + e.parentReview!.score, 0) / agentEntries.length;
      agentHealth[agent].avgScore = Number(avg.toFixed(2));
      agentHealth[agent].health = avg >= 9 ? "excellent" : avg >= 7 ? "good" : avg >= 5 ? "needs-improvement" : "poor";
    }
  }

  const totalEntries = source.length;
  const reviewedEntries = source.filter((e) => e.parentReview?.score !== undefined).length;
  const reviewRate = totalEntries > 0 ? reviewedEntries / totalEntries : 0;
  const recommendations: string[] = [];

  if (reviewRate < 1) recommendations.push(`Review compliance is ${(reviewRate * 100).toFixed(0)}%. ${totalEntries - reviewedEntries} entries are missing parentReview.`);
  if (humanInterventionCount > 0) recommendations.push(`${humanInterventionCount} entries required human intervention. Review these agents for instruction improvements.`);

  const cacheEff = computeCacheEfficiency(allUsages);
  if (cacheEff !== null && parseFloat(cacheEff) < 50) recommendations.push(`Cache efficiency is low (${cacheEff} cache hits). Consider structuring prompts to benefit more from prompt caching.`);

  for (const [agent, health] of Object.entries(agentHealth)) {
    if (health.health === "poor" || health.health === "needs-improvement") recommendations.push(`Agent "${agent}" has avg score ${health.avgScore} — review its instructions.`);
  }

  if (scoreTrend.length >= 2) {
    const first = scoreTrend[0].averageScore;
    const last = scoreTrend[scoreTrend.length - 1].averageScore;
    if (last < first) recommendations.push(`Score trend is declining (${first} → ${last}). Review recent couldImprove feedback.`);
    else if (last > first) recommendations.push(`Score trend is improving (${first} → ${last}). Current agent refinement approach is working.`);
  }

  const escalatedCount = source.filter((e) => e.escalated).length;
  if (escalatedCount > 0) recommendations.push(`${escalatedCount} escalated entries found. Review for patterns that need agent instruction updates.`);

  const entriesWithMcp = source.filter((e) => e.mcpToolsUsed && e.mcpToolsUsed.length > 0).length;
  if (totalEntries >= 5 && entriesWithMcp / totalEntries < 0.5) recommendations.push(`MCP adoption is low (${((entriesWithMcp / totalEntries) * 100).toFixed(0)}%). Ensure agents self-report mcpToolsUsed.`);

  return {
    repo: repo ?? "both",
    summary: {
      totalLogEntries: totalEntries,
      reviewedEntries,
      reviewComplianceRate: `${(reviewRate * 100).toFixed(0)}%`,
      uniqueAgentsUsed: Object.keys(agentHealth).length,
      humanInterventionRate: totalEntries > 0 ? `${((humanInterventionCount / totalEntries) * 100).toFixed(1)}%` : "0%",
    },
    tokenSummary: {
      totalTokensConsumed,
      totalCacheReadTokens,
      totalCacheCreationTokens,
      cacheEfficiency: cacheEff ?? "no cache data",
      entriesWithTokenData: allUsages.filter((u) => u.totalTokens).length,
    },
    linesChangedByAgent: linesChangedRanking,
    scoreTrend,
    agentHealth: Object.entries(agentHealth).sort(([, a], [, b]) => (b.avgScore ?? 0) - (a.avgScore ?? 0)).map(([agent, data]) => ({ agent, ...data })),
    hotFiles,
    recommendations,
  };
}

// ─── Tool: get_self_improvement_suggestions ───────────────────────────────────

function getSelfImprovementSuggestions(repo?: Repo): object {
  const source = loadAgentLogs(repo);

  const instructionGaps: { agent: string; gap: string; task: string; timestamp: string; repo?: string }[] = [];
  const missingTools: { agent: string; tools: string; task: string; timestamp: string; repo?: string }[] = [];
  const suggestedAgents: { agent: string; suggestion: string; task: string; timestamp: string; repo?: string }[] = [];

  for (const entry of source) {
    if (!entry.selfImprovement) continue;
    const si = entry.selfImprovement;
    const none = (val: string) => !val || ["none", "n/a", ""].includes(val.toLowerCase().trim());
    if (!none(si.instructionGaps)) instructionGaps.push({ agent: entry.agent, gap: si.instructionGaps, task: entry.task, timestamp: entry.timestamp, repo: entry._repo });
    if (!none(si.missingTools)) missingTools.push({ agent: entry.agent, tools: si.missingTools, task: entry.task, timestamp: entry.timestamp, repo: entry._repo });
    if (!none(si.suggestedAgents)) suggestedAgents.push({ agent: entry.agent, suggestion: si.suggestedAgents, task: entry.task, timestamp: entry.timestamp, repo: entry._repo });
  }

  const gapsByAgent: Record<string, string[]> = {};
  for (const item of instructionGaps) {
    if (!gapsByAgent[item.agent]) gapsByAgent[item.agent] = [];
    gapsByAgent[item.agent].push(item.gap);
  }

  const toolRequests: Record<string, { count: number; agents: string[] }> = {};
  for (const item of missingTools) {
    const key = item.tools.toLowerCase().trim();
    if (!toolRequests[key]) toolRequests[key] = { count: 0, agents: [] };
    toolRequests[key].count++;
    if (!toolRequests[key].agents.includes(item.agent)) toolRequests[key].agents.push(item.agent);
  }
  const rankedToolRequests = Object.entries(toolRequests).sort(([, a], [, b]) => b.count - a.count).map(([tool, data]) => ({ tool, requestCount: data.count, requestedBy: data.agents }));

  const agentSuggestionMap: Record<string, { count: number; suggestedBy: string[] }> = {};
  for (const item of suggestedAgents) {
    const key = item.suggestion.toLowerCase().trim();
    if (!agentSuggestionMap[key]) agentSuggestionMap[key] = { count: 0, suggestedBy: [] };
    agentSuggestionMap[key].count++;
    if (!agentSuggestionMap[key].suggestedBy.includes(item.agent)) agentSuggestionMap[key].suggestedBy.push(item.agent);
  }
  const rankedAgentSuggestions = Object.entries(agentSuggestionMap).sort(([, a], [, b]) => b.count - a.count).map(([suggestion, data]) => ({ suggestion, requestCount: data.count, suggestedBy: data.suggestedBy }));

  const recommendations: string[] = [];
  if (rankedToolRequests.length > 0) recommendations.push(`Most requested tool: "${rankedToolRequests[0].tool}" (${rankedToolRequests[0].requestCount}x by ${rankedToolRequests[0].requestedBy.join(", ")}). Consider adding this MCP or permission.`);
  for (const [agent, gaps] of Object.entries(gapsByAgent)) {
    if (gaps.length >= 2) recommendations.push(`Agent "${agent}" has reported instruction gaps ${gaps.length} times. Review and update its .md file.`);
  }
  if (rankedAgentSuggestions.length > 0 && rankedAgentSuggestions[0].requestCount >= 2) {
    recommendations.push(`New agent suggestion: "${rankedAgentSuggestions[0].suggestion}" (${rankedAgentSuggestions[0].requestCount}x). Consider creating this agent.`);
  }

  const totalEntries = source.length;
  const entriesWithSI = source.filter((e) => e.selfImprovement).length;

  return {
    repo: repo ?? "both",
    coverage: { totalEntries, entriesWithSelfImprovement: entriesWithSI, complianceRate: totalEntries > 0 ? `${((entriesWithSI / totalEntries) * 100).toFixed(0)}%` : "0%" },
    instructionGaps: { total: instructionGaps.length, byAgent: gapsByAgent, raw: instructionGaps },
    missingTools: { total: missingTools.length, ranked: rankedToolRequests, raw: missingTools },
    suggestedAgents: { total: suggestedAgents.length, ranked: rankedAgentSuggestions, raw: suggestedAgents },
    recommendations,
  };
}

// ─── Tool: get_mcp_usage_report ───────────────────────────────────────────────

function getMcpUsageReport(repo?: Repo): object {
  const source = loadAgentLogs(repo);

  const toolStats: Record<string, { count: number; agents: Set<string>; durations: number[] }> = {};
  const serverStats: Record<string, { count: number; tools: Set<string>; agents: Set<string> }> = {};
  const agentMcp: Record<string, { tools: string[]; totalCalls: number }> = {};
  let entriesWithMcp = 0, entriesWithoutMcp = 0, timedEntries = 0;

  for (const entry of source) {
    const rawTools: Array<string | McpCallEntry> = entry.mcpToolsUsed || [];
    if (rawTools.length > 0) {
      entriesWithMcp++;
      if (rawTools.some((t) => typeof t !== "string" && t.durationMs !== undefined)) timedEntries++;
    } else {
      entriesWithoutMcp++;
    }
    if (!agentMcp[entry.agent]) agentMcp[entry.agent] = { tools: [], totalCalls: 0 };

    for (const rawTool of rawTools) {
      const tool = extractToolName(rawTool);
      const duration = extractToolDuration(rawTool);
      if (!toolStats[tool]) toolStats[tool] = { count: 0, agents: new Set(), durations: [] };
      toolStats[tool].count++;
      toolStats[tool].agents.add(entry.agent);
      if (duration !== null) toolStats[tool].durations.push(duration);
      const serverName = tool.includes("__") ? tool.split("__")[0] : "unknown";
      if (!serverStats[serverName]) serverStats[serverName] = { count: 0, tools: new Set(), agents: new Set() };
      serverStats[serverName].count++;
      serverStats[serverName].tools.add(tool);
      serverStats[serverName].agents.add(entry.agent);
      agentMcp[entry.agent].tools.push(tool);
      agentMcp[entry.agent].totalCalls++;
    }
  }

  const rankedTools = Object.entries(toolStats).sort(([, a], [, b]) => b.count - a.count).map(([tool, data]) => ({
    tool, callCount: data.count, usedByAgents: Array.from(data.agents),
    avgDurationMs: data.durations.length > 0 ? Math.round(data.durations.reduce((a, b) => a + b, 0) / data.durations.length) : null,
    timedCalls: data.durations.length,
  }));

  const rankedServers = Object.entries(serverStats).sort(([, a], [, b]) => b.count - a.count).map(([server, data]) => ({
    server, totalCalls: data.count, uniqueTools: data.tools.size, usedByAgents: Array.from(data.agents),
  }));

  const agentBreakdown = Object.entries(agentMcp).sort(([, a], [, b]) => b.totalCalls - a.totalCalls).map(([agent, data]) => {
    const toolCounts: Record<string, number> = {};
    for (const t of data.tools) toolCounts[t] = (toolCounts[t] || 0) + 1;
    return {
      agent, totalMcpCalls: data.totalCalls, uniqueTools: Object.keys(toolCounts).length,
      topTools: Object.entries(toolCounts).sort(([, a], [, b]) => b - a).slice(0, 5).map(([tool, count]) => ({ tool, count })),
    };
  });

  const totalEntries = source.length;
  return {
    repo: repo ?? "both",
    summary: {
      totalLogEntries: totalEntries, entriesWithMcpUsage: entriesWithMcp, entriesWithoutMcpUsage: entriesWithoutMcp,
      mcpAdoptionRate: totalEntries > 0 ? `${((entriesWithMcp / totalEntries) * 100).toFixed(0)}%` : "0%",
      totalMcpCalls: rankedTools.reduce((sum, t) => sum + t.callCount, 0),
      uniqueToolsUsed: rankedTools.length, uniqueServersUsed: rankedServers.length, entriesWithTimingData: timedEntries,
    },
    toolRanking: rankedTools, serverRanking: rankedServers, agentBreakdown,
    agentsWithZeroMcpUsage: Object.entries(agentMcp).filter(([, d]) => d.totalCalls === 0).map(([a]) => a),
  };
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new Server(
  { name: "dnd-agent-analytics", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

const repoParam = {
  repo: {
    type: "string",
    enum: ["frontend", "backend"],
    description: "Filter to a specific repo. Omit to aggregate both frontend and backend logs.",
  },
};

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools: Tool[] = [
    {
      name: "get_agent_scores",
      description: "Get average scores by agent. Shows per-agent averages, high/low scores, avg tokens/duration/linesChanged per agent, overall cache efficiency, and review compliance rate. Use `repo` to filter to frontend or backend only.",
      inputSchema: { type: "object", properties: { ...repoParam } },
    },
    {
      name: "get_usage_frequency",
      description: "Get invocation counts per agent. Shows which agents are used most, never-used agents, success rates, and outcome breakdown. Use `repo` to filter to frontend or backend only.",
      inputSchema: { type: "object", properties: { ...repoParam } },
    },
    {
      name: "get_common_failures",
      description: "Analyze couldImprove feedback for recurring themes. Identifies low-scoring entries, error type distribution, human intervention cases, improvement patterns, and escalations. Use `repo` to filter to frontend or backend only.",
      inputSchema: { type: "object", properties: { ...repoParam } },
    },
    {
      name: "get_effectiveness_report",
      description: "Full effectiveness report with score trends, agent health, token summary with cache efficiency, lines changed by agent, human intervention rate, hot files, and actionable recommendations. Use `repo` to filter to frontend or backend only.",
      inputSchema: { type: "object", properties: { ...repoParam } },
    },
    {
      name: "get_self_improvement_suggestions",
      description: "Aggregate self-improvement feedback from agents: instruction gaps in their .md files, missing MCP servers or tools, and suggestions for new agent types. Use `repo` to filter to frontend or backend only.",
      inputSchema: { type: "object", properties: { ...repoParam } },
    },
    {
      name: "get_mcp_usage_report",
      description: "Analyze MCP tool usage across sub-agents. Per-tool call counts with avg duration, per-server aggregation, per-agent MCP breakdown, adoption rate. Use `repo` to filter to frontend or backend only.",
      inputSchema: { type: "object", properties: { ...repoParam } },
    },
  ];
  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const repo = (args as Record<string, unknown>)?.repo as Repo | undefined;

  try {
    let result: object;
    switch (name) {
      case "get_agent_scores": result = getAgentScores(repo); break;
      case "get_usage_frequency": result = getUsageFrequency(repo); break;
      case "get_common_failures": result = getCommonFailures(repo); break;
      case "get_effectiveness_report": result = getEffectivenessReport(repo); break;
      case "get_self_improvement_suggestions": result = getSelfImprovementSuggestions(repo); break;
      case "get_mcp_usage_report": result = getMcpUsageReport(repo); break;
      default: throw new Error(`Unknown tool: ${name}`);
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
});

async function main() {
  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("DnD Agent Analytics MCP Server running (v2.0.0 — dual-repo)");
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

main();
