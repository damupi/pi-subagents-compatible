import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { after, before, test } from "node:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createHarness, isProcessAlive, waitFor } from "./harness.ts";

let harness: Awaited<ReturnType<typeof createHarness>>;

before(async () => {
  harness = await createHarness();
});

after(async () => {
  await harness.cleanup();
});

test("route action uses Jev for advisory profile, effort, risk, desktop, and agent selection", async () => {
  const tool = harness.tools.get("subagent");
  assert.ok(tool);
  let classifierContext: any;
  writeFileSync(join(harness.root, "agents", "long-agent.md"), `---\nname: long-agent\ndescription: ${"Long specialist description ".repeat(30)}\n---\n\nLong-agent prompt.\n`);
  harness.ctx.modelRegistry = {
    async getAvailableOfType(type: string) {
      assert.equal(type, "classifier");
      return [
        { type, provider: "openrouter", id: "typesafe/jev-1.13" },
        { type, provider: "openrouter", id: "~typesafe/jev-latest" },
      ];
    },
    async classify(model: any, context: any) {
      assert.equal(`${model.provider}/${model.id}`, "openrouter/~typesafe/jev-latest");
      classifierContext = context;
      return {
        stopReason: "stop",
        usage: { input: 12, output: 4, totalTokens: 16, cost: { total: 0.001 } },
        answers: {
          profile: { type: "choice", choice: "reasoning_agent", confidence: 0.88, probabilities: { reasoning_agent: 0.88, fast_agent: 0.12 } },
          workflow: { type: "choice", choice: "single", confidence: 0.89, probabilities: { single: 0.89, reconnaissance: 0.11 } },
          effort: { type: "score", score: 2.2, confidence: 0.91 },
          risk: { type: "score", score: 1.1, confidence: 0.86 },
          needs_desktop: { type: "bool", probability: 0.14 },
          agent: { type: "choice", choice: "test-agent", confidence: 0.93, probabilities: { "test-agent": 0.93, "long-agent": 0.07 } },
        },
      };
    },
  };

  const result = await tool.execute("route-jev", {
    action: "route",
    task: "Investigate a difficult test failure across several files",
    cwd: harness.projectDir,
  }, undefined, undefined, harness.ctx);

  assert.equal(result.isError, undefined);
  assert.equal(result.details.executed, false);
  assert.equal(result.details.decision.source, "jev");
  assert.equal(result.details.decision.classifier, "openrouter/~typesafe/jev-latest");
  assert.equal(result.details.decision.profile, "reasoning_agent");
  assert.equal(result.details.decision.agent, "test-agent");
  assert.equal(result.details.decision.effort, "high");
  assert.equal(result.details.decision.risk, "medium");
  assert.equal(result.details.decision.needsDesktopAccess, false);
  assert.equal(result.usage.totalTokens, 16);
  assert.equal(classifierContext.state.task, "Investigate a difficult test failure across several files");
  assert.equal(classifierContext.state.agents.length, 2);
  assert.ok(classifierContext.questions.agent.criteria["long-agent"].length <= 360);
  assert.equal(classifierContext.questions.workflow.type, "choice");
  assert.equal(classifierContext.questions.effort.type, "score");
  assert.equal(classifierContext.questions.needs_desktop.type, "bool");
  assert.match(result.content[0].text, /not executed/);
  delete harness.ctx.modelRegistry;
});

test("route action falls back safely when Jev is unavailable", async () => {
  const tool = harness.tools.get("subagent");
  assert.ok(tool);
  delete harness.ctx.modelRegistry;

  const result = await tool.execute("route-fallback", {
    action: "route",
    task: "Deploy and publish the test agent change to production",
    cwd: harness.projectDir,
  }, undefined, undefined, harness.ctx);

  assert.equal(result.details.decision.source, "fallback");
  assert.equal(result.details.decision.classifierAvailable, false);
  assert.equal(result.details.decision.mode, "human");
  assert.equal(result.details.decision.risk, "high");
  assert.match(result.content[0].text, /Jev unavailable/);
  assert.match(result.content[0].text, /not executed/);
});

test("route action requires human review instead of truncating oversized tasks", async () => {
  const tool = harness.tools.get("subagent");
  assert.ok(tool);
  let classifierCalled = false;
  harness.ctx.modelRegistry = {
    findOfType: () => ({}),
    classify: async () => {
      classifierCalled = true;
      throw new Error("should not classify");
    },
  };

  const result = await tool.execute("route-oversized", {
    action: "route",
    task: `Investigate this request ${"x".repeat(16_100)}`,
    cwd: harness.projectDir,
  }, undefined, undefined, harness.ctx);

  assert.equal(classifierCalled, false);
  assert.equal(result.details.decision.mode, "human");
  assert.equal(result.details.decision.profile, "human");
  assert.equal(result.details.decision.risk, "high");
  assert.match(result.content[0].text, /classifier limit/);
  delete harness.ctx.modelRegistry;
});

