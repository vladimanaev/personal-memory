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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_PARENT="$(dirname "$REPO_ROOT")"
BACKUP_DIR="$REPO_PARENT/personal-memory-backups"
ARCHIVE_INPUT=""
DRY_RUN=0
CONFIRM=0

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
require_command node
require_command npx

case "$ARCHIVE_INPUT" in
  /*) archive_candidate="$ARCHIVE_INPUT" ;;
  *) archive_candidate="$PWD/$ARCHIVE_INPUT" ;;
esac
[[ -f "$archive_candidate" ]] || die "backup archive not found: $ARCHIVE_INPUT"
archive_dir="$(cd "$(dirname "$archive_candidate")" && pwd)"
ARCHIVE_PATH="$archive_dir/$(basename "$archive_candidate")"

cd "$REPO_ROOT"

node_major="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$node_major" =~ ^[0-9]+$ ]] || die "could not determine the Node.js version"
(( node_major >= 20 )) || die "Node.js 20 or newer is required (found $(node --version))"

log "Validating backup archive"
tar -tzf "$ARCHIVE_PATH" >/dev/null

while IFS= read -r archive_listing; do
  case "${archive_listing:0:1}" in
    -|d) ;;
    *) die "archive contains an unsupported entry type: $archive_listing" ;;
  esac
done < <(tar -tvzf "$ARCHIVE_PATH")

HAS_MEMORY=0
HAS_LEGACY_PUBLIC=0
HAS_NAMED_GRAPHS=0
while IFS= read -r archive_entry; do
  while [[ "$archive_entry" == ./* ]]; do
    archive_entry="${archive_entry#./}"
  done
  archive_entry="${archive_entry%/}"
  [[ -n "$archive_entry" ]] || continue

  [[ "$archive_entry" != /* ]] || die "archive contains an absolute path: $archive_entry"
  case "/$archive_entry/" in
    *"/../"*|*"/./"*) die "archive contains an unsafe path: $archive_entry" ;;
  esac

  top_level="${archive_entry%%/*}"
  case "$top_level" in
    memory) HAS_MEMORY=1 ;;
    memory-public) HAS_LEGACY_PUBLIC=1 ;;
    memory-graphs) HAS_NAMED_GRAPHS=1 ;;
    *) die "archive contains an unexpected top-level path: $top_level" ;;
  esac
done < <(tar -tzf "$ARCHIVE_PATH")

(( HAS_MEMORY || HAS_LEGACY_PUBLIC || HAS_NAMED_GRAPHS )) || die "archive contains no memory graph stores"

RESTORE_ROOT="$(mktemp -d "$REPO_ROOT/.personal-memory-restore.XXXXXX")"
EXTRACTED_ROOT="$RESTORE_ROOT/extracted"
CURRENT_ROOT="$RESTORE_ROOT/current"
RESTORE_STARTED=0
RESTORE_COMPLETE=0

cleanup() {
  cleanup_status=$?
  trap - EXIT

  if (( RESTORE_STARTED && ! RESTORE_COMPLETE )); then
    printf '\nRestore failed; rolling back the original graph stores.\n' >&2
    for store_name in memory memory-public memory-graphs; do
      if [[ -e "$CURRENT_ROOT/$store_name" ]]; then
        rm -rf "$REPO_ROOT/$store_name"
        mv "$CURRENT_ROOT/$store_name" "$REPO_ROOT/$store_name"
      elif [[ -e "$RESTORE_ROOT/installed-$store_name" ]]; then
        rm -rf "$REPO_ROOT/$store_name"
      fi
    done
    rm -rf "$REPO_ROOT/.index"
    printf 'Original stores restored; rebuild .index before using the CLI.\n' >&2
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
mkdir -p "$BACKUP_DIR"
BACKUP_DIR="$(cd "$BACKUP_DIR" && pwd)"
if [[ "$BACKUP_DIR" == "$REPO_ROOT" || "$BACKUP_DIR" == "$REPO_ROOT/"* ]]; then
  die "pre-restore backup directory must be outside the repository: $BACKUP_DIR"
fi

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
  tar -czf "$pre_restore_path" -- "${current_stores[@]}"
  tar -tzf "$pre_restore_path" >/dev/null
  printf 'Verified pre-restore backup: %s\n' "$pre_restore_path"
fi

log "Replacing the graph-store layout from the validated archive"
RESTORE_STARTED=1
for store_name in memory memory-public memory-graphs; do
  if [[ -e "$REPO_ROOT/$store_name" ]]; then
    mv "$REPO_ROOT/$store_name" "$CURRENT_ROOT/$store_name"
  fi
  if [[ -e "$EXTRACTED_ROOT/$store_name" ]]; then
    touch "$RESTORE_ROOT/installed-$store_name"
    mv "$EXTRACTED_ROOT/$store_name" "$REPO_ROOT/$store_name"
  fi
done

rm -rf "$REPO_ROOT/.index"

if [[ -d "$REPO_ROOT/memory-public" ]]; then
  log "Legacy two-graph layout restored"
  printf 'The rebuild is deferred because the current engine rejects memory-public/.\n'
  printf 'Run ./scripts/migrate.sh when you are ready to migrate this restored layout.\n'
else
  log "Rebuilding the derived index"
  npx tsx src/cli.ts index --force
  npx tsx src/cli.ts graphs sync --dry-run
  npx tsx src/cli.ts graphs list
fi

RESTORE_COMPLETE=1
printf '\nRestore complete.\n'
if [[ -n "$pre_restore_path" ]]; then
  printf 'Pre-restore backup: %s\n' "$pre_restore_path"
fi
printf 'No commits or memory data were pushed to a remote.\n'
