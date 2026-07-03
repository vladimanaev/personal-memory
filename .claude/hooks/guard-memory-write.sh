#!/usr/bin/env bash
# PreToolUse guard for Write/Edit/NotebookEdit/Bash in the personal-memory repo.
#
# Memory entries MUST be created/updated through `npx tsx src/cli.ts add` —
# never hand-written. A manual file under memory/entries/ skips index sync,
# source-id dedup, the near-dup guard, and the auto-commit hook, leaving an
# entry invisible to recall and unversioned. Same for .index/ (rebuildable
# derivative, never hand-edited). Full contract: MEMORY-GUARDRAILS.md.
#
# Allowed and untouched by this guard: memory/summaries/ (Synthesis prose after
# `digest`) and memory/connectors/ (private overrides).

input="$(cat)"

tool="$(printf '%s' "$input" | jq -r '.tool_name // ""')"

deny() {
  cat <<JSON
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Never write memory entries or .index/ by hand — a manual file skips index sync, dedup, the near-dup guard, and auto-commit (see MEMORY-GUARDRAILS.md). Capture/update via the CLI instead:\n  npx tsx src/cli.ts add --title … --type … [--people …] [--source-ids …] --body \"…\"\n  (same --source-ids updates in place; manual notes: add --update <id>)\nmemory/summaries/ (Synthesis section) and memory/connectors/ stay editable."}}
JSON
  exit 0
}

case "$tool" in
  Write|Edit|NotebookEdit)
    file_path="$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.notebook_path // ""')"
    case "$file_path" in
      *memory/entries/*|*.index/*) deny ;;
    esac
    ;;
  Bash)
    cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // ""')"
    # Only deny commands that reference the protected paths AND look like a
    # write (redirect/copy/move/delete/in-place edit). Plain reads pass, and
    # `cli.ts add` never mentions memory/entries at all.
    case "$cmd" in
      *memory/entries*|*.index/*)
        case "$cmd" in
          *'>'*|*'tee '*|*'cp '*|*'mv '*|*'rm '*|*'sed -i'*|*'touch '*|*'truncate '*|*'dd '*) deny ;;
        esac
        ;;
    esac
    ;;
esac

# Anything else passes: emit nothing, exit 0.
exit 0
