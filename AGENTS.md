# AGENTS.md — Personal Memory

This repository is the user's (`local-user`) **local RAG personal memory**. Any agent
(Claude Code, Codex, etc.) working here has two
jobs: **capture** memories when things happen, and **recall** them — grounded —
when the user discusses or plans.

Everything runs **fully locally**. Embeddings are computed on-device; nothing is
sent to any API by default.

## When to act

- User describes/says to log something about a person, team, event, decision,
  hiring, incident, meeting, feedback, achievement, a to-do, or a decision
  still pending → **capture** (see `skills/log-memory/SKILL.md`).
- User asks a question about people / past events, or wants to plan or
  remember → **recall**, grounded in the store (see `skills/recall-memory/SKILL.md`).
  Don't answer people/history questions from chat history alone.

## The `memory` CLI (the engine)

Run with `npx tsx src/cli.ts <cmd>` (Node ≥ 20 — `nvm use 20`).

| Command | Purpose |
|---|---|
| `add --title … --type … --people a,b --date YYYY-MM-DD --body "…" [--source-ids …] [--follows <id,…>]` | Create/update an entry + index it (dedups on `--source-ids`; `--update <id>`, `--force-new`, `--dup-threshold N` resolve the dup guard; `--follows` chains it to earlier entries) |
| `link <id> --follows <earlier-id,…>` | Add timeline links to an existing entry (validated: targets exist, not newer, no cycles; commits `memory/.git`) |
| `index [--force]` | Re-sync index with Markdown (incremental; `--force` rebuilds) |
| `query "<q>" ["<alt phrasing>" …] [--person|--type|--team|--tag|--since|--until|-k|--deep]` | Hybrid (semantic+lexical) search; pass 2–4 phrasings (all fused); `--deep` = recall-over-precision (k=40, wider pools) |
| `recall "<q>" ["<agent phrasing>" …] [filters] [--complete|--complete-if-small|--require-complete|--no-expand|--format json]` | Agent-facing recall with weighted query expansion, completeness reporting, and stable JSON output |
| `list [filters] [--limit n]` | Structured browse, newest first |
| `person <slug>` | Everything about a person |
| `digest --person <slug> \| --quarter <YYYY-Qn> \| --tag <slug>` | Build/refresh a rolling summary |
| `maintenance [--threshold N]` | Hygiene report: digest debt (suggested `digest` commands), index health, connector validity, possible unlinked chains (suggested `link` commands) + dangling links, similar-slug warnings |
| `connectors` | List + validate connector files, templates + private overrides (exit 1 if any invalid) |
| `ui [--port N] [--no-open]` | Local web UI — stats, browse, search, connector editing (default port 4664; memories stay read-only) |

## Data model

- **Source of truth:** Markdown files under `memory/entries/YYYY/MM/<id>.md`.
  One memory per file. `memory/` is **gitignored in the main repo** (personal
  data never gets pushed) and versioned in its own local-only nested git repo
  (`memory/.git`, no remote — the auto-commit hook commits there). Frontmatter:

  ```yaml
  id: 2026-06-28-acme-codev-kickoff   # date-prefixed kebab slug
  date: 2026-06-28                     # ISO
  type: event   # event|decision|todo|pending-decision|1on1|hiring|incident|achievement|feedback|meeting|note|summary
  title: Kickoff with Acme on co-dev
  people: [jane-doe, john-smith]       # kebab slugs — REUSE consistently
  teams: [platform-team]
  tags: [partnership, roadmap]
  source_ids: [slack:C0123ABCD:1700000000.0012]  # canonical external ids — dedup anchor
  follows: [2026-06-20-acme-codev-pending]  # timeline link: earlier entries this one develops/settles
  updated: 2026-06-30                   # last refresh (date stays = first-seen)
  # summary entries also carry: sources: [<entry-ids>]
  ```

  **Source ids** are canonical `scheme:rest` external references and are the
  dedup key: `slack:<channel>:<ts>`, `gmail:<thread-id>`, `gcal:<event-id>`,
  `gdrive:<file-id>`. A re-capture carrying a known source id **updates the
  existing entry in place** rather than creating a duplicate. Captures without a
  source id pass through a semantic near-duplicate guard at `add` time.

