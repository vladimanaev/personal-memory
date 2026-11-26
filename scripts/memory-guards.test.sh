#!/usr/bin/env bash
# Tests for the PreToolUse guards in .claude/hooks/.
#
# The guards are the only thing standing between an agent and hand-searching or
# hand-writing the memory store, so their pattern matching is worth pinning down:
# a false negative silently reopens the hole, a false positive teaches agents to
# route around the guard.
#
# Each case pipes a synthetic PreToolUse payload into a guard and asserts whether
# a "deny" decision came back.

set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
search_guard="$repo_root/.claude/hooks/guard-memory-search.sh"
write_guard="$repo_root/.claude/hooks/guard-memory-write.sh"

failures=0
checks=0

# run_guard <guard> <json-payload> -> prints guard stdout
run_guard() {
  printf '%s' "$2" | bash "$1"
}

# expect <deny|allow> <guard> <label> <json-payload>
expect() {
  local want="$1" guard="$2" label="$3" payload="$4"
  local out got
  checks=$((checks + 1))
  out="$(run_guard "$guard" "$payload")"
  case "$out" in
    *'"permissionDecision":"deny"'*) got=deny ;;
    *) got=allow ;;
  esac
  if [ "$got" != "$want" ]; then
    printf '  ✗ %s\n      want %s, got %s\n' "$label" "$want" "$got"
    failures=$((failures + 1))
  else
    printf '  ✓ %s (%s)\n' "$label" "$got"
  fi
}

# bash_case <deny|allow> <command>
bash_case() {
  local want="$1" cmd="$2"
  expect "$want" "$search_guard" "bash: $cmd" \
    "$(jq -nc --arg c "$cmd" '{tool_name:"Bash",tool_input:{command:$c}}')"
}

# grep_case <deny|allow> <pattern> <path> [glob]
grep_case() {
  local want="$1" pattern="$2" path="$3" glob="${4:-}"
  expect "$want" "$search_guard" "grep: pattern=[$pattern] path=[$path] glob=[$glob]" \
    "$(jq -nc --arg p "$pattern" --arg d "$path" --arg g "$glob" \
       '{tool_name:"Grep",tool_input:{pattern:$p,path:$d,glob:$g}}')"
}

# write_case <deny|allow> <command>
write_bash_case() {
  local want="$1" cmd="$2"
  expect "$want" "$write_guard" "write/bash: $cmd" \
    "$(jq -nc --arg c "$cmd" '{tool_name:"Bash",tool_input:{command:$c}}')"
}

# both_write_bash_case <deny|allow> <command>
# The .claude and .codex guards have drifted before, and a verb present in one
# but not the other means the same command is blocked under Codex and allowed
# under Claude Code. Assert them together so they cannot diverge silently.
both_write_bash_case() {
  local want="$1" cmd="$2" g
  for g in "$repo_root/.claude/hooks/guard-memory-write.sh" "$repo_root/.codex/hooks/guard-memory-write.sh"; do
    expect "$want" "$g" "both[$(basename "$(dirname "$(dirname "$g")")")]: $cmd" \
      "$(jq -nc --arg c "$cmd" '{tool_name:"Bash",tool_input:{command:$c}}')"
  done
}

# both_search_bash_case <deny|allow> <command>
# Same drift concern as the write guards: the .claude and .codex search guards
# are separate copies, so the heredoc cases run against both.
both_search_bash_case() {
  local want="$1" cmd="$2" g
  for g in "$repo_root/.claude/hooks/guard-memory-search.sh" "$repo_root/.codex/hooks/guard-memory-search.sh"; do
    expect "$want" "$g" "both[$(basename "$(dirname "$(dirname "$g")")")]: $(printf '%s' "$cmd" | tr '\n\t' '~^')" \
      "$(jq -nc --arg c "$cmd" '{tool_name:"Bash",tool_input:{command:$c}}')"
  done
}

# write_file_case <deny|allow> <file_path>
write_file_case() {
  local want="$1" file="$2"
  expect "$want" "$write_guard" "write/edit: $file" \
    "$(jq -nc --arg f "$file" '{tool_name:"Write",tool_input:{file_path:$f}}')"
}

echo "== write guards: an interpreter is a write verb, in BOTH harnesses =="
# node -e "...writeFileSync..." was denied under Codex and ALLOWED under
# Claude Code — the primary harness — because the verb lists had drifted.
both_write_bash_case deny "node -e \"require('fs').writeFileSync('memory/entries/2026/01/x.md','x')\""
both_write_bash_case deny "python3 -c \"open('memory/entries/2026/01/x.md','w').write('x')\""
both_write_bash_case deny "perl -pi -e s/a/b/ memory/entries/2026/01/x.md"
both_write_bash_case deny "node -e \"require('fs').writeFileSync('memory/graphs/queue.json','[]')\""
both_write_bash_case allow "node -e \"console.log(1)\""
both_write_bash_case allow "npx tsx src/cli.ts queue list --graph team-x"