test("auto routing executes one safe high-confidence specialist with effort-derived thinking", async () => {
  const tool = harness.tools.get("subagent");
  assert.ok(tool);
  harness.ctx.modelRegistry = {
    async getAvailableOfType() {
      return [{ type: "classifier", provider: "openrouter", id: "~typesafe/jev-latest" }];
    },
    async classify() {
      return {
        stopReason: "stop",
        usage: { input: 10, output: 3, totalTokens: 13, cost: { total: 0.001 } },
        answers: {
          profile: { type: "choice", choice: "fast_agent", confidence: 0.91, probabilities: { fast_agent: 0.91, reasoning_agent: 0.09 } },
          workflow: { type: "choice", choice: "single", confidence: 0.90, probabilities: { single: 0.90, reconnaissance: 0.10 } },
          effort: { type: "score", score: 2.1, confidence: 0.90 },
          risk: { type: "score", score: 0.1, confidence: 0.94 },
          needs_desktop: { type: "bool", probability: 0.05 },
          agent: { type: "choice", choice: "test-agent", confidence: 0.92, probabilities: { "test-agent": 0.92, "long-agent": 0.08 } },
        },
      };
    },
  };

  const result = await tool.execute("auto-safe", {
    auto: true,
    task: "Inspect the test implementation and report the relevant files",
    cwd: harness.projectDir,
  }, undefined, undefined, harness.ctx);

  assert.equal(result.isError, false);
  assert.equal(result.details.auto, true);
  assert.equal(result.details.agent, "test-agent");
  assert.equal(result.details.thinking, "high");
  assert.equal(result.details.routing.agent, "test-agent");
  assert.equal(result.usage.totalTokens, 13);
  const record = harness.records().find((item) => item.task === "Inspect the test implementation and report the relevant files");
  assert.ok(record);
  assert.equal(record.routingDecision.agent, "test-agent");
  assert.equal(record.routingDecision.effort, "high");
  assert.deepEqual(record.command.slice(record.command.indexOf("--thinking"), record.command.indexOf("--thinking") + 2), ["--thinking", "high"]);
  delete harness.ctx.modelRegistry;
});

test("auto routing returns unclassified workflows to the main agent without execution", async () => {
  const tool = harness.tools.get("subagent");
  assert.ok(tool);
  assert.match((tool as any).description, /unclassified/);
  const recordsBefore = harness.records().length;
  harness.ctx.modelRegistry = {
    async getAvailableOfType() {
      return [{ type: "classifier", provider: "openrouter", id: "~typesafe/jev-latest" }];
    },
    async classify() {
      return {
        stopReason: "stop",
        answers: {
          profile: { type: "choice", choice: "reasoning_agent", confidence: 0.91, probabilities: { reasoning_agent: 0.91, fast_agent: 0.09 } },
          workflow: { type: "choice", choice: "unclassified", confidence: 0.87, probabilities: { unclassified: 0.87, single: 0.13 } },
          effort: { type: "score", score: 2, confidence: 0.90 },
          risk: { type: "score", score: 0.3, confidence: 0.93 },
          needs_desktop: { type: "bool", probability: 0.06 },
          agent: { type: "choice", choice: "test-agent", confidence: 0.84, probabilities: { "test-agent": 0.84, "long-agent": 0.16 } },
        },
      };
    },
  };

  const result = await tool.execute("auto-unclassified", {
    auto: true,
    task: "Coordinate an unusual one-off workflow that has no reviewed template",
    cwd: harness.projectDir,
  }, undefined, undefined, harness.ctx);

  assert.equal(result.details.executed, false);
  assert.equal(result.details.handoff, "main");
  assert.equal(result.details.decision.workflow, "unclassified");
  assert.equal(result.details.decision.mode, "main");
  assert.match(result.content[0].text, /explicit one-off agent, parallel tasks, or chain/);
  assert.equal(harness.records().length, recordsBefore);
  delete harness.ctx.modelRegistry;
});

