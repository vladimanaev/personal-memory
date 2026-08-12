#!/usr/bin/env bash
# Codex PreToolUse guard for memory-store discovery.
#
# Recall must go through the hybrid memory CLI, not ad hoc file search: keyword
# search misses semantic matches, returns no ranking, and hands back raw files
# stripped of the `⤷ superseded by` / `status: resolved by` chain annotations —
# so a settled matter reads as still open.
#
# Denies three shapes:
#   1. a search/bulk read that NAMES a store (memory/, memory-graphs/, .index/),
#   2. an UNSCOPED recursive sweep that never names it but walks into it anyway
#      (`grep -rli "jane doe" .`, `rg jane`, `find . -name …`) — the form
#      hand-search actually takes in practice,
#   3. rg run with --no-ignore outside an allow-listed code directory.
#
# Kept behaviourally in sync with .claude/hooks/guard-memory-search.sh.
#
# NOTE: deliberately no `set -e`. A hook that exits non-zero is a NON-BLOCKING
# error — the harness logs it and runs the tool anyway — so an internal failure
# must fall through to an explicit decision, never abort the script. For the
# same reason field extraction never depends on a single binary being present.

set -uo pipefail

input="$(cat)"

# Leaf-key scan: finds "key":"value" anywhere in the payload, so it works for
# both tool_input.command and a top-level command.
raw_field() {
  printf '%s' "$input" | awk -v key="$1" '
    { s = $0
      k = "\"" key "\":"
      i = index(s, k); if (i == 0) exit
      s = substr(s, i + length(k))
      sub(/^[ \t]*/, "", s)
      if (substr(s, 1, 1) != "\"") exit
      s = substr(s, 2)
      out = ""; esc = 0
      for (j = 1; j <= length(s); j++) {
        c = substr(s, j, 1)
        if (esc) { out = out c; esc = 0; continue }
        if (c == "\\") { out = out c; esc = 1; continue }
        if (c == "\"") break
        out = out c
      }
      print out; exit
    }' 2>/dev/null
}

# node first (repo baseline, handles nesting/escapes properly), awk as fallback
# so a minimal image cannot turn the guard into a silent allow.
field() {
  local out p
  if command -v node >/dev/null 2>&1; then
    out="$(node -e '
const data = JSON.parse(process.argv[1] || "{}");
const paths = process.argv.slice(2);
for (const path of paths) {
  let cur = data;
  for (const key of path.split(".")) cur = cur == null ? undefined : cur[key];
  if (typeof cur === "string") { process.stdout.write(cur); process.exit(0); }
}
' "$input" "$@" 2>/dev/null)"
    [ -n "$out" ] && { printf '%s' "$out"; return; }
  fi
  for p in "$@"; do
    out="$(raw_field "${p##*.}")"
    [ -n "$out" ] && { printf '%s' "$out"; return; }
  done
}

cmd="$(field tool_input.command tool_input.cmd command cmd)"
# Extraction failed outright → match the raw payload rather than waving it through.
[ -n "$cmd" ] || cmd="$input"

deny() {
  cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Don't hand-search the memory store — it misses semantic matches, returns no ranking, and hides superseded/resolved chain status (a settled matter reads as still open). Recall via the CLI instead:\n  npx tsx src/cli.ts recall \"<question form>\" \"<keyword form>\" \"<entity form>\" [--person X] [--type Y] [--since DATE] [--format json]\n  npx tsx src/cli.ts person <slug>   |   npx tsx src/cli.ts list [filters]\nAdd --complete when the answer must be exhaustive. Then read only the specific files that result cites, and follow any \"superseded by\" pointer before answering."}}
JSON
  exit 0
}

deny_sweep() {
  cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"That's an unscoped recursive search of the current tree — it walks straight into the memory store even though it never names it, which is exactly how hand-search happens in practice. It misses semantic matches, returns no ranking, and hides superseded/resolved chain status.\nLooking for MEMORIES? Use the CLI:\n  npx tsx src/cli.ts recall \"<question form>\" \"<keyword form>\" \"<entity form>\" [--person X] [--type Y] [--since DATE]\n  npx tsx src/cli.ts person <slug>   |   npx tsx src/cli.ts list [filters]\nLooking for CODE? Scope the command to a non-store path (src/, skills/, scripts/) instead of \".\"."}}
JSON
  exit 0
}

# Sanctioned retrieval: any memory-CLI invocation passes untouched. (Previously
# this listed query/person/list and omitted `recall`, the documented primary.)
case "$cmd" in
  *cli.ts*) exit 0 ;;
esac

# Stage 1 — is there a filesystem search / bulk-read verb at all? Plain git
# inspection (`git -C memory log|status|diff`) carries none; `git grep` does.
case "$cmd" in
  *grep*|*rg\ *|*fd\ *|*ag\ *|*ack*|*find\ *|*cat\ *|*head\ *|*tail\ *|*less\ *|*more\ *|*ls\ *|*awk*|*sed\ *|*wc\ *|*sort\ *|*xargs*|*tree*) ;;
  *) exit 0 ;;
esac

# Stage 2a — does it name a store outright? "/memory/" (with slashes) rather
# than a bare "memory/", so "personal-memory/src" does not match.
case " $cmd " in
  *memory/entries*|*memory/summaries*|*memory-graphs/*|*memory-public/*|*/memory/*|*\ memory/*|*\ memory\ *|*.index/*) deny ;;
esac

# Only the segment BEFORE the first pipe reads the filesystem; anything after one
# filters stdin (`git log | grep foo`). This must not be a blunt "contains a pipe
# → allow": `grep -rli jane . | head` walks the tree and pipes the result onward.
walk="${cmd%%|*}"

# Stage 2b — recursive sweep, or rg with the ignore rules disabled (which would
# reach into the gitignored stores even from a scoped path).
sweeper=0
case "$walk" in
  *grep*\ -*[rR]*|*rg\ *|*fd\ *|*ag\ *|*ack\ *|*find\ *|*ls\ -*R*) sweeper=1 ;;
esac
case "$walk" in
  *rg*--no-ignore*|*rg*\ -uuu*|*rg*\ -uu*|*rg*\ -u*) sweeper=1 ;;
esac
[ "$sweeper" = 1 ] || exit 0

# Scoped to somewhere concrete? A bare "." target, or no path at all, means
# "sweep the current tree" — everything else names a real path.
swept=0
case "$walk" in
  *\ .|*\ .\ *|*\ ./*) swept=1 ;;
esac
case "$walk" in
  */*) ;;
  *) swept=1 ;;
esac
case "$walk" in
  *rg*--no-ignore*|*rg*\ -uuu*|*rg*\ -uu*|*rg*\ -u*) swept=1 ;;
esac
[ "$swept" = 1 ] || exit 0

# …unless it names a known non-store directory.
case "$walk" in
  *src*|*skills*|*scripts*|*docs*|*connectors*|*.claude*|*.codex*|*.agents*|*.github*|*node_modules*|*package.json*|*tsconfig*|*README*) exit 0 ;;
esac

deny_sweep
