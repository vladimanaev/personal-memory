---
description: Pull memories from connected sources (Gmail, Slack, …)
argument-hint: [connector name — default: all enabled pull connectors]
---

Use the `pull-memories` skill (`skills/pull-memories/SKILL.md`): validate the
connector files, compute each connector's window from
`.index/connector-state.json` (falling back to `fetch.lookback_days`), fetch
recent items via MCP, apply each connector's extraction prompt, capture
memory-worthy items with `npx tsx src/cli.ts add --source-ids …`, update the
state file, and report created/updated/unchanged per connector.

Scope:

$ARGUMENTS