echo "== write guard: the review queue is CLI-only, the rest of its directory is not =="
# Config beside it stays hand-editable; the queue does not, because its rows
# carry content hashes that have to match the store. A hand-written row is
# either ignored or acted on against wording the entry no longer has.
write_file_case deny "/repo/memory/graphs/queue.json"
write_file_case deny "memory/graphs/queue.json"
write_file_case allow "/repo/memory/graphs/rules.json"
write_file_case allow "/repo/memory-graphs/team-x/GRAPH.md"
write_bash_case deny "printf x > memory/graphs/queue.json"
write_bash_case deny "sed -i '' s/a/b/ memory/graphs/queue.json"
write_bash_case allow "cat memory/graphs/queue.json"
write_bash_case allow "npx tsx src/cli.ts queue approve 2026-01-01-x --graph team-x"

echo "== search guard: shell hand-search must be denied =="
# The exact shape of the incident this guard exists to prevent.
bash_case deny 'grep -rli "jane doe" memory/'
bash_case deny 'rg jane memory-graphs/'
bash_case deny 'cat memory/entries/2026-08-01-foo.md'
bash_case deny 'ls memory/entries'
bash_case deny "find memory/ -name '*.md'"
bash_case deny 'git -C memory grep jane'
bash_case deny 'grep -r foo /Users/x/personal-memory/memory/entries'
bash_case deny 'head -50 memory/summaries/summary-jane.md'
bash_case deny 'cat .index/connector-state.json'
bash_case deny 'cd "$MEMORY_HOME" && grep -rn jane memory/'

echo
echo "== search guard: UNSCOPED sweeps must be denied =="
# These never name the store but walk into it from the repo root — the form
# hand-search actually takes. Missing these is what let the incident through.
bash_case deny 'grep -rli "jane doe" .'
bash_case deny 'grep -rli "jane doe"'
bash_case deny 'grep -rn jane'
bash_case deny 'rg "jane doe"'
bash_case deny 'rg -l jane'
bash_case deny 'find . -name "*jane*"'
bash_case deny 'ls -R .'
bash_case deny 'grep -rl jane ./'
# A sweep piped ONWARD is still a sweep — only stdin-filtering is exempt.
bash_case deny 'grep -rli "jane doe" . | head -20'
bash_case deny 'rg jane | sort | uniq'
bash_case deny 'npm test && grep -rn jane .'
bash_case deny 'grep -rli "jane" . 2>&1 | head -2'

echo
echo "== search guard: sanctioned + unrelated shell must pass =="
bash_case allow 'npx tsx src/cli.ts recall "jane doe" --person jane-doe'
bash_case allow 'npx tsx src/cli.ts person jane-doe'
bash_case allow 'cd "$MEMORY_HOME" && npx tsx src/cli.ts list --type decision'
bash_case allow 'npx tsx src/cli.ts add --title "x" --type note --body "y"'
bash_case allow 'git -C memory log --oneline -5'
bash_case allow 'git -C memory status'
bash_case allow 'grep -rn "recall" src/'
bash_case allow 'grep -rn "recall" src'
bash_case allow 'grep -rn chain ./src'
bash_case allow 'grep -rn foo /Users/x/some-other-project'
bash_case allow 'rg recall skills/'
bash_case allow 'find scripts -name "*.sh"'
bash_case allow 'git log --oneline | grep fix'
bash_case allow 'ls src/'
bash_case allow 'ls'
bash_case allow 'cat package.json'
bash_case allow 'npm test'

