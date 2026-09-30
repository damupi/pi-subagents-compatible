import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export type RegisteredTool = {
  execute: (id: string, params: any, signal: AbortSignal | undefined, onUpdate: ((result: any) => void) | undefined, ctx: any) => Promise<any>;
  renderCall?: (...args: any[]) => any;
  renderResult?: (...args: any[]) => any;
};

export async function createHarness(options: { retentionDays?: number; dataPathMode?: "explicit" | "data-env" | "default" | "legacy" } = {}) {
  const repoRoot = process.cwd();
  const originalCwd = process.cwd();
  const root = mkdtempSync(join(tmpdir(), "pi-subagents-compatible-test-"));
  const agentsDir = join(root, "agents");
  const homeDir = join(root, "home");
  const dataPathMode = options.dataPathMode || "explicit";
  const dataDir = dataPathMode === "legacy"
    ? join(homeDir, ".pi", "agent", "extensions", "pi-subagent")
    : dataPathMode === "default"
      ? join(homeDir, ".pi", "agent", "pi-subagent")
      : dataPathMode === "data-env"
        ? join(root, "data-env")
        : root;
  const runsDir = join(dataDir, "runs");
  const projectDir = join(root, "project");
  const binDir = join(root, "bin");
  const markersDir = join(root, "markers");
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(join(homeDir, ".pi", "agent", "agents"), { recursive: true });
  mkdirSync(runsDir, { recursive: true });
  mkdirSync(join(projectDir, ".pi"), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(markersDir, { recursive: true });

  writeFileSync(join(agentsDir, "test-agent.md"), `---\nname: test-agent\ndescription: Hermetic test agent\n---\n\nYou are a test agent.\n`);
  const globalConfigPath = join(dataDir, "overrides.jsonc");
  writeFileSync(globalConfigPath, JSON.stringify({
    defaults: { timeoutMs: 5000, tools: ["Read"], inheritSkills: false },
    agentOverrides: { "test-agent": { thinking: "low" } },
  }, null, 2));
  writeFileSync(join(projectDir, ".pi", "subagent-overrides.jsonc"), JSON.stringify({
    defaults: { tools: ["Bash"] },
    agentOverrides: { "test-agent": { model: "fake-provider/fake-model", unset: ["thinking"] } },
  }, null, 2));

  const fakePiPath = join(binDir, "pi");
  writeFileSync(fakePiPath, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const taskArg = process.argv.find((arg) => arg.startsWith("@"));
const task = taskArg ? fs.readFileSync(taskArg.slice(1), "utf8") : "";
const markers = process.env.PI_SUBAGENT_TEST_MARKERS;
const marker = (name) => fs.writeFileSync(path.join(markers, name + "-" + process.pid), String(process.pid));
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
if (task.includes("SLEEP_IGNORE_TERM")) {
  process.on("SIGTERM", () => marker("term"));
  marker("ready");
  setInterval(() => {}, 1000);
} else {
  if (task.includes("PARALLEL ")) {
    marker("parallel-start");
    const deadline = Date.now() + 3000;
    while (fs.readdirSync(markers).filter((name) => name.startsWith("parallel-start-")).length < 2 && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
    if (fs.readdirSync(markers).filter((name) => name.startsWith("parallel-start-")).length < 2) process.exit(3);
  }
  const turn = (first, second, final) => {
    emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: first } });
    emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: second } });
    emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: final }] } });
  };
  if (task.includes("CHAIN ONE")) {
    turn("chain-one-", "output\\n", "chain-one-output\\n");
  } else if (task.includes("CHAIN TWO")) {
    const handoff = task.includes("Upstream handoff from previous chain step:") && task.includes("chain-one-output");
    const output = handoff ? "chain-handoff-ok\\n" : "chain-handoff-missing\\n";
    turn(output.slice(0, 6), output.slice(6), output);
  } else if (task.includes("PARALLEL ONE")) {
    turn("parallel-", "one\\n", "parallel-one\\n");
  } else if (task.includes("PARALLEL TWO")) {
    turn("parallel-", "two\\n", "parallel-two\\n");
  } else {
    turn("first ", "response\\n", "first response\\n");
    turn("second ", "response\\n", "second response\\n");
  }
  if (task.includes("STDERR")) process.stderr.write("test warning\\n");
}
`);
  chmodSync(fakePiPath, 0o755);

  const originalEnv = { ...process.env };
  process.env.PI_SUBAGENT_AGENT_DIR = agentsDir;
  if (dataPathMode === "explicit") {
    process.env.PI_SUBAGENT_CONFIG_PATH = globalConfigPath;
    process.env.PI_SUBAGENT_RUNS_DIR = runsDir;
  } else {
    delete process.env.PI_SUBAGENT_CONFIG_PATH;
    delete process.env.PI_SUBAGENT_RUNS_DIR;
  }
  if (dataPathMode === "data-env") process.env.PI_SUBAGENT_DATA_DIR = dataDir;
  else delete process.env.PI_SUBAGENT_DATA_DIR;
  process.env.PI_SUBAGENT_RUN_RETENTION_DAYS = String(options.retentionDays ?? 0);
  process.env.PI_SUBAGENT_TEST_MARKERS = markersDir;
  process.env.PATH = `${binDir}:${originalEnv.PATH || ""}`;
  process.env.HOME = homeDir;
  process.chdir(projectDir);

  const tools = new Map<string, RegisteredTool>();
  const commands = new Map<string, any>();
  const events = new Map<string, Array<(event: any, ctx: any) => any>>();
  const widgets = new Map<string, any>();
  const widgetComponents = new Map<string, any>();
  let customComponent: any;
  let customPromise: Promise<any> | undefined;
  let renderRequests = 0;
  const sentMessages: any[] = [];

  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const tui = {
    requestRender: () => { renderRequests += 1; },
  };
  const ui = {
    notify: () => {},
    setStatus: () => {},
    setFooter: () => {},
    setWidget(key: string, content: any) {
      const previous = widgetComponents.get(key);
      if (previous?.dispose) previous.dispose();
      if (content === undefined) {
        widgets.delete(key);
        widgetComponents.delete(key);
        return;
      }
      widgets.set(key, content);
      widgetComponents.set(key, typeof content === "function" ? content(tui, theme) : content);
    },
    custom(factory: any) {
      customPromise = new Promise((resolve, reject) => {
        let component: any;
        const done = (value: any) => {
          component?.dispose?.();
          resolve(value);
        };
        Promise.resolve(factory(tui, theme, {}, done)).then((created) => {
          component = created;
          customComponent = component;
        }, reject);
      });
      return customPromise;
    },
  };
  const ctx = {
    cwd: projectDir,
    mode: "tui",
    hasUI: true,
    model: undefined,
    thinkingLevel: undefined,
    ui,
    sessionManager: {
      getSessionId: () => "test-session",
      getSessionFile: () => null,
      getBranch: () => [],
    },
  };
  const api = {
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand(name: string, command: any) { commands.set(name, command); },
    registerMessageRenderer() {},
    on(name: string, handler: any) {
      const handlers = events.get(name) || [];
      handlers.push(handler);
      events.set(name, handlers);
    },
    appendEntry() {},
    sendMessage(message: any) { sentMessages.push(message); },
  };

  const moduleUrl = `${pathToFileURL(join(repoRoot, "index.ts")).href}?test=${Date.now()}-${Math.random()}`;
  const extension = (await import(moduleUrl)).default;
  extension(api as any);

  async function emitEvent(name: string, event: any = {}) {
    for (const handler of events.get(name) || []) await handler(event, ctx);
  }

  function records() {
    return readdirSync(runsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const metaPath = join(runsDir, entry.name, "meta.json");
        try { return JSON.parse(readFileSync(metaPath, "utf8")); } catch { return undefined; }
      })
      .filter(Boolean);
  }

  let cleaned = false;
  async function cleanup() {
    if (cleaned) return;
    cleaned = true;
    try { await emitEvent("session_shutdown"); } catch {}
    const pids = records().flatMap((record) => typeof record.pid === "number" ? [record.pid] : []);
    const leakedPids = pids.filter(isProcessAlive);
    for (const pid of leakedPids) {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
    if (leakedPids.length > 0) {
      try { await waitFor(() => leakedPids.every((pid) => !isProcessAlive(pid)), 3000); } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    Object.keys(process.env).forEach((key) => {
      if (!(key in originalEnv)) delete process.env[key];
    });
    Object.assign(process.env, originalEnv);
    process.chdir(originalCwd);
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
    if (leakedPids.length > 0) throw new Error(`Test cleanup found leaked child processes: ${leakedPids.join(", ")}`);
  }

  return {
    root,
    dataDir,
    globalConfigPath,
    runsDir,
    projectDir,
    markersDir,
    tools,
    commands,
    events,
    widgets,
    widgetComponents,
    ctx,
    theme,
    tui,
    emitEvent,
    records,
    cleanup,
    get customComponent() { return customComponent; },
    get customPromise() { return customPromise; },
    sentMessages,
    get renderRequests() { return renderRequests; },
  };
}

export async function waitFor(predicate: () => boolean, timeoutMs = 5000, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

export function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
