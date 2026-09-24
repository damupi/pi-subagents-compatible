import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Key, Text, isKeyRelease, matchesKey, truncateToWidth, type EditorComponent } from "@earendil-works/pi-tui";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, type Dirent } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

type ContextMode = "fresh" | "fork";
type SystemPromptMode = "append" | "replace";
type RunKind = "single" | "parallel" | "chain";
type DeliveryState = "undelivered" | "delivered";
type AsyncRunStatus = "queued" | "running" | "completed" | "failed" | "stopped" | "timed_out" | "spawn_error" | "orphaned";
type FleetEntryStatus = AsyncRunStatus;
type FleetEntryKind = "foreground" | "async";

type FleetEntry = {
  key: string;
  runId: string;
  kind: FleetEntryKind;
  agent: string;
  task: string;
  status: FleetEntryStatus;
  cwd: string;
  contextMode?: ContextMode;
  startedAtMs: number;
  updatedAtMs: number;
  finishedAtMs?: number;
  model?: string;
  stepLabel?: string;
  groupId?: string;
  currentTool?: string;
  currentToolArgs?: string;
  currentPath?: string;
  turnCount?: number;
  toolCount?: number;
  tokens?: number;
  outputPreview?: string;
  outputPath?: string;
  stderrPath?: string;
  artifactPath?: string;
  childSessionFile?: string;
};

type ChildActivity = {
  textDelta?: string;
  toolName?: string;
  toolArgs?: string;
  toolStarted?: boolean;
  toolEnded?: boolean;
  path?: string;
  turnEnded?: boolean;
  tokens?: number;
};

type OverrideConfig = {
  model?: string;
  fallbackModels?: string[];
  thinking?: string;
  tools?: string[];
  defaultContext?: ContextMode;
  timeoutMs?: number;
  turnBudget?: { maxTurns: number; graceTurns?: number };
  maxSubagentDepth?: number;
  systemPrompt?: string;
  systemPromptMode?: SystemPromptMode;
  description?: string;
  extensions?: string[];
  subagentOnlyExtensions?: string[];
  skills?: string[];
  inheritProjectContext?: boolean;
  inheritSkills?: boolean;
  acceptance?: string[];
  acceptanceRole?: string;
  completionGuard?: boolean;
  interactive?: boolean;
  memory?: string;
  output?: string;
  defaultReads?: string[];
  defaultProgress?: string;
  toolBudget?: number;
  async?: boolean;
  disabled?: boolean;
};

type NormalizedOverrideConfig = OverrideConfig & { unset?: Array<keyof OverrideConfig> };
type RuntimePolicyLayer = {
  defaults: NormalizedOverrideConfig;
  agentOverrides: Record<string, NormalizedOverrideConfig>;
};

type AgentDef = {
  name: string;
  runtimeName: string;
  packageName?: string;
  description: string;
  sourcePath: string;
  systemPrompt: string;
  override: OverrideConfig;
};

type RunRecord = {
  runId: string;
  kind: RunKind;
  agent: string;
  task: string;
  cwd: string;
  contextMode: ContextMode;
  model?: string;
  thinking?: string;
  modelCandidates?: string[];
  timeoutMs?: number;
  command: string[];
  sourcePath: string;
  status: AsyncRunStatus;
  exitCode?: number;
  startedAt: string;
  finishedAt?: string;
  elapsedMs?: number;
  timedOut?: boolean;
  stopped?: boolean;
  stopRequestedAt?: string;
  outputPath: string;
  stderrPath: string;
  metaPath: string;
  resultSummaryPath: string;
  resultFullPath: string;
  pid?: number;
  parentSessionId?: string;
  parentSessionFile?: string;
  childSessionFile?: string;
  notification: { state: DeliveryState; deliveredAt?: string };
  groupId?: string;
  stepIndex?: number;
  totalSteps?: number;
  stepLabel?: string;
  completionSummary?: string;
};

type ActiveRun = {
  record: RunRecord;
  proc: ChildProcessWithoutNullStreams;
  startedAtMs: number;
  outputChunks: string[];
  stderrChunks: string[];
  stdoutBuffer: string;
  timer?: ReturnType<typeof setTimeout>;
};

type RunRequest = {
  task: string;
  model?: string;
  thinking?: string;
  cwd: string;
  timeoutMs?: number;
  depth: number;
  context: ContextMode;
  parentSessionId?: string;
  parentSessionFile?: string;
  groupId?: string;
  stepIndex?: number;
  totalSteps?: number;
  stepLabel?: string;
  onUpdate?: (result: any) => void;
};

type ChildPlan = {
  args: string[];
  model?: string;
  thinking?: string;
  modelCandidates: string[];
  timeoutMs?: number;
  contextMode: ContextMode;
  childSessionFile?: string;
  effectiveTask: string;
};

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const ENV_AGENT_DIR = process.env.PI_SUBAGENT_AGENT_DIR?.trim() ? resolve(process.env.PI_SUBAGENT_AGENT_DIR.trim()) : undefined;
const CONFIG_PATH = resolveConfiguredPath(process.env.PI_SUBAGENT_CONFIG_PATH, join(EXTENSION_DIR, "overrides.jsonc"));
const PROJECT_CONFIG_RELATIVE_PATH = join(".pi", "subagent-overrides.jsonc");
const SCHEMA_PATH = join(EXTENSION_DIR, "overrides.schema.json");
const RUNS_DIR = resolveConfiguredPath(process.env.PI_SUBAGENT_RUNS_DIR, join(EXTENSION_DIR, "runs"));
const DEPTH_ENV = "PI_SUBAGENT_DEPTH";
const DEFAULT_RUN_RETENTION_DAYS = 7;
const RUN_RETENTION_DAYS = parseRunRetentionDays(process.env.PI_SUBAGENT_RUN_RETENTION_DAYS);
const RUN_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const RUN_ARTIFACT_MARKER = ".pi-subagent-run.json";
const OVERRIDE_KEYS = new Set<keyof OverrideConfig>([
  "model", "fallbackModels", "thinking", "tools", "defaultContext", "timeoutMs", "turnBudget", "maxSubagentDepth",
  "systemPrompt", "systemPromptMode", "description", "extensions", "subagentOnlyExtensions", "skills", "inheritProjectContext",
  "inheritSkills", "acceptance", "acceptanceRole", "completionGuard", "interactive", "memory", "output", "defaultReads",
  "defaultProgress", "toolBudget", "async", "disabled",
]);
const FORK_CONTEXT_LINES = 16;
const COMPLETED_UI_GRACE_MS = 15_000;
const FLEET_REFRESH_MS = 500;
const MAX_FLEET_ROWS = 5;
const MAX_OUTPUT_PREVIEW_CHARS = 2000;
const FLEET_WIDGET_KEY = "pi-subagent-fleet";
const LEGACY_WIDGET_KEY = "pi-subagent-runs";
const USE_LEGACY_FOOTER = false;

const fleetEntries = new Map<string, FleetEntry>();
let refreshExternalUi: () => void = () => {};

