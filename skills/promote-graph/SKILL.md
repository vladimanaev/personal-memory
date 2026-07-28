---
name: promote-graph
description: Use when the user wants to review private memories and promote shareable ones into a named graph — "review what can go public", "promote memories", "share entries with team-x", "publish recent memories". Proposes candidates one by one; every copy/move is user-confirmed.
---

# Promoting memories into a shared graph

Capture always lands in the PRIVATE graph. This skill is the ad-hoc sanctioned
flow that places entries into a **shared graph** (no default — the user names
the target; `npx tsx src/cli.ts graphs list` shows the registry):
scan candidates, judge them against the target graph's eligibility criteria,
and let the **user confirm every single entry**. Nothing is ever promoted
without an explicit per-entry yes. (Standing per-tag/per-type distribution
rules are the other door — configured on the `#/graphs` UI screen — and don't
need this flow.)

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
  `git -C "$MEMORY_HOME/memory" …` (or `git -C "$MEMORY_HOME/memory-graphs/<name>"`
  for a shared graph's repo).
- Neither? Ask the user where their personal-memory clone lives and suggest
  exporting `MEMORY_HOME` in their shell profile.

## Steps

1. **Read the target graph's eligibility criteria**: the body of
   `memory-graphs/<name>/GRAPH.md` — its description and eligibility notes
   define what belongs there (every graph gets a seeded template at creation;
   the user may have personalized it).

2. **Gather candidates** (mechanical prefilter — private entries that are not
   yet members and not previously declined at their current content):

   ```bash
   npx tsx src/cli.ts promote candidates --to <graph> [--since YYYY-MM-DD] [--limit N]
   ```

   Entries marked `[blocked by non-member refs: …]` cannot join until the
   entries they reference join too — note them, don't propose them (or
   propose the referenced entries first).

3. **Judge each candidate** against the criteria. Read the entry file when
   the title isn't enough. Split into **proposed** (meets EVERY criterion)
   and **stays out** (fails any — this should be most entries; doubt
   disqualifies).

4. **Review with the user — per-entry confirmation.** Present proposals
   compactly (id · date · type · title · why it qualifies) and collect an
   explicit decision per entry (yes / no / skip). Batch presentation is fine;
   batch approval is not — "yes to all" must come from the user.

5. **Execute the decisions**, one entry at a time:
   - Approved → `npx tsx src/cli.ts copy <id> --to <graph>` (**default** —
     the entry gains membership and stays private; copies auto-sync on later
     updates). Only use `move <id> --to <graph>` when the user explicitly
     wants it OUT of the private graph (move replaces the whole membership).
   - Declined → `npx tsx src/cli.ts promote dismiss <id> --graph <graph> [--reason "…"]`
     so it isn't proposed for that graph again unless its content changes.
   - Skipped/undecided → do nothing; it stays in the candidate pool.

6. **Verify + report**: `npx tsx src/cli.ts list --graph <graph> --since …`
   shows the new members; `git -C memory-graphs/<graph> log --oneline` shows
   the commits. Report copied / moved / dismissed / skipped counts with ids.

## Principles

- **User confirms every membership change.** Your judgment only selects what
  to *propose*.
- **Doubt disqualifies.** If you're unsure an entry qualifies, don't propose it.
- **Copy is the default; move is the exception.** Copying keeps the private
  home (and the CLI keeps every copy in sync); moving removes it.
- **Only `copy`/`move`/`promote dismiss` mutate state** — never edit or
  relocate files by hand, never rewrite an entry to make it "shareable" (if
  content must change to qualify, tell the user).
- Each shared store must stay self-contained: a member may not reference
  non-members — the CLI enforces it; blocked candidates are surfaced, not
  forced.
