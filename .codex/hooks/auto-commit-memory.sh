#!/usr/bin/env bash
# Codex PostToolUse hook: auto-commit nested memory repo after memory CLI add.
#
# Mirrors the existing Claude Code behavior without changing any existing files.

set -euo pipefail

input="$(cat)"

command="$(node -e '
const data = JSON.parse(process.argv[1] || "{}");
const candidates = [
  data.tool_input && data.tool_input.command,
  data.tool_input && data.tool_input.cmd,
  data.command,
  data.cmd,
];
for (const value of candidates) {
  if (typeof value === "string") {
    process.stdout.write(value);
    process.exit(0);
  }
}
' "$input")"

case "$command" in
  *cli.ts\ add*) ;;
  *) exit 0 ;;
esac

root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$root" || exit 0

[ -d memory/.git ] || exit 0

git -C memory add -A . 2>/dev/null || exit 0

if git -C memory diff --cached --quiet 2>/dev/null; then
  exit 0
fi

newest="$(git -C memory diff --cached --name-only 2>/dev/null | grep -E '^entries/.*\.md$' | head -n1 || true)"
title=""
if [ -n "$newest" ] && [ -f "memory/$newest" ]; then
  title="$(sed -n 's/^title:[[:space:]]*//p' "memory/$newest" | head -n1 | sed "s/^[\"']//; s/[\"']$//")"
fi

git -C memory commit -q \
  -m "Log memory: ${title:-entry update}" \
  -m "Auto-committed by Codex PostToolUse hook after \`cli.ts add\`." \
  >/dev/null 2>&1 || true
