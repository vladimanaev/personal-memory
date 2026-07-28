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

# Every store is checked (not parsed from --graph: a source-id match or a
# distribution rule can direct the write anywhere), and each commits into its
# own nested repo. Never fall back to the parent repo. The unmatched-glob
# literal `memory-graphs/*/` is absorbed by the .git guard below.
for store in memory memory-public memory-graphs/*/; do
  store="${store%/}"
  [ -d "$store/.git" ] || continue

  # Stage everything in the nested repo (paths are relative to the store).
  git -C "$store" add -A . 2>/dev/null || continue

  # Nothing staged → nothing to commit.
  if git -C "$store" diff --cached --quiet 2>/dev/null; then
    continue
  fi

  # Derive a message from the title of the newest staged entry, if any.
  newest="$(git -C "$store" diff --cached --name-only 2>/dev/null | grep -E '^entries/.*\.md$' | head -n1)"
  title=""
  if [ -n "$newest" ] && [ -f "$store/$newest" ]; then
    title="$(sed -n 's/^title:[[:space:]]*//p' "$store/$newest" | head -n1 | sed "s/^[\"']//; s/[\"']$//")"
  fi
  msg="Log memory: ${title:-entry update}"

  git -C "$store" commit -q \
    -m "$msg" \
    -m "Auto-committed by PostToolUse hook after \`cli.ts add\`." \
    >/dev/null 2>&1 || true
done
