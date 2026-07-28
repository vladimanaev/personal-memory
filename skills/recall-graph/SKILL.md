---
name: recall-graph
description: Use when the user wants ONLY one shared graph's memories — preparing content for a specific audience (team updates, docs, posts, drafts), or asking "what can I share with <audience> about X". Requires a graph name; searches that graph exclusively and never falls back to other graphs.
---

# Recalling from ONE shared graph only

You are retrieving from a **single shared graph**. There is no default —
the user names the graph (check `npx tsx src/cli.ts graphs list`; ask if
the target is ambiguous). The output of this skill is typically
destined to leave the private context, so every other graph — above all the
private one — is **out of bounds**: never search them, never read their
files, never fill gaps from them or from chat history.

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

## ⛔ Every command carries `--graph <name>` — no exceptions

Discovery is CLI-only (never Grep/Glob the store — see `recall-memory` for
why), and in this skill every retrieval command MUST be scoped to the target
graph:

```bash
npx tsx src/cli.ts recall "<question>" "<alt phrasing>" --graph <name> --format json
npx tsx src/cli.ts list --graph <name> [--type …] [--tag …] [--since …]
npx tsx src/cli.ts person <slug> --graph <name>
npx tsx src/cli.ts query "<question>" --graph <name>
```

Never omit the flag, and never re-run a silent query without it "just to
check" — that is exactly the leak this skill exists to prevent.

## Guardrails — the point of this skill

- **Silence is an answer.** If the target graph has nothing, say so plainly
  ("no <graph> memories cover this") — do NOT widen the scope, open other
  graphs' files, or fill in from conversation memory.
- **Cite only member entries.** Every claim grounds in a path inside that
  graph's store (`memory-graphs/<name>/…`). Never surface any other entry's
  content, id, title, or path in output meant for sharing.
- **Superseded-by pointers can cross out of the graph** (a matter can develop
  privately after being shared). If a hit shows `⤷ superseded by: <id>` and
  that id is not a member of the target graph, treat the hit as the latest
  SHAREABLE state — note only that there may be newer non-shareable context,
  without describing or identifying it.
- **Wrong tool?** If the user's question clearly needs private context
  ("what did Jane tell me in our 1:1"), tell them this skill is single-graph
  and point them at `/recall` instead.
- Read the cited member files in full before answering, as usual.

## Populating a shared graph

If recall keeps coming up empty, the graph probably just hasn't had a
promotion review lately — suggest `/promote --to <graph>`
(`skills/promote-graph/SKILL.md`), the user-confirmed flow that copies
eligible private entries in, or standing distribution rules on the `#/graphs`
UI screen. Never copy/move entries yourself without the user's explicit
per-entry confirmation.
