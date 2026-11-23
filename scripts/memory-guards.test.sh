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
echo "== search guard: heredoc bodies are stripped only for data consumers =="
nl=$'\n'; tab=$'\t'; cr=$'\r'
# The false positive: prose in a heredoc body that merely mentions a store.
both_search_bash_case allow "python3 tool.py msg x <<'EOF'${nl}Blocked: could not cat memory/people/a.md or ls memory-graphs/${nl}EOF"
both_search_bash_case allow "python3 tool.py msg x <<EOF${nl}cat memory/people/a.md${nl}EOF"
both_search_bash_case allow "python3 tool.py msg x <<\"EOF\"${nl}grep -rli jane .${nl}EOF"
both_search_bash_case allow "python scripts/tool.py <<'EOF'${nl}ls memory/entries${nl}EOF"
both_search_bash_case allow "cat > notes.md <<'EOF'${nl}see cat memory/x.md and ls memory-graphs/${nl}EOF"
both_search_bash_case allow "cat > notes.md <<-EOF${nl}${tab}cat memory/x.md${nl}${tab}EOF"
both_search_bash_case allow "cat >> notes.md <<A${nl}ls memory/${nl}A"
both_search_bash_case allow "cat <<'A' > notes.md <<'B'${nl}ls memory/${nl}A${nl}find memory/ -name x${nl}B"
both_search_bash_case allow "tee notes.md <<'EOF'${nl}cat memory/x.md${nl}EOF"
both_search_bash_case allow "git commit -F - <<'EOF'${nl}note: ls memory/entries${nl}EOF"
both_search_bash_case allow "git commit --file=- <<'EOF'${nl}note: ls memory/entries${nl}EOF"
both_search_bash_case allow "gh pr create --body-file - <<'EOF'${nl}note: ls memory/entries${nl}EOF"
both_search_bash_case allow "gh issue comment 1 -F - <<'EOF'${nl}note: ls memory/entries${nl}EOF"
both_search_bash_case allow "git commit -m \"\$(cat <<'EOF'${nl}note: ls memory/entries${nl}EOF${nl})\""
both_search_bash_case allow "gh pr create --body \"\$(cat <<'EOF'${nl}note: ls memory/entries${nl}EOF${nl})\""
# A real search is still denied around an allowed heredoc: on the command line,
# before it, after the terminator, between two heredocs, or after a $( ) heredoc.
both_search_bash_case deny "grep foo memory/ <<'EOF'${nl}harmless${nl}EOF"
both_search_bash_case deny "cat memory/x.md > out.md <<'EOF'${nl}harmless${nl}EOF"
both_search_bash_case deny "python3 tool.py <<'EOF'${nl}harmless${nl}EOF${nl}cat memory/x.md"
both_search_bash_case deny "cat > a.md <<A${nl}one${nl}A${nl}ls memory/${nl}cat > b.md <<B${nl}two${nl}B"
both_search_bash_case deny "echo \"\$(cat <<'EOF'${nl}x${nl}EOF${nl})\"${nl}ls memory/entries"
both_search_bash_case deny "git commit -m \"\$(cat <<'EOF'${nl}x${nl}EOF${nl})\"${nl}cat memory/x.md"
both_search_bash_case deny "cat > a.md <<-EOF${nl}x${nl}EOF${nl}cat memory/x.md"
# A heredoc body can be CODE or a LIST OF PATHS: unless the owning command only
# stores or forwards text, the body stays matched.
both_search_bash_case deny "bash <<'EOF'${nl}grep -rn jane memory/${nl}EOF"
both_search_bash_case deny "sh <<EOF${nl}cat memory/entries/x.md${nl}EOF"
both_search_bash_case deny "zsh <<EOF${nl}cat memory/entries/x.md${nl}EOF"
both_search_bash_case deny "python3 - <<'EOF'${nl}import subprocess; subprocess.run('grep -r jane memory/', shell=True)${nl}EOF"
both_search_bash_case deny "python3 -c 'import sys; exec(sys.stdin.read())' <<'EOF'${nl}import os; os.system('cat memory/x.md')${nl}EOF"
both_search_bash_case deny "node <<'EOF'${nl}require('child_process').execSync('cat memory/x.md')${nl}EOF"
both_search_bash_case deny "perl <<'EOF'${nl}system('cat memory/x.md')${nl}EOF"
both_search_bash_case deny "eval \"\$(cat <<'EOF'${nl}grep jane memory/${nl}EOF${nl})\""
both_search_bash_case deny "source /dev/stdin <<'EOF'${nl}cat memory/x.md${nl}EOF"
both_search_bash_case deny ". /dev/stdin <<'EOF'${nl}cat memory/x.md${nl}EOF"
both_search_bash_case deny "xargs cat <<'EOF'${nl}memory/entries/a.md${nl}EOF"
both_search_bash_case deny "while read f; do cat \"\$f\"; done <<'EOF'${nl}memory/entries/a.md${nl}EOF"
both_search_bash_case deny "cat <<'EOF' | bash${nl}cat memory/x.md${nl}EOF"
both_search_bash_case deny "cat <<'EOF'${nl}cat memory/x.md${nl}EOF"
both_search_bash_case deny "python3 tool.py <<'EOF' | xargs cat${nl}memory/entries/a.md${nl}EOF"
both_search_bash_case deny "cat > a.md <<'EOF' && bash a.md${nl}cat memory/x.md${nl}EOF"
# An unusual delimiter or any construct the scanner cannot judge: strip nothing.
both_search_bash_case deny "cat > a.md <<tr\"u\"e${nl}x${nl}true${nl}cat memory/x.md${nl}tr\"u\"e"
both_search_bash_case deny "cat > a.md <<EOF'x'${nl}b${nl}EOFx${nl}cat memory/x.md${nl}EOF'x'"
both_search_bash_case deny "cat > a.md <<E\\OF${nl}b${nl}EOF${nl}cat memory/x.md${nl}E\\OF"
both_search_bash_case deny "cat > a.md <<\\EOF${nl}cat memory/x.md${nl}EOF"
both_search_bash_case deny "cat > a.md <<EOF${cr}${nl}x${cr}${nl}EOF${cr}${nl}cat memory/x.md"
both_search_bash_case deny "echo \${x:-<<true }${nl}cat memory/x.md${nl}true"
both_search_bash_case deny "echo \$[1<<X]${nl}cat memory/x.md${nl}X]"
both_search_bash_case deny "echo \$'\\' <<EOF '\\'${nl}cat memory/x.md${nl}EOF"
both_search_bash_case deny "(echo hi)#<<EOF${nl}cat memory/x.md${nl}EOF"
both_search_bash_case deny "{ echo; }#<<EOF${nl}cat memory/x.md${nl}EOF"
both_search_bash_case deny "x=\$(cat > a.md <<EOF${nl}hi${nl}EOF)${nl}cat memory/x.md${nl}EOF"
both_search_bash_case deny "echo \"\$(case a in a) echo \" <<EOF \";; esac)\"${nl}cat memory/x.md${nl}EOF"
both_search_bash_case deny "echo \`cat > a.md <<EOF${nl}x${nl}EOF${nl}\`${nl}cat memory/x.md"
both_search_bash_case deny "bash -c \"cat > a.md <<EOF${nl}x${nl}EOF${nl}cat memory/x.md\""
# Terminators must match exactly (<<- strips tabs only; plain << strips nothing),
# and an UNTERMINATED heredoc keeps its body in the matched text.
both_search_bash_case deny "cat > a.md <<EOF${nl}x${nl} EOF${nl}cat memory/x.md"
both_search_bash_case deny "cat > a.md <<EOF${nl}x${nl}EOF ${nl}cat memory/x.md"
both_search_bash_case deny "cat > a.md <<EOF${nl}x${nl}${tab}EOF${nl}cat memory/x.md"
both_search_bash_case deny "cat > a.md <<-EOF${nl}x${nl}  EOF${nl}cat memory/x.md"
both_search_bash_case deny "cat > a.md <<EOF${nl}cat memory/x.md"
# Things that look like heredocs but are not must not hide a later command.
both_search_bash_case deny "cat <<<EOF${nl}cat memory/x.md"
both_search_bash_case deny "echo \"<<EOF\"${nl}cat memory/x.md${nl}EOF"
both_search_bash_case deny "echo '<<EOF'${nl}cat memory/x.md${nl}EOF"
both_search_bash_case deny "echo \$((1<<EOF))${nl}cat memory/x.md${nl}EOF"
both_search_bash_case deny "echo hi # <<EOF${nl}cat memory/x.md${nl}EOF"
# A here-string is a command-line word, not a body: still matched.
both_search_bash_case deny "cat <<< memory/x.md"
both_search_bash_case deny "grep -rn jane <<< memory/"
# Heredoc text never opens the sanctioned-CLI pass-through.
both_search_bash_case deny "cat memory/x.md > out.md <<'EOF'${nl}see src/cli.ts${nl}EOF"

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
