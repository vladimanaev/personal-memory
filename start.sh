#!/usr/bin/env bash
# Start the memory web UI. Usage: ./start.sh [--port N] [--no-open]
set -euo pipefail
cd "$(dirname "$0")"

# Ensure Node >= 20 (via nvm if available)
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  source "$HOME/.nvm/nvm.sh"
  nvm use 20 >/dev/null
fi

exec npx tsx src/cli.ts ui "$@"
