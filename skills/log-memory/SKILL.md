---
name: log-memory
description: Use when the user wants to record/log/remember an event — a 1:1, decision, a decision still pending, a to-do, hiring move, incident, achievement, feedback, meeting, or general note about people or teams. Captures it as a structured memory entry.
---

# Logging a personal memory

You are maintaining the user's long-horizon **Personal Memory**.
When the user says things like "log this", "remember that…",
"note for the record", or describes something that happened with a person/team,
capture it as a structured entry via the `memory` CLI.

## Locating the store

Everything in this skill is **store-relative** — not just the
`npx tsx src/cli.ts …` commands (the CLI resolves the store from its working
directory), but every path involved: `memory/…` and `connectors/…` files,
index files, and the entry paths that CLI output cites.

- Working inside the personal-memory repo already (`src/cli.ts` and
  `connectors/` present)? Run the commands and read the paths as written.
- Installed via the plugin marketplace and working in another project?
  `MEMORY_HOME` must point at the user's personal-memory clone. Run every
  command as `cd "$MEMORY_HOME" && npx tsx src/cli.ts …`, and resolve every
  store-relative file you read or edit under it too — entry paths printed by
  the CLI, connector files, `memory/summaries/…`, and git checks as
  `git -C "$MEMORY_HOME/memory" …`.
- Neither? Ask the user where their personal-memory clone lives and suggest
  exporting `MEMORY_HOME` in their shell profile.

## Steps

1. **Extract the fields** from what the user said (ask only if a critical one is
   genuinely missing — otherwise infer sensibly):
   - `title` — short, specific (required).
   - `type` — one of: `event | decision | todo | pending-decision | 1on1 | hiring | incident | achievement | feedback | meeting | note`.
     Use `pending-decision` for a decision still open and `todo` for action
     items to track. When an open matter is later settled, do **not** rewrite
     the old entry — log a **new** `decision` entry with
     `--follows <pending-id>` so the timeline is preserved (see below).
   - `date` — ISO `YYYY-MM-DD`; default to today if not stated.
   - `people` — kebab-case slugs (e.g. `jane-doe`). **Reuse existing slugs** — run
     `memory list` or check `memory/people/` first so the same person always maps
     to the same slug.
   - `teams`, `tags` — kebab-case slugs (optional but valuable for recall).
2. **Write a clear body**: what happened, context, decisions, and follow-ups /
   action items. Be concrete (names, numbers, dates) — future recall quality
   depends on it.
3. **Every capture is PRIVATE.** The store is split into a PRIVATE graph
   (`memory/` — secret, local-only) and a PUBLIC graph (`memory-public/` —
   safe to share with others), but capture never routes to public on its own:
   - Log to the private graph by default — no flag, no routing judgment, no
     asking. Entries reach the public graph later through the user-confirmed
     promotion review (`/promote-public`).
   - The ONLY exception: the user **explicitly says** to log something as
     public ("log this as a public memory"). Then check it against the
     eligibility prompt (`memory/routing/graph-routing.md` if present, else
     `routing/graph-routing.md`; `npx tsx src/cli.ts routing` shows which
     resolves) and pass `--graph public` only if it qualifies — if it doesn't,
     log it private and tell the user why.
   - **Chain guard**: an entry whose `--follows` targets a private entry can
     never be public — the CLI rejects the link direction.
   - A wrong placement is corrected later with
     `npx tsx src/cli.ts move <id> --to public|private` — never by editing or
     moving files.
4. **Store it** by running the CLI (body via `--body` or piped on stdin):

   ```bash
   npx tsx src/cli.ts add \
     --type 1on1 --title "1:1 with Jane — growth" \
     --people jane-doe --teams platform-team --tags growth,promotion \
     --date 2026-05-20 \
     --body "What happened… Decisions… Follow-ups…"
   ```

   `add` writes the Markdown file **and** updates the vector index automatically.
5. **Confirm** back to the user: the entry `id`, its file path, a one-line
   recap of what you stored (and whether it was `created`, `updated`, or
   `unchanged`), and the graph in the rare case it was explicitly logged public.

