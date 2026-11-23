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

cmd="$(field tool_input.command tool_input.cmd command cmd)"
if [ -n "$cmd" ]; then
  # Match the command LINES only; heredoc bodies are data (see above). If
  # stripping yields nothing (no awk), keep the full text.
  stripped="$(printf '%s\n' "$cmd" | strip_heredoc_bodies)"
  [ -n "$stripped" ] && cmd="$stripped"
else
  # Extraction failed outright → match the raw payload rather than waving it through.
  cmd="$input"
fi

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