- **Timeline chains (`follows`):** a matter that evolves across entries (note →
  `pending-decision` → `decision`) is chained by setting `follows` on each later
  entry (`add --follows` at capture, `link` after the fact). Everything else is
  **derived at read time**: recall/query hits carry a `chain` annotation
  (`latest`, `status: open|resolved`, `resolvedBy`) and print
  `⤷ superseded by: <id>` on stale members; `list`/`person` mark open items
  `[open]` / `[resolved → <id>]`. Settle an open matter with a **new** linked
  entry — never by rewriting the old one. Removing a followed entry leaves a
  dangling link (tolerated; `maintenance` reports it). (`gmail`, `slack`,
  `raw-capture`). `connectors/<name>.md` = generic git-tracked **template** (no
  personal queries/channels/names). `memory/connectors/<name>.md` = private
  **override** that fully replaces the template of the same name — it lives in
  the gitignored `memory/` dir, so personalization is never pushed; the loader
  and web UI resolve overrides automatically, and UI saves always go to the
  override layer. Frontmatter = mechanical fetch config (`enabled`,
  `source_id_scheme`, freeform `fetch` with `lookback_days`/queries/channels);
  body = the natural-language extraction prompt to apply when capturing from
  that source. The source-id scheme for each source is defined there. Overrides
  are committed to the nested memory repo (swept by the auto-commit hook's
  `add -A`, or `git -C memory commit` manually); template changes are committed
  to the main repo. Pull state (`last_pulled`) lives in
  `.index/connector-state.json`, not in the files.
- **Summaries:** `memory/summaries/<id>.md` (`type: summary`) — an **additive**
  compaction layer with `sources:` back-links. They augment, never replace, raw
  entries. `digest` writes a scaffold; the agent refines the `## Synthesis`
  section into prose, then runs `index`.
- **Index:** `.index/` — rebuildable derivatives, gitignored, never hand-edited:
  the LanceDB vector table (rows carry `people`/`teams`/`tags` as pipe-delimited
  strings so filters prefilter the vector search), `lexical.json` (persistent
  stemmed BM25 postings), and `entries-cache.json` (parsed-entry cache keyed by
  mtime/size). All self-invalidate on version/model change; `rm -rf .index` +
  `memory index` regenerates everything from the Markdown.

  *Why LanceDB, and when to revisit (decided 2026-07-03):* the embedded
  LanceDB + BM25 + RRF stack **is** the RAG DB — no separate/hosted vector store
  is needed, and adding one would duplicate it while breaking the fully-local,
  zero-service property. Revisit only if: (a) multi-writer/multi-machine access
  is needed; (b) the corpus nears ~10k+ entries and per-command load latency is
  felt (fix: page `loadAllEntries()`, still no new DB); or (c) retrieval
  *quality* degrades (fix: tune embedder/chunking/fusion first, not storage).
- **Recall guarantees:** filtered `query` runs are exhaustive when the filter
  matches ≤200 entries (every match is ranked — nothing droppable before the
  k-cut); unfiltered runs use corpus-scaled candidate pools.

## Rules

1. **Retrieve through the CLI — never grep/glob `memory/` to find entries.**
   `memory recall` / `memory query` (semantic + lexical, ranked, filtered) are
   the only correct ways to discover memories. Keyword/file search misses
   semantic matches and won't scale. Use `Read` only on the specific files a
   recall/query result cites.
2. **Write through the CLI — never hand-create/edit files under `memory/entries/`
   or `.index/`.** Capture and update go ONLY through `cli.ts add` (same
   `--source-ids` updates in place; `--update <id>` for manual notes); timeline
   links through `cli.ts add --follows` / `cli.ts link`; deletion
   ONLY through `cli.ts remove <id>`. A
   hand-written file skips index sync, dedup, and auto-commit — invisible to
   recall and unversioned. **Read `MEMORY-GUARDRAILS.md` before any write under
   `memory/`** (it also lists the allowed exceptions: `memory/summaries/`
   Synthesis prose, `memory/connectors/` overrides).
3. **One entry per source thread — a living record, not append-on-refetch.** A
   re-capture with a known `source_id` updates that entry in place (`date` =
   first-seen, `updated` = last refresh). Don't hand-rewrite history to tidy up,
   and don't fold a *different* event into an existing entry — genuinely new or
   different events are new entries.
4. **Slug discipline** — the same person/team always gets the same kebab slug;
   check existing entries (`memory list`, `memory/people/`) before inventing one.
5. **Always ground recall in citations** (entry file paths). If memory is silent,
   say so and offer to log it.
6. **Stay local** — default embeddings are on-device. Only set
   `MEMORY_EMBEDDINGS=openai|voyage` if the user explicitly opts into an API.
