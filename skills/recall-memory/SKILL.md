---
name: recall-memory
description: Use when the user wants to discuss, plan, or remember anything about people, past events, or decisions — any question that should be grounded in the stored personal memory rather than chat history alone. Retrieves and reasons over the memory.
---

# Recalling personal memory

You are answering grounded in the user's stored **Personal Memory**. Always
consult the memory before answering people/history
questions — do not rely on conversation history alone, which won't survive
across sessions.

## ⛔ Retrieve through the CLI — never grep the files

| Tempting shortcut | Why it's wrong |
|---|---|
| "I'll just grep `memory/` for the keyword" | Misses semantic matches; breaks past a handful of entries |
| "I'll glob and read all the entries" | Doesn't scale; no ranking; wastes context |
| "The repo is small, file search is fine" | It won't stay small — build the right habit now |

**Discovery is always via `memory query` / `memory list` / `memory person`.**
Use `Read` only to open the specific files those commands cite. Do not use
Grep/Glob to find memories.

## Adaptive depth — pick the right mode for the question

**A. Narrow lookup** ("what did we decide about ranking?", "when did the Acme
kickoff happen?") → hybrid search. **Always pass 2–4 phrasings** of the question
as separate quoted positionals — a question form, a keyword form, and an
entity/name form — they are all fused into one ranking:

```bash
npx tsx src/cli.ts query "what did we decide about ranking" "ranking decision" "ranker rollout" --person <slug> --since <date>
```

Filtered queries are trustworthy: when a filter (`--person`, `--since`, …)
matches ≤200 entries, **every** matching entry enters the ranking — nothing can
be silently dropped. Read the top cited entry file(s) in full, then answer with
citations (file paths).

If a hit is a `summary` entry, its output includes a `sources:` line — pull the
raw entries it cites when you need specifics behind the rollup.

**B. Synthesis / planning** ("how has Jane evolved?", "themes across this
quarter?", "who's ready for promotion?", "prep for my staff meeting") →
**filter the slice, then read everything**:

1. Scope deterministically with metadata, not just semantic search:
   ```bash
   npx tsx src/cli.ts person jane-doe            # everything about a person
   npx tsx src/cli.ts list --type decision --since 2026-04-01
   npx tsx src/cli.ts list --tag roadmap
   ```
   For open-ended synthesis where a list filter is too blunt, use `--deep`
   (recall-over-precision: returns ~40 generously-ranked candidates for you to
   sift):
   ```bash
   npx tsx src/cli.ts query "how has jane grown" "jane feedback promotion" --deep
   ```
2. **Read the matched files in full** (raw entries + any `memory/summaries/`
   rollups that cover the scope). At this corpus size the whole relevant slice
   fits in context — completeness beats top-k guessing here.
3. Synthesize: themes, what changed over time, open threads, risks, and what to
   watch next. Cite the entries you drew from.

## Filters available

`--person <slug>` · `--type <type>` · `--team <slug>` · `--tag <slug>` ·
`--since <YYYY-MM-DD>` · `--until <YYYY-MM-DD>` · `-k <n>` · `--deep`

## Keeping recall sharp (compaction)

For a heavily-referenced person/topic/quarter, refresh a rolling summary:

```bash
npx tsx src/cli.ts digest --person jane-doe     # or --quarter 2026-Q2 / --tag roadmap
```

This writes/updates an additive `type: summary` entry under `memory/summaries/`
with `sources:` back-links. **Then write the `## Synthesis` section** of that
file into real prose (it ships as a scaffold) and run `npx tsx src/cli.ts index`.
Summaries augment — never replace — the raw entries.

To find out **which** digests are due (plus index health and slug issues), run:

```bash
npx tsx src/cli.ts maintenance        # prints ready-to-run digest commands
```

## Principles

- Ground every claim in a cited entry; if memory is silent, say so plainly.
- Respect recency: newer entries can supersede older ones — note conflicts.
- Stay honest about gaps; suggest logging a memory if something important is
  missing.
