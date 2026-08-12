#!/usr/bin/env bash
# Codex PreToolUse guard for the personal-memory repo.
#
# Memory entries must be created, updated, or deleted through the memory CLI so
# index sync, dedup, near-duplicate detection, and nested git checkpointing run.
# This is additive Codex support; the existing Claude Code hooks remain intact.

# NOTE: deliberately no `set -e`. A hook that exits non-zero is a NON-BLOCKING
# error — the harness logs it and runs the tool anyway — so an internal failure
# must never abort this script before it reaches a decision. That is also why
# field extraction does not depend on `node` alone: in a minimal image the guard
# would otherwise silently ALLOW every write.
set -uo pipefail

input="$(cat)"

# Leaf-key scan: finds "key":"value" anywhere in the payload.
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

json_get() {
  local out p
  if command -v node >/dev/null 2>&1; then
    out="$(node -e '
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
' "$input" "$@" 2>/dev/null)"
    [ -n "$out" ] && { printf '%s' "$out"; return; }
  fi
  for p in "$@"; do
    out="$(raw_field "${p##*.}")"
    [ -n "$out" ] && { printf '%s' "$out"; return; }
  done
}

tool="$(json_get tool_name toolName name || true)"
tool_input="$(json_get tool_input input arguments || true)"
file_path="$(json_get tool_input.file_path tool_input.notebook_path tool_input.path file_path path || true)"
command="$(json_get tool_input.command tool_input.cmd command cmd || true)"
# Extraction failed outright → match the raw payload rather than allowing.
[ -n "$file_path" ] || file_path="$input"
[ -n "$command" ] || command="$input"

deny() {
  cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Never write memory entries or .index/ by hand — covers BOTH stores (memory/ and memory-public/). Capture/update via the CLI instead:\n  npx tsx src/cli.ts add --title ... --type ... [--graph public|private] [--people ...] [--source-ids ...] --body \"...\"\nDelete via:\n  npx tsx src/cli.ts remove <id>\nReclassify via:\n  npx tsx src/cli.ts move <id> --to <graph>\nmemory/summaries/ Synthesis, memory/connectors/, and memory/routing/ overrides remain editable."}}
JSON
  exit 0
}

is_protected_path() {
  case "$1" in
    *memory/entries/*|memory/entries/*|./memory/entries/*) return 0 ;;
    *memory-public/entries/*|memory-public/entries/*|./memory-public/entries/*) return 0 ;;
    *memory-graphs/*/entries/*|memory-graphs/*/entries/*|./memory-graphs/*/entries/*) return 0 ;;
    *.index/*|.index/*|./.index/*) return 0 ;;
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
      *memory/entries*|*memory-public/entries*|*memory-graphs/*/entries*|*.index/*|*.index*)
        case "$command" in
          *'>'*|*'tee '*|*'cp '*|*'mv '*|*'rm '*|*'sed -i'*|*'perl -pi'*|*'touch '*|*'truncate '*|*'dd '*|*'install '*|*'python '*|*'node '*) deny ;;
        esac
        ;;
    esac
    ;;
esac

exit 0
