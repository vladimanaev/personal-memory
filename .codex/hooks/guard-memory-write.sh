#!/usr/bin/env bash
# Codex PreToolUse guard for the personal-memory repo.
#
# Memory entries must be created, updated, or deleted through the memory CLI so
# index sync, dedup, near-duplicate detection, and nested git checkpointing run.
# This is additive Codex support; the existing Claude Code hooks remain intact.

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

tool="$(json_get tool_name toolName name || true)"
tool_input="$(json_get tool_input input arguments || true)"
file_path="$(json_get tool_input.file_path tool_input.notebook_path tool_input.path file_path path || true)"
command="$(json_get tool_input.command tool_input.cmd command cmd || true)"

deny() {
  cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Never write memory entries or .index/ by hand. Capture/update via the CLI instead:\n  npx tsx src/cli.ts add --title ... --type ... [--people ...] [--source-ids ...] --body \"...\"\nDelete via:\n  npx tsx src/cli.ts remove <id>\nmemory/summaries/ Synthesis and memory/connectors/ overrides remain editable."}}
JSON
  exit 0
}

is_protected_path() {
  case "$1" in
    *memory/entries/*|memory/entries/*|./memory/entries/*|*.index/*|.index/*|./.index/*) return 0 ;;
    *) return 1 ;;
  esac
}

case "$tool" in
  Write|Edit|NotebookEdit)
    if is_protected_path "$file_path"; then
      deny
    fi
    ;;
  apply_patch|Edit|Write)
    while IFS= read -r line; do
      case "$line" in
        "*** Add File: "*|"*** Update File: "*|"*** Delete File: "*)
          path="${line#*** Add File: }"
          path="${path#*** Update File: }"
          path="${path#*** Delete File: }"
          if is_protected_path "$path"; then
            deny
          fi
          ;;
      esac
    done <<<"$tool_input"
    ;;
  Bash)
    case "$command" in
      *cli.ts\ add*|*src/cli.ts\ remove*) exit 0 ;;
    esac
    case "$command" in
      *memory/entries*|*.index/*|*.index*)
        case "$command" in
          *'>'*|*'tee '*|*'cp '*|*'mv '*|*'rm '*|*'sed -i'*|*'perl -pi'*|*'touch '*|*'truncate '*|*'dd '*|*'install '*|*'python '*|*'node '*) deny ;;
        esac
        ;;
    esac
    ;;
esac

exit 0