echo
echo "== search guard: heredoc bodies are stripped only for three whole-command shapes =="
nl=$'\n'; tab=$'\t'; cr=$'\r'
py="import subprocess,sys; subprocess.run('cat memory/x.md', shell=True, stdout=sys.stderr)"
# Shape A: python <path>.py T* <<WORD, nothing after the terminator. The motivating
# false positive: prose in the body that merely mentions a store.
both_search_bash_case allow "python3 tool.py msg x <<'EOF'${nl}Blocked: could not cat memory/people/a.md or ls memory-graphs/${nl}EOF"
both_search_bash_case allow "python3 tool.py msg x <<\"EOF\"${nl}grep -rli jane .${nl}EOF"
both_search_bash_case allow "python scripts/tool.py msg 'two words' <<'EOF'${nl}ls memory/entries${nl}EOF${nl}${nl}"
# Shape B: a commit / PR message.
both_search_bash_case allow "git commit -m \"\$(cat <<'EOF'${nl}note: ls memory/entries${nl}EOF${nl})\""
both_search_bash_case allow "git commit --amend -m \"\$(cat <<'EOF'${nl}note: cat memory/x.md${nl}EOF${nl})\" --no-edit"
both_search_bash_case allow "gh pr create --title x --body \"\$(cat <<'EOF'${nl}note: ls memory/entries${nl}EOF${nl})\""
# Shape C: write a file.
both_search_bash_case allow "cat > notes.md <<'EOF'${nl}see cat memory/x.md and ls memory-graphs/${nl}EOF"
both_search_bash_case allow "cat >> notes.md <<'A'${nl}ls memory/${nl}A"
both_search_bash_case allow "python3 ./tool.py msg x <<'EOF'${nl}ls memory/entries${nl}EOF"
both_search_bash_case allow "python3 a/b/tool.py msg x <<'EOF'${nl}ls memory/entries${nl}EOF"
both_search_bash_case allow "cat > docs/notes.txt <<'EOF'${nl}ls memory/entries${nl}EOF"
# An UNQUOTED delimiter lets the shell expand $( ), backticks and ${ } in the body
# before python starts, so the body is code: never stripped.
both_search_bash_case deny "python3 tool.py msg x <<EOF${nl}cat memory/people/a.md${nl}EOF"
both_search_bash_case deny "python3 x.py <<EOF${nl}\$(cat memory/x.md >&2)${nl}EOF"
both_search_bash_case deny "python3 x.py <<EOF${nl}\`grep -r jane memory/ >&2\`${nl}EOF"
both_search_bash_case deny "python3 x.py <<EOF${nl}\${x:-\$(cat memory/x.md >&2)}${nl}EOF"
# bash 3.2 ends a heredoc inside \$( ) on a body line "WORD)": any body line that
# STARTS with WORD voids the shape, for all three shapes.
both_search_bash_case deny "git commit --dry-run -m \"\$(cat <<'EOF'${nl}EOF)\"${nl}cat memory/x.md${nl}EOF${nl})\""
both_search_bash_case deny "python3 x.py <<'EOF'${nl}EOF)${nl}cat memory/x.md${nl}EOF"
both_search_bash_case deny "python3 x.py <<'EOF'${nl}EOFx${nl}cat memory/x.md${nl}EOF"
both_search_bash_case deny "cat > s <<'EOF'${nl}EOF)${nl}cat memory/x.md${nl}EOF"
both_search_bash_case deny "cat > s <<'EOF'${nl}EOF ${nl}cat memory/x.md${nl}EOF"
# Near misses of A: pipe, redirect, chaining, command after the terminator, a
# \ continuation, $ / backtick / paren in an arg, a second heredoc, wrong script.
both_search_bash_case deny "python3 tool.py <<'EOF' | x${nl}cat memory/x.md${nl}EOF"
both_search_bash_case deny "python3 tool.py <<'EOF' 2>/dev/null${nl}cat memory/x.md${nl}EOF"
both_search_bash_case deny "python3 tool.py <<'EOF' > out${nl}cat memory/x.md${nl}EOF"
both_search_bash_case deny "python3 tool.py <<'EOF'; ls${nl}cat memory/x.md${nl}EOF"
both_search_bash_case deny "python3 tool.py <<'EOF'${nl}harmless${nl}EOF${nl}cat memory/x.md"
both_search_bash_case deny "python3 tool.py <<'EOF'${nl}harmless${nl}EOF; cat memory/x.md"
both_search_bash_case deny "python3 tool.py \\${nl}cat memory/x.md <<'EOF'${nl}harmless${nl}EOF"
both_search_bash_case deny "python3 - \\${nl}cat > /dev/null <<'EOF'${nl}${py}${nl}EOF"
both_search_bash_case deny "python3 tool.py \$HOME <<'EOF'${nl}cat memory/x.md${nl}EOF"
both_search_bash_case deny "python3 tool.py \"\$(ls memory/)\" <<'EOF'${nl}x${nl}EOF"
both_search_bash_case deny "python3 tool.py \`ls memory/\` <<'EOF'${nl}x${nl}EOF"
both_search_bash_case deny "python3 tool.py (x) <<'EOF'${nl}cat memory/x.md${nl}EOF"
both_search_bash_case deny "python3 tool.py <<'A' <<'B'${nl}x${nl}A${nl}cat memory/x.md${nl}B"
both_search_bash_case deny "python3 tool.py <<'EOF'${nl}cat memory/x.md${nl}EOF${nl}x${nl}EOF"
both_search_bash_case deny "python3 - <<'EOF'${nl}${py}${nl}EOF"
both_search_bash_case deny "python3 -c 'x' <<'EOF'${nl}${py}${nl}EOF"
both_search_bash_case deny "python3 -m tool.py <<'EOF'${nl}${py}${nl}EOF"
both_search_bash_case deny "python3 tool.py <<-EOF${nl}${tab}cat memory/x.md${nl}${tab}EOF"
both_search_bash_case deny "python3 tool.py <<EOF${cr}${nl}cat memory/x.md${cr}${nl}EOF${cr}"
both_search_bash_case deny "python3 tool.py <<E\\OF${nl}cat memory/x.md${nl}EOF"
both_search_bash_case deny "python3 tool.py <<EOF'x'${nl}cat memory/x.md${nl}EOFx"
both_search_bash_case deny "python3 tool.py <<tr\"u\"e${nl}cat memory/x.md${nl}true"
both_search_bash_case deny "python3 tool.py <<EOF${nl}cat memory/x.md"
both_search_bash_case deny "python3 tool.py <<EOF${nl}x${nl} EOF${nl}cat memory/x.md"
both_search_bash_case deny "true && python3 x.py <<'EOF'${nl}cat memory/x.md${nl}EOF"
both_search_bash_case deny "! python3 x.py <<'EOF'${nl}cat memory/x.md${nl}EOF"
both_search_bash_case deny "nohup python3 x.py <<'EOF'${nl}cat memory/x.md${nl}EOF"
both_search_bash_case deny "grep foo memory/ <<'EOF'${nl}harmless${nl}EOF"
# Near misses of B.
both_search_bash_case deny "git commit -m \"\$(cat <<'EOF'${nl}x${nl}EOF${nl})\"${nl}cat memory/x.md"
both_search_bash_case deny "git commit -m \"\$(cat <<'EOF'${nl}x${nl}EOF${nl})\"; cat memory/x.md"
both_search_bash_case deny "git commit -m \"\$(cat <<'EOF' | python3${nl}${py}${nl}EOF${nl})\""
both_search_bash_case deny "git commit -m \"\$(cat <<'EOF'${nl}cat memory/x.md${nl}EOF | python3${nl})\""
both_search_bash_case deny "echo \"\$(cat <<'EOF'${nl}x${nl}EOF${nl})\"${nl}ls memory/entries"
both_search_bash_case deny "echo \"\$(cat <<'EOF'${nl}note: ls memory/${nl}EOF${nl})\""
both_search_bash_case deny "git commit -m \"\$(cat <<EOF${nl}cat memory/x.md${nl}EOF${nl})\""
both_search_bash_case deny "git commit -m \"\$(cat <<'EOF'${nl}cat memory/x.md${nl}EOF${nl})\" | x"
both_search_bash_case deny "git commit -m \"\$(cat <<'EOF'${nl}x${nl}EOF${nl})\" \$(ls memory/)"
both_search_bash_case deny "git commit -m \"\$(cat <<'EOF'${nl}cat memory/x.md${nl}EOF${nl})"
both_search_bash_case deny "git commit -F - <<'EOF'${nl}note: ls memory/entries${nl}EOF"
both_search_bash_case deny "gh --version \"\$(cat <<'EOF' | python3${nl}${py}${nl}EOF${nl})\" >/dev/null"
both_search_bash_case deny "echo \"\$(cat <<'EOF' | python3${nl}${py}${nl}EOF${nl})\" >/dev/null; git commit --dry-run -m x; true"
both_search_bash_case deny "eval \"\$(cat <<'EOF'${nl}grep jane memory/${nl}EOF${nl})\""
# Near misses of C.
both_search_bash_case deny "cat > /dev/stdout <<'EOF' | python3${nl}${py}${nl}EOF"
both_search_bash_case deny "cat > /dev/stdout <<'EOF'${nl}cat memory/x.md${nl}EOF"
both_search_bash_case deny "cat > /dev/fd/1 <<'EOF'${nl}cat memory/x.md${nl}EOF"
both_search_bash_case deny "cat > - <<'EOF'${nl}cat memory/x.md${nl}EOF"
both_search_bash_case deny "cat > /dev/stdout <<'EOF' | b\\ash${nl}cat memory/x.md${nl}EOF"
both_search_bash_case deny "cat > /dev/stdout <<'EOF' | 'bash'${nl}cat memory/x.md${nl}EOF"
both_search_bash_case deny "cat <<'EOF' 2>/dev/null | python3${nl}${py}${nl}EOF"
both_search_bash_case deny "cat <<'EOF' > >(python3)${nl}${py}${nl}EOF"
both_search_bash_case deny "cat > notes.md 2>/dev/null <<'EOF'${nl}cat memory/x.md${nl}EOF"
both_search_bash_case deny "cat 2> notes.md <<'EOF'${nl}cat memory/x.md${nl}EOF"
both_search_bash_case deny "cat <<'EOF' > notes.md${nl}cat memory/x.md${nl}EOF"
both_search_bash_case deny "cat <<'EOF'${nl}cat memory/x.md${nl}EOF"
both_search_bash_case deny "cat > s <<'EOF'${nl}cat memory/x.md${nl}EOF${nl}chmod +x s && ./s"
both_search_bash_case deny "cat > s <<'EOF'${nl}${py}${nl}EOF${nl}python3 s"
both_search_bash_case deny "cat > notes.md <<'EOF'${nl}x${nl}EOF${nl}cat memory/x.md"
both_search_bash_case deny "cat > notes.md <<'EOF' && bash notes.md${nl}cat memory/x.md${nl}EOF"
both_search_bash_case deny "cat > \$f <<'EOF'${nl}cat memory/x.md${nl}EOF"
both_search_bash_case deny "cat > notes.md <<EOF${nl}cat memory/x.md${nl}EOF"
both_search_bash_case deny "cat > notes.md <<-'EOF'${nl}${tab}cat memory/x.md${nl}${tab}EOF"
both_search_bash_case deny "cat > notes.md <<'EOF'${nl}x${nl}EOF ${nl}cat memory/x.md"
both_search_bash_case deny "{ cat > f <<'EOF'${nl}cat memory/x.md${nl}EOF${nl}}"
both_search_bash_case deny "tee /dev/stdout <<'EOF' | python3${nl}${py}${nl}EOF"
both_search_bash_case deny "tee /dev/stdout <<'EOF' | sh${nl}cat memory/x.md${nl}EOF"
both_search_bash_case deny "tee >(sh) <<'EOF'${nl}cat memory/x.md${nl}EOF"
both_search_bash_case deny "tee notes.md <<'EOF'${nl}cat memory/x.md${nl}EOF"
# A: the script must be a REPO-RELATIVE path. Some .py files EXECUTE stdin (python's
# own code.py, pdb.py), so an absolute / ~ / .. / hidden path is never data.
cpy="/opt/homebrew/opt/python@3.11/Frameworks/Python.framework/Versions/3.11/lib/python3.11/code.py"
sysos="import os; os.system(\"cat memory/entries/a.md\")"
both_search_bash_case deny "python3 ${cpy} <<'X'${nl}${sysos}${nl}X"
both_search_bash_case deny "python3 /usr/lib/python3.11/pdb.py <<'X'${nl}!import os; os.system('cat memory/entries/a.md')${nl}X"
both_search_bash_case deny "python3 ../../x.py <<'X'${nl}${sysos}${nl}X"
both_search_bash_case deny "python3 ~/x.py <<'X'${nl}${sysos}${nl}X"
both_search_bash_case deny "python3 ./../x.py <<'X'${nl}${sysos}${nl}X"
both_search_bash_case deny "python3 a/../../x.py <<'X'${nl}${sysos}${nl}X"
both_search_bash_case deny "python3 a/../x.py <<'X'${nl}${sysos}${nl}X"
both_search_bash_case deny "python3 a/.. <<'X'${nl}${sysos}${nl}X"
both_search_bash_case deny "python3 ..py <<'X'${nl}${sysos}${nl}X"
both_search_bash_case deny "python3 \$HOME/x.py <<'X'${nl}${sysos}${nl}X"
both_search_bash_case deny "python3 \${HOME}/x.py <<'X'${nl}${sysos}${nl}X"
both_search_bash_case deny "python3 \${PWD}/x.py <<'X'${nl}${sysos}${nl}X"
both_search_bash_case deny "python3 \$PWD/../x.py <<'X'${nl}${sysos}${nl}X"
both_search_bash_case deny "python3 ~root/x.py <<'X'${nl}${sysos}${nl}X"
both_search_bash_case deny "python3 =python3.py <<'X'${nl}${sysos}${nl}X"
both_search_bash_case deny "python3 a=~/x.py <<'X'${nl}${sysos}${nl}X"
both_search_bash_case deny "python3 \"x.py\" <<'X'${nl}${sysos}${nl}X"
both_search_bash_case deny "python3 'x.py' <<'X'${nl}${sysos}${nl}X"
both_search_bash_case deny "python3 \"../x.py\" <<'X'${nl}${sysos}${nl}X"
both_search_bash_case deny "python3 '/abs/x.py' <<'X'${nl}${sysos}${nl}X"
both_search_bash_case deny "python3 x\\.py <<'X'${nl}${sysos}${nl}X"
both_search_bash_case deny "python3 ..\\x.py <<'X'${nl}${sysos}${nl}X"
both_search_bash_case deny "python3 //tmp/x.py <<'X'${nl}${sysos}${nl}X"
both_search_bash_case deny "python3 a//x.py <<'X'${nl}${sysos}${nl}X"
both_search_bash_case deny "python3 .hidden/x.py <<'X'${nl}${sysos}${nl}X"
both_search_bash_case deny "python3 .venv/lib/python3.11/site-packages/x.py <<'X'${nl}${sysos}${nl}X"
both_search_bash_case deny "python3 venv/lib/python3.11/site-packages/x.py <<'X'${nl}${sysos}${nl}X"
both_search_bash_case deny "python3 node_modules/x/y.py <<'X'${nl}${sysos}${nl}X"
both_search_bash_case deny "python3 .git/hooks/x.py <<'X'${nl}${sysos}${nl}X"
both_search_bash_case deny "python3 -x.py <<'X'${nl}${sysos}${nl}X"
both_search_bash_case deny "python3 x*.py <<'X'${nl}${sysos}${nl}X"
both_search_bash_case deny "python3 {a,b}.py <<'X'${nl}${sysos}${nl}X"
both_search_bash_case deny "python3 x.py\$IFS <<'X'${nl}${sysos}${nl}X"
both_search_bash_case deny "python3 é/x.py <<'X'${nl}${sysos}${nl}X"
both_search_bash_case deny "python3 ．．/x.py <<'X'${nl}${sysos}${nl}X"
both_search_bash_case deny "python3 x.py\\ y <<'X'${nl}${sysos}${nl}X"
both_search_bash_case deny "python3 x.pyc <<'X'${nl}${sysos}${nl}X"
both_search_bash_case deny "python3 x <<'X'${nl}${sysos}${nl}X"
# C: the target must be a repo-relative DATA file (.md .txt .csv .log .diff .patch).
# A shell startup file, git hook, script or hook config runs later on its own.
both_search_bash_case deny "cat > ~/.zshenv <<'X'${nl}${sysos}${nl}X"
both_search_bash_case deny "cat > .git/hooks/commit-msg <<'X'${nl}cat memory/entries/a.md${nl}X"
both_search_bash_case deny "cat > ~/notes.md <<'X'${nl}cat memory/entries/a.md${nl}X"
both_search_bash_case deny "cat > /tmp/notes.md <<'X'${nl}cat memory/entries/a.md${nl}X"
both_search_bash_case deny "cat > \$HOME/notes.md <<'X'${nl}cat memory/entries/a.md${nl}X"
both_search_bash_case deny "cat > \${PWD}/notes.md <<'X'${nl}cat memory/entries/a.md${nl}X"
both_search_bash_case deny "cat > ../notes.md <<'X'${nl}cat memory/entries/a.md${nl}X"
both_search_bash_case deny "cat > ./../notes.md <<'X'${nl}cat memory/entries/a.md${nl}X"
both_search_bash_case deny "cat > a/../../notes.md <<'X'${nl}cat memory/entries/a.md${nl}X"
both_search_bash_case deny "cat > a/.git/notes.md <<'X'${nl}cat memory/entries/a.md${nl}X"
both_search_bash_case deny "cat > .git/notes.md <<'X'${nl}cat memory/entries/a.md${nl}X"
both_search_bash_case deny "cat > .claude/settings.md <<'X'${nl}cat memory/entries/a.md${nl}X"
both_search_bash_case deny "cat > .zshenv <<'X'${nl}cat memory/entries/a.md${nl}X"
both_search_bash_case deny "cat > .envrc <<'X'${nl}cat memory/entries/a.md${nl}X"
both_search_bash_case deny "cat > .husky/pre-commit <<'X'${nl}cat memory/entries/a.md${nl}X"
both_search_bash_case deny "cat > .md <<'X'${nl}cat memory/entries/a.md${nl}X"
both_search_bash_case deny "cat > run.sh <<'X'${nl}cat memory/entries/a.md${nl}X"
both_search_bash_case deny "cat > run.py <<'X'${nl}cat memory/entries/a.md${nl}X"
both_search_bash_case deny "cat > package.json <<'X'${nl}cat memory/entries/a.md${nl}X"
both_search_bash_case deny "cat > Makefile <<'X'${nl}cat memory/entries/a.md${nl}X"
both_search_bash_case deny "cat > notes <<'X'${nl}cat memory/entries/a.md${nl}X"
both_search_bash_case deny "cat > notes.md.sh <<'X'${nl}cat memory/entries/a.md${nl}X"
both_search_bash_case deny "cat > \"notes.md\" <<'X'${nl}cat memory/entries/a.md${nl}X"
both_search_bash_case deny "cat > 'notes.md' <<'X'${nl}cat memory/entries/a.md${nl}X"
both_search_bash_case deny "cat > =x.md <<'X'${nl}cat memory/entries/a.md${nl}X"
both_search_bash_case deny "cat > a=~/x.md <<'X'${nl}cat memory/entries/a.md${nl}X"
both_search_bash_case deny "cat > ~root/x.md <<'X'${nl}cat memory/entries/a.md${nl}X"
both_search_bash_case deny "cat > a\\ b.md <<'X'${nl}cat memory/entries/a.md${nl}X"
both_search_bash_case deny "cat > a//b.md <<'X'${nl}cat memory/entries/a.md${nl}X"
both_search_bash_case deny "cat > é.md <<'X'${nl}cat memory/entries/a.md${nl}X"
both_search_bash_case deny "cat > x.md\$IFS <<'X'${nl}cat memory/entries/a.md${nl}X"
both_search_bash_case deny "cat >> ~/.zshrc <<'X'${nl}cat memory/entries/a.md${nl}X"
both_search_bash_case deny "cat >> ~/.bashrc <<'X'${nl}cat memory/entries/a.md${nl}X"
# Bodies that are CODE or PATH LISTS, and constructs the old scanner mishandled.
both_search_bash_case deny "bash <<'EOF'${nl}grep -rn jane memory/${nl}EOF"
both_search_bash_case deny "sh <<EOF${nl}cat memory/entries/x.md${nl}EOF"
both_search_bash_case deny "zsh <<EOF${nl}cat memory/entries/x.md${nl}EOF"
both_search_bash_case deny "python3 - <<'EOF'${nl}import subprocess; subprocess.run('grep -r jane memory/', shell=True)${nl}EOF"
both_search_bash_case deny "node <<'EOF'${nl}require('child_process').execSync('cat memory/x.md')${nl}EOF"
both_search_bash_case deny "perl <<'EOF'${nl}system('cat memory/x.md')${nl}EOF"
both_search_bash_case deny "source /dev/stdin <<'EOF'${nl}cat memory/x.md${nl}EOF"
both_search_bash_case deny ". /dev/stdin <<'EOF'${nl}cat memory/x.md${nl}EOF"
both_search_bash_case deny "xargs cat <<'EOF'${nl}memory/entries/a.md${nl}EOF"
both_search_bash_case deny "while read f; do cat \"\$f\"; done <<'EOF'${nl}memory/entries/a.md${nl}EOF"
both_search_bash_case deny "cat <<'EOF' | bash${nl}cat memory/x.md${nl}EOF"
both_search_bash_case deny "echo \${x:-<<true }${nl}cat memory/x.md${nl}true"
both_search_bash_case deny "echo \$[1<<X]${nl}cat memory/x.md${nl}X]"
both_search_bash_case deny "echo \$'\\' <<EOF '\\'${nl}cat memory/x.md${nl}EOF"
both_search_bash_case deny "echo \$'\\'${nl}cat > f <<EOF '\\'${nl}cat memory/x.md${nl}EOF"
both_search_bash_case deny "echo \${x:-${nl}cat > f <<EOF }${nl}cat memory/x.md${nl}EOF"
both_search_bash_case deny "echo \"${nl}cat > f <<EOF \"${nl}cat memory/x.md${nl}EOF"
both_search_bash_case deny "(echo hi)#<<EOF${nl}cat memory/x.md${nl}EOF"
both_search_bash_case deny "{ echo; }#<<EOF${nl}cat memory/x.md${nl}EOF"
both_search_bash_case deny "x=\$(cat <<EOF${nl}hi${nl}EOF)${nl}cat memory/x.md${nl}EOF"
both_search_bash_case deny "echo \"\$(case a in a) echo \" <<EOF \";; esac)\"${nl}cat memory/x.md${nl}EOF"
both_search_bash_case deny "echo \`cat <<EOF${nl}x${nl}EOF${nl}\`${nl}cat memory/x.md"
both_search_bash_case deny "bash -c \"cat <<EOF${nl}x${nl}EOF${nl}cat memory/x.md\""
both_search_bash_case deny "cat <<EOF${cr}${nl}x${cr}${nl}EOF${cr}${nl}cat memory/x.md"
both_search_bash_case deny "cat <<EOF${nl}x${nl}EOF ${nl}cat memory/x.md"
both_search_bash_case deny "cat <<-EOF${nl}x${nl}  EOF${nl}cat memory/x.md"
both_search_bash_case deny "cat memory/x.md; true <<'EOF'${nl}x${nl}EOF"
both_search_bash_case deny "cat <<A${nl}x${nl}A${nl}ls memory/${nl}cat <<B${nl}y${nl}B"
# Lookalikes: here-strings are command-line words, << in quotes/comments/arithmetic
# is not a heredoc; none may hide a later command.
both_search_bash_case deny "cat <<<EOF${nl}cat memory/x.md"
both_search_bash_case deny "cat <<< memory/x.md"
both_search_bash_case deny "grep -rn jane <<< memory/"
both_search_bash_case deny "echo \"<<EOF\"${nl}cat memory/x.md${nl}EOF"
both_search_bash_case deny "echo '<<EOF'${nl}cat memory/x.md${nl}EOF"
both_search_bash_case deny "echo \$((1<<EOF))${nl}cat memory/x.md${nl}EOF"
both_search_bash_case deny "echo hi # <<EOF${nl}cat memory/x.md${nl}EOF"

