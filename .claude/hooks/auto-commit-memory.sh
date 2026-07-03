#!/usr/bin/env bash
# PostToolUse hook: auto-commit a memory entry after the memory CLI's `add`
# command runs. Keeps raw entries versioned with no manual commit step.
#
# Entries are versioned in the NESTED git repo at memory/.git (local-only,
# never pushed). The parent repo gitignores memory/ entirely so personal data
# and commit subjects never reach a remote. Reads the hook payload (JSON) on
# stdin, acts only when the Bash command was a `cli.ts add` (i.e. a memory
# log), then stages + commits the new/changed Markdown inside memory/.
set -euo pipefail

input="$(cat)"
cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // ""')"

# Only act on memory-log commands; ignore every other Bash call.
case "$cmd" in
  *cli.ts\ add*) ;;
  *) exit 0 ;;
esac

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0

# The nested memory repo must exist; never fall back to the parent repo.
[ -d memory/.git ] || exit 0

# Stage everything in the nested repo (paths are relative to memory/).
git -C memory add -A . 2>/dev/null || exit 0

# Nothing staged → nothing to commit.
if git -C memory diff --cached --quiet 2>/dev/null; then
  exit 0
fi

# Derive a message from the title of the newest staged entry, if any.
newest="$(git -C memory diff --cached --name-only 2>/dev/null | grep -E '^entries/.*\.md$' | head -n1)"
title=""
if [ -n "$newest" ] && [ -f "memory/$newest" ]; then
  title="$(sed -n 's/^title:[[:space:]]*//p' "memory/$newest" | head -n1 | sed "s/^[\"']//; s/[\"']$//")"
fi
msg="Log memory: ${title:-entry update}"

git -C memory commit -q \
  -m "$msg" \
  -m "Auto-committed by PostToolUse hook after \`cli.ts add\`." \
  >/dev/null 2>&1 || true
