# pi-subagents-compatible

Claude-compatible subagent workflow for Pi.

This project is a **native Pi extension** intended as a **compatible replacement for the original `pi-subagents` workflow** for people who want a Claude-style subagent orchestration experience inside Pi.

It:

- loads shared agent personas from a configurable agents directory
- applies Pi-specific runtime overrides from local config
- provides a `subagent` tool for single-run, async, parallel, and chain workflows
- persists async run artifacts locally
- shows lightweight TUI status/inspection UI while runs are active

It is **not** the original `pi-subagents` project and does **not** reuse that package at runtime.

## Why this exists

This extension is for users who want:

- a Pi-native implementation instead of an external wrapper package
- a workflow compatible in spirit with Claude subagent delegation
- a migration path from the original `pi-subagents` UX and operating model

## Compatibility

This project is a **native Pi extension** intended as a **replacement for the original `pi-subagents` workflow**.

It preserves the same high-level subagent workflow pattern while using Pi’s extension, tool, event, and TUI APIs for implementation.

Compatibility here means:

- similar operator workflow
- similar delegation model
- similar roster/inspection concepts
- Pi-native implementation details

Not guaranteed:

- byte-for-byte behavior parity
- full feature parity with upstream in every edge case

## Status

Working features include:

- `subagent({ action: "list" | "reload" | "status" | "stop" })`
- single foreground runs
- single async/background runs
- async completion notifications back to the parent session
- persisted run metadata and artifacts
- practical `fork` support via child session-file cloning
- foreground parallel orchestration
- foreground chain orchestration
- async parallel fan-out
- transient TUI roster/footer while runs are active

Current limitation:

- async chain orchestration is not implemented yet

## Files

```text
index.ts
README.md
LICENSE
CHANGELOG.md
package.json
.gitignore
overrides.schema.json
overrides.jsonc.example
runs/
```

Local/private runtime file:

- `overrides.jsonc` — your real local config (gitignored)

## Install / load

### Install from GitHub

```bash
pi install git:github.com/damupi/pi-subagents-compatible
```

### Quick local test

```bash
pi -e ./index.ts
```

### Auto-discovered install

Place the extension at either:

- `~/.pi/agent/extensions/pi-subagent/index.ts`
- `.pi/extensions/pi-subagent/index.ts`

Then run:

```text
/reload
```

### Package metadata

This repo includes a `package.json` with a `pi.extensions` manifest so it can be used as a Pi package as well as copied directly.

## Configuration

This extension uses:

- layered agent directories with scope precedence
- layered global and project JSONC runtime-policy configs
- a run-artifacts directory

Agent resolution precedence is:

1. user scope: `~/.pi/agent/agents`
2. project scope: `./.pi/agents`
3. optional env override: `PI_SUBAGENT_AGENT_DIR`

If the same agent exists in both user and project scope, the **project-scope agent wins**.

For example, if you have `researcher` in both places, `./.pi/agents/researcher.md` is used.

Other configurable paths can be overridden with environment variables:

- `PI_SUBAGENT_AGENT_DIR` — optional highest-precedence extra agent directory
- `PI_SUBAGENT_CONFIG_PATH`
- `PI_SUBAGENT_RUNS_DIR`
- `PI_SUBAGENT_RUN_RETENTION_DAYS` — completed and inactive run artifacts are pruned after this many days; defaults to `7`, and `0` disables pruning

### Example

```bash
export PI_SUBAGENT_AGENT_DIR="$HOME/.config/pi-subagent/shared-agents"
export PI_SUBAGENT_CONFIG_PATH="$HOME/.pi/agent/extensions/pi-subagent/overrides.jsonc"
export PI_SUBAGENT_RUNS_DIR="$HOME/.pi/agent/extensions/pi-subagent/runs"
export PI_SUBAGENT_RUN_RETENTION_DAYS="7"
```

### Local config

`overrides.jsonc` is an extension-owned **child runtime policy**, not Pi model settings v2.

Runtime policy is resolved from each child task's effective `cwd`. This also applies to per-task working directories in parallel and chain runs.

For each agent, properties merge in this order:

1. global `defaults`
2. global matching `agentOverrides` entry
3. project `defaults` from `<child-cwd>/.pi/subagent-overrides.jsonc`
4. project matching `agentOverrides` entry

The project config is optional. Higher layers override only the properties they declare, so unrelated lower-layer values remain active. Use `"unset": ["propertyName"]` in a higher layer to remove inherited values explicitly.

