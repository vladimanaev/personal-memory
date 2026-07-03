<p align="center">
  <img src="docs/assets/memory-graph.png" alt="Sanitized Personal Memory graph view" width="900">
  <br>
  <em>Sanitized demo graph view.</em>
</p>

# Personal Memory

Personal Memory is a local-first RAG memory store for people, projects, decisions,
meetings, incidents, hiring context, and long-running work history. It gives
agents such as Codex and Claude Code a grounded way to remember and recall
context without sending your private memory corpus to a hosted service.

The source of truth is plain Markdown. The search layer is rebuildable. The
default embeddings run on your machine.

## Highlights

- **Fully local by default**: Markdown entries, LanceDB index, BM25 lexical
  search, and embeddings all live on disk.
- **Agent-friendly workflows**: dedicated capture and recall skills tell agents
  when to log memories and when to retrieve grounded context.
- **Hybrid retrieval**: semantic search and lexical search are fused, with
  filters for people, teams, tags, dates, and entry type.
- **Deduplicated capture**: source IDs and near-duplicate checks prevent repeated
  Slack, Gmail, calendar, or manual captures from creating noisy duplicates.
- **Readable storage**: every memory is a Markdown file with strict frontmatter.
- **Private personalization**: `memory/` is gitignored from the main repo and can
  be versioned locally in its own nested git repository.
- **Local web UI**: browse memories, search, view graph relationships, and edit
  connector configuration from a local-only interface.

## Quick Start

Requirements:

- Node.js 20 or newer
- npm

```bash
nvm use 20
npm install
npx tsx src/cli.ts index
```

Open the local UI:

```bash
npx tsx src/cli.ts ui
```

By default the UI starts on `http://localhost:4664`.

## Basic Usage

Add a memory:

```bash
npx tsx src/cli.ts add \
  --title "1:1 with Jane about growth path" \
  --type 1on1 \
  --people jane-doe \
  --teams platform-team \
  --tags growth,career \
  --date 2026-05-20 \
  --body "Discussed scope, strengths, concerns, decisions, and follow-ups."
```

Search memories:

```bash
npx tsx src/cli.ts query \
  "is Jane ready for a larger role?" \
  "Jane promotion readiness" \
  --person jane-doe \
  -k 8
```

Browse by metadata:

```bash
npx tsx src/cli.ts list --type decision --since 2026-04-01
npx tsx src/cli.ts person jane-doe
npx tsx src/cli.ts digest --person jane-doe
```

Keep the index in sync:

```bash
npx tsx src/cli.ts index
npx tsx src/cli.ts index --force
```

## CLI Reference

The examples above run the CLI through `npx tsx src/cli.ts`. The reference below
uses the installed binary name, `memory`; in this repository you can substitute
`npx tsx src/cli.ts` or `npm run memory --`.

```text
memory add --title "..." --type <type> [--people a,b] [--teams x,y]
           [--tags a,b] [--date YYYY-MM-DD] [--body "..."]
           [--source-ids slack:C123:1700000000.1,gmail:<thread-id>]
           [--update <id>] [--force-new]

memory query "<question>" ["<alternate phrasing>" ...]
             [--person slug] [--type type] [--team slug] [--tag slug]
             [--since YYYY-MM-DD] [--until YYYY-MM-DD] [-k n] [--deep]

memory list [--person slug] [--type type] [--team slug] [--tag slug]
            [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--limit n]

memory person <slug>
memory digest --person <slug> | --quarter <YYYY-Qn> | --tag <slug>
memory remove <id>
memory maintenance [--threshold n]
memory connectors
memory ui [--port n] [--no-open]
```

Supported memory types:

```text
event, decision, todo, pending-decision, 1on1, hiring, incident,
achievement, feedback, meeting, note, summary
```

## How It Works

Personal Memory keeps durable content and derived search state separate:

- `memory/entries/YYYY/MM/<id>.md` stores raw memory entries.
- `memory/summaries/<id>.md` stores additive summaries created by `digest`.
- `.index/` stores rebuildable local search artifacts.
- `connectors/<name>.md` stores public connector templates.
- `memory/connectors/<name>.md` stores private connector overrides.

Each entry has strict YAML frontmatter:

```yaml
id: 2026-06-28-acme-kickoff
date: 2026-06-28
type: meeting
title: Kickoff with Acme
people: [jane-doe, john-smith]
teams: [platform-team]
tags: [roadmap, partnership]
source_ids: [slack:C0123ABCD:1700000000.0012]
```

The index combines:

- local embeddings via Transformers.js
- LanceDB for vector search
- persistent BM25 lexical search
- reciprocal rank fusion
- metadata prefilters and source-of-truth validation

If the index is deleted, it can be rebuilt from Markdown:

```bash
rm -rf .index
npx tsx src/cli.ts index --force
```

## Working With Agents

This repository is designed for coding agents that operate over the local folder.
The important conventions live in:

- `AGENTS.md` - shared rules for capture, recall, citations, and local-only use
- `skills/log-memory/SKILL.md` - how agents should create or update memories
- `skills/recall-memory/SKILL.md` - how agents should retrieve grounded context
- `.claude/commands/remember.md` and `.claude/commands/recall.md` - slash command
  wrappers for Claude Code

Agents should retrieve through the CLI instead of searching `memory/` directly,
and should write entries through `memory add` instead of hand-editing files.

## Connectors

Connectors define how external sources should be captured. A connector file has
two parts:

- frontmatter with mechanical fetch configuration
- Markdown body with the extraction instructions an agent should apply

Public templates live in `connectors/`. Private overrides live in
`memory/connectors/` and replace templates of the same name.

Validate connector configuration:

```bash
npx tsx src/cli.ts connectors
```

## Privacy Model

The default setup is intentionally local:

- `memory/` is ignored by the main git repository.
- `.index/` is ignored and can be regenerated.
- Embeddings run locally with `Xenova/bge-small-en-v1.5`.
- No API backend is used unless you explicitly set `MEMORY_EMBEDDINGS`.

Optional remote embedding backends can be enabled deliberately:

```bash
MEMORY_EMBEDDINGS=openai npx tsx src/cli.ts index --force
MEMORY_EMBEDDINGS=voyage npx tsx src/cli.ts index --force
```

Do not publish a populated `memory/` directory or screenshots containing private
names, events, or relationships unless you have intentionally sanitized them.

## Development

Install dependencies:

```bash
npm install
```

Run the CLI:

```bash
npm run memory -- help
```

Type-check the project:

```bash
npm run typecheck
```

Generate or refresh the index:

```bash
npm run index
```

## Project Layout

```text
src/                      TypeScript CLI, indexing, schema, server, and UI APIs
src/ui/                   Local browser UI
skills/                   Agent skills for capture, recall, and pull workflows
connectors/               Public connector templates
memory/                   Private memories and connector overrides (gitignored)
.index/                   Rebuildable local index (gitignored)
.claude/                  Claude Code commands, hooks, and settings
MEMORY-GUARDRAILS.md      Safety rules for writes under memory/
AGENTS.md                 Cross-agent operating instructions
```

## Contributing

Contributions should preserve the local-first design:

- Do not require a hosted database or hosted embedding service for the default
  path.
- Do not commit personal memory data, connector overrides, `.index/`, or
  generated model caches.
- Keep CLI behavior scriptable and citation-friendly.
- Run `npm run typecheck` before submitting changes.

## License

No license file is currently included. Add a `LICENSE` file before publishing or
accepting external contributions.