test("auto routing executes the approved full-coding chain template", async () => {
  const tool = harness.tools.get("subagent");
  assert.ok(tool);
  for (const name of ["planner", "builder", "reviewer"]) {
    writeFileSync(join(harness.root, "agents", `${name}.md`), `---\nname: ${name}\ndescription: Test ${name} specialist\n---\n\nYou are the test ${name}.\n`);
  }
  harness.ctx.modelRegistry = {
    async getAvailableOfType() {
      return [{ type: "classifier", provider: "openrouter", id: "~typesafe/jev-latest" }];
    },
    async classify() {
      return {
        stopReason: "stop",
        answers: {
          profile: { type: "choice", choice: "reasoning_agent", confidence: 0.94, probabilities: { reasoning_agent: 0.94, fast_agent: 0.06 } },
          workflow: { type: "choice", choice: "full_coding", confidence: 0.91, probabilities: { full_coding: 0.91, implement_review: 0.09 } },
          effort: { type: "score", score: 2.2, confidence: 0.92 },
          risk: { type: "score", score: 1.1, confidence: 0.88 },
          needs_desktop: { type: "bool", probability: 0.03 },
          agent: { type: "choice", choice: "builder", confidence: 0.80, probabilities: { builder: 0.80, planner: 0.10, reviewer: 0.10 } },
        },
      };
    },
  };

  const result = await tool.execute("auto-full-coding", {
    auto: true,
    task: "Implement and validate the requested feature",
    cwd: harness.projectDir,
  }, undefined, undefined, harness.ctx);

  assert.equal(result.isError, false);
  assert.equal(result.details.action, "chain");
  assert.equal(result.details.auto, true);
  assert.equal(result.details.workflow, "full_coding");
  assert.equal(result.details.routing.mode, "chain");
  assert.deepEqual(result.details.steps.map((step: any) => step.agent), ["planner", "builder", "reviewer"]);
  assert.ok(result.details.steps.every((step: any) => step.thinking === "high"));
  const routedRecords = harness.records().filter((record) => record.routingDecision?.workflow === "full_coding");
  assert.equal(routedRecords.length, 3);
  assert.ok(routedRecords.every((record) => record.routingDecision.mode === "chain"));
  delete harness.ctx.modelRegistry;
});

test("auto routing executes the approved independent-research parallel template", async () => {
  const tool = harness.tools.get("subagent");
  assert.ok(tool);
  for (const name of ["scout", "researcher"]) {
    writeFileSync(join(harness.root, "agents", `${name}.md`), `---\nname: ${name}\ndescription: Test ${name} specialist\n---\n\nYou are the test ${name}.\n`);
  }
  harness.ctx.modelRegistry = {
    async getAvailableOfType() {
      return [{ type: "classifier", provider: "openrouter", id: "~typesafe/jev-latest" }];
    },
    async classify() {
      return {
        stopReason: "stop",
        answers: {
          profile: { type: "choice", choice: "reasoning_agent", confidence: 0.90, probabilities: { reasoning_agent: 0.90, fast_agent: 0.10 } },
          workflow: { type: "choice", choice: "independent_research", confidence: 0.88, probabilities: { independent_research: 0.88, single: 0.12 } },
          effort: { type: "score", score: 1.8, confidence: 0.90 },
          risk: { type: "score", score: 0.2, confidence: 0.94 },
          needs_desktop: { type: "bool", probability: 0.04 },
          agent: { type: "choice", choice: "researcher", confidence: 0.82, probabilities: { researcher: 0.82, scout: 0.18 } },
        },
      };
    },
  };

  const result = await tool.execute("auto-independent-research", {
    auto: true,
    task: "Investigate the implementation and relevant external documentation",
    cwd: harness.projectDir,
  }, undefined, undefined, harness.ctx);

  assert.equal(result.isError, false);
  assert.equal(result.details.action, "parallel");
  assert.equal(result.details.workflow, "independent_research");
  assert.deepEqual(result.details.steps.map((step: any) => step.agent), ["scout", "researcher"]);
  assert.ok(result.details.steps.every((step: any) => step.routingDecision === undefined));
  const routedRecords = harness.records().filter((record) => record.routingDecision?.workflow === "independent_research");
  assert.equal(routedRecords.length, 2);
  delete harness.ctx.modelRegistry;
});