export default function (pi: ExtensionAPI) {
  pi.registerMessageRenderer("subagent-notify", (message: any, _options: any, theme: any) => {
    const content = typeof message?.content === "string" ? message.content : "Subagent notification";
    return new Text(`${theme.fg("success", "✓ Subagent")} ${content}`, 0, 0);
  });

  let agents = loadAgents();
  const activeRuns = new Map<string, ActiveRun>();
  let uiCtx: any;
  let uiInputUnsubscribe: (() => void) | undefined;
  let uiRefreshTimer: ReturnType<typeof setInterval> | undefined;
  let runPruneTimer: ReturnType<typeof setInterval> | undefined;
  let widgetRegistered = false;
  let widgetTui: any;
  let footerRegistered = false;
  let selectorActive = false;
  let inspectorOpen = false;
  let inspectorScroll = 0;
  let selectedKey = "main";
  let currentSessionId: string | undefined;
  let currentProjectCwd = process.cwd();
  let lastStatusText: string | undefined;

  function refresh(cwd?: string) {
    if (cwd) currentProjectCwd = cwd;
    agents = loadAgents(currentProjectCwd);
    return agents;
  }

  function updateStatus(ctx?: any) {
    const target = ctx || uiCtx;
    if (!target) return;
    const runs = listRunRecords();
    const fleet = visibleFleetEntries();
    const running = fleet.filter((run) => run.status === "running" || run.status === "queued").length;
    const failed = runs.filter((run) => run.status === "failed" || run.status === "spawn_error" || run.status === "timed_out").length;
    const text = [`subagents:${agents.length}`, `runs:${running}`];
    if (failed > 0) text.push(`issues:${failed}`);
    const nextStatusText = text.join(" ");
    if (nextStatusText === lastStatusText) return;
    lastStatusText = nextStatusText;
    target.ui.setStatus("pi-subagent", nextStatusText);
  }

  function visibleFleetEntries() {
    return getVisibleFleetEntries(listRunRecords());
  }

  function updateUiWidget(ctx?: any) {
    const target = ctx || uiCtx;
    if (!target) return;

    if (visibleFleetEntries().length === 0) {
      if (widgetRegistered) target.ui.setWidget(FLEET_WIDGET_KEY, undefined);
      widgetRegistered = false;
      widgetTui = undefined;
      return;
    }

    if (!widgetRegistered) {
      target.ui.setWidget(FLEET_WIDGET_KEY, (tui: any, theme: any) => {
        widgetTui = tui;
        return {
          render(width: number): string[] {
            const entries = visibleFleetEntries();
            if (entries.length === 0) return [];

            if (inspectorOpen) {
              const selected = entries.find((entry) => entry.key === selectedKey);
              if (!selected) return [];
              return renderFleetInspector(selected, width, theme, inspectorScroll);
            }

            const roster = ["main", ...entries.map((entry) => entry.key)];
            if (!roster.includes(selectedKey)) selectedKey = "main";
            const selectedIndex = Math.max(0, roster.indexOf(selectedKey));
            const hint = selectorActive
              ? "↑↓/jk select · enter inspect · pgup/pgdn scroll · esc back"
              : "↓ for subagents";
            const lines = [truncateToWidth(`  ${theme.fg("dim", hint)}`, width), ""];
            lines.push(renderRosterLine(width, theme, 0, selectedIndex, "main", "main"));
            for (let index = 0; index < Math.min(entries.length, MAX_FLEET_ROWS); index += 1) {
              const entry = entries[index]!;
              lines.push(renderRosterLine(width, theme, index + 1, selectedIndex, entry.key, formatFleetHeadline(entry, theme)));
              lines.push(truncateToWidth(`    ${theme.fg("dim", formatFleetActivity(entry, width - 6))}`, width));
            }
            if (entries.length > MAX_FLEET_ROWS) {
              lines.push(truncateToWidth(`    ${theme.fg("dim", `+${entries.length - MAX_FLEET_ROWS} more subagents`)}`, width));
            }
            return lines;
          },
          invalidate() {},
          dispose() {
            if (widgetTui === tui) widgetTui = undefined;
            widgetRegistered = false;
          },
        };
      }, { placement: "belowEditor" });
      widgetRegistered = true;
      return;
    }

    widgetTui?.requestRender();
  }

  function setFooter(ctx?: any) {
    const target = ctx || uiCtx;
    if (!target) return;
    if (footerRegistered) {
      target.ui.setFooter(undefined);
      footerRegistered = false;
    }
    if (!USE_LEGACY_FOOTER) return;
  }

  function refreshUi(ctx?: any) {
    pruneFleetEntries();
    updateStatus(ctx);
    updateUiWidget(ctx);
    setFooter(ctx);
  }

  function cleanupUi() {
    if (uiRefreshTimer) clearInterval(uiRefreshTimer);
    uiRefreshTimer = undefined;
    if (runPruneTimer) clearInterval(runPruneTimer);
    runPruneTimer = undefined;
    if (uiInputUnsubscribe) uiInputUnsubscribe();
    uiInputUnsubscribe = undefined;
    if (uiCtx) {
      try { uiCtx.ui.setWidget(FLEET_WIDGET_KEY, undefined); } catch {}
      try { uiCtx.ui.setWidget(LEGACY_WIDGET_KEY, undefined); } catch {}
      try { uiCtx.ui.setFooter(undefined); } catch {}
      try { uiCtx.ui.setStatus("pi-subagent", undefined); } catch {}
    }
    lastStatusText = undefined;
    fleetEntries.clear();
    widgetRegistered = false;
    widgetTui = undefined;
    footerRegistered = false;
    selectorActive = false;
    inspectorOpen = false;
    inspectorScroll = 0;
    selectedKey = "main";
  }

  function handleTerminalKey(data: string) {
    const target = uiCtx;
    const entries = visibleFleetEntries();
    if (!target || isKeyRelease(data) || entries.length === 0) return undefined;
    if (!editorHasFocus(widgetTui)) {
      if (selectorActive || inspectorOpen) {
        selectorActive = false;
        inspectorOpen = false;
        inspectorScroll = 0;
        selectedKey = "main";
        refreshUi();
      }
      return undefined;
    }

    if (inspectorOpen) {
      if (matchesKey(data, "escape") || matchesKey(data, "left") || matchesKey(data, "h")) {
        inspectorOpen = false;
        inspectorScroll = 0;
        refreshUi();
        return { consume: true };
      }
      if (matchesKey(data, "down") || matchesKey(data, "j")) {
        inspectorScroll += 1;
        refreshUi();
        return { consume: true };
      }
      if (matchesKey(data, "up") || matchesKey(data, "k")) {
        inspectorScroll = Math.max(0, inspectorScroll - 1);
        refreshUi();
        return { consume: true };
      }
      if (matchesKey(data, "pagedown") || matchesKey(data, "ctrl+f")) {
        inspectorScroll += 8;
        refreshUi();
        return { consume: true };
      }
      if (matchesKey(data, "pageup") || matchesKey(data, "ctrl+b")) {
        inspectorScroll = Math.max(0, inspectorScroll - 8);
        refreshUi();
        return { consume: true };
      }
      if (matchesKey(data, "g")) {
        inspectorScroll = 0;
        refreshUi();
        return { consume: true };
      }
      return undefined;
    }

    if (!selectorActive) {
      const activates = matchesKey(data, "down") || matchesKey(data, "left");
      if (!activates || target.ui.getEditorText() !== "") return undefined;
      selectorActive = true;
      selectedKey = entries[0]?.key || "main";
      refreshUi();
      return { consume: true };
    }

    const roster = ["main", ...entries.map((entry) => entry.key)];
    const selectedIndex = Math.max(0, roster.indexOf(selectedKey));
    if (matchesKey(data, "down") || matchesKey(data, "j")) {
      selectedKey = roster[Math.min(roster.length - 1, selectedIndex + 1)] || "main";
      refreshUi();
      return { consume: true };
    }
    if (matchesKey(data, "up") || matchesKey(data, "k")) {
      if (selectedIndex === 0) {
        selectorActive = false;
        selectedKey = "main";
      } else {
        selectedKey = roster[selectedIndex - 1] || "main";
      }
      refreshUi();
      return { consume: true };
    }
    if (matchesKey(data, "escape")) {
      selectorActive = false;
      selectedKey = "main";
      refreshUi();
      return { consume: true };
    }
    if (matchesKey(data, Key.enter) || matchesKey(data, "right") || matchesKey(data, "l")) {
      if (selectedKey === "main") {
        selectorActive = false;
      } else {
        inspectorOpen = true;
        inspectorScroll = 0;
      }
      refreshUi();
      return { consume: true };
    }

    return undefined;
  }

  refreshExternalUi = () => refreshUi();

  pi.on("session_start", async (_event, ctx) => {
    cleanupUi();
    uiCtx = ctx;
    currentSessionId = getSessionId(ctx) || undefined;
    currentProjectCwd = ctx.cwd || process.cwd();
    const pruneResult = pruneExpiredRunArtifacts(Date.now(), getProtectedRunIds(activeRuns));
    if (pruneResult.deleted.length > 0 && ctx.hasUI) {
      ctx.ui.notify(`Pruned ${pruneResult.deleted.length} subagent run artifact director${pruneResult.deleted.length === 1 ? "y" : "ies"} older than ${RUN_RETENTION_DAYS} days.`, "info");
    }
    if (pruneResult.errors.length > 0 && ctx.hasUI) {
      ctx.ui.notify(`Could not prune ${pruneResult.errors.length} subagent run artifact director${pruneResult.errors.length === 1 ? "y" : "ies"}.`, "warning");
    }
    reconcileStoredRuns();
    if (ctx.hasUI && typeof ctx.ui.onTerminalInput === "function") {
      uiInputUnsubscribe = ctx.ui.onTerminalInput((data: string) => handleTerminalKey(data));
    }
    uiRefreshTimer = setInterval(() => {
      reconcileStoredRuns();
      refreshUi();
    }, FLEET_REFRESH_MS);
    uiRefreshTimer.unref?.();
    runPruneTimer = setInterval(() => {
      pruneExpiredRunArtifacts(Date.now(), getProtectedRunIds(activeRuns));
    }, RUN_PRUNE_INTERVAL_MS);
    runPruneTimer.unref?.();
    refresh(ctx.cwd);
    deliverPendingNotifications(pi, currentSessionId);
    refreshUi(ctx);
  });

  pi.on("session_shutdown", async () => {
    for (const run of activeRuns.values()) {
      persistRunRecord(run.record);
    }
    cleanupUi();
  });

  pi.registerCommand("subagents", {
    description: "List shared subagents",
    handler: async (_args, ctx) => {
      refresh(ctx.cwd);
      refreshUi(ctx);
      ctx.ui.notify(renderAgentList(agents, currentProjectCwd).join("\n"), "info");
    },
  });

  pi.registerCommand("subagents-reload", {
    description: "Reload shared subagent registry",
    handler: async (_args, ctx) => {
      refresh(ctx.cwd);
      refreshUi(ctx);
      ctx.ui.notify(`reloaded ${agents.length} subagents from ${describeAgentSources(currentProjectCwd)}`, "info");
    },
  });

  pi.registerCommand("subagent-runs", {
    description: "List async subagent runs",
    handler: async (_args, ctx) => {
      const runs = listRunRecords();
      ctx.ui.notify(renderRunList(runs).join("\n"), "info");
    },
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "List or run shared subagents using Pi-native overrides and a Claude-compatible subagent workflow.",
    parameters: Type.Object({
      action: Type.Optional(Type.Union([
        Type.Literal("list"),
        Type.Literal("reload"),
        Type.Literal("status"),
        Type.Literal("stop"),
      ])),
      agent: Type.Optional(Type.String({ description: "Runtime agent name, for example maribel or package.agent" })),
      task: Type.Optional(Type.String({ description: "Task for the child subagent" })),
      tasks: Type.Optional(Type.Array(Type.Object({
        agent: Type.String(),
        task: Type.String(),
        model: Type.Optional(Type.String()),
        thinking: Type.Optional(Type.String()),
        cwd: Type.Optional(Type.String()),
        timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
      })) ),
      chain: Type.Optional(Type.Array(Type.Object({
        agent: Type.String(),
        task: Type.String(),
        model: Type.Optional(Type.String()),
        thinking: Type.Optional(Type.String()),
        cwd: Type.Optional(Type.String()),
        timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
      })) ),
      model: Type.Optional(Type.String({ description: "Optional one-off model override" })),
      thinking: Type.Optional(Type.String({ description: "Optional one-off thinking override" })),
      cwd: Type.Optional(Type.String({ description: "Working directory for the child run" })),
      context: Type.Optional(Type.Union([Type.Literal("fresh"), Type.Literal("fork")], { description: "fresh starts isolated; fork copies the current session into a child session file." })),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1, description: "Optional child timeout override in ms" })),
      async: Type.Optional(Type.Boolean({ description: "Run in background and return a runId immediately." })),
      runId: Type.Optional(Type.String({ description: "Async run id for status or stop." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const input = params as {
        action?: "list" | "reload" | "status" | "stop";
        agent?: string;
        task?: string;
        tasks?: Array<{ agent: string; task: string; model?: string; thinking?: string; cwd?: string; timeoutMs?: number }>;
        chain?: Array<{ agent: string; task: string; model?: string; thinking?: string; cwd?: string; timeoutMs?: number }>;
        model?: string;
        thinking?: string;
        cwd?: string;
        context?: ContextMode;
        timeoutMs?: number;
        async?: boolean;
        runId?: string;
      };

      if (input.action === "reload") {
        refresh(ctx.cwd);
        refreshUi(ctx);
        return {
          content: [{ type: "text", text: `Reloaded ${agents.length} subagents.` }],
          details: { action: "reload", count: agents.length, agentSources: getAgentSourceDirs(currentProjectCwd), configPath: CONFIG_PATH },
        };
      }

      if (input.action === "list" || (!input.action && !input.agent && !input.tasks?.length && !input.chain?.length)) {
        refresh(ctx.cwd);
        refreshUi(ctx);
        return {
          content: [{ type: "text", text: renderAgentList(agents, currentProjectCwd).join("\n") }],
          details: { action: "list", count: agents.length, agents: agents.map(summarizeAgent), agentSources: getAgentSourceDirs(currentProjectCwd), configPath: CONFIG_PATH },
        };
      }

      if (input.action === "status") {
        const result = getRunStatus(input.runId);
        return {
          content: [{ type: "text", text: renderRunStatusText(result) }],
          details: { action: "status", ...result },
          isError: Boolean(result.isError),
        };
      }

      if (input.action === "stop") {
        const result = stopRun(input.runId, activeRuns);
        refreshUi(ctx);
        return {
          content: [{ type: "text", text: renderStopText(result) }],
          details: { action: "stop", ...result },
          isError: Boolean(result.isError),
        };
      }

      const currentDepth = Number.parseInt(process.env[DEPTH_ENV] || "0", 10) || 0;
      const parentSessionId = getSessionId(ctx) || undefined;
      const parentSessionFile = getSessionFile(ctx) || undefined;
      const requestedContext: ContextMode | undefined = input.context;

      if (input.chain?.length) {
        const runCwd = input.cwd || ctx.cwd;
        const steps = resolveRequestedTasks(input.chain, currentDepth, runCwd);
        if (steps.error) return toolError(steps.error);
        if (input.async) {
          return toolError("Async chain orchestration is not implemented yet; run the chain in foreground for now.");
        }
        const result = await runChainForeground(pi, steps.value, {
          cwd: runCwd,
          depth: currentDepth + 1,
          context: requestedContext,
          parentSessionId,
          parentSessionFile,
        }, ctx);
        refreshUi(ctx);
        return {
          content: [{ type: "text", text: renderChainResult(result) }],
          details: { action: "chain", ...result },
          isError: result.steps.some((step) => step.exitCode !== 0),
        };
      }

      if (input.tasks?.length) {
        const runCwd = input.cwd || ctx.cwd;
        const steps = resolveRequestedTasks(input.tasks, currentDepth, runCwd);
        if (steps.error) return toolError(steps.error);
        const groupId = createRunId("parallel");
        if (input.async) {
          const launched = steps.value.map((step, index) => launchAsyncRun(pi, step.agent, {
            task: step.task,
            model: step.model,
            thinking: step.thinking,
            cwd: step.cwd || input.cwd || ctx.cwd,
            timeoutMs: step.timeoutMs || input.timeoutMs,
            depth: currentDepth + 1,
            context: requestedContext || step.agent.override.defaultContext || "fresh",
            parentSessionId,
            parentSessionFile,
            groupId,
            stepIndex: index,
            totalSteps: steps.value.length,
            stepLabel: `parallel ${index + 1}/${steps.value.length}`,
          }, activeRuns, ctx));
          refreshUi(ctx);
          return {
            content: [{ type: "text", text: `Started ${launched.length} background subagents. groupId: ${groupId}` }],
            details: { action: "parallel", mode: "async", groupId, runs: launched.map((item) => item.record) },
          };
        }
        const result = await runParallelForeground(steps.value, {
          cwd: runCwd,
          depth: currentDepth + 1,
          context: requestedContext,
          parentSessionId,
          parentSessionFile,
        }, ctx);
        refreshUi(ctx);
        return {
          content: [{ type: "text", text: renderParallelResult(result) }],
          details: { action: "parallel", ...result },
          isError: result.steps.some((step) => step.exitCode !== 0),
        };
      }

      if (!input.task?.trim()) {
        return toolError("Missing task. Pass { agent, task }.");
      }

      const runCwd = input.cwd || ctx.cwd;
      const agent = resolveAgent(loadAgents(runCwd), input.agent || "");
      if (!agent) return toolError(`Unknown agent '${input.agent}' for cwd '${runCwd}'. Run subagent({ action: 'list' }) from that project first.`);
      const maxDepth = agent.override.maxSubagentDepth;
      if (typeof maxDepth === "number" && currentDepth >= maxDepth) {
        return toolError(`Blocked: agent '${agent.runtimeName}' reached maxSubagentDepth ${maxDepth}.`);
      }

      const request: RunRequest = {
        task: input.task,
        model: input.model,
        thinking: input.thinking,
        cwd: runCwd,
        timeoutMs: input.timeoutMs,
        depth: currentDepth + 1,
        context: input.context || agent.override.defaultContext || "fresh",
        parentSessionId,
        parentSessionFile,
        onUpdate: _onUpdate,
      };

      if (input.async ?? agent.override.async) {
        const launched = launchAsyncRun(pi, agent, request, activeRuns, ctx);
        refreshUi(ctx);
        return {
          content: [{ type: "text", text: `Started ${agent.runtimeName} in background. runId: ${launched.record.runId}` }],
          details: { action: "run", mode: "async", runId: launched.record.runId, record: launched.record },
        };
      }

      const runResult = await runChildAgentForeground(agent, request, ctx);
      refreshUi(ctx);
      return {
        content: [{ type: "text", text: runResult.output || "(no output)" }],
        details: {
          action: "run",
          mode: "foreground",
          agent: agent.runtimeName,
          model: runResult.model,
          thinking: runResult.thinking,
          attemptedModels: runResult.attemptedModels,
          command: runResult.command,
          timeoutMs: runResult.timeoutMs,
          elapsedMs: runResult.elapsedMs,
          exitCode: runResult.exitCode,
          timedOut: runResult.timedOut,
          contextMode: runResult.contextMode,
          childSessionFile: runResult.childSessionFile,
          sourcePath: agent.sourcePath,
          configPath: CONFIG_PATH,
        },
        isError: runResult.exitCode !== 0,
      };
    },
  });
}

function toolError(text: string) {
  return {
    content: [{ type: "text", text }],
    details: { isError: true },
    isError: true,
  };
}

function resolveRequestedTasks(
  tasks: Array<{ agent: string; task: string; model?: string; thinking?: string; cwd?: string; timeoutMs?: number }>,
  currentDepth: number,
  defaultCwd: string,
): { value: Array<{ agent: AgentDef; task: string; model?: string; thinking?: string; cwd?: string; timeoutMs?: number }>; error?: undefined } | { value?: undefined; error: string } {
  const resolved: Array<{ agent: AgentDef; task: string; model?: string; thinking?: string; cwd?: string; timeoutMs?: number }> = [];
  for (const task of tasks) {
    const effectiveCwd = task.cwd || defaultCwd;
    const agent = resolveAgent(loadAgents(effectiveCwd), task.agent);
    if (!agent) return { error: `Unknown agent '${task.agent}' for cwd '${effectiveCwd}'.` };
    const maxDepth = agent.override.maxSubagentDepth;
    if (typeof maxDepth === "number" && currentDepth >= maxDepth) {
      return { error: `Blocked: agent '${agent.runtimeName}' reached maxSubagentDepth ${maxDepth}.` };
    }
    resolved.push({ agent, task: task.task, model: task.model, thinking: task.thinking, cwd: task.cwd, timeoutMs: task.timeoutMs });
  }
  return { value: resolved };
}

async function runParallelForeground(
  steps: Array<{ agent: AgentDef; task: string; model?: string; thinking?: string; cwd?: string; timeoutMs?: number }>,
  options: { cwd: string; depth: number; context?: ContextMode; parentSessionId?: string; parentSessionFile?: string },
  ctx: any,
) {
  const results = await Promise.all(steps.map((step) => runChildAgentForeground(step.agent, {
    task: step.task,
    model: step.model,
    thinking: step.thinking,
    cwd: step.cwd || options.cwd,
    timeoutMs: step.timeoutMs,
    depth: options.depth,
    context: options.context || step.agent.override.defaultContext || "fresh",
    parentSessionId: options.parentSessionId,
    parentSessionFile: options.parentSessionFile,
  }, ctx)));
  return {
    mode: "foreground",
    steps: results.map((result, index) => ({
      index,
      agent: steps[index]!.agent.runtimeName,
      task: steps[index]!.task,
      ...result,
    })),
  };
}

async function runChainForeground(
  pi: ExtensionAPI,
  steps: Array<{ agent: AgentDef; task: string; model?: string; thinking?: string; cwd?: string; timeoutMs?: number }>,
  options: { cwd: string; depth: number; context?: ContextMode; parentSessionId?: string; parentSessionFile?: string },
  ctx: any,
) {
  const results: Array<{ index: number; agent: string; task: string; output: string; exitCode: number; elapsedMs: number; timedOut: boolean; model?: string; attemptedModels: string[]; command: string[]; timeoutMs?: number; contextMode: ContextMode; childSessionFile?: string }> = [];
  let previousOutput = "";
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]!;
    const task = previousOutput.trim()
      ? `${step.task}\n\nUpstream handoff from previous chain step:\n${truncateLine(previousOutput.trim(), 6000)}`
      : step.task;
    const result = await runChildAgentForeground(step.agent, {
      task,
      model: step.model,
      thinking: step.thinking,
      cwd: step.cwd || options.cwd,
      timeoutMs: step.timeoutMs,
      depth: options.depth,
      context: options.context || step.agent.override.defaultContext || "fresh",
      parentSessionId: options.parentSessionId,
      parentSessionFile: options.parentSessionFile,
      stepIndex: index,
      totalSteps: steps.length,
      stepLabel: `chain ${index + 1}/${steps.length}`,
    }, ctx);
    results.push({ index, agent: step.agent.runtimeName, task: step.task, ...result });
    previousOutput = result.output;
    if (result.exitCode !== 0) break;
  }
  return { mode: "foreground", steps: results };
}

