---
name: recall-public
description: Use when the user wants ONLY shareable/public memories — preparing content for teammates (team updates, docs, posts, message drafts), or explicitly asking "what can I share about X" / "public memories only". Searches the public graph exclusively and never falls back to private memories.
---

# Recalling PUBLIC memories only

You are retrieving from the **public graph only** (`memory-public/` — the
shareable half of the user's Personal Memory). The output of this skill is
typically destined to leave the private context, so the private graph is
**out of bounds**: never search it, never read its files, never fill gaps
from it or from chat history.

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

## ⛔ Every command carries `--graph public` — no exceptions

Discovery is CLI-only (never Grep/Glob the store — see `recall-memory` for
why), and in this skill every retrieval command MUST be scoped:

```bash
npx tsx src/cli.ts recall "<question>" "<alt phrasing>" --graph public --format json
npx tsx src/cli.ts list --graph public [--type …] [--tag …] [--since …]
npx tsx src/cli.ts person <slug> --graph public
npx tsx src/cli.ts query "<question>" --graph public
```

Never omit the flag, and never re-run a silent query without it "just to
check" — that is exactly the leak this skill exists to prevent.

## Guardrails — the point of this skill

- **Silence is an answer.** If the public graph has nothing, say so plainly
  ("no public memories cover this") — do NOT widen the scope, open private
  entry files, or fill in from conversation memory.
- **Cite only public entries.** Every claim grounds in a `memory-public/…`
  path. Never surface a private entry's content, id, title, or path in output
  meant for sharing.
- **Superseded-by pointers can cross into private** (a matter can develop
  privately after a public entry). If a public hit shows
  `⤷ superseded by: <id>` and that id is not in the public graph, treat the
  public entry as the latest SHAREABLE state — note only that there may be
  newer non-shareable context, without describing or identifying it.
- **Wrong tool?** If the user's question clearly needs private context
  ("what did Jane tell me in our 1:1"), tell them this skill is public-only
  and point them at `/recall` instead.
- Read the cited `memory-public/…` files in full before answering, as usual.

## Populating the public graph

If recall keeps coming up empty, the graphs may need rebalancing — an entry
can be reclassified with `npx tsx src/cli.ts move <id> --to public` (the CLI
validates that it references no private ids). Suggest this to the user when
relevant; never move entries yourself without their explicit confirmation.
