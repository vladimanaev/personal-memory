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
  This is also what "pull memory on X", "pull up what we have on X", "recap
  where we landed", "catch me up", "brief me", and "prep me for my 1:1 with
  Jane" mean — all of them are recall, not a connector pull.
  Don't answer people/history questions from chat history alone, and don't
  reach for file search because the request sounded urgent.
- User wants ONLY one shared graph's memories (preparing a team update, doc,
  or any output leaving the private context) → **single-graph recall**
  (see `skills/recall-graph/SKILL.md`) — never falls back to other graphs.
- User wants to review/promote memories into a shared graph →
  **promotion review**, every copy/move user-confirmed
  (see `skills/promote-graph/SKILL.md`).
- User wants to create graphs, set up per-tag/per-type distribution rules, or
  repair graph consistency → **graph management**
  (see `skills/manage-graphs/SKILL.md`).
- User wants to merge/consolidate/clean up similar tags (or person/team slugs)
  → **compact**, every merge user-confirmed (see `skills/compact-tags/SKILL.md`).

## The `memory` CLI (the engine)

Run with `npx tsx src/cli.ts <cmd>` (Node ≥ 20 — `nvm use 20`).

| Command | Purpose |
|---|---|
| `add --title … --type … --people a,b --date YYYY-MM-DD --body "…" [--source-ids …] [--follows <id,…>]` | Create/update an entry + index it (dedups on `--source-ids`; `--update <id>`, `--force-new`, `--dup-threshold N` resolve the dup guard; `--follows` chains it to earlier entries). Always lands in the DEFAULT graph (standing rules may then auto-copy it — `→ rule:` output lines); `--graph <name>` is reserved for an explicit user request. Updates refresh EVERY synced copy |
| `link <id> --follows <earlier-id,…>` | Add timeline links to an existing entry (validated: targets exist, not newer, no cycles, containment; commits every member store) |
| `copy <id> --to <graph>` | Add membership: materialize a synced copy in another graph (entry stays in the default graph too; containment validated; checkpoints the target repo) |
| `move <id> --to <graph>` | Replace the entry's WHOLE membership with `<graph>` (removes every other copy; `--to default` = repatriation; containment validated both directions; checkpoints every affected repo) |
| `graphs list` / `graphs create <slug> [--display-name\|--description]` / `graphs sync [--dry-run]` / `graphs delete <slug> --confirm` | Registry (dirs under `memory-graphs/` + `GRAPH.md` manifests) / create a graph (own nested repo) / detect+repair drifted copies (the default copy wins) / permanently delete a graph (user-approved only; blocked while entries exist only there) |
| `rules list` / `rules apply [--dry-run]` | Standing per-tag/per-type distribution rules (`memory/graphs/rules.json`); apply reconciles them against existing default-graph entries — dry-run first |
| `promote candidates --to <graph> [--since\|--until\|--limit]` | Default-graph entries awaiting promotion review for a graph (target REQUIRED; per-graph dismissals hidden until content changes; non-member-ref blockers flagged) |
| `promote dismiss <id> --graph <g> [--reason "…"]` | Record a "not for that graph" decision — hidden from its candidates until the entry's content changes |
| `index [--force]` | Re-sync index with Markdown (incremental; `--force` rebuilds) |
| `query "<q>" ["<alt phrasing>" …] [--person|--type|--team|--tag|--since|--until|--graph|-k|--deep]` | Hybrid (semantic+lexical) search; pass 2–4 phrasings (all fused); `--deep` = recall-over-precision (k=40, wider pools); `--graph <name>` scopes to one graph's members (default: all, shared memberships labeled) |
| `recall "<q>" ["<agent phrasing>" …] [filters] [--complete|--complete-if-small|--require-complete|--no-expand|--format json]` | Agent-facing recall with weighted query expansion, completeness reporting, and stable JSON output |
| `list [filters] [--limit n]` | Structured browse, newest first |
| `person <slug>` | Everything about a person |
| `digest --person <slug> \| --quarter <YYYY-Qn> \| --tag <slug> [--graph <name>]` | Build/refresh a rolling summary (a shared-graph digest draws only on that graph's members and lands in its store) |
| `maintenance [--threshold N]` | Hygiene report: digest debt (suggested `digest` commands), index health, connector validity, possible unlinked chains (suggested `link` commands) + dangling links, similar-slug warnings |
| `slugs list --kind person\|team\|tag [--min-count N]` | Slug vocabulary with usage counts (for tag compaction / slug reuse) |
| `slugs merge --kind person\|team\|tag --from <slug> --to <slug> [--dry-run] [--create-target]` | Sanctioned slug merge: rewrites the affected frontmatter arrays, syncs the index, checkpoints `memory/.git` before/after |
| `slugs propose --kind person\|team\|tag --from <slug> --to <slug> --reason "…"` | Defer a merge decision: parks the pair as a suggestion in `maintenance` + web UI until merged or ignored there |
| `slugs dismiss --kind person\|team\|tag --from <slug> --to <slug>` | Permanently hide a wrong merge suggestion from `maintenance` |
| `connectors` | List + validate connector files, templates + private overrides (exit 1 if any invalid) |
| `ui [--port N] [--no-open]` | Local web UI — stats, browse, search, connector editing, maintenance screen (default port 4664; memory writes limited to slug merges + chain links, both via the same validated code paths as the CLI) |

## Data model

- **One DEFAULT graph + N named shared graphs:** the `default` graph lives
  in `memory/` (secret, local-only, home of every capture); each shared graph
  in `memory-graphs/<slug>/` (deliberately shareable as a unit; all
  user-created; directory existence = registry; `GRAPH.md` = manifest with
  description + eligibility notes, seeded from a template at creation). Same
  internal layout, each its own nested git repo, all gitignored in the main
  repo. **Membership is derived from file locations** — no frontmatter field:
  one entry may be a member of several graphs as byte-identical synced copies
  (default-first sorted `graphs` list; multi-member ⇒ the default graph is
  the home). The CLI keeps copies in sync on every update; drift is detected
  at load and repaired by `graphs sync` (the default copy wins). Ids are
  unique per logical entry across ALL stores. **Capture always lands in the
  default graph**; entries enter shared graphs via standing rules
  (auto-applied at capture + `rules apply` backfills), the user-confirmed
  promotion review, or an explicit user request. Hard rule (containment): a
  shared graph is self-contained — its members never reference non-members
  via `follows` or `sources` (enforced at `add`/`link`/`copy`/`move`/`rules
  apply`); default-graph entries may reference anything.
- **Source of truth:** Markdown files under `memory/entries/YYYY/MM/<id>.md`
  (and `memory-graphs/<slug>/entries/…` for each shared-graph copy).
  One memory per file. `memory/` is **gitignored in the main repo** (personal
  data never gets pushed) and versioned in its own local-only nested git repo
  (`memory/.git`, no remote — the auto-commit hook covers every store). Frontmatter:

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
  dedup key: `slack:<channel>:<ts>`, `gmail:<thread-id>`,
  `gchat:<space-id>:<thread-id>`, `gcal:<event-id>`, `gdrive:<file-id>`. A re-capture carrying a known source id **updates the
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
  `gchat`, `raw-capture`). `connectors/<name>.md` = generic git-tracked **template** (no
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

1. **Retrieve through the CLI — never grep/glob `memory/` to find entries, and
   never hand-search it from the shell either** (`grep`, `rg`, `find`, `cat`,
   `ls`, `awk` over a store are the same violation; the rule is about
   *discovery*, not about which tool performs it).
   `memory recall` / `memory query` (semantic + lexical, ranked, filtered) are
   the only correct ways to discover memories. Keyword/file search misses
   semantic matches, won't scale, and returns raw files stripped of the
   `⤷ superseded by` / `status: resolved by` annotations — so a settled matter
   reads as still open. Use `Read` only on the specific files a recall/query
   result cites. Requests that sound like "pull memory on X", "recap this",
   "catch me up", or "prep me for my 1:1" are all `recall`.
2. **Write through the CLI — never hand-create/edit files under
   `memory/entries/`, any `memory-graphs/<name>/entries/`, or `.index/`.**
   Capture and update go ONLY through `cli.ts add` (same `--source-ids`
   updates in place; `--update <id>` for manual notes); timeline links through
   `cli.ts add --follows` / `cli.ts link`; deletion ONLY through
   `cli.ts remove <id>`; membership ONLY through
   `cli.ts copy|move <id> --to <graph>` / `cli.ts rules apply`. A hand-written
   file skips index sync, dedup, copy-sync, and auto-commit — invisible to
   recall, unversioned, and a drift source. **Read `MEMORY-GUARDRAILS.md`
   before any write under any store** (it also lists the allowed exceptions:
   each store's `summaries/` Synthesis prose, `memory/connectors/` overrides,
   `memory/graphs/rules.json`, `GRAPH.md` manifests).
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
