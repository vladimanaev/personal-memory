---
name: pull-memories
description: Use when the user asks to pull/sync/ingest memories from connected sources (Gmail, Slack, …) — iterates the enabled connectors in connectors/, fetches recent items via MCP, applies each connector's extraction prompt, and captures memory-worthy items idempotently.
---

# Pulling memories from connectors

You are sweeping the user's connected sources and capturing what is memory-worthy
into the Personal Memory store. Each source's config is a connector file —
a generic template in `connectors/<name>.md`, replaced entirely by the private
override `memory/connectors/<name>.md` when one exists (that's where the real
queries/channels live; `npx tsx src/cli.ts connectors` shows which resolved).
Frontmatter = fetch settings, body = the extraction prompt that defines what
to capture, what to ignore, and how to write entries.

The whole run is **idempotent**: every capture is anchored with `--source-ids`,
so re-pulling the same window updates entries in place (`↻ matches existing` /
`✓ unchanged` outputs are expected and fine, not errors).

## Steps

1. **Validate + enumerate**: run `npx tsx src/cli.ts connectors`. Fix nothing
   silently — if a file is invalid, report it and skip that connector. Process
   only connectors that are **enabled** and have a **`fetch`** block
   (push-only ones like `raw-capture` are never pulled).

2. **Compute the window** per connector:
   - Read `.index/connector-state.json`; if it has `<name>.last_pulled`, use
     that as `since`.
   - Otherwise `since = now − fetch.lookback_days` (default 7 days).

3. **Read the connector file** — `memory/connectors/<name>.md` if it exists,
   else `connectors/<name>.md` — the `fetch` keys drive the queries; the body
   is your extraction prompt for this source.

4. **Fetch via MCP** (each connector's `fetch` block is the source of truth;
   typical shape):
   - **gmail**: run each `fetch.queries` entry through Gmail search
     (`search_threads`) constrained to the window (`after:YYYY/MM/DD`);
     `get_thread` for candidates that look memory-worthy.
   - **slack**: for each `fetch.channels` entry, read recent channel history /
     search within the window; follow threads that look memory-worthy. Also
     sweep threads where the user was mentioned if the config says so.

5. **Filter + capture** by applying the connector's body prompt. For each
   memory-worthy item:
   - Build the canonical source id per the connector's `source_id_scheme`
     (e.g. `gmail:<thread-id>`, `slack:<channel-id>:<thread-root-ts>`).
   - Follow `skills/log-memory/SKILL.md` for slugs and body quality (reuse
     existing people/team slugs — `memory list` first).
   - `npx tsx src/cli.ts add --title … --type … --people … --source-ids <id> --body …`
   - `memory add` records `<name>.last_captured` automatically when the source
     id prefix matches a known connector.

6. **Record the pull**: for each connector that was actually swept, set
   `<name>.last_pulled` to the run's start time (UTC ISO 8601) through the CLI:

   ```bash
   npx tsx src/cli.ts connectors mark-pulled <name> --at <run-start-iso>
   ```

   Do this even when every candidate was skipped as noise. Do not hand-edit
   `.index/connector-state.json`.

7. **Report** per connector: items scanned / created / updated / unchanged /
   skipped-as-noise, with entry ids for anything created or updated.

## Automation

MCP auth (Gmail/Slack) is interactive, so pulls run inside a live Claude Code
session — manual (`/pull-memories`), on an interval (`/loop 4h pull memories
from all connectors`), or a scheduled interactive session. Headless cron is out
of scope. Missing MCP tools for a connector → report it and skip, don't fail
the whole run.

## Principles

- **The connector file is the contract** — don't invent queries or capture
  criteria beyond it; if it's wrong, tell the user to edit it (UI: `#/connectors`).
- **Precision over volume** — a noisy store poisons recall. When in doubt,
  skip and mention it in the report.
- **Never re-anchor** — one entry per source thread; don't fold a different
  event into an existing entry (see log-memory principles).
