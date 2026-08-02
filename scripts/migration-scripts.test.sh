#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
TEST_TMP_PARENT="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
TEST_ROOT="$(mktemp -d "$TEST_TMP_PARENT/personal-memory-migration-tests.XXXXXX")"
ORIGINAL_PATH="$PATH"
BASH_BIN="$(command -v bash)"
PASSED=0

cleanup() {
  cleanup_status=$?
  trap - EXIT
  case "$TEST_ROOT" in
    "$TEST_TMP_PARENT"/personal-memory-migration-tests.*) rm -rf "$TEST_ROOT" ;;
  esac
  exit "$cleanup_status"
}
trap cleanup EXIT

fail() {
  printf 'not ok - %s\n' "$*" >&2
  exit 1
}

pass() {
  PASSED=$((PASSED + 1))
  printf 'ok %d - %s\n' "$PASSED" "$1"
}

write_file() {
  mkdir -p "$(dirname "$1")"
  printf '%s\n' "$2" > "$1"
}

assert_file_contains() {
  local file="$1"
  local expected="$2"
  case "$(<"$file")" in
    *"$expected"*) ;;
    *) fail "$file does not contain '$expected'" ;;
  esac
}

copy_migration_scripts() {
  local repo="$1"
  mkdir -p "$repo/scripts"
  cp "$PROJECT_ROOT/scripts/migration_lib.sh" "$repo/scripts/migration_lib.sh"
  cp "$PROJECT_ROOT/scripts/migrate.sh" "$repo/scripts/migrate.sh"
  cp "$PROJECT_ROOT/scripts/restore_backup.sh" "$repo/scripts/restore_backup.sh"
  chmod 755 "$repo/scripts/migrate.sh" "$repo/scripts/restore_backup.sh"
}

init_migrate_fixture() {
  local fixture="$1"
  local repo="$fixture/repo"
  copy_migration_scripts "$repo"
  write_file "$repo/scripts/migrate-graphs.ts" "// disposable migration fixture"
  write_file "$repo/tracked.txt" "clean"
  mkdir -p "$fixture/bin"
  write_file "$fixture/bin/npx" '#!/usr/bin/env bash
printf "%s\\n" "$*" >> "${MIGRATION_NPX_LOG:?}"'
  chmod 755 "$fixture/bin/npx"
  git -C "$repo" init -q
  git -C "$repo" config user.name "Migration Test"
  git -C "$repo" config user.email "migration-test@example.invalid"
  git -C "$repo" add scripts tracked.txt
  git -C "$repo" commit -qm "fixture"
}

attach_local_remote() {
  local fixture="$1"
  local repo="$fixture/repo"
  git init --bare -q "$fixture/remote.git"
  git -C "$repo" branch -M main
  git -C "$repo" remote add origin "$fixture/remote.git"
  git -C "$repo" push -qu -u origin main
  git --git-dir="$fixture/remote.git" symbolic-ref HEAD refs/heads/main
}

advance_remote() {
  local fixture="$1"
  local content="$2"
  local updater="$fixture/updater-$content"
  git clone -q --branch main "$fixture/remote.git" "$updater"
  git -C "$updater" config user.name "Migration Test"
  git -C "$updater" config user.email "migration-test@example.invalid"
  write_file "$updater/remote-$content.txt" "$content"
  git -C "$updater" add "remote-$content.txt"
  git -C "$updater" commit -qm "remote $content"
  git -C "$updater" push -q origin main
}

make_tar_only_path() {
  local bin_dir="$1"
  local tool tool_path
  mkdir -p "$bin_dir"
  for tool in tar gzip dirname basename mktemp mkdir rm mv cp touch date; do
    tool_path="$(command -v "$tool")"
    ln -s "$tool_path" "$bin_dir/$tool"
  done
}

