import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { MEMORY_DIR } from "./ingest.js";

const execFileP = promisify(execFile);

/** Stage + commit everything in the nested memory repo; false if absent/clean. */
export async function commitMemoryRepo(message: string): Promise<boolean> {
  if (!existsSync(join(MEMORY_DIR, ".git"))) return false;
  await execFileP("git", ["-C", MEMORY_DIR, "add", "-A", "."]);
  const { stdout } = await execFileP("git", ["-C", MEMORY_DIR, "status", "--porcelain"]);
  if (!stdout.trim()) return false;
  await execFileP("git", ["-C", MEMORY_DIR, "commit", "-q", "-m", message]);
  return true;
}
