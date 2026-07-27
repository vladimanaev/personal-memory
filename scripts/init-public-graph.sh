#!/usr/bin/env bash
# One-time (idempotent) migration: stand up the PUBLIC memory graph.
#
# The private graph is the existing memory/ store — the split touches ZERO
# existing entry files; every pre-split memory is private purely by location.
# This script only:
#   1. checkpoints the private nested repo (safety),
#   2. creates memory-public/ with its own nested git repo + README,
#   3. rebuilds the search index (INDEX_VERSION bump adds the graph column).
#
# A verified tarball backup of memory/ (including memory/.git) should exist
# BEFORE running this — see MEMORY-GUARDRAILS.md.
set -euo pipefail

cd "$(dirname "$0")/.."

# 1. Checkpoint the private store (skip cleanly if nothing to commit).
if [ -d memory/.git ]; then
  git -C memory add -A .
  if ! git -C memory diff --cached --quiet; then
    git -C memory commit -q -m "Checkpoint before graph split"
    echo "✓ checkpointed memory/.git"
  else
    echo "✓ memory/.git already clean"
  fi
else
  echo "✗ memory/.git missing — refusing to continue" >&2
  exit 1
fi

# 2. Public store: dirs + nested repo + README (all idempotent).
mkdir -p memory-public/entries memory-public/summaries
if [ ! -d memory-public/.git ]; then
  git -C memory-public init -q
  echo "✓ initialized memory-public/.git"
fi
if [ ! -f memory-public/README.md ]; then
  cat > memory-public/README.md <<'EOF'
# memory-public

Shareable memory graph — the public half of a personal-memory store. Every
entry in this repo was deliberately routed here as safe to share; it must
never reference anything in the private graph (not even by id).

The search index is a derived artifact and is never stored here; rebuild it
from these Markdown files with `npx tsx src/cli.ts index`.
EOF
  echo "✓ wrote memory-public/README.md"
fi
git -C memory-public add -A .
if ! git -C memory-public diff --cached --quiet; then
  git -C memory-public commit -q -m "Initialize public memory graph"
  echo "✓ committed memory-public initial state"
fi

# 3. Rebuild the index — the version bump forces one clean rebuild; every
#    existing row lands with graph=private.
npx tsx src/cli.ts index
echo "✓ index rebuilt with graph column"
echo "Done. All existing memories are PRIVATE; the public graph starts empty."