test("auto routing blocks high-risk work without launching a child", async () => {
  const tool = harness.tools.get("subagent");
  assert.ok(tool);
  const recordsBefore = harness.records().length;
  harness.ctx.modelRegistry = {
    async getAvailableOfType() {
      return [{ type: "classifier", provider: "openrouter", id: "~typesafe/jev-latest" }];
    },
    async classify() {
      return {
        stopReason: "stop",
        answers: {
          profile: { type: "choice", choice: "fast_agent", confidence: 0.95, probabilities: { fast_agent: 0.95, human: 0.05 } },
          workflow: { type: "choice", choice: "single", confidence: 0.92, probabilities: { single: 0.92, reconnaissance: 0.08 } },
          effort: { type: "score", score: 1, confidence: 0.90 },
          risk: { type: "score", score: 1.9, confidence: 0.96 },
          needs_desktop: { type: "bool", probability: 0.1 },
          agent: { type: "choice", choice: "test-agent", confidence: 0.94, probabilities: { "test-agent": 0.94, "long-agent": 0.06 } },
        },
      };
    },
  };

  const result = await tool.execute("auto-blocked", {
    auto: true,
    task: "Deploy and publish the test change to production",
    cwd: harness.projectDir,
  }, undefined, undefined, harness.ctx);

  assert.equal(result.details.executed, false);
  assert.equal(result.details.decision.risk, "high");
  assert.equal(result.details.handoff, "human");
  assert.match(result.details.blocked, /high-risk/);
  assert.match(result.content[0].text, /Automatic execution blocked/);
  assert.equal(harness.records().length, recordsBefore);
  delete harness.ctx.modelRegistry;
});

