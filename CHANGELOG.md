# Changelog

## Unreleased

- Add layered project runtime policy from `./.pi/subagent-overrides.jsonc`, resolved from each child task's effective working directory
- Merge policy in global-default → global-agent → project-default → project-agent order, with explicit `unset` support
- Automatically prune completed and inactive run artifacts after seven days
- Allow retention override with `PI_SUBAGENT_RUN_RETENTION_DAYS`; set it to `0` to disable pruning
- Prevent repeated foreground progress rows in terminal scrollback by deduplicating renders, hiding Pi's built-in working row, and keeping the idle fleet widget to one stable summary line until inspection is activated

## 0.1.0

- Initial public release
- Native Pi extension for Claude-compatible subagent workflows
- Async/background runs with parent-session completion notifications
- Foreground chain and parallel orchestration
- Configurable agent directory, config path, and runs directory
