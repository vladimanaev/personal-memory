<p align="center">
  <img src="docs/assets/memory-graph.png" alt="Sanitized Personal Memory graph view" width="900">
  <br>
  <em>Sanitized demo graph view.</em>
</p>

# Personal Memory

Personal Memory is a local-first RAG memory store for people, projects,
decisions, meetings, incidents, hiring context, and long-running work history.
It gives agents such as Codex and Claude Code a grounded way to remember and
recall context without sending your private memory corpus to a hosted service.

Markdown is the source of truth. The search index is rebuildable. Embeddings run
locally by default.

## Quick Start

Requires Node.js 20 or newer.

```bash
git clone https://github.com/vladimanaev/personal-memory.git
cd personal-memory
npm install
npm run index
npm start
```

`npm start` opens the local UI at `http://127.0.0.1:4664`.

## Use It

Capture a memory:

```bash
npm run memory -- add \
  --title "Project kickoff" \
  --type meeting \
  --people jane-doe \
  --teams platform-team \
  --tags roadmap \
  --date 2026-07-03 \
  --body "Discussed goals, open questions, decisions, and follow-ups."
```

Recall context:

```bash
npm run memory -- query \
  "what did we decide about project alpha?" \
  "project alpha decision" \
  --deep
```

Browse by metadata:

```bash
npm run memory -- list --type decision --since 2026-01-01
npm run memory -- person jane-doe
npm run memory -- digest --person jane-doe
```

Use it with an agent:

```text
"Log this 1:1..."
"What do I know about Jane's promotion readiness?"
"Find the decision we made about project alpha."
```

Agents should use the CLI for capture and recall, then cite the memory files
they used. The full agent contract is in [AGENTS.md](AGENTS.md).

## Why This Exists

Long-running work creates context that does not fit in chat history: people,
decisions, feedback, planning threads, hiring notes, operational incidents, and
follow-ups. Personal Memory keeps that context in a local, queryable record that
an agent can retrieve before answering.

Key properties:

- **Local-first**: entries, index, and default embeddings stay on disk.
- **Plain Markdown**: every memory is readable and portable.
- **Hybrid retrieval**: semantic search, BM25 lexical search, and rank fusion.
- **Structured filters**: query by person, team, tag, date, and memory type.
- **Deduped capture**: source IDs and near-duplicate checks avoid noisy repeats.
- **Agent-aware**: skills and guardrails tell agents when to capture or recall.
- **Local UI**: browse, search, inspect the graph, and edit connector config.

## Commands

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

In this repository, run those commands as `npm run memory -- <command>`.

Supported memory types:

```text
event, decision, todo, pending-decision, 1on1, hiring, incident,
achievement, feedback, meeting, note, summary
```

## How It Works

Personal Memory separates durable content from derived search state:

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

Rebuild the index at any time:

```bash
rm -rf .index
npm run index -- --force
```

## Privacy

The default setup is intentionally local:

- `memory/` is ignored by the main git repository.
- `.index/` is ignored and can be regenerated.
- The UI binds to `127.0.0.1`.
- Embeddings run locally with `Xenova/bge-small-en-v1.5`.
- No API backend is used unless you explicitly set `MEMORY_EMBEDDINGS`.

Optional remote embedding backends can be enabled deliberately:

```bash
MEMORY_EMBEDDINGS=openai npm run index -- --force
MEMORY_EMBEDDINGS=voyage npm run index -- --force
```

Do not publish a populated `memory/` directory or screenshots containing private
names, events, or relationships unless you have intentionally sanitized them.

## Agent Workflows

This repository is designed for coding agents that operate over the local
folder. The important conventions live in:

- [AGENTS.md](AGENTS.md) - shared rules for capture, recall, citations, and
  local-only use
- [MEMORY-GUARDRAILS.md](MEMORY-GUARDRAILS.md) - write safety contract for
  `memory/`
- [skills/log-memory/SKILL.md](skills/log-memory/SKILL.md) - creating or
  updating memories
- [skills/recall-memory/SKILL.md](skills/recall-memory/SKILL.md) - retrieving
  grounded context
- [.claude/commands/remember.md](.claude/commands/remember.md) and
  [.claude/commands/recall.md](.claude/commands/recall.md) - Claude Code slash
  commands

Agents should retrieve through the CLI instead of searching `memory/` directly,
and should write entries through `memory add` instead of hand-editing files.

## Development

```bash
npm install
npm run memory -- help
npm run typecheck
npm run index
```

Project layout:

```text
src/                      TypeScript CLI, indexing, schema, server, and UI APIs
src/ui/                   Local browser UI
skills/                   Agent skills for capture, recall, and pull workflows
connectors/               Public connector templates
memory/                   Private memories and connector overrides (gitignored)
.index/                   Rebuildable local index (gitignored)
.claude/                  Claude Code commands, hooks, and settings
docs/assets/              Public README assets
```

## Community

- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md)
- Security reports: [SECURITY.md](SECURITY.md)
- Code of conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- License: [Apache License 2.0](LICENSE)
