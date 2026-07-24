import { execFile } from "node:child_process";
import { existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { MEMORY_DIR } from "./ingest.js";

const execFileP = promisify(execFile);

/** Backoff before re-trying a git call that lost the index.lock race. */
const RETRY_DELAYS_MS = [300, 700];
/** An index.lock older than this can't belong to a live add/commit — treat as orphaned. */
const LOCK_STALE_MS = 60_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isIndexLockError(err: unknown): boolean {
  const stderr = (err as { stderr?: string })?.stderr ?? "";
  const message = err instanceof Error ? err.message : "";
  return /index\.lock': File exists/.test(stderr + message);
}

function lockAgeMs(lockPath: string): number {
  try {
    return Date.now() - statSync(lockPath).mtimeMs;
  } catch {
    return 0; // lock already gone — a plain retry will proceed
  }
}

async function git(dir: string, args: string[]) {
  const lockPath = join(dir, ".git", "index.lock");
  let removedStaleLock = false;
  for (let attempt = 0; ; attempt++) {
    try {
      return await execFileP("git", ["-C", dir, ...args]);
    } catch (err) {
      if (!isIndexLockError(err)) throw err;
      if (!removedStaleLock && lockAgeMs(lockPath) > LOCK_STALE_MS) {
        rmSync(lockPath, { force: true });
        removedStaleLock = true;
        continue;
      }
      if (attempt >= RETRY_DELAYS_MS.length) throw err;
      await sleep(RETRY_DELAYS_MS[attempt] ?? 0);
    }
  }
}

/** Serializes commitMemoryRepo calls so concurrent callers can't race on index.lock. */
let queue: Promise<unknown> = Promise.resolve();

/** Stage + commit everything in the nested memory repo; false if absent/clean. */
export function commitMemoryRepo(message: string, dir: string = MEMORY_DIR): Promise<boolean> {
  const run = queue.then(async () => {
    if (!existsSync(join(dir, ".git"))) return false;
    await git(dir, ["add", "-A", "."]);
    const { stdout } = await git(dir, ["status", "--porcelain"]);
    if (!stdout.trim()) return false;
    await git(dir, ["commit", "-q", "-m", message]);
    return true;
  });
  queue = run.catch(() => {});
  return run;
}