echo
echo "== search guard: Grep/Glob scoping =="
grep_case deny  'jane doe' ''                  # unscoped sweeps the store
grep_case deny  'jane doe' '.'
grep_case deny  'jane'        'memory'
grep_case deny  'jane'        'memory/entries'
grep_case deny  'jane'        './memory-graphs'
grep_case deny  'jane'        '/Users/x/personal-memory/memory/entries'
grep_case deny  'jane'        'src' 'memory/**/*.md'
grep_case allow 'chain'       'src'
grep_case allow 'chain'       'src/ui'
grep_case allow 'memory leak' 'src'                # pattern is not inspected
grep_case allow 'recall'      'skills'

echo
echo "== write guard: unchanged behaviour =="
write_file_case deny  'memory/entries/2026-08-01-foo.md'
write_file_case deny  'memory-graphs/team-x/entries/foo.md'
write_file_case allow 'memory/summaries/summary-jane.md'
write_file_case allow 'src/recall.ts'
write_bash_case deny  'echo hi > memory/entries/foo.md'
write_bash_case allow 'npx tsx src/cli.ts add --title "x" --type note --body "y"'

echo
echo "== write guard: the golden set is CLI-only =="
write_file_case deny  'memory/eval/golden.json'
write_file_case deny  '/Users/x/personal-memory/memory/eval/baseline.json'
write_bash_case deny  'echo "{}" > memory/eval/golden.json'
write_bash_case deny  'cp golden.json memory/eval/golden.json'
write_bash_case allow 'npx tsx src/cli.ts eval add-golden "where did we land" --expect 2026-01-01-x'
write_bash_case allow 'npx tsx src/cli.ts eval run --compare'
# people profiles are private config, like connectors: editable, never entries
write_file_case allow 'memory/people/jane-doe.md'
write_bash_case allow 'npx tsx src/cli.ts people alias jane-doe --add "Jane"'
bash_case deny 'cat memory/people/jane-doe.md'