test_migrate_backup_includes_all_stores_and_state() {
  local fixture="$TEST_ROOT/migrate-success"
  local repo="$fixture/repo"
  local archive_contents
  local archives
  init_migrate_fixture "$fixture"
  write_file "$repo/memory/record.txt" "default graph"
  write_file "$repo/memory-graphs/team/record.txt" "named graph"
  write_file "$repo/.index/connector-state.json" '{"slack":{"last_pulled":"2026-08-02"}}'

  MIGRATION_NPX_LOG="$fixture/npx.log" PATH="$fixture/bin:$ORIGINAL_PATH" \
    "$BASH_BIN" "$repo/scripts/migrate.sh" --no-update --skip-install --backup-dir "$fixture/backups" \
    > "$fixture/output" 2>&1

  archives=("$fixture"/backups/personal-memory-*.tgz)
  [[ ${#archives[@]} -eq 1 && -f "${archives[0]}" ]] || fail "migration did not create exactly one backup"
  archive_contents="$(tar -tzf "${archives[0]}")"
  case "$archive_contents" in *"memory/record.txt"*) ;; *) fail "default graph missing from backup" ;; esac
  case "$archive_contents" in *"memory-graphs/team/record.txt"*) ;; *) fail "named graph missing from backup" ;; esac
  case "$archive_contents" in *".index/connector-state.json"*) ;; *) fail "durable index state missing from backup" ;; esac
  pass "migration backs up every graph store and durable index state"
}

test_migrate_rejects_dirty_tracked_tree() {
  local fixture="$TEST_ROOT/migrate-dirty"
  local repo="$fixture/repo"
  init_migrate_fixture "$fixture"
  write_file "$repo/tracked.txt" "dirty"

  if MIGRATION_NPX_LOG="$fixture/npx.log" PATH="$fixture/bin:$ORIGINAL_PATH" \
    "$BASH_BIN" "$repo/scripts/migrate.sh" --no-update --skip-install --backup-dir "$fixture/backups" \
    > "$fixture/output" 2>&1; then
    fail "migration accepted a dirty tracked tree"
  fi
  assert_file_contains "$fixture/output" "tracked changes make migration unsafe"
  pass "migration rejects dirty tracked files before backup or execution"
}

test_migrate_rejects_physical_backup_path_inside_repo() {
  local fixture="$TEST_ROOT/migrate-backup-symlink"
  local repo="$fixture/repo"
  init_migrate_fixture "$fixture"
  mkdir -p "$repo/private-archives"
  ln -s "$repo/private-archives" "$fixture/apparently-external"

  if MIGRATION_NPX_LOG="$fixture/npx.log" PATH="$fixture/bin:$ORIGINAL_PATH" \
    "$BASH_BIN" "$repo/scripts/migrate.sh" --no-update --skip-install \
    --backup-dir "$fixture/apparently-external" > "$fixture/output" 2>&1; then
    fail "migration accepted a symlinked backup path inside the repository"
  fi
  assert_file_contains "$fixture/output" "must resolve outside the repository"
  pass "migration resolves backup containment physically"
}

test_migrate_rejects_non_restorable_store_archive() {
  local fixture="$TEST_ROOT/migrate-special-entry"
  local repo="$fixture/repo"
  init_migrate_fixture "$fixture"
  write_file "$repo/memory/record.txt" "record"
  ln -s record.txt "$repo/memory/record-link"

  if MIGRATION_NPX_LOG="$fixture/npx.log" PATH="$fixture/bin:$ORIGINAL_PATH" \
    "$BASH_BIN" "$repo/scripts/migrate.sh" --no-update --skip-install --backup-dir "$fixture/backups" \
    > "$fixture/output" 2>&1; then
    fail "migration accepted a backup that restore would reject"
  fi
  assert_file_contains "$fixture/output" "unsupported entry type"
  pass "migration and restore enforce the same archive entry rules"
}

test_migrate_fast_forwards_clean_branch() {
  local fixture="$TEST_ROOT/migrate-fast-forward"
  local repo="$fixture/repo"
  init_migrate_fixture "$fixture"
  attach_local_remote "$fixture"
  advance_remote "$fixture" "forward"

  MIGRATION_NPX_LOG="$fixture/npx.log" PATH="$fixture/bin:$ORIGINAL_PATH" \
    "$BASH_BIN" "$repo/scripts/migrate.sh" --skip-install --backup-dir "$fixture/backups" \
    > "$fixture/output" 2>&1
  [[ -f "$repo/remote-forward.txt" ]] || fail "migration did not fast-forward a clean branch"
  pass "migration fast-forwards a clean tracked branch"
}

test_migrate_keeps_clean_local_commits_when_ahead() {
  local fixture="$TEST_ROOT/migrate-ahead"
  local repo="$fixture/repo"
  init_migrate_fixture "$fixture"
  attach_local_remote "$fixture"
  write_file "$repo/local-ahead.txt" "ahead"
  git -C "$repo" add local-ahead.txt
  git -C "$repo" commit -qm "local ahead"

  MIGRATION_NPX_LOG="$fixture/npx.log" PATH="$fixture/bin:$ORIGINAL_PATH" \
    "$BASH_BIN" "$repo/scripts/migrate.sh" --skip-install --backup-dir "$fixture/backups" \
    > "$fixture/output" 2>&1
  assert_file_contains "$fixture/output" "Local branch is ahead"
  [[ -f "$repo/local-ahead.txt" ]] || fail "migration lost a local ahead commit"
  pass "migration retains clean local commits when ahead"
}

