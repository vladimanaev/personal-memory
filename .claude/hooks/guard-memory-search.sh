#!/usr/bin/env bash
# PreToolUse guard for Grep/Glob/Bash in the personal-memory repo.
#
# Memory recall MUST go through the semantic CLI (`npx tsx src/cli.ts recall`),
# not freestyle file search — keyword/file search misses semantic matches, has no
# ranking, and carries none of the timeline metadata (`⤷ superseded by`,
# `status: resolved by`), so a stale entry reads as current.
#
# This hook denies BOTH shapes of hand-discovery:
#   - Grep/Glob calls that would touch a store (i.e. not explicitly scoped to a
#     non-memory path), and
#   - shell searches/bulk reads issued through Bash (grep/rg/find/cat/ls/…) that
#     reference a store. The rule is about DISCOVERY, not about which tool
#     performs it — routing around Grep by shelling out is the same mistake.
#
# Reading specific files a recall cites is unaffected: this hook never matches
# the Read tool, and any `cli.ts` invocation passes untouched.

input="$(cat)"

# Field extraction must not depend on `jq`: this hook also runs in sandboxed /
# mounted environments (cowork VMs, containers) whose image may not ship it. A
# missing dependency used to make the script exit non-zero, which Claude Code
# treats as a non-blocking error — i.e. the guard silently ALLOWED everything.
# Fall back to awk (POSIX, present essentially everywhere), then to raw matching.
field() {
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$input" | jq -r "$1 // \"\"" 2>/dev/null
    return
  fi
  key="$(printf '%s' "$1" | sed 's/.*\.//; s/[^A-Za-z_].*//')"
  printf '%s' "$input" | awk -v key="$key" '
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

tool="$(field .tool_name)"

deny() {
  cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Don't search the memory store with Grep/Glob — it misses semantic matches, returns no ranking, and hides superseded/resolved chain status (a stale entry looks current). Recall via the CLI instead:\n  npx tsx src/cli.ts recall \"<question form>\" \"<keyword form>\" \"<entity form>\" [--person X] [--type Y] [--since DATE] [--format json]\n  npx tsx src/cli.ts person <slug>   |   npx tsx src/cli.ts list [filters]\nAdd --complete when the answer must be exhaustive. Then Read only the files a recall result cites, and follow any \"superseded by\" pointer before answering. (To search CODE, scope this Grep/Glob to a non-memory path like src/.)"}}
JSON
  exit 0
}

deny_bash() {
  cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Same rule, different tool: don't hand-search the memory store from the shell (grep/rg/find/cat/ls/head/awk over memory/, memory-graphs/, or .index/). It misses semantic matches, returns no ranking, and hides superseded/resolved chain status — a stale entry looks current. Recall via the CLI instead:\n  npx tsx src/cli.ts recall \"<question form>\" \"<keyword form>\" \"<entity form>\" [--person X] [--type Y] [--since DATE] [--format json]\n  npx tsx src/cli.ts person <slug>   |   npx tsx src/cli.ts list [filters]\nAdd --complete when the answer must be exhaustive. Then open the specific files that result cites with the Read tool — not cat."}}
JSON
  exit 0
}

deny_sweep() {
  cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"That's an unscoped recursive search of the current tree — it walks straight into the memory store even though it never names it, which is exactly how hand-search happens in practice. It misses semantic matches, returns no ranking, and hides superseded/resolved chain status.\nLooking for MEMORIES? Use the CLI:\n  npx tsx src/cli.ts recall \"<question form>\" \"<keyword form>\" \"<entity form>\" [--person X] [--type Y] [--since DATE]\n  npx tsx src/cli.ts person <slug>   |   npx tsx src/cli.ts list [filters]\nLooking for CODE? Scope the command to a non-store path (src/, skills/, scripts/) instead of \".\"."}}
JSON
  exit 0
}