## Timeline links (`--follows`) — chain evolving matters

A matter often evolves across entries: note → `pending-decision` → `decision`.
Link each later development to its earlier entries so recall can always show
the latest state instead of a stale one:

- **At capture time**: if the new memory develops or settles an earlier matter,
  find that entry (`memory recall`/`memory list`) and pass
  `--follows <earlier-id>` (comma-separate for several). Typical: a `decision`
  that settles a `pending-decision`, a follow-up note with new facts, an
  outcome after an incident.
- **After the fact**: `npx tsx src/cli.ts link <later-id> --follows <earlier-id>`
  links two existing entries. `memory maintenance` suggests likely missing
  links as ready-to-run `link` commands — review and run the ones that are right.
- The CLI validates targets (must exist, not be newer, no cycles) and derives
  everything else at read time: an unresolved `pending-decision`/`todo` shows as
  `[open]`, a chained one as `[resolved → <id>]`, and recall annotates stale
  chain members with `⤷ superseded by: <latest-id>`.
- Don't confuse this with `--update`: same evolving *source thread* → update in
  place; a **new development of a matter** → new entry + `--follows`.

## Dedup & updates (important when capturing from Slack/email)

The same Slack thread or email often gets fetched more than once. To avoid
duplicates, **anchor each capture to its source** with `--source-ids`:

- Each connected source defines its canonical id scheme **and** an extraction
  prompt (what's memory-worthy, what to ignore, how to write it) in
  `connectors/<name>.md` — read that file before capturing from the source.
  Currently: `connectors/gmail.md` (`gmail:<thread-id>`), `connectors/slack.md`
  (`slack:<channel-id>:<message-ts>`), `connectors/gchat.md`
  (`gchat:<space-id>:<thread-id>`). For pasted text/screenshots follow
  `connectors/raw-capture.md` and pass `--connector raw-capture` to `memory add`
  so the connector UI records that the raw-capture prompt was used.
- Sources without a connector file use these fallback conventions:
  Calendar `gcal:<event-id>`, Drive `gdrive:<file-id>`.
- Pass ids comma-separated: `--source-ids slack:C0123ABCD:1700000000.001200`
- If pasted/screenshot content clearly came from Slack/email, keep the source id
  for dedup and also pass the prompt connector, e.g.
  `--connector raw-capture --source-ids slack:C0123ABCD:1700000000.001200`.

What the CLI then does automatically:
- **Same source seen again, nothing new** → prints `✓ unchanged`, no duplicate.
- **Same source, new content** (e.g. new replies) → **updates the existing entry
  in place**: same `id`/path, body refreshed, `updated` date bumped. One entry
  per source thread.

For manual notes with **no** source id, `add` runs a near-duplicate guard. If it
reports a candidate and exits, decide:
- it's the same thing → re-run with `--update <id>` to refresh that entry, or
- it's genuinely distinct → re-run with `--force-new`.

## Principles

- **One entry per source thread; it's a living record.** Source-anchored entries
  are **updated in place** on re-fetch — `date` = first capture / event date,
  `updated` = last refresh. Do not create a second entry for the same thread.
- **Genuinely new or different events are new entries.** Don't fold an unrelated
  event into an existing one just because it's similar.
- **Always pass `--source-ids`** when the material came from Slack/email/
  Google Chat/calendar — it's the dedup anchor.
- **Slug discipline**: consistent `people`/`team` slugs are what make later
  filtering and per-person recall work. When unsure, check existing entries;
  `npx tsx src/cli.ts maintenance` flags suspiciously-similar slugs that may be
  the same person/team under two names.
- Prefer one focused entry per event over a giant catch-all note.
- **Capture is private; promotion is a separate, reviewed step.** Never pass
  `--graph public` unless the user explicitly asked for a public memory. Mixed
  private+public content → private; never split one event into two entries to
  force part of it public. Re-captures of an existing entry stay in that
  entry's graph (the CLI ignores a conflicting `--graph` and points at `move`).