test_migrate_rejects_diverged_branch() {
  local fixture="$TEST_ROOT/migrate-diverged"
  local repo="$fixture/repo"
  init_migrate_fixture "$fixture"
  attach_local_remote "$fixture"
  write_file "$repo/local-diverged.txt" "local"
  git -C "$repo" add local-diverged.txt
  git -C "$repo" commit -qm "local divergence"
  advance_remote "$fixture" "diverged"

  if MIGRATION_NPX_LOG="$fixture/npx.log" PATH="$fixture/bin:$ORIGINAL_PATH" \
    "$BASH_BIN" "$repo/scripts/migrate.sh" --skip-install --backup-dir "$fixture/backups" \
    > "$fixture/output" 2>&1; then
    fail "migration accepted a diverged branch"
  fi
  assert_file_contains "$fixture/output" "has diverged"
  pass "migration rejects diverged branches"
}

test_restore_dry_run_needs_no_node_runtime() {
  local fixture="$TEST_ROOT/restore-dry-run"
  local repo="$fixture/repo"
  copy_migration_scripts "$repo"
  write_file "$fixture/archive/memory/record.txt" "record"
  tar -czf "$fixture/backup.tgz" -C "$fixture/archive" memory
  make_tar_only_path "$fixture/tar-only-bin"

  PATH="$fixture/tar-only-bin" "$BASH_BIN" "$repo/scripts/restore_backup.sh" \
    "$fixture/backup.tgz" --dry-run > "$fixture/output" 2>&1
  assert_file_contains "$fixture/output" "Dry run complete"
  pass "restore dry-run works without Node.js or npm"
}

