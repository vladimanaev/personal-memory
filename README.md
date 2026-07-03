# Personal Memory

A **local, private RAG memory store** for capturing and recalling what matters
over the long haul — people, decisions, events, and work context.

**Owner:** the owner

Two flows, both driven by an agent (Claude Code / Codex) working over this folder:

- **Capture** — when something happens, log a structured memory entry.
- **Recall** — in conversation, pull relevant past memories to remember, plan,
  and reason over everything stored so far.

Everything runs **on your machine** — embeddings are computed locally and nothing
is sent to any API by default.

## Quick start

```bash
nvm use 20            # Node ≥ 20
npm install           # one-time
npx tsx src/cli.ts index   # build/refresh the local vector index
```

Day-to-day you just talk to the agent ("log this 1:1…", "what do I know about
Jane?") or use `/remember` and `/recall`. Under the hood it calls the CLI below.

## The `memory` CLI

```bash
npx tsx src/cli.ts add --type 1on1 --title "1:1 with Jane — growth" \
  --people jane-doe --teams platform-team --tags growth --date 2026-05-20 \
  --body "What happened… decisions… follow-ups…"

npx tsx src/cli.ts query "is Jane ready for promotion?" --person jane-doe -k 8
npx tsx src/cli.ts list --type decision --since 2026-04-01
npx tsx src/cli.ts person jane-doe
npx tsx src/cli.ts digest --person jane-doe   # rolling summary (compaction)
npx tsx src/cli.ts index [--force]            # re-sync index with the files
npx tsx src/cli.ts ui                         # local read-only web UI (port 4664)
```

## How it works

- **Source of truth:** human-readable Markdown under `memory/entries/YYYY/MM/`,
  one memory per file with typed frontmatter (`date`, `type`, `people`, `teams`,
  `tags`). Git-tracked. Raw entries are **immutable history**.
- **Summaries:** `memory/summaries/` — an *additive* compaction layer
  (`type: summary`) with `sources:` back-links. They augment, never replace, raw
  entries. `digest` writes a scaffold; refine its `## Synthesis` then re-`index`.
- **Index:** `.index/` (LanceDB) — a rebuildable, gitignored vector index.
  Retrieval is hybrid (semantic + lexical BM25, fused) with metadata filters.
- **Embeddings:** local via Transformers.js (`Xenova/bge-small-en-v1.5`). Set
  `MEMORY_EMBEDDINGS=openai|voyage` only if you explicitly want an API backend.

## Layout

```
memory/entries/YYYY/MM/<id>.md   # raw memories — source of truth
memory/summaries/<id>.md         # rolling summaries (additive)
src/                             # TypeScript CLI: cli, schema, embed, ingest, store
skills/                          # agent skills: log-memory, recall-memory
.claude/commands/                # /remember, /recall slash commands
AGENTS.md                        # cross-agent conventions (Claude + Codex)
.index/                          # local vector index (gitignored)
```

See `AGENTS.md` for the full conventions any agent should follow here.

---

*Maintained by the owner.*
