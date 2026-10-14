#!/usr/bin/env node
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Builds a local routing-evaluation corpus from historical Pi sessions and
 * pi-subagents-compatible run artifacts. It never calls a model or modifies
 * source logs. The generated JSONL is local-only and should be manually
 * reviewed before it is used as an evaluation set.
 */

type EvalCase = {
  id: string;
  task: string;
  source: "subagent-run" | "pi-session";
  expected?: {
    agent?: string;
    model?: string;
    thinking?: string;
    mode: "single";
  };
  reviewStatus: "unreviewed" | "approved" | "corrected" | "rejected";
};

const args = parseArgs(process.argv.slice(2));
const sessionsDir = resolve(args.sessions || join(homedir(), ".pi", "agent", "sessions"));
const runsDir = resolve(args.runs || defaultRunsDir());
const outputPath = resolve(args.out || join(process.cwd(), ".pi-subagent-evals", "routing-cases.local.jsonl"));
const maxSessionCases = positiveInt(args["max-session-cases"], 500);
const maxTaskChars = positiveInt(args["max-task-chars"], 8_000);

const reviewedCases = loadReviewedCases(outputPath);
const cases = new Map<string, EvalCase>();
const runStats = collectRunCases(runsDir, cases, maxTaskChars);
const sessionStats = collectSessionCases(sessionsDir, cases, maxSessionCases, maxTaskChars);
for (const [id, reviewed] of reviewedCases) cases.set(id, reviewed);
const sorted = [...cases.values()].sort((a, b) => a.source.localeCompare(b.source) || a.id.localeCompare(b.id));
const outputDir = dirname(outputPath);
const outputDirExists = existsSync(outputDir);
mkdirSync(outputDir, { recursive: true, mode: 0o700 });
if (!outputDirExists) chmodSync(outputDir, 0o700);
if (existsSync(outputPath)) chmodSync(outputPath, 0o600);
writeFileSync(outputPath, sorted.map((item) => JSON.stringify(item)).join("\n") + (sorted.length ? "\n" : ""), { encoding: "utf8", mode: 0o600 });
chmodSync(outputPath, 0o600);

console.log(`Routing evaluation corpus written to ${outputPath}`);
console.log(`Cases: ${sorted.length} (${runStats.added} labeled subagent runs, ${sessionStats.added} unlabeled session prompts, ${reviewedCases.size} reviewed cases preserved)`);
console.log(`Skipped: ${runStats.skipped + sessionStats.skipped}`);
console.log("Review and label the local JSONL before treating it as ground truth.");

function loadReviewedCases(path: string): Map<string, EvalCase> {
  const reviewed = new Map<string, EvalCase>();
  if (!existsSync(path)) return reviewed;
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line) as EvalCase;
      if (typeof parsed?.id === "string" && parsed.reviewStatus !== "unreviewed") reviewed.set(parsed.id, parsed);
    }
  } catch (error) {
    throw new Error(`Refusing to replace unreadable existing evaluation corpus at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return reviewed;
}

function collectRunCases(root: string, output: Map<string, EvalCase>, maxChars: number) {
  let added = 0;
  let skipped = 0;
  for (const metaPath of findFiles(root, "meta.json")) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf8"));
      const task = normalizeTask(meta.task, maxChars);
      const agent = stringValue(meta.agent);
      if (!task || !agent) {
        skipped += 1;
        continue;
      }
      const id = stableId("run", `${agent}\n${task}`);
      if (output.has(id)) {
        skipped += 1;
        continue;
      }
      output.set(id, {
        id,
        task,
        source: "subagent-run",
        expected: {
          mode: "single",
          agent,
          model: stringValue(meta.model),
          thinking: stringValue(meta.thinking),
        },
        reviewStatus: "unreviewed",
      });
      added += 1;
    } catch {
      skipped += 1;
    }
  }
  return { added, skipped };
}

function collectSessionCases(root: string, output: Map<string, EvalCase>, limit: number, maxChars: number) {
  let added = 0;
  let skipped = 0;
  for (const sessionPath of findFiles(root, ".jsonl", true)) {
    if (added >= limit) break;
    let lines: string[];
    try {
      lines = readFileSync(sessionPath, "utf8").split("\n");
    } catch {
      skipped += 1;
      continue;
    }
    for (const line of lines) {
      if (added >= limit) break;
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry?.type !== "message" || entry?.message?.role !== "user") continue;
        const task = normalizeTask(messageText(entry.message.content), maxChars);
        if (!isUsefulPrompt(task)) {
          skipped += 1;
          continue;
        }
        const id = stableId("session", task);
        if (output.has(id)) {
          skipped += 1;
          continue;
        }
        output.set(id, { id, task, source: "pi-session", reviewStatus: "unreviewed" });
        added += 1;
      } catch {
        skipped += 1;
      }
    }
  }
  return { added, skipped };
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && typeof part === "object" && (part as any).type === "text" && typeof (part as any).text === "string")
    .map((part) => (part as any).text)
    .join("\n");
}

function normalizeTask(value: unknown, maxChars: number): string {
  if (typeof value !== "string") return "";
  const normalized = value.replace(/\r\n/g, "\n").trim();
  return normalized.length <= maxChars ? normalized : "";
}

function isUsefulPrompt(task: string): boolean {
  if (task.length < 20) return false;
  if (task.startsWith("/")) return false;
  if (/^(yes|no|ok|okay|thanks|thank you|continue|go ahead)[.!\s]*$/i.test(task)) return false;
  return true;
}

function findFiles(root: string, suffix: string, suffixMatch = false): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (suffixMatch ? entry.name.endsWith(suffix) : entry.name === suffix) found.push(path);
    }
  }
  return found.sort();
}

function defaultRunsDir(): string {
  const legacy = join(homedir(), ".pi", "agent", "extensions", "pi-subagent", "runs");
  return existsSync(legacy) ? legacy : join(homedir(), ".pi", "agent", "pi-subagent", "runs");
}

function stableId(prefix: string, value: string): string {
  return `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(values: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (!key?.startsWith("--")) continue;
    const value = values[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
    parsed[key.slice(2)] = value;
    index += 1;
  }
  return parsed;
}
