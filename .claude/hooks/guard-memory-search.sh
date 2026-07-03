#!/usr/bin/env bash
# PreToolUse guard for Grep/Glob in the personal-memory repo.
#
# Memory recall MUST go through the semantic CLI (`npx tsx src/cli.ts query`),
# not freestyle file search — keyword/file search misses semantic matches and
# won't scale. This hook denies any Grep/Glob that would touch the memory/ store
# (i.e. searches not explicitly scoped to a non-memory path), and tells the
# agent what to run instead. Reading specific files a query cites is unaffected
# (this hook only matches Grep/Glob, never Read).

input="$(cat)"

# Pull the fields Grep/Glob expose; default to empty when absent.
path="$(printf '%s' "$input"    | jq -r '.tool_input.path    // ""')"
pattern="$(printf '%s' "$input" | jq -r '.tool_input.pattern // ""')"
glob="$(printf '%s' "$input"    | jq -r '.tool_input.glob    // ""')"

deny() {
  cat <<JSON
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Don't search the memory store with Grep/Glob — it misses semantic matches and won't scale. Recall via the CLI instead:\n  npx tsx src/cli.ts query \"<question>\" [--person X] [--type Y] [--since DATE]\n  npx tsx src/cli.ts person <slug>   |   npx tsx src/cli.ts list [filters]\nThen Read only the files a query result cites. (To search CODE, scope this Grep/Glob to a non-memory path like src/.)"}}
JSON
  exit 0
}

# Explicit mention of the memory store anywhere → deny.
case " $path $pattern $glob " in
  *[Mm]emory*) deny ;;
esac

# Unscoped search (no path, or repo root, or a path inside memory/) would hit
# the store → deny. A search scoped to a real non-memory path (e.g. src/) passes.
case "$path" in
  ""|"."|"./"|"/") deny ;;
  memory|memory/*|./memory|./memory/*) deny ;;
esac

# Anything else (e.g. path=src) is allowed: emit nothing, exit 0.
exit 0