function loadAgents(projectCwd = process.cwd()): AgentDef[] {
  const policyLayers = loadRuntimePolicy(projectCwd);
  const resolved = new Map<string, AgentDef>();

  for (const dir of getAgentSourceDirs(projectCwd)) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".md")) continue;
      const filePath = join(dir, entry);
      const parsed = parseMarkdownAgent(readFileSync(filePath, "utf8"));
      if (!parsed) continue;
      const name = asNonEmptyString(parsed.frontmatter.name);
      if (!name) continue;
      const packageName = asNonEmptyString(parsed.frontmatter.package);
      const runtimeName = packageName ? `${packageName}.${name}` : name;
      const override = resolveRuntimeOverride(policyLayers, runtimeName, name);
      if (override.disabled === true) continue;
      resolved.set(runtimeName, {
        name,
        runtimeName,
        packageName,
        description: override.description || asNonEmptyString(parsed.frontmatter.description) || "",
        sourcePath: filePath,
        systemPrompt: typeof override.systemPrompt === "string" ? override.systemPrompt : parsed.body,
        override,
      });
    }
  }

  return Array.from(resolved.values()).sort((a, b) => a.runtimeName.localeCompare(b.runtimeName));
}

function getRuntimePolicyPaths(projectCwd = process.cwd()): string[] {
  const projectConfigPath = resolve(projectCwd, PROJECT_CONFIG_RELATIVE_PATH);
  return projectConfigPath === CONFIG_PATH ? [CONFIG_PATH] : [CONFIG_PATH, projectConfigPath];
}

function loadRuntimePolicy(projectCwd = process.cwd()): RuntimePolicyLayer[] {
  const layers: RuntimePolicyLayer[] = [];

  for (const configPath of getRuntimePolicyPaths(projectCwd)) {
    if (!existsSync(configPath)) continue;
    const parsed = parseJsonc(readFileSync(configPath, "utf8"));
    const rawDefaults = parsed.defaults;
    const defaults = rawDefaults && typeof rawDefaults === "object" && !Array.isArray(rawDefaults)
      ? normalizeDefaultsPolicy(rawDefaults as JsonObject)
      : {};
    const agentOverrides: Record<string, NormalizedOverrideConfig> = {};
    const rawOverrides = parsed.agentOverrides;
    if (rawOverrides && typeof rawOverrides === "object" && !Array.isArray(rawOverrides)) {
      for (const [name, rawOverride] of Object.entries(rawOverrides)) {
        if (!rawOverride || typeof rawOverride !== "object" || Array.isArray(rawOverride)) continue;
        agentOverrides[name] = normalizeOverride(rawOverride as JsonObject);
      }
    }
    layers.push({ defaults, agentOverrides });
  }

  return layers;
}

function resolveRuntimeOverride(layers: RuntimePolicyLayer[], runtimeName: string, name: string): OverrideConfig {
  let resolved: OverrideConfig = {};
  for (const layer of layers) {
    resolved = mergeOverrides(resolved, layer.defaults);
    resolved = mergeOverrides(resolved, layer.agentOverrides[runtimeName] ?? layer.agentOverrides[name] ?? {});
  }
  return resolved;
}

function normalizeDefaultsPolicy(input: JsonObject): NormalizedOverrideConfig {
  const defaults = normalizeOverride(input);
  delete defaults.model;
  delete defaults.fallbackModels;
  delete defaults.thinking;
  return defaults;
}

function mergeOverrides(defaults: OverrideConfig, override: NormalizedOverrideConfig): OverrideConfig {
  const merged = { ...defaults };
  for (const [key, value] of Object.entries(override)) {
    if (key === "unset" || value === undefined) continue;
    (merged as Record<string, unknown>)[key] = value;
  }
  for (const key of override.unset ?? []) delete merged[key];
  return merged;
}

function normalizeOverride(input: JsonObject): NormalizedOverrideConfig {
  return {
    model: asNonEmptyString(input.model),
    fallbackModels: asStringArray(input.fallbackModels),
    thinking: asNonEmptyString(input.thinking),
    tools: normalizeToolList(asStringArray(input.tools)),
    defaultContext: input.defaultContext === "fresh" || input.defaultContext === "fork" ? input.defaultContext : undefined,
    timeoutMs: asPositiveInteger(input.timeoutMs),
    turnBudget: asTurnBudget(input.turnBudget),
    maxSubagentDepth: asPositiveInteger(input.maxSubagentDepth),
    systemPrompt: asNonEmptyString(input.systemPrompt),
    systemPromptMode: input.systemPromptMode === "replace" || input.systemPromptMode === "append" ? input.systemPromptMode : undefined,
    description: asNonEmptyString(input.description),
    extensions: asStringArray(input.extensions),
    subagentOnlyExtensions: asStringArray(input.subagentOnlyExtensions),
    skills: asStringArray(input.skills),
    inheritProjectContext: asBoolean(input.inheritProjectContext),
    inheritSkills: asBoolean(input.inheritSkills),
    acceptance: asStringArray(input.acceptance) || (typeof input.acceptance === "string" ? [input.acceptance] : undefined),
    acceptanceRole: asNonEmptyString(input.acceptanceRole),
    completionGuard: asBoolean(input.completionGuard),
    interactive: asBoolean(input.interactive),
    memory: asNonEmptyString(input.memory),
    output: asNonEmptyString(input.output),
    defaultReads: asStringArray(input.defaultReads),
    defaultProgress: asNonEmptyString(input.defaultProgress),
    toolBudget: asPositiveInteger(input.toolBudget),
    async: asBoolean(input.async),
    disabled: asBoolean(input.disabled),
    unset: asStringArray(input.unset)?.filter((key): key is keyof OverrideConfig => OVERRIDE_KEYS.has(key as keyof OverrideConfig)),
  };
}