echo
echo "== guards must fail CLOSED without jq (sandboxed/mounted VM images) =="
# A hook that exits non-zero is a NON-BLOCKING error: Claude Code logs it and
# runs the tool anyway. So a missing dependency must never turn into "allow".
nojq_bin="$(mktemp -d)/bin"
mkdir -p "$nojq_bin"
for b in bash awk cat printf sed grep head; do
  src="$(command -v "$b" 2>/dev/null)" && ln -sf "$src" "$nojq_bin/$b"
done

# nojq_case <deny|allow> <guard> <label> <payload>
nojq_case() {
  local want="$1" guard="$2" label="$3" payload="$4" out got
  checks=$((checks + 1))
  out="$(printf '%s' "$payload" | env -i PATH="$nojq_bin" bash "$guard" 2>/dev/null)"
  case "$out" in
    *'"permissionDecision":"deny"'*) got=deny ;;
    *) got=allow ;;
  esac
  if [ "$got" != "$want" ]; then
    printf '  ✗ %s\n      want %s, got %s\n' "$label" "$want" "$got"
    failures=$((failures + 1))
  else
    printf '  ✓ %s (%s)\n' "$label" "$got"
  fi
}

nojq_case deny "$search_guard" "no-jq: grep -rli 'jane doe' ." \
  '{"tool_name":"Bash","tool_input":{"command":"grep -rli \"jane doe\" ."}}'
