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

# write_file_case <deny|allow> <file_path>
write_file_case() {
  local want="$1" file="$2"
  expect "$want" "$write_guard" "write/edit: $file" \
    "$(jq -nc --arg f "$file" '{tool_name:"Write",tool_input:{file_path:$f}}')"
}

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
