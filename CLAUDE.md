# CLAUDE.md — house rules for this repo

This repo is **the user's local Personal Memory** store. It is a
RAG store, not a normal codebase. Two jobs: **capture** memories and **recall**
them. The retrieval engine is the `memory` CLI — use it.

> Run commands with Node ≥ 20: `nvm use 20` then `npx tsx src/cli.ts <cmd>`.

## ⛔ The one rule that matters: never search memory by hand

When the user asks anything about people, past events, decisions, or
wants to plan/remember — **you MUST retrieve through the CLI**, not by reading
files freestyle:

```bash
npx tsx src/cli.ts recall "<question form>" "<keyword form>" "<entity form>" [--person X] [--type Y] [--since DATE] [--format json]
npx tsx src/cli.ts person <slug>     # everything about a person
npx tsx src/cli.ts list [filters]    # structured browse
```

Pass the user's question first and add **1–3 agent phrasings** when useful — they
are fused with CLI-generated expansion phrases into one weighted ranking.
`recall` defaults to deep pools and complete-if-small (≤200 candidates); use
`--complete` / `--require-complete` when exhaustive recall is required.
`npx tsx src/cli.ts maintenance` reports which digests are due + index health.

**Do NOT use Grep / Glob / free-form Read to discover memories under `memory/`.**
Keyword/file search only finds exact-word matches and will silently miss
semantically-relevant entries the moment there is more than a handful — which
defeats the entire point of this store. Semantic ranking + filters live in the
CLI.

The only correct use of `Read` here is to open the **specific files a `recall`
or `query` result cited**, to ground your answer. Discovery → CLI. Reading a
cited path → ok.

If you catch yourself about to grep `memory/`, stop and run `memory recall` instead.

## ⛔ The twin rule: never WRITE memory by hand

Never create/edit files under `memory/entries/` (or `.index/`) with Write/Edit/
shell — capture goes ONLY through `npx tsx src/cli.ts add …` (a manual file
skips index sync, dedup, and auto-commit: invisible to recall, unversioned).
Full contract — **read it before any write under `memory/`**: `MEMORY-GUARDRAILS.md`.
A hook enforces this; a denial means "use `cli.ts add`", not "find another way".

## Capturing

When the user wants to log/remember something, use the `log-memory` skill and
`npx tsx src/cli.ts add …`. Reuse existing people/team slugs (check `memory list`
first).

**Timeline chains:** when the new memory develops or settles an earlier matter
(e.g. a `decision` resolving a `pending-decision`), pass `--follows <earlier-id>`
— or link existing entries via `npx tsx src/cli.ts link <id> --follows <earlier-id>`.
Never settle an open item by rewriting it; log a new linked entry. On recall,
`⤷ superseded by: <id>` / `status: resolved by <id>` annotations mean the matter
moved on — read the latest chain member before answering (see the skills).

**Per-source rules live in `connectors/<name>.md`** (gmail, slack, raw-capture):
frontmatter = fetch config + `source_id_scheme`, body = the extraction prompt —
read the relevant one before capturing from that source. Those files are
**generic templates**; a private override in `memory/connectors/<name>.md`
(gitignored, never pushed) replaces its template entirely — the CLI/UI resolve
this automatically, and personalization (real queries, channels, names) belongs
ONLY in the override. To sweep sources
periodically, use the `pull-memories` skill (`/pull-memories` — manual or via
`/loop`); `npx tsx src/cli.ts connectors` lists + validates them.

**Tag compaction:** when the user wants to merge/consolidate similar tags
(`k8s`/`kubernetes`, plurals, typos), use the `compact-tags` skill
(`/compact-tags`) — it proposes candidates from `memory maintenance` + the
`slugs list` vocabulary, gets explicit user confirmation per pair, and executes
ONLY via `npx tsx src/cli.ts slugs merge` (dry-run first, verified after). If
the user doesn't want to decide in chat, defer the pair with `slugs propose` —
it then shows in `memory maintenance` and the web UI until merged or ignored.

**Dedup:** when the material comes from Slack/email/calendar, always pass
`--source-ids` (e.g. `slack:<channel>:<ts>`, `gmail:<thread-id>`). The CLI dedups
on it — re-fetching the same source **updates that entry in place** (one entry per
thread; `date` = first-seen, `updated` = last refresh) instead of duplicating.
Captures without a source id hit a near-duplicate guard; resolve it with
`--update <id>` (same thing) or `--force-new` (genuinely distinct). Don't fold a
*different* event into an existing entry.

## More detail

See `AGENTS.md` for the full data model, schema, and conventions (shared with
Codex). Skills: `skills/recall-memory`, `skills/log-memory`, `skills/pull-memories`,
`skills/compact-tags`.
