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

# A heredoc body is stdin DATA when its command only stores or reads it as data,
# and matching it then denies harmless commands whose text merely MENTIONS a store
# (`tool.py msg x <<'EOF' … cat memory/a.md … EOF`). But a body can equally be CODE
# or a PATH LIST (`bash <<EOF`, `xargs cat <<EOF`, `… | python3`), and a scanner
# cannot tell the two apart across every shell construct. So the body is stripped
# ONLY when the ENTIRE command is exactly one of these shapes; anything else is
# matched whole (no stripping). T is a plain token [A-Za-z0-9_./~@%+=:,-]+ (or a
# single-quoted string); WORD is [A-Za-z_][A-Za-z0-9_]*; one heredoc, nothing after
# the terminator but empty lines (and, in B, the closing line). A body line that
# merely STARTS with WORD (bash 3.2 ends a $( ) heredoc on `WORD)`) voids the shape.
#   A  python|python3 <path>.py T* <<'WORD' | <<"WORD"   ... WORD   (QUOTED: an unquoted
#      body is expanded by the shell, so $(…) in it would run)
#   B  git commit T* -m "$(cat <<'WORD'  ... WORD  )" T*          (or gh T* --body …)
#   C  cat > <file> <<'WORD'  ... WORD                             (or >>; not /dev/*, not -)
# A and C take a REPO-RELATIVE path (see relok): that is what keeps a script that
# EXECUTES its stdin (python's own code.py, pdb.py) and a file that runs on its own
# later (~/.zshenv, .git/hooks/*) out of the whitelist. A is assumed to read stdin
# as data: that is a property of the script, which the guard cannot check.
# The command line (and B's closing line) stays matched as before.
strip_heredoc_bodies() {
  # LC_ALL=C: bracket ranges are plain ASCII, so no locale can widen a path class.
  LC_ALL=C awk -v sqc="'" '
    # Repo-relative path, or 0. Plain characters only (the callers match
    # [A-Za-z0-9_@%+,:./-]: no $ ~ = \ quotes globs braces or non-ASCII), and no
    # absolute path, `..` segment, empty segment, hidden segment (.git, .claude,
    # .venv, .envrc …) or vendored-code directory. Lexical only: a symlink inside
    # the repo is not resolved.
    function relok(p,   n, s, i, c) {
      c = substr(p, 1, 1)
      if (c == "/" || c == "-") return 0
      n = split(p, s, "/")
      for (i = 1; i <= n; i++) {
        if (s[i] == "") return 0
        if (s[i] != "." && substr(s[i], 1, 1) == ".") return 0
        if (s[i] == "site-packages" || s[i] == "dist-packages" || s[i] == "node_modules") return 0
      }
      return 1
    }
    BEGIN {
      T = "([A-Za-z0-9_./~@%+=:,-]+|" sqc "[^" sqc "]*" sqc ")"
      W = "[A-Za-z_][A-Za-z0-9_]*"
      P = "[A-Za-z0-9_@%+,:./-]+"
      ra = "^python3? " P "\\.py( " T ")* <<(" sqc W sqc "|\"" W "\")$"
      rb = "^(git commit|gh)( " T ")* (-m|--body) \"\\$\\(cat <<" sqc W sqc "$"
      rc = "^cat >>? " P " <<" sqc W sqc "$"
      rend = "^\\)\"( " T ")*$"
      rq = "<<[\"" sqc "]?" W "[\"" sqc "]?$"
      qs = "[\"" sqc "]"
    }
    { L[NR] = $0 }
    END {
      n = NR
      while (n > 0 && L[n] == "") n--
      ok = 0
      if (n >= 2) {
        h = L[1]
        isa = (h ~ ra); isb = (h ~ rb); isc = (h ~ rc)
        if (isa) { split(h, hp, " "); if (!relok(hp[2])) isa = 0 }
        if (isc) {
          # A data file only: an executable or auto-run target (no extension, .sh,
          # .py, .json hook config …) is a payload, not data.
          split(h, hp, " ")
          if (!relok(hp[3]) || hp[3] !~ /[A-Za-z0-9_]\.(md|txt|csv|log|diff|patch)$/) isc = 0
        }
        if (isa || isb || isc) {
          match(h, rq)
          w = substr(h, RSTART + 2); gsub(qs, "", w)
          last = isb ? n - 1 : n
          if (!isb || L[n] ~ rend) {
            k = 2; bad = 0
            while (k <= n && L[k] != w) {
              if (substr(L[k], 1, length(w)) == w) bad = 1
              k++
            }
            if (k == last && last >= 2 && !bad) ok = 1
          }
        }
      }
      for (k = 1; k <= NR; k++) {
        if (!ok || k == 1 || (isb && k >= n)) print L[k]
      }
    }
  '
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
    if [ -n "$cmd" ]; then
      # Match the command LINES only; heredoc bodies are data (see above). If
      # stripping yields nothing (no awk), keep the full text.
      stripped="$(printf '%s\n' "$cmd" | strip_heredoc_bodies)"
      [ -n "$stripped" ] && cmd="$stripped"
    else
      cmd="$input"
    fi

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
