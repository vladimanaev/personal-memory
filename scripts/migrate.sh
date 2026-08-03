#!/usr/bin/env bash

set -Eeuo pipefail

usage() {
  cat <<'EOF'
Usage: ./scripts/migrate.sh [options]

Back up the local memory stores, update the checkout, install dependencies,
run the graph migration, and verify the resulting graph layout.

Options:
  --backup-dir <path>  Store the backup archive in this directory.
                       Default: ../personal-memory-backups
  --no-update          Do not fetch or fast-forward the current branch.
  --skip-install       Do not run npm ci/npm install.
  -h, --help           Show this help text.

The script never pushes commits or memory data to a remote.
EOF
}

log() {
  printf '\n==> %s\n' "$*"
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
BACKUP_DIR="$(dirname "$REPO_ROOT")/personal-memory-backups"
UPDATE_CODE=1
INSTALL_DEPS=1

# shellcheck source=migration_lib.sh
source "$SCRIPT_DIR/migration_lib.sh"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --backup-dir)
      [[ $# -ge 2 ]] || die "--backup-dir requires a path"
      BACKUP_DIR="$2"
      shift 2
      ;;
    --no-update)
      UPDATE_CODE=0
      shift
      ;;
    --skip-install)
      INSTALL_DEPS=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1 (run with --help for usage)"
      ;;
  esac
done

require_command git
require_command tar
require_command node
require_command npm
require_command npx

cd "$REPO_ROOT"
git rev-parse --show-toplevel >/dev/null 2>&1 || die "$REPO_ROOT is not a Git checkout"
if ! git diff --quiet || ! git diff --cached --quiet; then
  die "tracked changes make migration unsafe; commit or stash them first"
fi

umask 077
BACKUP_DIR="$(migration_external_dir "$BACKUP_DIR" "$REPO_ROOT" "backup directory")"

store_paths=()
for store_path in memory memory-public memory-graphs; do
  if [[ -e "$store_path" ]]; then
    [[ ! -L "$store_path" ]] || die "graph store must not be a symbolic link: $store_path"
    [[ -d "$store_path" ]] || die "graph store is not a directory: $store_path"
    store_paths+=("$store_path")
  fi
done

backup_path=""
if [[ ${#store_paths[@]} -gt 0 ]]; then
  timestamp="$(date '+%Y%m%d-%H%M%S')"
  backup_path="$BACKUP_DIR/personal-memory-$timestamp-$$.tgz"
  log "Backing up every existing graph store: ${store_paths[*]}"
  backup_paths=("${store_paths[@]}")
  for state_file in "${DURABLE_INDEX_STATE_FILES[@]}"; do
    if [[ -f ".index/$state_file" ]]; then
      backup_paths+=(".index/$state_file")
    fi
  done
  migration_create_archive "$backup_path" "${backup_paths[@]}"
  printf 'Verified backup: %s\n' "$backup_path"
else
  log "No existing memory stores found; backup is not needed"
fi

if (( UPDATE_CODE )); then
  log "Checking for upstream code updates"

  current_branch="$(git symbolic-ref --quiet --short HEAD || true)"
  [[ -n "$current_branch" ]] || die "cannot update code from a detached HEAD; rerun with --no-update"

  tracking_ref="$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true)"
  if [[ -n "$tracking_ref" ]]; then
    remote_name="${tracking_ref%%/*}"
    remote_branch="${tracking_ref#*/}"
  elif git remote get-url upstream >/dev/null 2>&1; then
    remote_name="upstream"
    remote_branch="$current_branch"
  elif git remote get-url origin >/dev/null 2>&1; then
    remote_name="origin"
    remote_branch="$current_branch"
  else
    die "no upstream or origin remote is configured; rerun with --no-update"
  fi

  git fetch "$remote_name" "$remote_branch"
  fetched_sha="$(git rev-parse FETCH_HEAD)"
  head_sha="$(git rev-parse HEAD)"

  if [[ "$head_sha" == "$fetched_sha" ]]; then
    printf 'Already up to date with %s/%s.\n' "$remote_name" "$remote_branch"
  elif git merge-base --is-ancestor "$head_sha" "$fetched_sha"; then
    git merge --ff-only "$fetched_sha"
  elif git merge-base --is-ancestor "$fetched_sha" "$head_sha"; then
    printf 'Local branch is ahead of %s/%s; keeping the local commits.\n' "$remote_name" "$remote_branch"
  else
    die "local branch has diverged from $remote_name/$remote_branch; reconcile it manually"
  fi
else
  log "Skipping code update"
fi

[[ -f scripts/migrate-graphs.ts ]] || die "scripts/migrate-graphs.ts is missing after the code update"

node_major="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$node_major" =~ ^[0-9]+$ ]] || die "could not determine the Node.js version"
(( node_major >= 20 )) || die "Node.js 20 or newer is required (found $(node --version))"

if (( INSTALL_DEPS )); then
  log "Installing Node.js dependencies"
  if [[ -f package-lock.json ]]; then
    npm ci
  else
    npm install
  fi
else
  log "Skipping dependency installation"
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  die "tracked files changed before migration execution; commit or stash them first"
fi

log "Migrating the memory stores"
npx tsx scripts/migrate-graphs.ts

log "Verifying the graph registry"
npx tsx src/cli.ts graphs list

printf '\nMigration complete.\n'
if [[ -n "$backup_path" ]]; then
  printf 'Backup: %s\n' "$backup_path"
fi
printf 'No commits or memory data were pushed to a remote.\n'