function renderAgentList(agents: AgentDef[], projectCwd = process.cwd()): string[] {
  const sourceDirs = getAgentSourceDirs(projectCwd);
  if (agents.length === 0) {
    return [
      "No subagents found.",
      `agent sources: ${sourceDirs.join(" | ")}`,
      `configs: ${getRuntimePolicyPaths(projectCwd).join(" | ")}`,
      `schema: ${SCHEMA_PATH}`,
    ];
  }

  const lines = [
    `agent sources: ${sourceDirs.join(" | ")}`,
    `precedence: later sources win (project overrides user)`,
    `configs: ${getRuntimePolicyPaths(projectCwd).join(" | ")}`,
    `precedence: project config overrides global config`,
    `schema: ${SCHEMA_PATH}`,
    `runs dir: ${RUNS_DIR}`,
    `count: ${agents.length}`,
    "",
  ];

  for (const agent of agents) {
    lines.push(`- ${agent.runtimeName}${agent.override.model ? ` – ${agent.override.model}` : ""}`);
    if (agent.description) lines.push(`  ${agent.description}`);
    if (agent.override.tools?.length) lines.push(`  tools: ${agent.override.tools.join(", ")}`);
    if (agent.override.extensions?.length || agent.override.subagentOnlyExtensions?.length) {
      lines.push(`  extensions: ${[...(agent.override.extensions || []), ...(agent.override.subagentOnlyExtensions || [])].join(", ")}`);
    }
    if (agent.override.timeoutMs) lines.push(`  timeoutMs: ${agent.override.timeoutMs}`);
    if (agent.override.defaultContext) lines.push(`  defaultContext: ${agent.override.defaultContext}`);
  }

  return lines;
}

function renderRunList(runs: RunRecord[]): string[] {
  if (runs.length === 0) {
    return ["No async runs found.", `runs dir: ${RUNS_DIR}`];
  }

  const lines = [`runs dir: ${RUNS_DIR}`, `count: ${runs.length}`, ""];
  for (const run of runs) {
    lines.push(`- ${run.runId} – ${run.agent} – ${run.status}`);
    lines.push(`  started: ${run.startedAt}`);
    if (run.finishedAt) lines.push(`  finished: ${run.finishedAt}`);
    if (run.elapsedMs !== undefined) lines.push(`  elapsedMs: ${run.elapsedMs}`);
    lines.push(`  context: ${run.contextMode}`);
    if (run.groupId) lines.push(`  group: ${run.groupId}`);
    lines.push(`  cwd: ${run.cwd}`);
  }
  return lines;
}

function summarizeAgent(agent: AgentDef) {
  return {
    name: agent.name,
    runtimeName: agent.runtimeName,
    description: agent.description,
    sourcePath: agent.sourcePath,
    model: agent.override.model,
    thinking: agent.override.thinking,
    fallbackModels: agent.override.fallbackModels,
    tools: agent.override.tools,
    extensions: agent.override.extensions,
    subagentOnlyExtensions: agent.override.subagentOnlyExtensions,
    timeoutMs: agent.override.timeoutMs,
    defaultContext: agent.override.defaultContext,
    maxSubagentDepth: agent.override.maxSubagentDepth,
  };
}

function resolveAgent(agents: AgentDef[], requested: string): AgentDef | undefined {
  return agents.find((agent) => agent.runtimeName === requested) || agents.find((agent) => agent.name === requested);
}

function launchAsyncRun(
  pi: ExtensionAPI,
  agent: AgentDef,
  options: RunRequest,
  activeRuns: Map<string, ActiveRun>,
  ctx: any,
): ActiveRun {
  ensureRunsDir();
  const runId = createRunId(agent.runtimeName);
  const runDir = join(RUNS_DIR, runId);
  createRunArtifactDirectory(runDir, runId, "async");
  const plan = buildChildPlan(agent, options, ctx, runDir);

  const record: RunRecord = {
    runId,
    kind: "single",
    agent: agent.runtimeName,
    task: options.task,
    cwd: options.cwd,
    contextMode: plan.contextMode,
    model: plan.model,
    thinking: plan.thinking,
    modelCandidates: plan.modelCandidates,
    timeoutMs: plan.timeoutMs,
    command: plan.args,
    sourcePath: agent.sourcePath,
    status: "running",
    startedAt: new Date().toISOString(),
    outputPath: join(runDir, "output.txt"),
    stderrPath: join(runDir, "stderr.txt"),
    metaPath: join(runDir, "meta.json"),
    resultSummaryPath: join(runDir, "result.summary.md"),
    resultFullPath: join(runDir, "result.full.md"),
    parentSessionId: options.parentSessionId,
    parentSessionFile: options.parentSessionFile,
    childSessionFile: plan.childSessionFile,
    notification: { state: "undelivered" },
    groupId: options.groupId,
    stepIndex: options.stepIndex,
    totalSteps: options.totalSteps,
    stepLabel: options.stepLabel,
  };
  persistRunRecord(record);
  upsertFleetEntry(fleetEntryFromRecord(record, "async"));
  appendRunEntry(pi, record, "started");

  const proc = spawn("pi", plan.args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      [DEPTH_ENV]: String(options.depth),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  record.pid = proc.pid;
  persistRunRecord(record);

  const active: ActiveRun = {
    record,
    proc,
    startedAtMs: Date.now(),
    outputChunks: [],
    stderrChunks: [],
    stdoutBuffer: "",
  };
  activeRuns.set(runId, active);

  if (plan.timeoutMs) {
    active.timer = setTimeout(() => {
      active.record.timedOut = true;
      active.record.status = "timed_out";
      updateFleetStatus(runId, "timed_out");
      persistRunRecord(active.record);
      proc.kill("SIGTERM");
    }, plan.timeoutMs);
    active.timer.unref?.();
  }

  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk: string) => {
    active.stdoutBuffer += chunk;
    const lines = active.stdoutBuffer.split("\n");
    active.stdoutBuffer = lines.pop() || "";
    for (const line of lines) consumeJsonLine(line, active.outputChunks, (activity) => updateFleetActivity(runId, activity));
    persistRunBuffers(active);
  });

  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (chunk: string) => {
    active.stderrChunks.push(chunk);
    updateFleetPreview(runId, chunk);
    persistRunBuffers(active);
  });

  proc.on("close", (code) => {
    if (active.timer) clearTimeout(active.timer);
    if (active.stdoutBuffer.trim()) consumeJsonLine(active.stdoutBuffer, active.outputChunks, (activity) => updateFleetActivity(runId, activity));
    if (active.record.status === "running") active.record.status = code === 0 ? "completed" : "failed";
    if (active.record.stopped) active.record.status = "stopped";
    if (active.record.timedOut) active.record.status = "timed_out";
    active.record.exitCode = code ?? 1;
    active.record.finishedAt = new Date().toISOString();
    active.record.elapsedMs = Date.now() - active.startedAtMs;
    finalizeRunArtifacts(active.record, active.outputChunks.join(""), active.stderrChunks.join(""));
    persistRunBuffers(active);
    persistRunRecord(active.record);
    finishFleetEntry(runId, active.record.status);
    appendRunEntry(pi, active.record, "completed");
    deliverRunNotification(pi, active.record);
    activeRuns.delete(runId);
  });

  proc.on("error", (error) => {
    if (active.timer) clearTimeout(active.timer);
    active.stderrChunks.push(error.message);
    updateFleetPreview(runId, error.message);
    active.record.status = "spawn_error";
    active.record.exitCode = 1;
    active.record.finishedAt = new Date().toISOString();
    active.record.elapsedMs = Date.now() - active.startedAtMs;
    finalizeRunArtifacts(active.record, active.outputChunks.join(""), active.stderrChunks.join(""));
    persistRunBuffers(active);
    persistRunRecord(active.record);
    finishFleetEntry(runId, active.record.status);
    appendRunEntry(pi, active.record, "completed");
    deliverRunNotification(pi, active.record);
    activeRuns.delete(runId);
  });

  return active;
}

