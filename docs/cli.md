# CLI reference

Most of the time you talk to an agent and it calls these commands for you. The
CLI is the engine underneath, and it is what you reach for when debugging,
scripting, or checking index and connector health.

Run it as `npx tsx src/cli.ts <command>` (or `npm run memory -- <command>`)
from your clone. `npx tsx src/cli.ts help` always prints the authoritative
list; this page is the narrative version.

## Capture

```text
memory add --title "..." --type <type> [--people a,b] [--teams x,y]
           [--tags a,b] [--date YYYY-MM-DD] [--body "..."]
           [--source-ids slack:C123:1700000000.1,gmail:<thread-id>]
           [--connector raw-capture]
           [--follows <earlier-id,...>] [--due YYYY-MM-DD]
           [--update <id>] [--force-new] [--dup-threshold N]
           [--graph <name>]
```

`--source-ids` is the dedup anchor. Re-capturing the same Slack thread or
email updates that entry in place instead of creating a second one. Without a
source id a near-duplicate guard catches repeats; resolve it with `--update
<id>` (same event) or `--force-new` (genuinely different).

`--graph` files a new entry into a named graph **and nowhere else** — it leaves
no copy in the default graph. It is reserved for an explicit request; captures
otherwise land in the default graph and gain shared memberships through rules or
promotion, which keep the home copy. See [concepts](concepts.md#graphs).

Entry types:

```text
event, decision, todo, pending-decision, 1on1, hiring, incident,
achievement, feedback, meeting, note, summary
```

## Timeline links

```text
memory link <id> --follows <earlier-id,...>
memory unlink <id> --follows <earlier-id,...>
```

`--follows` records that an entry develops or settles an earlier one. Links are
validated at write time: targets must exist, must not be newer, and cycles are
rejected. Settle an open matter by logging a new linked entry rather than
rewriting the old one. See [timeline chains](concepts.md#timeline-chains).

## Due dates

```text
memory add ... --type todo --due YYYY-MM-DD
memory due <id> <YYYY-MM-DD|none>
```

`--due` is accepted on `todo` and `pending-decision` entries only, and must be a
real calendar date. `memory due` sets it on an existing todo / pending decision
(settled or not) and clears it from any entry, in every graph that holds a copy.
Retyping an entry out of those types drops its due date. A due
date only flags an item as overdue; it never settles it.

## Retrieval

```text
memory recall "<question>" ["<agent phrasing>" ...]
              [--person slug] [--type type] [--team slug] [--tag slug]
              [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--graph G] [-k n]
              [--complete | --complete-if-small | --no-complete]
              [--require-complete] [--no-expand] [--no-cutoff]
              [--rerank | --no-rerank] [--index-slot <name>]
              [--format text|json]

memory query "<question>" ["<alternate phrasing>" ...]
             [--person slug] [--type type] [--team slug] [--tag slug]
             [--since YYYY-MM-DD] [--until YYYY-MM-DD] [-k n] [--deep]

memory list [--person|--type|--team|--tag|--since|--until|--graph|--limit]
memory person <slug> [--graph <name>]
memory open ["<phrasing>" ...] [--source <prefix,...>] [--person X] [--limit N]
            [--overdue | --no-due]
```

Each quoted positional is a separate phrasing; all of them are fused into one
weighted ranking, together with expansions the CLI generates itself. Two to
four phrasings is the useful range. `recall` defaults to deep candidate pools
and complete-if-small (exhaustive up to 200 candidates); `--require-complete`
makes an incomplete answer an error rather than a warning.

`--graph <name>` scopes to a single graph's members. Without it, recall spans
every graph and labels shared memberships `[<graph>,…]`.

`memory open` lists unresolved todos and pending decisions that a new capture
might settle — pass the confirmed ids to `--follows`. Items with a due date show
it, flagged `⚠ overdue` once past; `--overdue` / `--no-due` narrow to those
past due or without a date.

## Graphs

```text
memory graphs [list]
memory graphs create <slug> [--display-name "..."] [--description "..."]
memory graphs sync [--dry-run]
memory graphs delete <slug> --confirm
memory copy <id> --to <graph>
memory move <id> --to <graph>
memory rules [list]
memory rules apply [--dry-run]
memory promote candidates --to <graph>
memory promote dismiss <id> --graph <g>
memory queue [list] [--graph <g>] [--state ready|stale|blocked|all] [--json]
memory queue show <id> --graph <g> [--json]
memory queue add <id> --to <g> --reason "..." [--summary-file <path|->] [--force]
memory queue approve <id> --graph <g> [--summary]
memory queue dismiss <id> --graph <g> [--reason "..."]
memory queue sweep --graph <g> [--through YYYY-MM-DD] [--force]
```

`copy` adds a membership and keeps the default-graph copy; `move` replaces the
entry's whole membership. Both validate containment in each direction: a
shared-graph entry may only reference fellow members, so copying an entry whose
`follows` target is not yet a member fails with the ids you need to copy first.

`graphs delete` is permanent and is blocked while entries exist only in that
graph.

### The review queue

Nothing reaches a shared graph on its own. Standing rules, an explicit
"log this to X", and sweep routines all end at the same place: a queue of
candidates for you to approve one at a time, here or on the Manage Graphs
screen. Each row says who proposed it and why.

`queue add` is what a sweep calls once it has judged an entry against the
graph's `GRAPH.md` criteria. When the substance belongs in the graph but the
wording does not, it can offer a redaction with `--summary-file` — approving
with `--summary` publishes those words instead of the entry's own, and the
shared copy records what it was derived from so `graphs sync` can tell it
apart from drift. Reword the private entry afterwards and the published copy
stays exactly as you approved it, coming back to the queue marked stale.

`queue sweep` records how far a routine has read, so the next run resumes
there instead of re-judging the whole corpus. It refuses to move the
watermark backwards unless you pass `--force`.

Declining is remembered against the entry's current content: a dismissed
candidate stays out until the entry itself changes.

## Summaries and housekeeping

```text
memory digest --person <slug> | --quarter <YYYY-Qn> | --tag <slug> [--graph <name>]
memory remove <id>
memory maintenance [--threshold n]
memory slugs list --kind person|team|tag [--min-count N]
memory slugs merge --kind person|team|tag --from <slug> --to <slug> [--dry-run] [--create-target]
memory slugs propose ...
memory connectors
memory connectors mark-pulled <name> [--at ISO_TIMESTAMP]
memory connectors mark-captured <name> [--at ISO_TIMESTAMP]
memory sources
memory ui [--port n] [--no-open]
```

`memory maintenance` is a read-only report: digest debt, index health, slug
hygiene, dangling timeline links, and which index slots exist.

## Index

```text
memory index [--force|--reembed] [--rebuild] [--optimize [--header-batch N]]
memory index --build [<slot>] [--dry-run] [--force]
memory index --activate <slot|previous>
memory index --prune [--confirm]
memory index slots
```

Rebuild at any time — the index is derived state and nothing in it is a source
of truth:

```bash
npm run memory -- index --rebuild   # rebuild catalog/lexical tables, reuse vectors
rm -rf .index                       # full reset, drops vectors and root sidecars
npm run index -- --force
```

Slot mechanics and when the next-format index is worth switching to are in
[upgrading](upgrading.md#switching-to-the-next-format-index).
