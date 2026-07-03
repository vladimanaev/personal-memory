#!/usr/bin/env bash
# Codex PreToolUse guard for memory-store discovery.
#
# Recall must go through the hybrid memory CLI, not ad hoc file search. This
# blocks searches that explicitly target memory/ or .index/, plus no-ignore root
# searches that would bypass the repo's gitignore and sweep private memory data.

set -euo pipefail

input="$(cat)"

json_get() {
  node -e '
const data = JSON.parse(process.argv[1] || "{}");
const paths = process.argv.slice(2);
for (const path of paths) {
  let cur = data;
  for (const key of path.split(".")) cur = cur == null ? undefined : cur[key];
  if (typeof cur === "string") {
    process.stdout.write(cur);
    process.exit(0);
  }
}
' "$input" "$@"
}

command="$(json_get tool_input.command tool_input.cmd command cmd || true)"

deny() {
  cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Do not search the memory store with rg/grep/find. Recall via the CLI instead:\n  npx tsx src/cli.ts query \"<question>\" [\"<alt phrasing>\"] [--person X] [--type Y] [--since DATE] [--deep]\n  npx tsx src/cli.ts person <slug>\n  npx tsx src/cli.ts list [filters]\nThen read only the specific files cited by query results."}}
JSON
  exit 0
}

case "$command" in
  *src/cli.ts\ query*|*src/cli.ts\ person*|*src/cli.ts\ list*) exit 0 ;;
esac

case "$command" in
  *'rg '*|rg\ *|*'grep '*|grep\ *|*'fd '*|fd\ *|*'find '*|find\ *|*'ag '*|ag\ *|*'ack '*|ack\ *)
    case "$command" in
      *memory/*|*./memory*|*' memory '*|*.index/*|*.index*) deny ;;
    esac
    case "$command" in
      *rg*--no-ignore*|*rg*\ -uuu*|*rg*\ -uu*|*rg*\ -u*)
        case "$command" in
          *' src/'*|*' ./src/'*|*' connectors/'*|*' ./connectors/'*|*' skills/'*|*' ./skills/'*|*' .claude/'*|*' .codex/'*|*' .agents/'*) ;;
          *) deny ;;
        esac
        ;;
    esac
    ;;
esac

exit 0
