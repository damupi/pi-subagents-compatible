import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, before, test } from "node:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
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