- Omit `model` to preserve a lower-layer pin, or inherit the active parent Pi session model when no layer pins it. Use `"unset": ["model"]` to remove a lower-layer pin.
- Omit `thinking` to preserve a lower-layer pin, or inherit the active parent Pi session thinking level when no layer pins it. Use `"unset": ["thinking"]` to remove a lower-layer pin.
- Pin `model` / `thinking` only for intentional per-agent exceptions.
- Use `tools` as the Pi child tool allowlist. This replaces Claude-imported markdown `tools:` values for subagent runs.
- Keep Pi-wide defaults such as `defaultModel` and `defaultThinkingLevel` in Pi `settings.json`, not here.

Default context guidance in the example config:

- `researcher` stays `fresh` for independent discovery work
- most other specialist agents default to `fork` so they inherit a snapshot of the parent session context

Tracked example file:

- `overrides.jsonc.example`

To start:

```bash
cp overrides.jsonc.example overrides.jsonc
```

## Tool usage

### List agents

```js
subagent({ action: "list" })
```

### Reload registry

```js
subagent({ action: "reload" })
```

### Run one subagent

```js
subagent({
  agent: "researcher",
  task: "Research X and summarize it."
})
```

### Run in background

```js
subagent({
  agent: "researcher",
  task: "Research X and summarize it.",
  async: true
})
```

### Check status

```js
subagent({
  action: "status",
  runId: "..."
})
```

### Stop a run

```js
subagent({
  action: "stop",
  runId: "..."
})
```

### Parallel fan-out

```js
subagent({
  tasks: [
    { agent: "researcher", task: "Research angle A" },
    { agent: "researcher", task: "Research angle B" }
  ],
  async: true
})
```

### Foreground chain

```js
subagent({
  chain: [
    { agent: "researcher", task: "Research the topic" },
    { agent: "maribel", task: "Turn the findings into a concise reply" }
  ]
})
```

## Testing

After edits:

```text
/reload
```

Suggested manual tests:

1. launch a background `researcher` run
2. confirm a `runId` is returned immediately
3. use `status` to inspect progress
4. confirm completion notification appears in the parent session
5. inspect artifacts in `runs/<runId>/`
6. test `fork` with a persisted session
7. test stop behavior across `/reload`

## Run artifacts

Each async run writes a directory under:

```text
runs/<runId>/
```

Typical files:

- `.pi-subagent-run.json` — ownership marker used by safe retention cleanup
- `meta.json`
- `output.txt`
- `stderr.txt`
- `result.summary.md`
- `result.full.md`
- `prompt.md`
- `task.md`
- optional `child-session.jsonl`

### Automatic pruning

Run artifacts are pruned automatically at session startup and then hourly. The default retention period is seven days. Pruning:

- skips async runs whose persisted status is `running` or `queued`
- skips runs active in the current extension process or carrying a live foreground PID marker
- deletes only directories with a matching Pi subagent ownership marker or validated legacy async metadata
- uses the newest direct artifact modification time, so recently updated artifacts are retained
- ignores non-directory and unrelated directory entries in the runs directory

Set `PI_SUBAGENT_RUN_RETENTION_DAYS=0` to disable automatic pruning.

## TUI behavior

- roster/widget appears only while there are active or very recent visible runs
- custom footer appears only while there are visible runs
- completed runs fade from UI after a short grace period
- completed members of a parallel group stay visible while siblings are still active

## Security

This extension runs with your user permissions.

It can:

- spawn child `pi` processes
- read/write run artifacts on disk
- load configured child extensions
- allow child agents to use whatever tools you give them in overrides

Review `overrides.jsonc` carefully before publishing or sharing defaults.

## Public-safe cleanup notes

Before publishing or adopting in another environment, avoid hardcoded local assumptions.

This repo now avoids machine-specific paths in the code and exposes environment-variable overrides, but you should still review:

- default shared-agent layout
- default example models/tools
- any personal/private agents in your real `overrides.jsonc`
- whether your target repo should include packaging files like `package.json` and `tsconfig.json`

## Attribution

This extension is an independent, compatible replacement inspired by the original [`pi-subagents`](https://pi.dev/packages/pi-subagents) project.

Original upstream references:

- package: https://pi.dev/packages/pi-subagents
- source: https://github.com/nicobailon/pi-subagents

It is **not** an official continuation or endorsed fork.

This repo is a separate implementation built for Pi-native use and Claude-compatible operator workflow.

## License

MIT — free to use, copy, modify, and redistribute.