async function runChildAgentForeground(
  agent: AgentDef,
  options: RunRequest,
  ctx: any,
): Promise<{ output: string; exitCode: number; elapsedMs: number; timedOut: boolean; model?: string; thinking?: string; attemptedModels: string[]; timeoutMs?: number; command: string[]; contextMode: ContextMode; childSessionFile?: string }> {
  const runId = createRunId(`${agent.runtimeName}-fg`);
  const runDir = join(RUNS_DIR, runId);
  createRunArtifactDirectory(runDir, runId, "foreground");
  const candidates = getModelCandidates(agent, options, ctx);
  let lastResult: { output: string; exitCode: number; elapsedMs: number; timedOut: boolean; model?: string; thinking?: string; timeoutMs?: number; command: string[]; contextMode: ContextMode; childSessionFile?: string } | undefined;
  const attempted: string[] = [];

  for (const candidate of candidates.length > 0 ? candidates : [undefined]) {
    const plan = buildChildPlan(agent, { ...options, model: candidate }, ctx, runDir);
    upsertFleetEntry({
      key: runId,
      runId,
      kind: "foreground",
      agent: agent.runtimeName,
      task: options.task,
      status: "running",
      cwd: options.cwd,
      contextMode: plan.contextMode,
      startedAtMs: fleetEntries.get(runId)?.startedAtMs || Date.now(),
      updatedAtMs: Date.now(),
      model: plan.model,
      stepLabel: options.stepLabel,
      groupId: options.groupId,
      childSessionFile: plan.childSessionFile,
    });
    let emitForegroundUpdate = makeForegroundUpdateEmitter(options.onUpdate, runId);
    emitForegroundUpdate();
    const env = { ...process.env, [DEPTH_ENV]: String(options.depth) };
    const result = await new Promise<{ output: string; exitCode: number; elapsedMs: number; timedOut: boolean; model?: string; thinking?: string; timeoutMs?: number; command: string[]; contextMode: ContextMode; childSessionFile?: string }>((resolveRun) => {
      const startedAt = Date.now();
      const proc = spawn("pi", plan.args, { cwd: options.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
      const activeMarkerPath = join(runDir, "active.json");
      writeFileSync(activeMarkerPath, `${JSON.stringify({ kind: "foreground", pid: proc.pid, startedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
      let timedOut = false;
      let buffer = "";
      const textChunks: string[] = [];
      const stderrChunks: string[] = [];
      const timer = plan.timeoutMs ? setTimeout(() => {
        timedOut = true;
        updateFleetStatus(runId, "timed_out");
        proc.kill("SIGTERM");
      }, plan.timeoutMs) : null;
      timer?.unref?.();

      proc.stdout.setEncoding("utf8");
      proc.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) consumeJsonLine(line, textChunks, (activity) => {
          updateFleetActivity(runId, activity);
          emitForegroundUpdate();
        });
      });

      proc.stderr.setEncoding("utf8");
      proc.stderr.on("data", (chunk: string) => {
        stderrChunks.push(chunk);
        updateFleetPreview(runId, chunk);
        emitForegroundUpdate();
      });

      proc.on("close", (code) => {
        if (timer) clearTimeout(timer);
        rmSync(activeMarkerPath, { force: true });
        if (buffer.trim()) consumeJsonLine(buffer, textChunks, (activity) => {
          updateFleetActivity(runId, activity);
          emitForegroundUpdate(true);
        });
        const output = textChunks.join("").trim() || stderrChunks.join("").trim();
        resolveRun({
          output,
          exitCode: code ?? 1,
          elapsedMs: Date.now() - startedAt,
          timedOut,
          model: plan.model,
          thinking: plan.thinking,
          timeoutMs: plan.timeoutMs,
          command: plan.args,
          contextMode: plan.contextMode,
          childSessionFile: plan.childSessionFile,
        });
      });

      proc.on("error", (error) => {
        if (timer) clearTimeout(timer);
        rmSync(activeMarkerPath, { force: true });
        updateFleetPreview(runId, error.message);
        emitForegroundUpdate(true);
        resolveRun({
          output: error.message,
          exitCode: 1,
          elapsedMs: Date.now() - startedAt,
          timedOut,
          model: plan.model,
          thinking: plan.thinking,
          timeoutMs: plan.timeoutMs,
          command: plan.args,
          contextMode: plan.contextMode,
          childSessionFile: plan.childSessionFile,
        });
      });
    });

    if (result.model) attempted.push(result.model);
    lastResult = result;
    if (result.exitCode === 0 || candidate === candidates[candidates.length - 1]) break;
    updateFleetPreview(runId, `\nRetrying ${agent.runtimeName} with next model...\n`);
    emitForegroundUpdate(true);
  }

  const finalStatus: FleetEntryStatus = lastResult?.timedOut ? "timed_out" : lastResult?.exitCode === 0 ? "completed" : "failed";
  finishFleetEntry(runId, finalStatus);
  makeForegroundUpdateEmitter(options.onUpdate, runId)(true);

  const fallback = lastResult || {
    output: "Failed before launch.",
    exitCode: 1,
    elapsedMs: 0,
    timedOut: false,
    model: candidates[0],
    thinking: resolveThinking(agent, options, ctx),
    timeoutMs: options.timeoutMs || agent.override.timeoutMs,
    command: [],
    contextMode: options.context,
    childSessionFile: undefined,
  };
  return { ...fallback, attemptedModels: attempted };
}

function getModelCandidates(agent: AgentDef, options: RunRequest, ctx: any): string[] {
  const inheritedModel = currentParentModel(ctx);
  return uniqueStrings([options.model, agent.override.model, ...(agent.override.fallbackModels || []), inheritedModel]);
}

function currentParentModel(ctx: any): string | undefined {
  const model = ctx?.model;
  if (!model) return undefined;
  if (typeof model === "string") return model.trim() || undefined;
  const provider = typeof model.provider === "string" ? model.provider : typeof model.provider?.id === "string" ? model.provider.id : undefined;
  const id = typeof model.id === "string" ? model.id : typeof model.model === "string" ? model.model : undefined;
  if (provider && id) return `${provider}/${id}`;
  return id || undefined;
}

function resolveThinking(agent: AgentDef, options: RunRequest, ctx: any): string | undefined {
  return options.thinking || agent.override.thinking || asNonEmptyString(ctx?.thinkingLevel) || asNonEmptyString(ctx?.thinking);
}

function buildChildPlan(agent: AgentDef, options: RunRequest, ctx: any, runDir: string): ChildPlan {
  const contextMode: ContextMode = options.context || agent.override.defaultContext || "fresh";
  const modelCandidates = getModelCandidates(agent, options, ctx);
  const model = modelCandidates[0];
  const thinking = resolveThinking(agent, options, ctx);
  const timeoutMs = options.timeoutMs || agent.override.timeoutMs;
  const args = ["--mode", "json", "-p"];

  let childSessionFile: string | undefined;
  if (contextMode === "fork") {
    const parentSessionFile = options.parentSessionFile || getSessionFile(ctx) || undefined;
    if (!parentSessionFile || !existsSync(parentSessionFile)) {
      throw new Error("Forked subagent context requires a persisted parent session file. Save or continue the session first.");
    }
    childSessionFile = join(runDir, "child-session.jsonl");
    mkdirSync(dirname(childSessionFile), { recursive: true });
    copyFileSync(parentSessionFile, childSessionFile);
    args.push("--session", childSessionFile);
  } else {
    args.push("--no-session");
  }

  if (model) args.push("--model", model);
  if (thinking) args.push("--thinking", thinking);
  if (agent.override.tools) {
    args.push(agent.override.tools.length > 0 ? "--tools" : "--no-tools");
    if (agent.override.tools.length > 0) args.push(agent.override.tools.join(","));
  }

  const extensionPaths = uniqueStrings([...(agent.override.extensions || []), ...(agent.override.subagentOnlyExtensions || [])]);
  for (const extensionPath of extensionPaths) {
    args.push("--extension", extensionPath);
  }

  if (agent.override.inheritProjectContext === false) args.push("--no-context-files");
  if (agent.override.inheritSkills === false) args.push("--no-skills");

  const systemPrompt = buildEffectiveSystemPrompt(agent, options, ctx);
  if (systemPrompt.trim()) {
    const promptPath = join(runDir, "prompt.md");
    writeFileSync(promptPath, systemPrompt, "utf8");
    args.push(agent.override.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt", promptPath);
  }

  const taskPath = join(runDir, "task.md");
  const effectiveTask = buildTaskPacket(agent, options.task, contextMode, ctx, options.parentSessionId);
  writeFileSync(taskPath, effectiveTask, "utf8");
  args.push(`@${taskPath}`);

  return { args, model, thinking, modelCandidates, timeoutMs, contextMode, childSessionFile, effectiveTask };
}

function buildEffectiveSystemPrompt(agent: AgentDef, options: RunRequest, ctx: any): string {
  let prompt = agent.systemPrompt.trim();
  if (agent.override.turnBudget) {
    const grace = agent.override.turnBudget.graceTurns ?? 1;
    prompt += `\n\nTurn budget hint: wrap up within ${agent.override.turnBudget.maxTurns} assistant turns with ${grace} grace turns.`;
  }
  if (agent.override.toolBudget) {
    prompt += `\n\nTool budget hint: keep tool usage within about ${agent.override.toolBudget} calls unless the task clearly requires more.`;
  }
  if (agent.override.defaultReads?.length) {
    prompt += `\n\nDefault reads to inspect early when relevant:\n${agent.override.defaultReads.map((item) => `- ${item}`).join("\n")}`;
  }
  if (agent.override.acceptance?.length) {
    const role = agent.override.acceptanceRole || "Acceptance";
    prompt += `\n\n${role}:\n${agent.override.acceptance.map((item) => `- ${item}`).join("\n")}`;
  }
  if (agent.override.completionGuard === true) {
    prompt += "\n\nCompletion guard: do not claim completion without concrete evidence, changed files, commands run, or explicit reason no such evidence exists.";
  }
  if (agent.override.defaultProgress) {
    prompt += `\n\nProgress reporting preference: ${agent.override.defaultProgress}`;
  }
  if (agent.override.memory) {
    prompt += `\n\nMemory scope for this run: ${agent.override.memory}.`;
  }
  if (agent.override.skills?.length) {
    prompt += `\n\nSkills expected for this run: ${agent.override.skills.join(", ")}.`;
  }
  if (options.context === "fork") {
    const sessionId = options.parentSessionId || getSessionId(ctx) || "unknown";
    prompt += `\n\nThis is a forked child run from parent session ${sessionId}. Continue the inherited work, but stay scoped to the delegated task.`;
  }
  return prompt;
}

function buildTaskPacket(agent: AgentDef, task: string, contextMode: ContextMode, ctx: any, parentSessionId?: string): string {
  const blocks = ["## Task", task.trim()];
  blocks.push("", "## Runtime", `- Agent: ${agent.runtimeName}`, `- Context: ${contextMode}`);
  if (parentSessionId) blocks.push(`- Parent session: ${parentSessionId}`);
  if (agent.override.output) blocks.push(`- Expected output artifact: ${agent.override.output}`);
  if (agent.override.interactive === false) blocks.push("- Interactive follow-up: avoid asking for live clarification; return best effort plus open questions.");
  if (contextMode === "fork") {
    const branch = typeof ctx?.sessionManager?.getBranch === "function" ? ctx.sessionManager.getBranch() : [];
    const summary = summarizeBranch(branch, FORK_CONTEXT_LINES);
    if (summary) blocks.push("", "## Forked parent context snapshot", summary);
  }
  blocks.push("", "## Completion contract", "Return a concise summary, key findings, concrete artifacts/changed files, commands run if any, and recommended next step for the parent.");
  return blocks.join("\n");
}

function summarizeBranch(entries: any[], maxLines: number): string {
  const lines: string[] = [];
  for (const entry of entries.slice(-80)) {
    if (entry?.type !== "message") continue;
    const role = entry.message?.role;
    if (role !== "user" && role !== "assistant" && role !== "toolResult") continue;
    const text = extractEntryText(entry).replace(/\s+/g, " ").trim();
    if (!text) continue;
    lines.push(`- ${role}: ${truncateLine(text, 240)}`);
  }
  return lines.slice(-maxLines).join("\n");
}

function extractEntryText(entry: any): string {
  const content = entry?.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n");
}

function consumeJsonLine(line: string, textChunks: string[], onActivity?: (activity: ChildActivity) => void) {
  if (!line.trim()) return;
  try {
    const event = JSON.parse(line) as any;
    const activity = extractChildActivity(event);
    if (event.type === "message_update") {
      const delta = event.assistantMessageEvent;
      if (delta?.type === "text_delta" && typeof delta.delta === "string") textChunks.push(delta.delta);
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      const parts = event.message?.content;
      if (Array.isArray(parts)) {
        const text = parts
          .filter((part: any) => part?.type === "text" && typeof part.text === "string")
          .map((part: any) => part.text)
          .join("");
        if (text) textChunks.push(text);
      }
    }
    if (onActivity && Object.keys(activity).length > 0) onActivity(activity);
  } catch {
    // ignore non-json noise
  }
}

function extractChildActivity(event: any): ChildActivity {
  const activity: ChildActivity = {};
  const delta = event?.assistantMessageEvent;
  if (delta?.type === "text_delta" && typeof delta.delta === "string") activity.textDelta = delta.delta;
  if (event?.type === "message_end" && event?.message?.role === "assistant") activity.turnEnded = true;

  if (event?.type === "tool_execution_start") {
    activity.toolStarted = true;
    activity.toolName = asNonEmptyString(event.toolName);
    activity.toolArgs = summarizeToolArgs(event.args);
    const directPath = findPathHint(event.args);
    if (directPath) activity.path = directPath;
  } else if (event?.type === "tool_execution_end" || event?.type === "tool_result_end") {
    activity.toolEnded = true;
  } else {
    const tool = findToolHint(event);
    if (tool.name) {
      activity.toolName = tool.name;
      activity.toolArgs = tool.args;
    }
  }

  const path = findPathHint(event);
  if (path) activity.path = path;
  const tokens = findTokenHint(event);
  if (tokens !== undefined) activity.tokens = tokens;
  return activity;
}

function findToolHint(value: unknown, depth = 0): { name?: string; args?: string } {
  if (!value || typeof value !== "object" || depth > 5) return {};
  const record = value as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
  const name = typeof record.name === "string" ? record.name : typeof record.toolName === "string" ? record.toolName : undefined;
  if (name && (type.includes("tool") || "toolName" in record || "input" in record || "arguments" in record)) {
    const args = summarizeToolArgs(record.input ?? record.arguments ?? record.args);
    return { name, args };
  }
  for (const child of Object.values(record)) {
    const found = findToolHint(child, depth + 1);
    if (found.name) return found;
  }
  return {};
}

function summarizeToolArgs(value: unknown): string | undefined {
  if (typeof value === "string") return truncateLine(value.replace(/\s+/g, " "), 80);
  if (!value || typeof value !== "object") return undefined;
  try {
    return truncateLine(JSON.stringify(value), 80);
  } catch {
    return undefined;
  }
}

function findPathHint(value: unknown, depth = 0): string | undefined {
  if (!value || typeof value !== "object" || depth > 5) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["path", "file", "filePath", "cwd"] as const) {
    if (typeof record[key] === "string") return truncateLine(record[key], 120);
  }
  for (const child of Object.values(record)) {
    const found = findPathHint(child, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function findTokenHint(value: unknown, depth = 0): number | undefined {
  if (!value || typeof value !== "object" || depth > 5) return undefined;
  const record = value as Record<string, unknown>;
  const direct = record.tokens ?? record.totalTokens ?? record.total_tokens;
  if (typeof direct === "number" && Number.isFinite(direct)) return direct;
  const input = record.inputTokens ?? record.input_tokens ?? record.prompt_tokens;
  const output = record.outputTokens ?? record.output_tokens ?? record.completion_tokens;
  if (typeof input === "number" && typeof output === "number") return input + output;
  for (const child of Object.values(record)) {
    const found = findTokenHint(child, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function getRunStatus(runId: string | undefined): { isError?: boolean; runId?: string; run?: RunRecord; runs?: RunRecord[]; outputPreview?: string; stderrPreview?: string } {
  if (!runId) return { runs: listRunRecords() };
  const record = readRunRecord(runId);
  if (!record) return { isError: true, runId, outputPreview: "", stderrPreview: "" };
  const reconciled = reconcileRunRecord(record);
  return {
    runId,
    run: reconciled,
    outputPreview: readPreview(reconciled.outputPath),
    stderrPreview: readPreview(reconciled.stderrPath),
  };
}

function stopRun(runId: string | undefined, activeRuns: Map<string, ActiveRun>): { isError?: boolean; runId?: string; status?: string; message: string } {
  if (!runId) return { isError: true, message: "Missing runId for stop." };
  const active = activeRuns.get(runId);
  if (active) {
    active.record.stopped = true;
    active.record.stopRequestedAt = new Date().toISOString();
    persistRunRecord(active.record);
    active.proc.kill("SIGTERM");
    return { runId, status: "stopping", message: `Stop requested for run '${runId}'.` };
  }

  const existing = readRunRecord(runId);
  if (!existing) return { isError: true, runId, message: `Run '${runId}' not found.` };
  existing.stopRequestedAt = new Date().toISOString();
  existing.stopped = true;
  persistRunRecord(existing);
  if (existing.pid && isPidAlive(existing.pid)) {
    try {
      process.kill(existing.pid, "SIGTERM");
      return { runId, status: "stopping", message: `Stop requested for run '${runId}'.` };
    } catch {
      return { runId, status: existing.status, message: `Stop requested for run '${runId}', but the owning process could not be signalled.` };
    }
  }
  const reconciled = reconcileRunRecord(existing);
  return { runId, status: reconciled.status, message: `Run '${runId}' is not live anymore; marked as ${reconciled.status}.` };
}

function renderRunStatusText(result: { isError?: boolean; runId?: string; run?: RunRecord; runs?: RunRecord[]; outputPreview?: string; stderrPreview?: string }): string {
  if (result.runs) return renderRunList(result.runs).join("\n");
  if (!result.run) return result.runId ? `Run '${result.runId}' not found.` : "No run data.";
  const lines = [
    `runId: ${result.run.runId}`,
    `agent: ${result.run.agent}`,
    `status: ${result.run.status}`,
    `context: ${result.run.contextMode}`,
    `model: ${result.run.model || "inherited"}`,
    `thinking: ${result.run.thinking || "inherited"}`,
    `cwd: ${result.run.cwd}`,
    `startedAt: ${result.run.startedAt}`,
  ];
  if (result.run.groupId) lines.push(`groupId: ${result.run.groupId}`);
  if (result.run.finishedAt) lines.push(`finishedAt: ${result.run.finishedAt}`);
  if (result.run.elapsedMs !== undefined) lines.push(`elapsedMs: ${result.run.elapsedMs}`);
  if (result.run.childSessionFile) lines.push(`childSessionFile: ${result.run.childSessionFile}`);
  if (result.outputPreview) lines.push("", "output preview:", result.outputPreview);
  if (result.stderrPreview) lines.push("", "stderr preview:", result.stderrPreview);
  return lines.join("\n");
}

function renderStopText(result: { isError?: boolean; runId?: string; status?: string; message: string }): string {
  return result.message;
}

function renderParallelResult(result: { steps: Array<{ index: number; agent: string; task: string; output: string; exitCode: number }> }): string {
  return result.steps
    .map((step) => `## ${step.index + 1}. ${step.agent}\nstatus: ${step.exitCode === 0 ? "completed" : "failed"}\n\n${step.output || "(no output)"}`)
    .join("\n\n");
}

function renderChainResult(result: { steps: Array<{ index: number; agent: string; task: string; output: string; exitCode: number }> }): string {
  return result.steps
    .map((step) => `## Step ${step.index + 1} – ${step.agent}\nstatus: ${step.exitCode === 0 ? "completed" : "failed"}\n\n${step.output || "(no output)"}`)
    .join("\n\n");
}

function ensureRunsDir() {
  mkdirSync(RUNS_DIR, { recursive: true });
}

function createRunArtifactDirectory(runDir: string, runId: string, kind: "async" | "foreground") {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, RUN_ARTIFACT_MARKER), `${JSON.stringify({ schemaVersion: 1, runId, kind, createdAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
}

function parseRunRetentionDays(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_RUN_RETENTION_DAYS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_RUN_RETENTION_DAYS;
}

type RunPruneResult = {
  deleted: string[];
  errors: Array<{ runId: string; message: string }>;
};

function pruneExpiredRunArtifacts(now = Date.now(), protectedRunIds = new Set<string>()): RunPruneResult {
  const result: RunPruneResult = { deleted: [], errors: [] };
  if (RUN_RETENTION_DAYS === 0) return result;

  let entries: Dirent[];
  try {
    ensureRunsDir();
    entries = readdirSync(RUNS_DIR, { withFileTypes: true });
  } catch (error) {
    result.errors.push({ runId: RUNS_DIR, message: error instanceof Error ? error.message : String(error) });
    return result;
  }

  const cutoff = now - RUN_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  for (const entry of entries) {
    if (!entry.isDirectory() || protectedRunIds.has(entry.name) || !isExpectedRunDirectoryName(entry.name)) continue;
    const runDir = join(RUNS_DIR, entry.name);

    try {
      const metaPath = join(runDir, "meta.json");
      const ownershipMarkerPath = join(runDir, RUN_ARTIFACT_MARKER);
      let record: Partial<RunRecord> | undefined;
      if (existsSync(metaPath)) {
        try {
          record = JSON.parse(readFileSync(metaPath, "utf8")) as Partial<RunRecord>;
        } catch {
          record = undefined;
        }
      }
      const hasValidMetadata = isValidLegacyRunRecord(record, entry.name);
      const ownsRunDirectory = hasValidRunArtifactMarker(ownershipMarkerPath, entry.name) || hasValidMetadata;
      if (!ownsRunDirectory) continue;
      if (hasValidMetadata && (record?.status === "running" || record?.status === "queued")) continue;

      const activeMarkerPath = join(runDir, "active.json");
      if (existsSync(activeMarkerPath)) {
        const marker = JSON.parse(readFileSync(activeMarkerPath, "utf8")) as { pid?: unknown };
        if (typeof marker.pid === "number" && isPidAlive(marker.pid)) continue;
      }

      let newestArtifactMtime = statSync(runDir).mtimeMs;
      for (const artifact of readdirSync(runDir, { withFileTypes: true })) {
        if (!artifact.isFile()) continue;
        newestArtifactMtime = Math.max(newestArtifactMtime, statSync(join(runDir, artifact.name)).mtimeMs);
      }
      if (newestArtifactMtime >= cutoff) continue;

      rmSync(runDir, { recursive: true, force: true });
      result.deleted.push(entry.name);
    } catch (error) {
      result.errors.push({ runId: entry.name, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

function isValidLegacyRunRecord(record: Partial<RunRecord> | undefined, expectedRunId: string): boolean {
  if (!record || record.runId !== expectedRunId || record.kind !== "single") return false;
  if (typeof record.agent !== "string" || record.agent.trim() === "") return false;
  if (typeof record.task !== "string" || typeof record.cwd !== "string") return false;
  if (!Array.isArray(record.command) || !record.command.every((argument) => typeof argument === "string")) return false;
  if (typeof record.sourcePath !== "string" || record.sourcePath.trim() === "") return false;
  if (record.contextMode !== "fresh" && record.contextMode !== "fork") return false;
  if (typeof record.startedAt !== "string" || !Number.isFinite(Date.parse(record.startedAt))) return false;
  if (!isAsyncRunStatus(record.status)) return false;
  if (!record.notification || (record.notification.state !== "delivered" && record.notification.state !== "undelivered")) return false;
  return hasExpectedArtifactPath(record.outputPath, expectedRunId, "output.txt")
    && hasExpectedArtifactPath(record.stderrPath, expectedRunId, "stderr.txt")
    && hasExpectedArtifactPath(record.metaPath, expectedRunId, "meta.json")
    && hasExpectedArtifactPath(record.resultSummaryPath, expectedRunId, "result.summary.md")
    && hasExpectedArtifactPath(record.resultFullPath, expectedRunId, "result.full.md");
}

function isAsyncRunStatus(status: unknown): status is AsyncRunStatus {
  return status === "queued" || status === "running" || status === "completed" || status === "failed"
    || status === "stopped" || status === "timed_out" || status === "spawn_error" || status === "orphaned";
}

function hasExpectedArtifactPath(path: unknown, expectedRunId: string, expectedFile: string): boolean {
  return typeof path === "string" && basename(path) === expectedFile && basename(dirname(path)) === expectedRunId;
}

function hasValidRunArtifactMarker(markerPath: string, expectedRunId: string): boolean {
  if (!existsSync(markerPath)) return false;
  try {
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as { schemaVersion?: unknown; runId?: unknown };
    return marker.schemaVersion === 1 && marker.runId === expectedRunId;
  } catch {
    return false;
  }
}

function getProtectedRunIds(activeRuns: Map<string, ActiveRun>): Set<string> {
  const protectedRunIds = new Set(activeRuns.keys());
  for (const entry of fleetEntries.values()) {
    if (entry.status === "running" || entry.status === "queued") protectedRunIds.add(entry.runId);
  }
  return protectedRunIds;
}

function isExpectedRunDirectoryName(name: string): boolean {
  return /^.+-\d{14}-[a-z0-9]{6}$/i.test(name);
}

function createRunId(agentName: string): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${agentName.replace(/[^A-Za-z0-9._-]/g, "-")}-${stamp}-${suffix}`;
}

function persistRunBuffers(active: ActiveRun) {
  writeFileSync(active.record.outputPath, active.outputChunks.join(""), "utf8");
  writeFileSync(active.record.stderrPath, active.stderrChunks.join(""), "utf8");
  if (active.record.status === "running") refreshExternalUi();
}

function finalizeRunArtifacts(record: RunRecord, output: string, stderr: string) {
  const summary = buildCompletionSummary(record, output, stderr);
  record.completionSummary = summary;
  writeFileSync(record.resultSummaryPath, `${summary}\n`, "utf8");
  const full = [
    `# Subagent run ${record.runId}`,
    "",
    `- agent: ${record.agent}`,
    `- status: ${record.status}`,
    `- context: ${record.contextMode}`,
    `- cwd: ${record.cwd}`,
    record.model ? `- model: ${record.model}` : undefined,
    record.thinking ? `- thinking: ${record.thinking}` : undefined,
    record.childSessionFile ? `- childSessionFile: ${record.childSessionFile}` : undefined,
    "",
    "## Task",
    record.task,
    "",
    "## Output",
    output.trim() || "(no output)",
    stderr.trim() ? "" : undefined,
    stderr.trim() ? "## Stderr" : undefined,
    stderr.trim() || undefined,
  ].filter((line) => line !== undefined).join("\n");
  writeFileSync(record.resultFullPath, `${full}\n`, "utf8");
}

function buildCompletionSummary(record: RunRecord, output: string, stderr: string): string {
  const source = output.trim() || stderr.trim() || "(no output)";
  const lines = source.split("\n").map((line) => line.trim()).filter(Boolean);
  const preview = lines.slice(0, 5).join(" ");
  const prefix = `${record.agent} ${record.status}`;
  return truncateLine(`${prefix}: ${preview || "(no output)"}`, 1200);
}

function persistRunRecord(record: RunRecord) {
  ensureRunsDir();
  mkdirSync(dirname(record.metaPath), { recursive: true });
  writeFileSync(record.metaPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  refreshExternalUi();
}

function listRunRecords(): RunRecord[] {
  const runs: RunRecord[] = [];
  let entries: string[];
  try {
    ensureRunsDir();
    entries = readdirSync(RUNS_DIR);
  } catch {
    return runs;
  }
  for (const entry of entries) {
    const metaPath = join(RUNS_DIR, entry, "meta.json");
    if (!existsSync(metaPath)) continue;
    try {
      const parsed = JSON.parse(readFileSync(metaPath, "utf8")) as RunRecord;
      runs.push(reconcileRunRecord(parsed));
    } catch {
      // ignore bad file
    }
  }
  runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return runs;
}

function getVisibleUiRecords(records: RunRecord[], now = Date.now()): RunRecord[] {
  return records.filter((record) => shouldShowInUi(record, records, now));
}

function getVisibleFleetEntries(records: RunRecord[], now = Date.now()): FleetEntry[] {
  const entries = new Map<string, FleetEntry>();
  for (const record of getVisibleUiRecords(records, now)) {
    entries.set(record.runId, fleetEntryFromRecord(record, "async"));
  }
  for (const entry of fleetEntries.values()) {
    if (shouldShowFleetEntry(entry, now)) entries.set(entry.key, entry);
  }
  return Array.from(entries.values()).sort((a, b) => {
    const activeA = a.status === "running" || a.status === "queued" ? 1 : 0;
    const activeB = b.status === "running" || b.status === "queued" ? 1 : 0;
    if (activeA !== activeB) return activeB - activeA;
    return b.startedAtMs - a.startedAtMs;
  });
}

function shouldShowFleetEntry(entry: FleetEntry, now = Date.now()): boolean {
  if (entry.status === "running" || entry.status === "queued") return true;
  if (!entry.finishedAtMs) return false;
  return now - entry.finishedAtMs <= COMPLETED_UI_GRACE_MS;
}

function pruneFleetEntries(now = Date.now()) {
  for (const [key, entry] of fleetEntries) {
    if (!shouldShowFleetEntry(entry, now)) fleetEntries.delete(key);
  }
}

function fleetEntryFromRecord(record: RunRecord, kind: FleetEntryKind): FleetEntry {
  const existing = fleetEntries.get(record.runId);
  const startedAtMs = Date.parse(record.startedAt);
  const finishedAtMs = record.finishedAt ? Date.parse(record.finishedAt) : undefined;
  return {
    key: record.runId,
    runId: record.runId,
    kind,
    agent: record.agent,
    task: record.task,
    status: record.status,
    cwd: record.cwd,
    contextMode: record.contextMode,
    startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : existing?.startedAtMs || Date.now(),
    updatedAtMs: existing?.updatedAtMs || Date.now(),
    finishedAtMs: typeof finishedAtMs === "number" && Number.isFinite(finishedAtMs) ? finishedAtMs : existing?.finishedAtMs,
    model: record.model,
    stepLabel: record.stepLabel,
    groupId: record.groupId,
    outputPreview: existing?.outputPreview,
    currentTool: existing?.currentTool,
    currentToolArgs: existing?.currentToolArgs,
    currentPath: existing?.currentPath,
    turnCount: existing?.turnCount,
    toolCount: existing?.toolCount,
    tokens: existing?.tokens,
    outputPath: record.outputPath,
    stderrPath: record.stderrPath,
    artifactPath: record.resultFullPath,
    childSessionFile: record.childSessionFile,
  };
}

function upsertFleetEntry(entry: FleetEntry) {
  const previous = fleetEntries.get(entry.key);
  fleetEntries.set(entry.key, { ...previous, ...entry, updatedAtMs: Date.now() });
  refreshExternalUi();
}

function updateFleetStatus(key: string, status: FleetEntryStatus) {
  const entry = fleetEntries.get(key);
  if (!entry) return;
  entry.status = status;
  entry.updatedAtMs = Date.now();
  if (status !== "running" && status !== "queued") entry.finishedAtMs = Date.now();
  refreshExternalUi();
}

function finishFleetEntry(key: string, status: FleetEntryStatus) {
  updateFleetStatus(key, status);
}

function updateFleetPreview(key: string, chunk: string) {
  const entry = fleetEntries.get(key);
  if (!entry || !chunk) return;
  const cleaned = chunk.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
  entry.outputPreview = truncateFromEnd(`${entry.outputPreview || ""}${cleaned}`, MAX_OUTPUT_PREVIEW_CHARS);
  entry.updatedAtMs = Date.now();
  refreshExternalUi();
}

function updateFleetActivity(key: string, activity: ChildActivity) {
  const entry = fleetEntries.get(key);
  if (!entry) return;
  entry.updatedAtMs = Date.now();
  if (activity.textDelta) entry.outputPreview = truncateFromEnd(`${entry.outputPreview || ""}${activity.textDelta}`, MAX_OUTPUT_PREVIEW_CHARS);
  if (activity.toolName) {
    entry.currentTool = activity.toolName;
    entry.currentToolArgs = activity.toolArgs;
    if (activity.toolStarted) entry.toolCount = (entry.toolCount || 0) + 1;
  }
  if (activity.path) entry.currentPath = activity.path;
  if (activity.toolEnded) {
    entry.currentTool = undefined;
    entry.currentToolArgs = undefined;
    entry.currentPath = undefined;
  }
  if (activity.turnEnded) entry.turnCount = (entry.turnCount || 0) + 1;
  if (activity.tokens !== undefined) entry.tokens = activity.tokens;
  refreshExternalUi();
}

function makeForegroundUpdateEmitter(onUpdate: ((result: any) => void) | undefined, key: string) {
  let lastEmit = 0;
  return (force = false) => {
    if (!onUpdate) return;
    const now = Date.now();
    if (!force && now - lastEmit < 300) return;
    lastEmit = now;
    const entry = fleetEntries.get(key);
    if (!entry) return;
    const text = renderForegroundProgressText(entry);
    try {
      onUpdate({
        content: [{ type: "text", text }],
        details: {
          action: "run",
          mode: "foreground",
          progress: [{
            runId: entry.runId,
            agent: entry.agent,
            status: entry.status,
            currentTool: entry.currentTool,
            currentToolArgs: entry.currentToolArgs,
            currentPath: entry.currentPath,
            turnCount: entry.turnCount,
            toolCount: entry.toolCount,
            tokens: entry.tokens,
            outputPreview: entry.outputPreview,
          }],
        },
      });
    } catch {
      // Live tool updates are best-effort; the final tool result still returns normally.
    }
  };
}

function renderForegroundProgressText(entry: FleetEntry): string {
  const lines = [
    `Subagent ${entry.agent} ${entry.status} (${formatFleetElapsed(entry)}).`,
    `Activity: ${formatFleetActivity(entry, 120)}`,
  ];
  if (entry.currentTool) lines.push(`Current tool: ${entry.currentTool}${entry.currentToolArgs ? ` ${entry.currentToolArgs}` : ""}`);
  if (entry.currentPath) lines.push(`Path: ${entry.currentPath}`);
  return lines.join("\n");
}

function shouldShowInUi(record: RunRecord, records: RunRecord[], now = Date.now()): boolean {
  if (record.status === "running" || record.status === "queued") return true;
  const activeSiblingExists = Boolean(record.groupId)
    && records.some((candidate) => candidate.groupId === record.groupId && candidate.runId !== record.runId && (candidate.status === "running" || candidate.status === "queued"));
  if (activeSiblingExists) return true;
  const completedAt = record.finishedAt ? Date.parse(record.finishedAt) : Number.NaN;
  if (!Number.isFinite(completedAt)) return false;
  return now - completedAt <= COMPLETED_UI_GRACE_MS;
}

function reconcileStoredRuns() {
  for (const run of listRunRecords()) {
    reconcileRunRecord(run);
  }
}

function reconcileRunRecord(record: RunRecord): RunRecord {
  let changed = false;
  if ((record.status === "running" || record.status === "queued") && (!record.pid || !isPidAlive(record.pid))) {
    record.status = record.stopped || record.stopRequestedAt ? "stopped" : "orphaned";
    record.finishedAt ||= new Date().toISOString();
    if (record.elapsedMs === undefined && record.finishedAt) {
      record.elapsedMs = Math.max(0, Date.parse(record.finishedAt) - Date.parse(record.startedAt));
    }
    changed = true;
  }
  if (!record.completionSummary && (record.status !== "running" && record.status !== "queued")) {
    const summary = buildCompletionSummary(record, existsSync(record.outputPath) ? readFileSync(record.outputPath, "utf8") : "", existsSync(record.stderrPath) ? readFileSync(record.stderrPath, "utf8") : "");
    record.completionSummary = summary;
    if (!existsSync(record.resultSummaryPath)) writeFileSync(record.resultSummaryPath, `${summary}\n`, "utf8");
    changed = true;
  }
  if (changed) persistRunRecord(record);
  return record;
}

function deliverPendingNotifications(pi: ExtensionAPI, currentSessionId: string | undefined) {
  if (!currentSessionId) return;
  for (const record of listRunRecords()) {
    if (record.parentSessionId !== currentSessionId) continue;
    if (record.notification.state !== "undelivered") continue;
    if (record.status === "running" || record.status === "queued") continue;
    deliverRunNotification(pi, record);
  }
}

function deliverRunNotification(pi: ExtensionAPI, record: RunRecord) {
  if (record.notification.state === "delivered") return;
  const text = [
    `Subagent ${record.agent} finished (${record.status}).`,
    record.completionSummary ? `Summary: ${record.completionSummary}` : undefined,
    `Run ID: ${record.runId}`,
    `Summary file: ${record.resultSummaryPath}`,
    `Full artifact: ${record.resultFullPath}`,
  ].filter(Boolean).join("\n");
  try {
    pi.sendMessage({ customType: "subagent-notify", content: text, display: true, details: { runId: record.runId, agent: record.agent, status: record.status } }, { triggerTurn: false });
    record.notification = { state: "delivered", deliveredAt: new Date().toISOString() };
    persistRunRecord(record);
  } catch {
    // leave undelivered for session_start retry
  }
}

function appendRunEntry(pi: ExtensionAPI, record: RunRecord, phase: "started" | "completed") {
  try {
    pi.appendEntry("subagent-run", {
      runId: record.runId,
      agent: record.agent,
      phase,
      status: record.status,
      contextMode: record.contextMode,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      summary: record.completionSummary,
      resultSummaryPath: record.resultSummaryPath,
      resultFullPath: record.resultFullPath,
    });
  } catch {
    // best effort only
  }
}

function readRunRecord(runId: string): RunRecord | undefined {
  const metaPath = join(RUNS_DIR, runId, "meta.json");
  if (!existsSync(metaPath)) return undefined;
  try {
    return reconcileRunRecord(JSON.parse(readFileSync(metaPath, "utf8")) as RunRecord);
  } catch {
    return undefined;
  }
}

function readPreview(path: string): string {
  if (!existsSync(path)) return "";
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return "";
  return raw.length > 2000 ? `${raw.slice(0, 2000)}\n…` : raw;
}

function formatFleetHeadline(entry: FleetEntry, theme: any): string {
  const parts = [entry.agent, colorStatus(theme, entry.status), formatFleetElapsed(entry)];
  if (entry.kind === "foreground") parts.splice(1, 0, theme.fg("muted", "fg"));
  if (entry.stepLabel) parts.push(theme.fg("dim", entry.stepLabel));
  return parts.join(" · ");
}

function formatFleetActivity(entry: FleetEntry, maxWidth: number): string {
  const parts: string[] = [];
  if (entry.currentTool) {
    parts.push(entry.currentToolArgs ? `${entry.currentTool} ${entry.currentToolArgs}` : entry.currentTool);
  } else if (entry.status === "queued") {
    parts.push("queued…");
  } else if (entry.status === "running") {
    const idleSeconds = Math.max(0, Math.round((Date.now() - entry.updatedAtMs) / 1000));
    parts.push(entry.outputPreview ? `active · output ${idleSeconds}s ago` : "thinking…");
  } else {
    parts.push(entry.status);
  }
  if (entry.turnCount) parts.push(`${entry.turnCount} turns`);
  if (entry.toolCount) parts.push(`${entry.toolCount} tools`);
  if (entry.tokens) parts.push(`${formatCompactNumber(entry.tokens)} tokens`);
  if (entry.currentPath) parts.push(entry.currentPath);
  const preview = (entry.outputPreview || entry.task).split("\n").map((line) => line.trim()).filter(Boolean).slice(-1)[0];
  if (preview) parts.push(truncateLine(preview.replace(/\s+/g, " "), Math.max(12, maxWidth - parts.join(" · ").length - 3)));
  return truncateLine(parts.join(" · "), Math.max(12, maxWidth));
}

function renderFleetInspector(entry: FleetEntry, width: number, theme: any, scroll: number): string[] {
  const diskOutput = entry.outputPath ? readPreview(entry.outputPath) : "";
  const diskStderr = entry.stderrPath ? readPreview(entry.stderrPath) : "";
  const transcript = (entry.outputPreview || diskOutput || diskStderr || entry.task)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const lines = [
    truncateToWidth(`  ${theme.fg("dim", "esc/← back · ↑↓ scroll · pgup/pgdn page")}`, width),
    "",
    truncateToWidth(`  ${theme.fg("accent", entry.agent)} · ${entry.kind} · ${colorStatus(theme, entry.status)} · ${formatFleetElapsed(entry)}`, width),
    truncateToWidth(`  runId: ${entry.runId}`, width),
    entry.contextMode ? truncateToWidth(`  context: ${entry.contextMode}`, width) : "",
    truncateToWidth(`  model: ${entry.model || "default"}`, width),
    truncateToWidth(`  cwd: ${entry.cwd}`, width),
    entry.childSessionFile ? truncateToWidth(`  childSession: ${entry.childSessionFile}`, width) : "",
    entry.groupId ? truncateToWidth(`  group: ${entry.groupId}`, width) : "",
    entry.currentTool ? truncateToWidth(`  currentTool: ${entry.currentTool}${entry.currentToolArgs ? ` ${entry.currentToolArgs}` : ""}`, width) : "",
    entry.turnCount ? truncateToWidth(`  turns: ${entry.turnCount}`, width) : "",
    entry.toolCount ? truncateToWidth(`  tools: ${entry.toolCount}`, width) : "",
    entry.tokens ? truncateToWidth(`  tokens: ${entry.tokens}`, width) : "",
    entry.artifactPath ? truncateToWidth(`  artifact: ${entry.artifactPath}`, width) : "",
    "",
    truncateToWidth(`  task: ${truncateLine(entry.task.replace(/\s+/g, " "), Math.max(10, width - 8))}`, width),
    "",
    truncateToWidth("  latest activity", width),
    ...transcript.map((line) => truncateToWidth(`    ${line}`, width)),
  ].filter(Boolean);
  const maxVisible = 22;
  const clampedScroll = Math.max(0, Math.min(scroll, Math.max(0, lines.length - maxVisible)));
  return lines.slice(clampedScroll, clampedScroll + maxVisible);
}

function formatFleetElapsed(entry: FleetEntry): string {
  const end = entry.finishedAtMs || Date.now();
  return `${Math.max(0, Math.round((end - entry.startedAtMs) / 1000))}s`;
}

function formatCompactNumber(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(value);
}

function renderRosterLine(width: number, theme: any, rosterIndex: number, selectedIndex: number, _key: string, label: string): string {
  const bullet = rosterIndex === selectedIndex ? theme.fg("accent", "⏺") : theme.fg("dim", "◯");
  return truncateToWidth(`  ${bullet} ${label}`, width);
}

function renderInspector(record: RunRecord, width: number, theme: any, scroll: number): string[] {
  const output = readPreview(record.outputPath);
  const stderr = readPreview(record.stderrPath);
  const transcript = (output || stderr || record.task)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const lines = [
    truncateToWidth(`  ${theme.fg("dim", "esc/← back · ↑↓ scroll · pgup/pgdn page")}`, width),
    "",
    truncateToWidth(`  ${theme.fg("accent", record.agent)} · ${colorStatus(theme, record.status)} · ${formatElapsed(record)}`, width),
    truncateToWidth(`  runId: ${record.runId}`, width),
    truncateToWidth(`  context: ${record.contextMode}`, width),
    truncateToWidth(`  model: ${record.model || "inherited"}`, width),
    truncateToWidth(`  thinking: ${record.thinking || "inherited"}`, width),
    truncateToWidth(`  cwd: ${record.cwd}`, width),
    record.childSessionFile ? truncateToWidth(`  childSession: ${record.childSessionFile}`, width) : "",
    record.groupId ? truncateToWidth(`  group: ${record.groupId}`, width) : "",
    "",
    truncateToWidth(`  task: ${truncateLine(record.task.replace(/\s+/g, " "), Math.max(10, width - 8))}`, width),
    "",
    truncateToWidth(`  latest transcript`, width),
    ...transcript.map((line) => truncateToWidth(`    ${line}`, width)),
  ].filter(Boolean);
  const maxVisible = 22;
  const clampedScroll = Math.max(0, Math.min(scroll, Math.max(0, lines.length - maxVisible)));
  return lines.slice(clampedScroll, clampedScroll + maxVisible);
}

function colorStatus(theme: any, status: AsyncRunStatus): string {
  if (status === "completed") return theme.fg("success", status);
  if (status === "running" || status === "queued") return theme.fg("accent", status);
  if (status === "stopped") return theme.fg("warning", status);
  return theme.fg("error", status);
}

function formatElapsed(record: RunRecord): string {
  if (record.elapsedMs !== undefined) return `${Math.max(0, Math.round(record.elapsedMs / 1000))}s`;
  return `${Math.max(0, Math.round((Date.now() - Date.parse(record.startedAt)) / 1000))}s`;
}

function editorHasFocus(tui: any): boolean {
  const focused = tui?.focusedComponent;
  if (!focused || typeof focused !== "object") return false;
  const candidate = focused as Partial<EditorComponent>;
  return typeof candidate.render === "function"
    && typeof candidate.invalidate === "function"
    && typeof candidate.handleInput === "function"
    && typeof candidate.getText === "function"
    && typeof candidate.setText === "function";
}

function latestRecordLine(record: RunRecord): string {
  if (!existsSync(record.outputPath)) return "";
  const output = readFileSync(record.outputPath, "utf8").trim();
  if (!output) return "";
  const lines = output.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines[lines.length - 1] || "";
}

function truncateLine(value: string, max: number): string {
  if (max <= 1) return value.slice(0, Math.max(0, max));
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;
}

function truncateFromEnd(value: string, max: number): string {
  if (value.length <= max) return value;
  return `…${value.slice(Math.max(0, value.length - max + 1))}`;
}

function normalizeToolList(tools: string[] | undefined): string[] | undefined {
  if (!tools) return undefined;
  const mapped = tools
    .map((tool) => CLAUDE_TO_PI_TOOL[tool] === undefined ? tool : CLAUDE_TO_PI_TOOL[tool])
    .filter((tool): tool is string => typeof tool === "string" && tool.trim().length > 0)
    .map((tool) => tool.trim());
  return uniqueStrings(mapped);
}

const CLAUDE_TO_PI_TOOL: Record<string, string | null> = {
  Read: "read",
  Write: "write",
  Edit: "edit",
  MultiEdit: "edit",
  Bash: "bash",
  Grep: "grep",
  Glob: "find",
  LS: "ls",
  Task: null,
  TodoWrite: null,
  WebFetch: null,
  WebSearch: null,
  AskUserQuestion: null,
};

function parseMarkdownAgent(raw: string): { frontmatter: JsonObject; body: string } | null {
  if (!raw.startsWith("---\n")) return null;
  const end = raw.indexOf("\n---\n", 4);
  if (end === -1) return null;
  return {
    frontmatter: parseYamlSubset(raw.slice(4, end)),
    body: raw.slice(end + 5).trim(),
  };
}

function parseJsonc(input: string): JsonObject {
  const parsed = JSON.parse(stripJsonComments(input)) as Json;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed as JsonObject;
}

function stripJsonComments(input: string): string {
  let result = "";
  let inString = false;
  let quote = "";
  let escaped = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];

    if (inString) {
      result += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) {
        inString = false;
        quote = "";
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      quote = char;
      result += char;
      continue;
    }

    if (char === "/" && next === "/") {
      while (index < input.length && input[index] !== "\n") index += 1;
      result += "\n";
      continue;
    }

    if (char === "/" && next === "*") {
      index += 2;
      while (index < input.length && !(input[index] === "*" && input[index + 1] === "/")) index += 1;
      index += 1;
      continue;
    }

    result += char;
  }

  return result;
}

function parseYamlSubset(input: string): JsonObject {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const { value } = parseYamlMap(lines, 0, 0);
  return value;
}

function parseYamlMap(lines: string[], start: number, indent: number): { value: JsonObject; next: number } {
  const value: JsonObject = {};
  let index = start;

  while (index < lines.length) {
    const rawLine = lines[index];
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) {
      index += 1;
      continue;
    }

    const currentIndent = leadingSpaces(rawLine);
    if (currentIndent < indent) break;
    if (currentIndent > indent) {
      index += 1;
      continue;
    }

    const line = rawLine.slice(indent);
    const separator = line.indexOf(":");
    if (separator === -1) {
      index += 1;
      continue;
    }

    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();

    if (rawValue.length > 0) {
      value[key] = parseYamlScalar(rawValue);
      index += 1;
      continue;
    }

    const nextIndex = nextMeaningfulLine(lines, index + 1);
    if (nextIndex === -1) {
      value[key] = "";
      return { value, next: lines.length };
    }

    const nextIndent = leadingSpaces(lines[nextIndex]);
    if (nextIndent <= indent) {
      value[key] = "";
      index += 1;
      continue;
    }

    const childLine = lines[nextIndex].slice(nextIndent);
    if (childLine.startsWith("- ")) {
      const parsedList = parseYamlList(lines, nextIndex, nextIndent);
      value[key] = parsedList.value;
      index = parsedList.next;
      continue;
    }

    const parsedMap = parseYamlMap(lines, nextIndex, nextIndent);
    value[key] = parsedMap.value;
    index = parsedMap.next;
  }

  return { value, next: index };
}

function parseYamlList(lines: string[], start: number, indent: number): { value: Json[]; next: number } {
  const value: Json[] = [];
  let index = start;

  while (index < lines.length) {
    const rawLine = lines[index];
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) {
      index += 1;
      continue;
    }
    const currentIndent = leadingSpaces(rawLine);
    if (currentIndent < indent) break;
    if (currentIndent > indent) {
      index += 1;
      continue;
    }
    const line = rawLine.slice(indent);
    if (!line.startsWith("- ")) break;
    value.push(parseYamlScalar(line.slice(2).trim()));
    index += 1;
  }

  return { value, next: index };
}

function parseYamlScalar(raw: string): Json {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (/^-?\d+$/.test(raw)) return Number.parseInt(raw, 10);
  if (/^-?\d+\.\d+$/.test(raw)) return Number.parseFloat(raw);
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  if ((raw.startsWith("{") && raw.endsWith("}")) || (raw.startsWith("[") && raw.endsWith("]"))) {
    try {
      return JSON.parse(raw) as Json;
    } catch {
      return raw;
    }
  }
  return raw;
}

function resolveConfiguredPath(value: string | undefined, fallback: string): string {
  return value && value.trim() ? resolve(value.trim()) : fallback;
}

function expandHomePath(value: string): string {
  return value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
}

function getAgentSourceDirs(projectCwd = process.cwd()): string[] {
  const userDir = resolve(expandHomePath("~/.pi/agent/agents"));
  const projectDir = resolve(projectCwd, ".pi", "agents");
  const dirs = [userDir, projectDir];
  if (ENV_AGENT_DIR) dirs.push(ENV_AGENT_DIR);
  return Array.from(new Set(dirs));
}

function describeAgentSources(projectCwd = process.cwd()): string {
  return getAgentSourceDirs(projectCwd).join(" -> ");
}

function nextMeaningfulLine(lines: string[], start: number): number {
  for (let index = start; index < lines.length; index += 1) {
    if (lines[index].trim() && !lines[index].trimStart().startsWith("#")) return index;
  }
  return -1;
}

function leadingSpaces(value: string): number {
  let count = 0;
  while (count < value.length && value[count] === " ") count += 1;
  return count;
}

function asNonEmptyString(value: Json | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asStringArray(value: Json | undefined): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

function asPositiveInteger(value: Json | undefined): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function asBoolean(value: Json | undefined): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asTurnBudget(value: Json | undefined): { maxTurns: number; graceTurns?: number } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, Json>;
  const maxTurns = asPositiveInteger(raw.maxTurns);
  if (!maxTurns) return undefined;
  const graceTurns = typeof raw.graceTurns === "number" && Number.isInteger(raw.graceTurns) && raw.graceTurns >= 0
    ? raw.graceTurns
    : undefined;
  return { maxTurns, ...(graceTurns !== undefined ? { graceTurns } : {}) };
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value || !value.trim()) continue;
    const trimmed = value.trim();
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getSessionId(ctx: any): string | null {
  try {
    return typeof ctx?.sessionManager?.getSessionId === "function" ? ctx.sessionManager.getSessionId() : null;
  } catch {
    return null;
  }
}

function getSessionFile(ctx: any): string | null {
  try {
    return typeof ctx?.sessionManager?.getSessionFile === "function" ? ctx.sessionManager.getSessionFile() : null;
  } catch {
    return null;
  }
}
