# Changelog

## Unreleased

- Keep mutable configuration and run artifacts outside npm package installations
- Automatically reuse legacy `~/.pi/agent/extensions/pi-subagent/` data during npm migration
- Add `PI_SUBAGENT_DATA_DIR` for overriding the shared mutable-data directory

## 0.2.1

- Publish the package on npm as `pi-subagents-compatible`
- Add trusted npm publishing through GitHub Actions releases
- Document npm installation

## 0.2.0

- Add layered project runtime policy from `./.pi/subagent-overrides.jsonc`, resolved from each child task's effective working directory
- Merge policy in global-default → global-agent → project-default → project-agent order, with explicit `unset` support
- Automatically prune completed and inactive run artifacts after seven days
- Allow retention override with `PI_SUBAGENT_RUN_RETENTION_DAYS`; set it to `0` to disable pruning
- Render foreground single, parallel, and chain progress inside the tool card
- Keep the persistent fleet widget to one fixed-height summary line for Ghostty-safe redraws
- Cancel foreground children through the tool `AbortSignal`, with SIGTERM-to-SIGKILL escalation
- Add `/subagent-inspect` as a dedicated TUI screen for browsing and stopping active or recent runs
- Persist foreground metadata and output so completed foreground work remains inspectable
- Add hermetic lifecycle, cancellation, persistence, inspector, widget, and override regression tests
- Run the test suite and extension syntax checks in GitHub Actions on Node 22 and 24

## 0.1.0

- Initial public release
- Native Pi extension for Claude-compatible subagent workflows
- Async/background runs with parent-session completion notifications
- Foreground chain and parallel orchestration
- Configurable agent directory, config path, and runs directory
