import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, utimesSync, writeFileSync, closeSync, openSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitMemoryRepo } from "./memory-git.js";

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "memory-git-test-"));
  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "test@test"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "test"]);
  return dir;
}

function lockPath(dir: string): string {
  return join(dir, ".git", "index.lock");
}

function createLock(dir: string): void {
  closeSync(openSync(lockPath(dir), "wx"));
}

function commitCount(dir: string): number {
  try {
    const out = execFileSync("git", ["-C", dir, "rev-list", "--count", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return Number(out.trim());
  } catch {
    return 0; // no HEAD yet — zero commits
  }
}

test("clean repo → false, no commit", async (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(await commitMemoryRepo("noop", dir), false);
});

test("dirty repo → commits and returns true", async (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "a.md"), "hello");
  assert.equal(await commitMemoryRepo("add a", dir), true);
  assert.equal(commitCount(dir), 1);
});

test("stale index.lock (old mtime) is removed and commit succeeds", async (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "a.md"), "hello");
  createLock(dir);
  const old = (Date.now() - 10 * 60_000) / 1000; // 10 minutes ago
  utimesSync(lockPath(dir), old, old);

  assert.equal(await commitMemoryRepo("recover", dir), true);
  assert.equal(commitCount(dir), 1);
  assert.equal(existsSync(lockPath(dir)), false);
});

test("fresh index.lock that clears during backoff → succeeds via retry", async (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "a.md"), "hello");
  createLock(dir);
  setTimeout(() => rmSync(lockPath(dir), { force: true }), 150);

  assert.equal(await commitMemoryRepo("after retry", dir), true);
  assert.equal(commitCount(dir), 1);
});

test("fresh index.lock that persists → rejects with lock error", async (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "a.md"), "hello");
  createLock(dir);

  await assert.rejects(commitMemoryRepo("blocked", dir), /index\.lock/);
  assert.equal(commitCount(dir), 0);
});

test("concurrent calls are serialized — no lock errors, work committed", async (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(join(dir, "a.md"), "first");
  const results = await Promise.all(
    Array.from({ length: 5 }, (_, i) => commitMemoryRepo(`concurrent ${i}`, dir)),
  );

  assert.ok(results.some((r) => r === true), "at least one call committed");
  assert.equal(commitCount(dir), 1);
  const status = execFileSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8" });
  assert.equal(status.trim(), "");
});