test("routing evaluation builder uses private permissions and preserves reviewed cases", async () => {
  const sessionsDir = join(harness.root, "eval-sessions");
  const runsDir = join(harness.root, "eval-runs");
  const runDir = join(runsDir, "sample-run");
  const outPath = join(harness.root, "private-eval", "cases.local.jsonl");
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(sessionsDir, "sample.jsonl"), [
    JSON.stringify({ type: "message", message: { role: "user", content: "Investigate why checkout tracking failed yesterday" } }),
    JSON.stringify({ type: "message", message: { role: "user", content: `Oversized historical task ${"x".repeat(8_100)}` } }),
    "",
  ].join("\n"));
  writeFileSync(join(runDir, "meta.json"), JSON.stringify({ task: "Review the authentication implementation", agent: "reviewer", model: "test/model", thinking: "high" }));

  const scriptPath = join(import.meta.dirname, "..", "scripts", "build-routing-eval.ts");
  const command = [scriptPath, "--sessions", sessionsDir, "--runs", runsDir, "--out", outPath, "--max-session-cases", "10"];
  const first = spawnSync(process.execPath, command, { cwd: harness.root, encoding: "utf8" });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(statSync(join(harness.root, "private-eval")).mode & 0o777, 0o700);
  assert.equal(statSync(outPath).mode & 0o777, 0o600);

  const records = readFileSync(outPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(records.length, 2);
  const reviewed = records.find((item) => item.source === "subagent-run");
  assert.ok(reviewed);
  reviewed.reviewStatus = "approved";
  reviewed.expected.agent = "manually-reviewed-agent";
  writeFileSync(outPath, `${records.map((item) => JSON.stringify(item)).join("\n")}\n`);

  const second = spawnSync(process.execPath, command, { cwd: harness.root, encoding: "utf8" });
  assert.equal(second.status, 0, second.stderr);
  const rebuilt = readFileSync(outPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const preserved = rebuilt.find((item) => item.id === reviewed.id);
  assert.equal(preserved.reviewStatus, "approved");
  assert.equal(preserved.expected.agent, "manually-reviewed-agent");
  assert.equal(statSync(outPath).mode & 0o777, 0o600);

  const sharedDir = join(harness.root, "shared-output");
  const sharedOut = join(sharedDir, "cases.local.jsonl");
  mkdirSync(sharedDir, { mode: 0o755 });
  chmodSync(sharedDir, 0o755);
  const customOutputCommand = [scriptPath, "--sessions", sessionsDir, "--runs", runsDir, "--out", sharedOut, "--max-session-cases", "10"];
  const customOutput = spawnSync(process.execPath, customOutputCommand, { cwd: harness.root, encoding: "utf8" });
  assert.equal(customOutput.status, 0, customOutput.stderr);
  assert.equal(statSync(sharedDir).mode & 0o777, 0o755);
  assert.equal(statSync(sharedOut).mode & 0o777, 0o600);
});

test("foreground output is reconstructed once and persisted with layered overrides", async () => {
  const tool = harness.tools.get("subagent");
  assert.ok(tool);

  const result = await tool.execute("foreground-output", {
    agent: "test-agent",
    task: "NORMAL STDERR",
    cwd: harness.projectDir,
  }, undefined, undefined, harness.ctx);

  assert.equal(result.isError, false);
  assert.equal(result.content[0].text, "first response\nsecond response");

  const record = harness.records().find((item) => item.task === "NORMAL STDERR");
  assert.ok(record);
  assert.equal(record.status, "completed");
  assert.equal(record.executionMode, "foreground");
  assert.equal(record.pid, undefined);
  assert.equal(readFileSync(record.outputPath, "utf8"), "first response\nsecond response\n");
  assert.equal(readFileSync(record.stderrPath, "utf8"), "test warning\n");

  const full = readFileSync(record.resultFullPath, "utf8");
  assert.equal((full.match(/first response/g) || []).length, 1);
  assert.equal((full.match(/second response/g) || []).length, 1);
  assert.match(full, /## Stderr\ntest warning/);
  assert.ok(existsSync(record.resultSummaryPath));
  assert.ok(existsSync(join(record.outputPath, "..", ".pi-subagent-run.json")));
  assert.ok(!existsSync(join(record.outputPath, "..", "active.json")));

  assert.deepEqual(record.command.slice(record.command.indexOf("--tools"), record.command.indexOf("--tools") + 2), ["--tools", "bash"]);
  assert.ok(record.command.includes("--no-skills"));
  assert.deepEqual(record.command.slice(record.command.indexOf("--model"), record.command.indexOf("--model") + 2), ["--model", "fake-provider/fake-model"]);
  assert.equal(record.command.includes("--thinking"), false);
});

test("empty successful foreground output triggers fallback and preserves raw protocol", async () => {
  const tool = harness.tools.get("subagent");
  assert.ok(tool);
  const projectConfigPath = join(harness.projectDir, ".pi", "subagent-overrides.jsonc");
  const originalConfig = readFileSync(projectConfigPath, "utf8");

  try {
    writeFileSync(projectConfigPath, JSON.stringify({
      defaults: { tools: ["Bash"] },
      agentOverrides: {
        "test-agent": {
          model: "fake-provider/empty-primary",
          fallbackModels: ["fake-provider/fallback"],
          unset: ["thinking"],
        },
      },
    }, null, 2));

    const result = await tool.execute("empty-fallback", {
      agent: "test-agent",
      task: "EMPTY_SUCCESS FOREGROUND",
      cwd: harness.projectDir,
    }, undefined, undefined, harness.ctx);

    assert.equal(result.isError, false);
    assert.equal(result.content[0].text, "first response\nsecond response");
    assert.deepEqual(result.details.attemptedModels, ["fake-provider/empty-primary", "fake-provider/fallback"]);

    const record = harness.records().find((item) => item.task === "EMPTY_SUCCESS FOREGROUND");
    assert.ok(record);
    assert.equal(record.status, "completed");
    assert.equal(record.model, "fake-provider/fallback");
    assert.deepEqual(record.attemptedModels, ["fake-provider/empty-primary", "fake-provider/fallback"]);
    assert.ok(existsSync(record.rawStdoutPath));
    const raw = readFileSync(record.rawStdoutPath, "utf8");
    assert.match(raw, /protocol_notice/);
    assert.match(raw, /message_update/);
  } finally {
    writeFileSync(projectConfigPath, originalConfig);
  }
});

test("empty successful async output is recorded as failure with a diagnostic", async () => {
  const tool = harness.tools.get("subagent");
  assert.ok(tool);
  const launched = await tool.execute("async-empty", {
    agent: "test-agent",
    task: "EMPTY_SUCCESS ASYNC",
    model: "fake-provider/empty-primary",
    async: true,
    cwd: harness.projectDir,
  }, undefined, undefined, harness.ctx);
  const runId = launched.details.runId;

  await waitFor(() => harness.records().some((item) => item.runId === runId && item.status === "failed"));
  const record = harness.records().find((item) => item.runId === runId);
  assert.ok(record);
  assert.equal(record.exitCode, 1);
  assert.ok(existsSync(record.rawStdoutPath));
  assert.match(readFileSync(record.rawStdoutPath, "utf8"), /protocol_notice/);
  assert.match(readFileSync(record.outputPath, "utf8"), /produced no recognized assistant text/);
  assert.match(readFileSync(record.outputPath, "utf8"), /stdout\.raw\.ndjson/);
});

test("parallel and chain foreground orchestration preserve structured results", async () => {
  const tool = harness.tools.get("subagent");
  assert.ok(tool);

  const parallel = await tool.execute("parallel", {
    tasks: [
      { agent: "test-agent", task: "PARALLEL ONE" },
      { agent: "test-agent", task: "PARALLEL TWO" },
    ],
    cwd: harness.projectDir,
  }, undefined, undefined, harness.ctx);
  assert.equal(parallel.isError, false);
  assert.equal(parallel.details.steps.length, 2);
  assert.ok(parallel.details.steps.every((step: any) => step.exitCode === 0));
  assert.deepEqual(parallel.details.steps.map((step: any) => step.output), ["parallel-one", "parallel-two"]);
  assert.equal(typeof parallel.details.groupId, "string");
  const parallelRecords = harness.records().filter((item) => item.task === "PARALLEL ONE" || item.task === "PARALLEL TWO");
  assert.equal(parallelRecords.length, 2);
  assert.deepEqual(new Set(parallelRecords.map((item) => item.groupId)), new Set([parallel.details.groupId]));

  const chain = await tool.execute("chain", {
    chain: [
      { agent: "test-agent", task: "CHAIN ONE" },
      { agent: "test-agent", task: "CHAIN TWO" },
    ],
    cwd: harness.projectDir,
  }, undefined, undefined, harness.ctx);
  assert.equal(chain.isError, false);
  assert.equal(chain.details.steps.length, 2);
  assert.equal(chain.details.totalSteps, 2);
  assert.ok(chain.details.steps.every((step: any) => step.exitCode === 0));
  assert.equal(chain.details.steps[0].output, "chain-one-output");
  assert.equal(chain.details.steps[1].output, "chain-handoff-ok");
});

test("normal async completion persists exact output and sends one notification", async () => {
  const tool = harness.tools.get("subagent");
  assert.ok(tool);
  const launched = await tool.execute("async-complete", {
    agent: "test-agent",
    task: "ASYNC NORMAL STDERR",
    async: true,
    cwd: harness.projectDir,
  }, undefined, undefined, harness.ctx);
  const runId = launched.details.runId;

  await waitFor(() => harness.records().some((item) => item.runId === runId && item.status === "completed"));
  const record = harness.records().find((item) => item.runId === runId);
  assert.ok(record);
  assert.equal(record.executionMode, "async");
  assert.equal(record.pid, undefined);
  assert.equal(readFileSync(record.outputPath, "utf8"), "first response\nsecond response\n");
  assert.equal(readFileSync(record.stderrPath, "utf8"), "test warning\n");
  assert.equal((readFileSync(record.resultFullPath, "utf8").match(/first response/g) || []).length, 1);
  assert.equal(record.notification.state, "delivered");
  assert.equal(harness.sentMessages.filter((message) => message?.details?.runId === runId).length, 1);
});

test("persisted stop signals only a verified owned process", async () => {
  const tool = harness.tools.get("subagent");
  assert.ok(tool);

  const createPersistedRun = (label: string, actualTaskName = "task.md", processStartedAtMs = Date.now()) => {
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
    const runId = `persisted-${label}-${stamp}-${Math.random().toString(36).slice(2, 8)}`;
    const runDir = join(harness.runsDir, runId);
    const taskPath = join(runDir, "task.md");
    const actualTaskPath = join(runDir, actualTaskName);
    const outputPath = join(runDir, "output.txt");
    const stderrPath = join(runDir, "stderr.txt");
    const metaPath = join(runDir, "meta.json");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(taskPath, "SLEEP_IGNORE_TERM PERSISTED\n");
    if (actualTaskPath !== taskPath) writeFileSync(actualTaskPath, "SLEEP_IGNORE_TERM FOREIGN\n");
    writeFileSync(outputPath, "");
    writeFileSync(stderrPath, "");

    const child = spawn(join(harness.root, "bin", "pi"), ["--mode", "json", `@${actualTaskPath}`], {
      env: process.env,
      stdio: "ignore",
    });
    assert.ok(child.pid);
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const startedAt = new Date().toISOString();
    const record = {
      runId,
      kind: "single",
      executionMode: "async",
      agent: "test-agent",
      task: "SLEEP_IGNORE_TERM PERSISTED",
      cwd: harness.projectDir,
      contextMode: "fresh",
      command: [join(harness.root, "bin", "pi"), "--mode", "json", `@${taskPath}`],
      sourcePath: join(harness.root, "agents", "test-agent.md"),
      status: "running",
      startedAt,
      outputPath,
      stderrPath,
      metaPath,
      resultSummaryPath: join(runDir, "result-summary.md"),
      resultFullPath: join(runDir, "result-full.md"),
      pid: child.pid,
      processStartedAtMs,
      notification: { state: "undelivered" },
    };
    writeFileSync(metaPath, `${JSON.stringify(record, null, 2)}\n`);
    writeFileSync(join(runDir, ".pi-subagent-run.json"), `${JSON.stringify({ schemaVersion: 1, runId })}\n`);
    return { child, exited, record };
  };

  const owned = createPersistedRun("owned");
  await waitFor(() => readdirSync(harness.markersDir).includes(`ready-${owned.child.pid}`));
  const stopped = await tool.execute("persisted-stop", {
    action: "stop",
    runId: owned.record.runId,
  }, undefined, undefined, harness.ctx);
  assert.equal(stopped.isError, false);
  await waitFor(() => !isProcessAlive(owned.child.pid!), 4000);
  await owned.exited;
  assert.ok(readdirSync(harness.markersDir).includes(`term-${owned.child.pid}`));
  const status = await tool.execute("persisted-status", {
    action: "status",
    runId: owned.record.runId,
  }, undefined, undefined, harness.ctx);
  assert.equal(status.details.run.status, "stopped");
  assert.equal(status.details.run.pid, undefined);

  const assertStopRefused = async (run: ReturnType<typeof createPersistedRun>) => {
    try {
      await waitFor(() => readdirSync(harness.markersDir).includes(`ready-${run.child.pid}`));
      const refused = await tool.execute("persisted-stop-refused", {
        action: "stop",
        runId: run.record.runId,
      }, undefined, undefined, harness.ctx);
      assert.equal(refused.isError, true);
      assert.match(refused.content[0].text, /could not be stopped safely/);
      assert.equal(isProcessAlive(run.child.pid!), true);
    } finally {
      try { process.kill(run.child.pid!, "SIGKILL"); } catch {}
      await run.exited;
    }
  };

  await assertStopRefused(createPersistedRun("foreign", "foreign-task.md"));
  await assertStopRefused(createPersistedRun("stale", "task.md", Date.now() - 60_000));
});

test("AbortSignal cancellation escalates and leaves no foreground process", async () => {
  const tool = harness.tools.get("subagent");
  assert.ok(tool);
  const controller = new AbortController();
  const existingReady = new Set(readdirSync(harness.markersDir));

  const execution = tool.execute("cancel", {
    agent: "test-agent",
    task: "SLEEP_IGNORE_TERM FOREGROUND",
    cwd: harness.projectDir,
    timeoutMs: 10000,
  }, controller.signal, undefined, harness.ctx);

  await waitFor(() => readdirSync(harness.markersDir).some((name) => name.startsWith("ready-") && !existingReady.has(name)));
  const record = harness.records().find((item) => item.task === "SLEEP_IGNORE_TERM FOREGROUND");
  assert.ok(record?.pid);
  const pid = record.pid;
  controller.abort();

  const result = await execution;
  assert.equal(result.isError, true);
  assert.equal(result.details.stopped, true);
  await waitFor(() => !isProcessAlive(pid), 4000);
  assert.ok(readdirSync(harness.markersDir).includes(`term-${pid}`));
  assert.equal(existsSync(join(harness.runsDir, record.runId, "active.json")), false);

  const finalRecord = harness.records().find((item) => item.runId === record.runId);
  assert.equal(finalRecord.status, "stopped");
  assert.equal(finalRecord.pid, undefined);
});

test("fleet widget stays one line and inspector stops an async run", async () => {
  const tool = harness.tools.get("subagent");
  const command = harness.commands.get("subagent-inspect");
  assert.ok(tool);
  assert.ok(command);
  await harness.emitEvent("session_start");

  const launched = await tool.execute("async-stop", {
    agent: "test-agent",
    task: "SLEEP_IGNORE_TERM ASYNC",
    async: true,
    cwd: harness.projectDir,
    timeoutMs: 10000,
  }, undefined, undefined, harness.ctx);
  const runId = launched.details.runId;
  await waitFor(() => harness.records().some((item) => item.runId === runId && item.pid));

  const widget = harness.widgetComponents.get("pi-subagent-fleet");
  assert.ok(widget);
  assert.equal(widget.render(120).length, 1);
  const narrowLines = widget.render(32);
  assert.equal(narrowLines.length, 1);
  assert.doesNotMatch(narrowLines[0], /[\r\n]/);
  assert.ok(visibleWidth(narrowLines[0]) <= 32);

  const renderRequests = harness.renderRequests;
  await tool.execute("unchanged-widget", { action: "list" }, undefined, undefined, harness.ctx);
  assert.equal(harness.renderRequests, renderRequests);

  const inspectorPromise = command.handler("", harness.ctx);
  await waitFor(() => Boolean(harness.customComponent));
  const inspector = harness.customComponent;
  assert.match(inspector.render(80).join("\n"), /test-agent/);

  inspector.handleInput("s");
  assert.match(inspector.render(80).join("\n"), /Press s again within 3 seconds/);
  const activeRecord = harness.records().find((item) => item.runId === runId);
  assert.ok(activeRecord?.pid && isProcessAlive(activeRecord.pid));

  inspector.handleInput("s");
  await waitFor(() => harness.records().some((item) => item.runId === runId && item.status === "stopped"), 5000);
  await waitFor(() => !isProcessAlive(activeRecord.pid), 5000);

  await new Promise((resolve) => setTimeout(resolve, 850));
  const settledRenderRequests = harness.renderRequests;
  await new Promise((resolve) => setTimeout(resolve, 850));
  assert.equal(harness.renderRequests, settledRenderRequests);

  inspector.handleInput("\r");
  assert.match(inspector.render(48).join("\n"), /Subagent details/);
  inspector.handleInput("\x1b");
  assert.match(inspector.render(48).join("\n"), /Subagent inspector/);
  inspector.handleInput("\x1b");
  await inspectorPromise;
});

test("retention deletes only expired owned run directories", async () => {
  await harness.cleanup();
  const retention = await createHarness({ retentionDays: 1 });
  try {
    const oldRunId = "owned-20200101000000-aaaaaa";
    const recentRunId = "owned-20990101000000-bbbbbb";
    const unrelatedRunId = "unrelated-20200101000000-cccccc";
    const oldRunDir = join(retention.runsDir, oldRunId);
    const recentRunDir = join(retention.runsDir, recentRunId);
    const unrelatedRunDir = join(retention.runsDir, unrelatedRunId);
    const oldDate = new Date("2020-01-01T00:00:00Z");

    for (const [runId, runDir, owned] of [
      [oldRunId, oldRunDir, true],
      [recentRunId, recentRunDir, true],
      [unrelatedRunId, unrelatedRunDir, false],
    ] as const) {
      mkdirSync(runDir, { recursive: true });
      if (owned) writeFileSync(join(runDir, ".pi-subagent-run.json"), JSON.stringify({ schemaVersion: 1, runId }));
    }
    utimesSync(join(oldRunDir, ".pi-subagent-run.json"), oldDate, oldDate);
    utimesSync(oldRunDir, oldDate, oldDate);
    utimesSync(unrelatedRunDir, oldDate, oldDate);

    await retention.emitEvent("session_start");
    assert.equal(existsSync(oldRunDir), false);
    assert.equal(existsSync(recentRunDir), true);
    assert.equal(existsSync(unrelatedRunDir), true);
  } finally {
    await retention.cleanup();
  }
});

test("subagents-auto command persistently enables and disables automatic routing", async () => {
  const isolated = await createHarness({ dataPathMode: "data-env" });
  try {
    const command = isolated.commands.get("subagents-auto");
    const tool = isolated.tools.get("subagent");
    assert.ok(command);
    assert.ok(tool);

    await command.handler("off", isolated.ctx);
    const statePath = join(isolated.dataDir, "auto-routing.json");
    assert.deepEqual(JSON.parse(readFileSync(statePath, "utf8")), { enabled: false });
    assert.equal(statSync(statePath).mode & 0o777, 0o600);

    const disabled = await tool.execute("auto-disabled", {
      auto: true,
      task: "Inspect this repository",
      cwd: isolated.projectDir,
    }, undefined, undefined, isolated.ctx);
    assert.equal(disabled.isError, true);
    assert.match(disabled.content[0].text, /\/subagents-auto on/);

    const disabledPrompt = { systemPromptOptions: { promptGuidelines: [] as string[] } };
    await isolated.emitEvent("before_agent_start", disabledPrompt);
    assert.match(disabledPrompt.systemPromptOptions.promptGuidelines[0]!, /disabled/);

    await command.handler("on", isolated.ctx);
    assert.deepEqual(JSON.parse(readFileSync(statePath, "utf8")), { enabled: true });
    const enabledPrompt = { systemPromptOptions: { promptGuidelines: [] as string[] } };
    await isolated.emitEvent("before_agent_start", enabledPrompt);
    assert.match(enabledPrompt.systemPromptOptions.promptGuidelines[0]!, /enabled/);
  } finally {
    await isolated.cleanup();
  }
});

test("mutable data stays outside the package and existing legacy data is reused", async () => {
  for (const dataPathMode of ["default", "legacy", "data-env"] as const) {
    const isolated = await createHarness({ dataPathMode });
    try {
      const tool = isolated.tools.get("subagent");
      assert.ok(tool);
      const listed = await tool.execute("list-data-paths", { action: "list" }, undefined, undefined, isolated.ctx);
      assert.equal(listed.details.configPath, isolated.globalConfigPath);

      await tool.execute("persist-data-path", {
        agent: "test-agent",
        task: `DATA PATH ${dataPathMode}`,
        cwd: isolated.projectDir,
      }, undefined, undefined, isolated.ctx);
      const record = isolated.records().find((item) => item.task === `DATA PATH ${dataPathMode}`);
      assert.ok(record);
      assert.ok(record.outputPath.startsWith(isolated.runsDir));
    } finally {
      await isolated.cleanup();
    }
  }
});