nojq_case deny "$search_guard" "no-jq: cat memory/entries/x.md" \
  '{"tool_name":"Bash","tool_input":{"command":"cat memory/entries/x.md"}}'
nojq_case deny "$search_guard" "no-jq: Grep unscoped" \
  '{"tool_name":"Grep","tool_input":{"pattern":"jane","path":""}}'
nojq_case allow "$search_guard" "no-jq: cli.ts recall" \
  '{"tool_name":"Bash","tool_input":{"command":"npx tsx src/cli.ts recall \"jane\""}}'
nojq_case allow "$search_guard" "no-jq: grep -rn chain src/" \
  '{"tool_name":"Bash","tool_input":{"command":"grep -rn chain src/"}}'
nojq_case deny "$write_guard" "no-jq: Write memory/entries/x.md" \
  '{"tool_name":"Write","tool_input":{"file_path":"memory/entries/x.md"}}'
nojq_case allow "$write_guard" "no-jq: Write src/foo.ts" \
  '{"tool_name":"Write","tool_input":{"file_path":"src/foo.ts"}}'

rm -rf "$(dirname "$nojq_bin")"

echo
if [ "$failures" -ne 0 ]; then
  printf 'memory-guards: %d/%d checks FAILED\n' "$failures" "$checks"
  exit 1
fi
printf 'memory-guards: all %d checks passed\n' "$checks"