test_restore_preserves_and_restores_durable_state() {
  local fixture="$TEST_ROOT/restore-state"
  local repo="$fixture/repo"
  local pre_backups pre_backup_contents
  copy_migration_scripts "$repo"
  write_file "$repo/memory/current.txt" "current"
  write_file "$repo/.index/connector-state.json" '{"state":"current"}'
  write_file "$repo/.index/lexical.json" '{"derived":true}'
  write_file "$fixture/archive/memory/restored.txt" "restored"
  write_file "$fixture/archive/.index/connector-state.json" '{"state":"archived"}'
  tar -czf "$fixture/backup.tgz" -C "$fixture/archive" memory .index/connector-state.json
  make_tar_only_path "$fixture/tar-only-bin"

  PATH="$fixture/tar-only-bin" "$BASH_BIN" "$repo/scripts/restore_backup.sh" \
    "$fixture/backup.tgz" --confirm --backup-dir "$fixture/pre-backups" > "$fixture/output" 2>&1

  [[ -f "$repo/memory/restored.txt" && ! -e "$repo/memory/current.txt" ]] || fail "graph layout was not restored"
  assert_file_contains "$repo/.index/connector-state.json" '"archived"'
  [[ ! -e "$repo/.index/lexical.json" ]] || fail "derived index artifact survived restore"
  pre_backups=("$fixture"/pre-backups/pre-restore-*.tgz)
  [[ ${#pre_backups[@]} -eq 1 && -f "${pre_backups[0]}" ]] || fail "pre-restore backup missing"
  pre_backup_contents="$(tar -tzf "${pre_backups[0]}")"
  case "$pre_backup_contents" in *".index/connector-state.json"*) ;; *) fail "pre-restore backup omitted durable state" ;; esac
  assert_file_contains "$fixture/output" "Derived index rebuild deferred"
  pass "restore replaces durable state, drops derived artifacts, and backs up the prior state"
}

test_restore_preserves_current_state_for_legacy_archive_format() {
  local fixture="$TEST_ROOT/restore-old-archive"
  local repo="$fixture/repo"
  copy_migration_scripts "$repo"
  write_file "$repo/memory/current.txt" "current"
  write_file "$repo/.index/slug-dismissals.json" '[{"kind":"tag"}]'
  write_file "$fixture/archive/memory/restored.txt" "restored"
  tar -czf "$fixture/backup.tgz" -C "$fixture/archive" memory
  make_tar_only_path "$fixture/tar-only-bin"

  PATH="$fixture/tar-only-bin" "$BASH_BIN" "$repo/scripts/restore_backup.sh" \
    "$fixture/backup.tgz" --confirm --backup-dir "$fixture/pre-backups" > "$fixture/output" 2>&1
  assert_file_contains "$repo/.index/slug-dismissals.json" '"tag"'
  assert_file_contains "$fixture/output" "preserved the current workflow state"
  pass "restore preserves workflow state when an older archive has none"
}

test_restore_rolls_back_stores_and_complete_index_on_failure() {
  local fixture="$TEST_ROOT/restore-rollback"
  local repo="$fixture/repo"
  copy_migration_scripts "$repo"
  write_file "$repo/memory/current.txt" "current"
  write_file "$repo/.index/connector-state.json" '{"state":"current"}'
  write_file "$repo/.index/lexical.json" '{"derived":"current"}'
  write_file "$repo/node_modules/.bin/tsx" '#!/usr/bin/env bash
exit 42'
  chmod 755 "$repo/node_modules/.bin/tsx"
  write_file "$fixture/archive/memory/restored.txt" "restored"
  write_file "$fixture/archive/.index/connector-state.json" '{"state":"archived"}'
  tar -czf "$fixture/backup.tgz" -C "$fixture/archive" memory .index/connector-state.json

  if "$BASH_BIN" "$repo/scripts/restore_backup.sh" "$fixture/backup.tgz" --confirm \
    --backup-dir "$fixture/pre-backups" > "$fixture/output" 2>&1; then
    fail "restore unexpectedly succeeded after injected index failure"
  fi
  [[ -f "$repo/memory/current.txt" && ! -e "$repo/memory/restored.txt" ]] || fail "graph stores did not roll back"
  assert_file_contains "$repo/.index/connector-state.json" '"current"'
  assert_file_contains "$repo/.index/lexical.json" '"current"'
  assert_file_contains "$fixture/output" "Original stores and index state restored"
  pass "restore failure rolls back graph stores and the complete prior index"
}

test_restore_rejects_physical_backup_path_inside_repo() {
  local fixture="$TEST_ROOT/restore-backup-symlink"
  local repo="$fixture/repo"
  copy_migration_scripts "$repo"
  write_file "$repo/memory/current.txt" "current"
  write_file "$fixture/archive/memory/restored.txt" "restored"
  tar -czf "$fixture/backup.tgz" -C "$fixture/archive" memory
  mkdir -p "$repo/private-archives"
  ln -s "$repo/private-archives" "$fixture/apparently-external"

  if "$BASH_BIN" "$repo/scripts/restore_backup.sh" "$fixture/backup.tgz" --confirm \
    --backup-dir "$fixture/apparently-external" > "$fixture/output" 2>&1; then
    fail "restore accepted a symlinked backup path inside the repository"
  fi
  [[ -f "$repo/memory/current.txt" ]] || fail "restore changed stores before rejecting backup containment"
  assert_file_contains "$fixture/output" "must resolve outside the repository"
  pass "restore resolves pre-backup containment physically before replacement"
}

test_restore_rejects_symlink_archive() {
  local fixture="$TEST_ROOT/restore-symlink-archive"
  local repo="$fixture/repo"
  copy_migration_scripts "$repo"
  write_file "$fixture/archive/memory/record.txt" "record"
  ln -s record.txt "$fixture/archive/memory/record-link"
  tar -czf "$fixture/backup.tgz" -C "$fixture/archive" memory

  if "$BASH_BIN" "$repo/scripts/restore_backup.sh" "$fixture/backup.tgz" --dry-run \
    > "$fixture/output" 2>&1; then
    fail "restore accepted a symlink archive"
  fi
  assert_file_contains "$fixture/output" "unsupported entry type"
  pass "restore rejects symlinks before extraction"
}

printf '1..13\n'
test_migrate_backup_includes_all_stores_and_state
test_migrate_rejects_dirty_tracked_tree
test_migrate_rejects_physical_backup_path_inside_repo
test_migrate_rejects_non_restorable_store_archive
test_migrate_fast_forwards_clean_branch
test_migrate_keeps_clean_local_commits_when_ahead
test_migrate_rejects_diverged_branch
test_restore_dry_run_needs_no_node_runtime
test_restore_preserves_and_restores_durable_state
test_restore_preserves_current_state_for_legacy_archive_format
test_restore_rolls_back_stores_and_complete_index_on_failure
test_restore_rejects_physical_backup_path_inside_repo
test_restore_rejects_symlink_archive
