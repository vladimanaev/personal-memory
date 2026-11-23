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

# Heredoc bodies are stdin DATA when the command that owns them only stores or
# forwards text: `tool.py msg x <<'EOF' … cat memory/a.md … EOF` runs nothing but
# tool.py, so matching the body denies harmless commands whose text merely
# MENTIONS a store. But a body can equally be CODE (`bash <<EOF`, `python3 - <<EOF`,
# `eval "$(cat <<EOF …)"`) or a LIST OF PATHS (`xargs cat <<EOF`), and then it must
# stay matched. So bodies are stripped only in a narrow, known-safe case, and
# otherwise NOTHING is stripped (the whole command is matched as before).
#
# Owner allowlist — every heredoc in the command must be owned by one of:
#   - cat with its output redirected to a file (`cat > f <<EOF`);
#   - cat inside "$( … )" used as an argument of `git commit …` or `gh …`;
#   - tee <file>;
#   - git commit … -F - / --file=-;   gh … --body-file - / -F -;
#   - python|python3 <path>.py (the next word is a .py path, not -, -c or -m).
# And the command lines must contain none of: eval source . xargs read while sh bash
# zsh dash ksh node perl ruby tsx deno osascript (also as path basenames).
#
# Strip nothing when the scanner is unsure: an unterminated heredoc, a delimiter that
# is not exactly WORD / 'WORD' / "WORD" (WORD = [A-Za-z_][A-Za-z0-9_]*, followed by
# a blank, ;&|<>() or end of line), `${` `$[` `$'` or a backtick on a line with `<<`,
# `#` right after `)` or `}`, a body line that is the terminator followed by `)`,
# `case` in a $( ), or an open quote at the end of a line that carries `<<`.
# `<<<` here-strings, and `<<` in quotes, comments or $(( )) arithmetic, are not
# heredocs. Commands after a terminator line are command lines and stay matched.
strip_heredoc_bodies() {
  awk -v sqc="'" '
    function trim(s) { gsub(/^[ \t]+/, "", s); gsub(/[ \t]+$/, "", s); return s }
    function bad_words(text,    t, n, w, i) {
      t = text; gsub(badre, " ", t)
      n = split(t, w, /[ \t\r\n]+/)
      for (i = 1; i <= n; i++) { sub(/^.*\//, "", w[i]); if (w[i] in F) return 1 }
      return 0
    }
    function owner_ok(seg, lv, outer,    n, tk, o, i, red) {
      n = split(trim(seg), tk, /[ \t]+/)
      if (tk[1] == "cat") {
        for (i = 2; i <= n; i++) {
          if (tk[i] ~ /^[0-9]*>>?$/ && i < n && tk[i + 1] !~ /^&/) red = 1
          else if (tk[i] ~ /^[0-9]*>>?[^>&]/) red = 1
        }
        if (red) return 1
        split(trim(outer), o, /[ \t]+/)
        if (lv > 0 && ((o[1] == "git" && o[2] == "commit") || o[1] == "gh")) return 1
        return 0
      }
      if (tk[1] == "tee") {
        for (i = 2; i <= n; i++) if (tk[i] !~ /^-/ && tk[i] !~ /^[0-9]*[<>]/) return 1
        return 0
      }
      if (tk[1] == "git" && tk[2] == "commit") {
        for (i = 3; i <= n; i++) {
          if (tk[i] == "--file=-") return 1
          if ((tk[i] == "-F" || tk[i] == "--file") && tk[i + 1] == "-") return 1
        }
        return 0
      }
      if (tk[1] == "gh") {
        for (i = 2; i <= n; i++) {
          if (tk[i] == "--body-file=-") return 1
          if ((tk[i] == "-F" || tk[i] == "--body-file") && tk[i + 1] == "-") return 1
        }
        return 0
      }
      if (tk[1] ~ /^python3?$/ && tk[2] ~ /\.py$/ && tk[2] !~ /^-/) return 1
      return 0
    }
    function scan(line,    n, i, c, c1, c2, j, d, w, k, first, q, nx, hasw) {
      n = length(line); i = 1; first = nh + 1; ns = 0; lastsep = 0
      if (index(line, "<<") && (index(line, "${") || index(line, "$[") || index(line, "$" sqc) || index(line, "`"))) unsure = 1
      if ((lvl > 0 || index(line, "$(")) && line ~ /(^|[^A-Za-z0-9_])case([^A-Za-z0-9_]|$)/) unsure = 1
      while (i <= n) {
        c = substr(line, i, 1); c1 = substr(line, i + 1, 1); c2 = substr(line, i + 2, 1)
        if (sq) { if (c == sqc) sq = 0; i++; continue }
        if (dq) {
          if (c == "\\") { i += 2; continue }
          if (c == "$" && c1 == "(" && c2 != "(") {
            lvl++; cs[lvl] = 1; pd[lvl] = 0; dq = 0
            outer[lvl] = substr(line, lastsep + 1, i - lastsep - 1); lastsep = i + 1; i += 2; continue
          }
          if (c == "\"") dq = 0
          i++; continue
        }
        if (c == "\\") { i += 2; continue }
        if (c == sqc) { sq = 1; i++; continue }
        if (c == "\"") { dq = 1; i++; continue }
        if (c == "#" && i > 1 && substr(line, i - 1, 1) ~ /[)}]/) unsure = 1
        if (c == "#" && (i == 1 || substr(line, i - 1, 1) ~ /[ \t;&|(]/)) break
        if (ar > 0) {
          if (c == "(") ar++; else if (c == ")") ar--
          i++; continue
        }
        if (c == "$" && c1 == "(" && c2 != "(") {
          lvl++; cs[lvl] = 0; pd[lvl] = 0
          outer[lvl] = substr(line, lastsep + 1, i - lastsep - 1); lastsep = i + 1; i += 2; continue
        }
        if (c == "(" && c1 == "(") { ar = 2; i += 2; continue }
        if (c == ";" || c == "&" || c == "|" || c == "(" || c == ")") {
          sp[++ns] = i
          if (lvl > 0 && c == "(") pd[lvl]++
          else if (lvl > 0 && c == ")") { if (pd[lvl] > 0) pd[lvl]--; else { dq = cs[lvl]; lvl-- } }
          lastsep = i; i++; continue
        }
        if (c == "<" && c1 == "<") {
          if (c2 == "<") { i += 3; continue }
          j = i + 2; d = 0
          if (substr(line, j, 1) == "-") { d = 1; j++ }
          while (substr(line, j, 1) ~ /[ \t]/) j++
          c = substr(line, j, 1); w = ""
          if (c == sqc || c == "\"") {
            if (match(substr(line, j + 1), /^[A-Za-z_][A-Za-z0-9_]*/) && substr(line, j + 1 + RLENGTH, 1) == c) {
              w = substr(line, j + 1, RLENGTH); j = j + RLENGTH + 2
            }
          } else if (match(substr(line, j), /^[A-Za-z_][A-Za-z0-9_]*/)) {
            w = substr(line, j, RLENGTH); j = j + RLENGTH
          }
          nx = substr(line, j, 1)
          if (w == "" || (nx != "" && nx !~ /[ \t;&|<>()]/)) { unsure = 1; i += 2; continue }
          nh++; term[nh] = w; dash[nh] = d; hpos[nh] = i; hprev[nh] = lastsep
          hlvl[nh] = lvl; hout[nh] = (lvl > 0) ? outer[lvl] : ""
          i = j; continue
        }
        i++
      }
      if ((sq || dq) && nh >= first) unsure = 1
      for (q = first; q <= nh; q++) {
        nx = n + 1
        for (k = 1; k <= ns; k++) if (sp[k] > hpos[q]) { nx = sp[k]; break }
        if (!owner_ok(substr(line, hprev[q] + 1, nx - hprev[q] - 1), hlvl[q], hout[q])) badowner = 1
      }
      return (nh >= first) ? first : 0
    }
    BEGIN {
      split("eval source . xargs read while sh bash zsh dash ksh node perl ruby tsx deno osascript", fw, " ")
      for (k in fw) F[fw[k]] = 1
      badre = "[;&|()\"" sqc "`$<>{}=]"
    }
    {
      L[NR] = $0; kind[NR] = 0
      if (rd > 0) {
        t = $0
        if (dash[rd]) sub(/^\t+/, "", t)
        if (t == term[rd]) { kind[NR] = 2; rd++; if (rd > grpend) rd = 0 }
        else {
          kind[NR] = 1
          if (substr(t, 1, length(term[rd]) + 1) == term[rd] ")") unsure = 1
        }
        next
      }
      f = scan($0)
      if (f > 0) { rd = f; grpend = nh }
    }
    END {
      strip = (nh > 0 && rd == 0 && !unsure && !badowner)
      if (strip) {
        cmdtext = ""
        for (k = 1; k <= NR; k++) if (kind[k] == 0) cmdtext = cmdtext L[k] "\n"
        if (bad_words(cmdtext)) strip = 0
      }
      for (k = 1; k <= NR; k++) if (kind[k] == 0 || !strip) print L[k]
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