case "$tool" in
  Grep|Glob)
    path="$(field .tool_input.path)"
    glob="$(field .tool_input.glob)"

    # Unscoped search (no path, or a filesystem/repo root) would sweep a store.
    case "$path" in
      ""|"."|"./"|"/") deny ;;
    esac
    if [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
      case "$path" in
        "$CLAUDE_PROJECT_DIR"|"$CLAUDE_PROJECT_DIR"/) deny ;;
      esac
    fi

    # A path inside any store — relative or absolute. Matched on path/glob only:
    # the search PATTERN is deliberately not inspected, so a legitimate code
    # search like Grep(pattern="memory leak", path="src/") still passes.
    case "$path" in
      memory|memory/*|./memory|./memory/*) deny ;;
      memory-public|memory-public/*|./memory-public|./memory-public/*) deny ;;
      memory-graphs|memory-graphs/*|./memory-graphs|./memory-graphs/*) deny ;;
      .index|.index/*|./.index|./.index/*) deny ;;
      */memory|*/memory/*) deny ;;
      */memory-public|*/memory-public/*) deny ;;
      */memory-graphs|*/memory-graphs/*) deny ;;
      */.index|*/.index/*) deny ;;
    esac
    case "$glob" in
      memory/*|memory-public/*|memory-graphs/*|.index/*) deny ;;
      */memory/*|*/memory-public/*|*/memory-graphs/*|*/.index/*) deny ;;
    esac
    ;;

  Bash)
    cmd="$(field .tool_input.command)"
    # Extraction failed outright (exotic payload, no jq, no awk) → match against
    # the raw payload rather than waving the call through.
    [ -n "$cmd" ] || cmd="$input"

    # Sanctioned retrieval: any memory-CLI invocation passes untouched. This also
    # keeps the repo's own path (…/personal-memory/src/cli.ts) from tripping the
    # store patterns below.
    case "$cmd" in
      *cli.ts*) exit 0 ;;
    esac

    # Stage 1 — is there a filesystem search / bulk-read verb at all? Plain git
    # inspection (`git -C memory log|status|diff`) carries none and passes;
    # `git grep` does not.
    case "$cmd" in
      *grep*|*rg\ *|*ag\ *|*ack*|*find\ *|*cat\ *|*head\ *|*tail\ *|*less\ *|*more\ *|*ls\ *|*awk*|*sed\ *|*wc\ *|*sort\ *|*xargs*|*tree*) ;;
      *) exit 0 ;;
    esac

    # Stage 2a — does it name a store outright? "/memory/" (with slashes) rather
    # than a bare "memory/", so "personal-memory/src" does not match.
    case " $cmd " in
      *memory/entries*|*memory/summaries*|*memory-graphs/*|*memory-public/*|*/memory/*|*\ memory/*|*\ memory\ *|*.index/*) deny_bash ;;
    esac

    # Stage 2b — an UNSCOPED whole-tree sweep never names the store but walks
    # into it anyway (`grep -rli "jane doe" .`, `rg jane`, `find . -name …`).
    # This is the same shape the Grep/Glob branch denies on an empty `path`, and
    # it is the form hand-search actually takes in practice.
    #
    # Only the segment BEFORE the first pipe reads the filesystem; anything after
    # one is filtering stdin (`git log | grep foo`). Note this must not be a blunt
    # "contains a pipe → allow": `grep -rli jane . | head` walks the tree and then
    # pipes the result onward, which is still a sweep.
    walk="${cmd%%|*}"

    case "$walk" in
      *grep*\ -*[rR]*|*rg\ *|*ag\ *|*ack\ *|*find\ *|*ls\ -*R*) ;;
      *) exit 0 ;;
    esac

    # Scoped to somewhere concrete? A bare "." target, or no path at all, means
    # "sweep the current tree" — everything else names a real path and is fine.
    swept=0
    case "$walk" in
      *\ .|*\ .\ *|*\ ./*) swept=1 ;;
    esac
    case "$walk" in
      */*) ;;
      *) swept=1 ;;
    esac
    [ "$swept" = 1 ] || exit 0

    # …unless that path is a known non-store part of the repo.
    case "$walk" in
      *src*|*skills*|*scripts*|*docs*|*connectors*|*.claude*|*.github*|*node_modules*|*package.json*|*tsconfig*|*README*) exit 0 ;;
    esac

    deny_sweep
    ;;
esac

# Anything else is allowed: emit nothing, exit 0.
exit 0
