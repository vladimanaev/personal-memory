#!/usr/bin/env bash

set -Eeuo pipefail

usage() {
  cat <<'EOF'
Usage: ./scripts/restore_backup.sh <backup.tgz> (--dry-run | --confirm) [options]

Validate and restore a backup created by scripts/migrate.sh. Restoring replaces
the complete graph-store layout with the layout in the archive.

Options:
  --dry-run            Validate and inspect the archive without changing stores.
  --confirm            Perform the restore after validation.
  --backup-dir <path>  Store the automatic pre-restore backup here.
                       Default: ../personal-memory-backups
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
REPO_PARENT="$(dirname "$REPO_ROOT")"
BACKUP_DIR="$REPO_PARENT/personal-memory-backups"
ARCHIVE_INPUT=""
DRY_RUN=0
CONFIRM=0

# shellcheck source=migration_lib.sh
source "$SCRIPT_DIR/migration_lib.sh"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --confirm)
      CONFIRM=1
      shift
      ;;
    --backup-dir)
      [[ $# -ge 2 ]] || die "--backup-dir requires a path"
      BACKUP_DIR="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      die "unknown option: $1 (run with --help for usage)"
      ;;
    *)
      [[ -z "$ARCHIVE_INPUT" ]] || die "only one backup archive may be supplied"
      ARCHIVE_INPUT="$1"
      shift
      ;;
  esac
done

[[ -n "$ARCHIVE_INPUT" ]] || die "a backup archive is required"
(( DRY_RUN + CONFIRM == 1 )) || die "choose exactly one of --dry-run or --confirm"

require_command tar

case "$ARCHIVE_INPUT" in
  /*) archive_candidate="$ARCHIVE_INPUT" ;;
  *) archive_candidate="$PWD/$ARCHIVE_INPUT" ;;
esac
[[ -f "$archive_candidate" ]] || die "backup archive not found: $ARCHIVE_INPUT"
archive_dir="$(cd "$(dirname "$archive_candidate")" && pwd -P)"
ARCHIVE_PATH="$archive_dir/$(basename "$archive_candidate")"

cd "$REPO_ROOT"

log "Validating backup archive"
migration_validate_archive "$ARCHIVE_PATH"

RESTORE_ROOT="$(mktemp -d "$REPO_ROOT/.personal-memory-restore.XXXXXX")"
EXTRACTED_ROOT="$RESTORE_ROOT/extracted"
CURRENT_ROOT="$RESTORE_ROOT/current"
RESTORE_STARTED=0
RESTORE_COMPLETE=0

cleanup() {
  cleanup_status=$?
  trap - EXIT

  if (( RESTORE_STARTED && ! RESTORE_COMPLETE )); then
    printf '\nRestore failed; rolling back the original graph stores and index state.\n' >&2
    for store_name in memory memory-public memory-graphs; do
      if [[ -e "$CURRENT_ROOT/$store_name" ]]; then
        rm -rf "$REPO_ROOT/$store_name"
        mv "$CURRENT_ROOT/$store_name" "$REPO_ROOT/$store_name"
      elif [[ -e "$RESTORE_ROOT/installed-$store_name" ]]; then
        rm -rf "$REPO_ROOT/$store_name"
      fi
    done
    if [[ -e "$CURRENT_ROOT/.index" ]]; then
      rm -rf "$REPO_ROOT/.index"
      mv "$CURRENT_ROOT/.index" "$REPO_ROOT/.index"
    elif [[ -e "$RESTORE_ROOT/installed-.index" ]]; then
      rm -rf "$REPO_ROOT/.index"
    fi
    printf 'Original stores and index state restored.\n' >&2
  fi

  if [[ "$RESTORE_ROOT" == "$REPO_ROOT/".personal-memory-restore.* ]]; then
    rm -rf "$RESTORE_ROOT"
  fi
  exit "$cleanup_status"
}
trap cleanup EXIT

mkdir -p "$EXTRACTED_ROOT" "$CURRENT_ROOT"
tar -xzf "$ARCHIVE_PATH" -C "$EXTRACTED_ROOT"

archive_stores=()
for store_name in memory memory-public memory-graphs; do
  if [[ -e "$EXTRACTED_ROOT/$store_name" ]]; then
    [[ -d "$EXTRACTED_ROOT/$store_name" ]] || die "archive store is not a directory: $store_name"
    archive_stores+=("$store_name")
  fi
done

printf 'Archive: %s\n' "$ARCHIVE_PATH"
printf 'Graph stores: %s\n' "${archive_stores[*]}"
if (( DRY_RUN )); then
  printf 'Dry run complete; no graph stores were changed.\n'
  exit 0
fi

umask 077
BACKUP_DIR="$(migration_external_dir "$BACKUP_DIR" "$REPO_ROOT" "pre-restore backup directory")"

current_stores=()
for store_name in memory memory-public memory-graphs; do
  if [[ -e "$store_name" ]]; then
    current_stores+=("$store_name")
  fi
done

pre_restore_path=""
if [[ ${#current_stores[@]} -gt 0 ]]; then
  timestamp="$(date '+%Y%m%d-%H%M%S')"
  pre_restore_path="$BACKUP_DIR/pre-restore-$timestamp-$$.tgz"
  log "Backing up the current graph stores before restore"
  pre_restore_paths=("${current_stores[@]}")
  for state_file in "${DURABLE_INDEX_STATE_FILES[@]}"; do
    if [[ -f ".index/$state_file" ]]; then
      pre_restore_paths+=(".index/$state_file")
    fi
  done
  migration_create_archive "$pre_restore_path" "${pre_restore_paths[@]}"
  printf 'Verified pre-restore backup: %s\n' "$pre_restore_path"
fi

log "Replacing the graph-store layout from the validated archive"
RESTORE_STARTED=1
if [[ -e "$REPO_ROOT/.index" ]]; then
  [[ ! -L "$REPO_ROOT/.index" ]] || die ".index must not be a symbolic link"
  mv "$REPO_ROOT/.index" "$CURRENT_ROOT/.index"
fi
for store_name in memory memory-public memory-graphs; do
  if [[ -e "$REPO_ROOT/$store_name" ]]; then
    mv "$REPO_ROOT/$store_name" "$CURRENT_ROOT/$store_name"
  fi
  if [[ -e "$EXTRACTED_ROOT/$store_name" ]]; then
    touch "$RESTORE_ROOT/installed-$store_name"
    mv "$EXTRACTED_ROOT/$store_name" "$REPO_ROOT/$store_name"
  fi
done

touch "$RESTORE_ROOT/installed-.index"
mkdir -p "$REPO_ROOT/.index"
archive_has_index_state=0
for state_file in "${DURABLE_INDEX_STATE_FILES[@]}"; do
  if [[ -f "$EXTRACTED_ROOT/.index/$state_file" ]]; then
    archive_has_index_state=1
    mv "$EXTRACTED_ROOT/.index/$state_file" "$REPO_ROOT/.index/$state_file"
  fi
done
if (( ! archive_has_index_state )); then
  for state_file in "${DURABLE_INDEX_STATE_FILES[@]}"; do
    if [[ -f "$CURRENT_ROOT/.index/$state_file" ]]; then
      cp -p "$CURRENT_ROOT/.index/$state_file" "$REPO_ROOT/.index/$state_file"
    fi
  done
  printf 'Archive predates durable index-state backups; preserved the current workflow state.\n'
fi

if [[ -d "$REPO_ROOT/memory-public" ]]; then
  log "Legacy two-graph layout restored"
  printf 'The rebuild is deferred because the current engine rejects memory-public/.\n'
  printf 'Run ./scripts/migrate.sh when you are ready to migrate this restored layout.\n'
else
  can_rebuild_index=0
  if command -v node >/dev/null 2>&1 && [[ -x "$REPO_ROOT/node_modules/.bin/tsx" ]]; then
    node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
    if [[ "$node_major" =~ ^[0-9]+$ ]] && (( node_major >= 20 )); then
      can_rebuild_index=1
    fi
  fi

  if (( can_rebuild_index )); then
    log "Rebuilding the derived index"
    "$REPO_ROOT/node_modules/.bin/tsx" src/cli.ts index --force
    "$REPO_ROOT/node_modules/.bin/tsx" src/cli.ts graphs sync --dry-run
    "$REPO_ROOT/node_modules/.bin/tsx" src/cli.ts graphs list
  else
    log "Derived index rebuild deferred"
    printf 'The graph stores and workflow state are restored. Install Node.js 20+ and dependencies, then run:\n'
    printf '  npx tsx src/cli.ts index --force\n'
    printf '  npx tsx src/cli.ts graphs sync --dry-run\n'
  fi
fi

RESTORE_COMPLETE=1
printf '\nRestore complete.\n'
if [[ -n "$pre_restore_path" ]]; then
  printf 'Pre-restore backup: %s\n' "$pre_restore_path"
fi
printf 'No commits or memory data were pushed to a remote.\n'
