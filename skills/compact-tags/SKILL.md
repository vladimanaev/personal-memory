---
name: compact-tags
description: Use when the user wants to merge, consolidate, compact, or clean up similar/duplicate tags (or person/team slugs) — e.g. "merge k8s into kubernetes", "clean up my tags", "these two tags are the same". Proposes merge candidates, requires explicit per-merge confirmation, then relinks entries via the sanctioned slugs-merge CLI. Never edits entry files by hand.
---

# Compacting tags

You are consolidating the tag vocabulary of the user's **Personal Memory**.
When the user says things like "merge these tags", "compact/clean up my tags",
or "`k8s` and `kubernetes` are the same thing", propose tag merges, get the
user's explicit confirmation, and execute them **only** through
`npx tsx src/cli.ts slugs merge`.

The contract: every merge is previewed with a dry-run, confirmed by the user,
executed via the CLI, and verified afterward. Nothing is deleted — a merge
rewrites `from → to` inside each affected entry's frontmatter, entry bodies are
untouched, and `memory/.git` is checkpointed before and committed after each
merge, so every step is reversible.

## Steps

1. **Determine the mode.**
   - *Explicit pair(s)* — the user named the tags ("merge k8s into kubernetes"):
     skip to step 3 with those pairs. The user's stated direction wins.
   - *General compaction* ("clean up my tags"): gather candidates (step 2).

2. **Gather candidates** (general mode) from three sources:

   ```bash
   npx tsx src/cli.ts slugs list --kind tag
   ```

   ```bash
   npx tsx src/cli.ts maintenance
   ```

   - The maintenance **slug hygiene** section lists engine suggestions
     (typos, reordered tokens, prefixes) with confidence and affected-entry
     counts; previously dismissed pairs are already excluded.
   - Then apply your own **semantic judgment** over the full `slugs list`
     output — the engine is edit-distance based and misses true synonyms:
     abbreviations (`k8s`/`kubernetes`), singular/plural, hyphen/spelling
     variants, same-concept-different-word. Before proposing a semantic pair,
     check it isn't already dismissed (read-only):

   ```bash
   cat .index/slug-dismissals.json
   ```

   - Only propose tags that denote the **same concept** — never merely related
     ones (`hiring` ≠ `interviews`). When unsure, present it as a question,
     not a recommendation.

3. **Dry-run every candidate pair** (mandatory, also for user-named pairs):

   ```bash
   npx tsx src/cli.ts slugs merge --kind tag --from <lower-usage> --to <higher-usage> --dry-run
   ```

   Default direction: the lower-usage tag merges into the higher-usage one
   (use the counts from `slugs list`). The dry-run validates the pair and
   lists the affected entries. Also record before-counts for verification:

   ```bash
   npx tsx src/cli.ts list --tag <from> --limit 1
   npx tsx src/cli.ts list --tag <to> --limit 1
   ```

   (the trailing `N entries` line is the count).

4. **Batch review with the user** — present **all** proposals in one review
   (AskUserQuestion with multi-select when available, otherwise a numbered
   list), each as `'<from>' (N entries) → '<to>' (M entries) — <reason>`,
   showing the affected entries (or the first ~10 plus a count). For each
   pair the user can:
   - **Merge** — execute now (step 5);
   - **Defer to maintenance screen** — don't decide in chat; park it as a
     suggestion in `memory maintenance` and the web UI (step 7);
   - **Skip this time** / **Never suggest again**;
   - or reverse the direction.
   The user may also defer the **whole review** ("just put them in
   maintenance") — then propose every pair and merge nothing.
   **Never merge a pair the user did not explicitly approve in this review**
   — "yes to all" covers exactly the pairs presented, nothing more.

5. **Execute approved merges one at a time**:

   ```bash
   npx tsx src/cli.ts slugs merge --kind tag --from <from> --to <to>
   ```

   Each run independently checkpoints `memory/.git` before, rewrites only the
   `tags` frontmatter arrays (deduped, schema-validated), syncs the index,
   refreshes the maintenance audit, and commits after. If a merge errors,
   **stop the batch**: report the exact error and which merges already
   completed (each completed one is safely committed). Never hand-edit
   `memory/entries/` to recover.

6. **Verify after each merge** (all read-only):

   ```bash
   npx tsx src/cli.ts list --tag <from> --limit 1
   ```

   → must report **0 entries** (the old tag is gone everywhere).

   ```bash
   npx tsx src/cli.ts list --tag <to> --limit 1
   ```

   → count must equal `to_before + from_before − shared`, where `shared` is
   entries that carried both tags (they are deduped to one — preserved, not
   duplicated). The merge output itself must show `index synced` and both
   repo checkpoints. To show the audit trail:

   ```bash
   git -C memory log --oneline -3
   ```

   → expect `Merge tag slug: <from> -> <to>` preceded by
   `Checkpoint before slug merge: …`.

7. **Record deferrals and rejections**:
   - **Deferred pairs** — park them in the maintenance screen with the
     reasoning that will be shown next to the suggestion:

   ```bash
   npx tsx src/cli.ts slugs propose --kind tag --from <from> --to <to> --reason "<why they are the same concept>"
   ```

     The pair then appears under slug hygiene in `memory maintenance` and the
     web UI maintenance screen (with dry-run / merge / ignore buttons) and
     stays there until merged or ignored. Both slugs must still exist; a
     previously-dismissed pair is refused.
   - **"Never suggest again" rejections**:

   ```bash
   npx tsx src/cli.ts slugs dismiss --kind tag --from <from> --to <to>
   ```

   ("skip this time" → do nothing.)

8. **Recap to the user**: pairs merged (with entry counts), pairs deferred to
   the maintenance screen, pairs skipped/dismissed, tag-vocabulary size
   before → after (`slugs list` again), and a reminder that every merge is
   reversible via the `memory/.git` history.

## Merging into a brand-new canonical tag

Only when the user explicitly wants a new canonical name (e.g. merge `k8s`
and `kube` into a brand-new `kubernetes`): the **first** merge uses
`--create-target`. Call out in the confirmation that this **creates a new
tag** that currently appears on zero entries, and get the new name itself
explicitly approved. Subsequent merges into it need no flag. Never use
`--create-target` to get past a "target does not exist" dry-run error — that
usually means a typo in `--to`.

## Safety model — why this cannot orphan or lose data

- Tags are not standalone records — they exist only as frontmatter arrays on
  entries. The graph view derives tag nodes and edges from those arrays on
  every load.
- The merge maps `from → to` inside each affected entry and dedupes, so every
  entry keeps a valid tag edge; the `from` node disappears only because zero
  entries reference it. No entry, body, id, date, person, or team is touched.
- `memory/.git` checkpoint before + commit after each merge = a full undo
  path per merge.
- The index is re-synced in the same operation, so recall never sees a stale
  tag.

## Principles

- **One review, explicit approval per pair** — never assume approval, never
  merge silently, never extend approval beyond the pairs presented.
- **"Not now" ≠ "no"** — when the user doesn't want to decide in chat, defer
  the pair to the maintenance screen with `slugs propose` instead of dropping
  it.
- **Dry-run before, verify after** every real merge.
- **`slugs merge` is the only write path** for tag changes across entries
  (`MEMORY-GUARDRAILS.md`). A hook denial means "use the CLI", not "work
  around it".
- **Direction**: fewer-usage → more-usage by default; the user's stated
  direction always wins.
- **Same concept, not same topic.** Uncertain → ask, don't recommend.
- The same flow serves `--kind person|team` when the user asks to merge
  person or team slugs.
