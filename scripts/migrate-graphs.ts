#!/usr/bin/env -S npx tsx
/**
 * Idempotent migration: two-graph layout → N-graph layout.
 *
 *   memory-public/  →  memory-graphs/public/   (plain rename — .git history intact)
 *
 * Uses ONLY fs + git (never src/graphs.ts) so it can run while the legacy
 * guard in the engine refuses the old layout. Safe to re-run: every step
 * checks before acting. Take a verified backup first (MEMORY-GUARDRAILS.md).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const OLD_PUBLIC = join(ROOT, "memory-public");
const PARENT = join(ROOT, "memory-graphs");
const NEW_PUBLIC = join(PARENT, "public");

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

function checkpoint(dir: string, msg: string): void {
  if (!existsSync(join(dir, ".git"))) return;
  git(dir, "add", "-A", ".");
  if (git(dir, "status", "--porcelain").trim()) {
    git(dir, "commit", "-q", "-m", msg);
    console.log(`✓ checkpointed ${dir}`);
  }
}

// 1. Checkpoint every nested repo that exists.
checkpoint(join(ROOT, "memory"), "Checkpoint before multi-graph migration");
if (existsSync(OLD_PUBLIC)) checkpoint(OLD_PUBLIC, "Checkpoint before multi-graph migration");

// 2. Relocate the public store — but an EMPTY one is dropped, not carried
//    over (no graph ships by default; an empty store has nothing to keep
//    beyond history of already-deleted entries, and the checkpoint above +
//    the recommended backup preserve that).
function entryCount(dir: string): number {
  const entriesDir = join(dir, "entries");
  if (!existsSync(entriesDir)) return 0;
  let n = 0;
  const walk = (d: string) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      if (ent.isDirectory()) walk(join(d, ent.name));
      else if (ent.name.endsWith(".md")) n++;
    }
  };
  walk(entriesDir);
  return n;
}

if (existsSync(OLD_PUBLIC) && existsSync(NEW_PUBLIC)) {
  console.error("✗ BOTH memory-public/ and memory-graphs/public/ exist — resolve manually before re-running");
  process.exit(1);
} else if (existsSync(OLD_PUBLIC)) {
  if (entryCount(OLD_PUBLIC) === 0) {
    rmSync(OLD_PUBLIC, { recursive: true, force: true });
    console.log("✓ memory-public/ was empty — removed (no graph ships by default; create your own with `memory graphs create`)");
  } else {
    mkdirSync(PARENT, { recursive: true });
    renameSync(OLD_PUBLIC, NEW_PUBLIC);
    console.log("✓ moved memory-public/ → memory-graphs/public/ (.git history intact)");
  }
} else if (existsSync(NEW_PUBLIC)) {
  console.log("✓ memory-graphs/public/ already in place");
} else {
  console.log("✓ no legacy public store — nothing to relocate");
}

// 3. Manifest for the public graph.
const manifest = join(NEW_PUBLIC, "GRAPH.md");
if (existsSync(NEW_PUBLIC) && !existsSync(manifest)) {
  writeFileSync(
    manifest,
    `---
name: public
created: '${new Date().toISOString().slice(0, 10)}'
---

A shareable graph (carried over from the earlier two-graph layout — now an
ordinary named graph). Eligibility: only content every teammate could see —
work artifacts, announced decisions, technical learnings — never anything
about identifiable people's performance, hiring, comp, health, or feelings.
Doubt disqualifies; wrong placements are corrected with
\`memory copy|move <id> --to <graph>\`, never by editing files.
`,
    "utf8",
  );
  checkpoint(NEW_PUBLIC, "Add GRAPH.md manifest");
  console.log("✓ wrote memory-graphs/public/GRAPH.md");
}

// 4. Promotion dismissals gain the per-graph field (reader defaults anyway).
const dismissalsPath = join(ROOT, ".index", "promotion-dismissals.json");
if (existsSync(dismissalsPath)) {
  try {
    const records = JSON.parse(readFileSync(dismissalsPath, "utf8")) as { graph?: string }[];
    if (Array.isArray(records) && records.some((r) => r.graph === undefined)) {
      for (const r of records) r.graph ??= "public";
      writeFileSync(dismissalsPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");
      console.log("✓ promotion dismissals migrated to per-graph records");
    }
  } catch {
    console.warn("⚠ could not parse promotion-dismissals.json — leaving as-is (reader is tolerant)");
  }
}

// 5. Rebuild the index (INDEX_VERSION bump forces it) + consistency check.
execFileSync("npx", ["tsx", "src/cli.ts", "index"], { stdio: "inherit" });
execFileSync("npx", ["tsx", "src/cli.ts", "graphs", "sync", "--dry-run"], { stdio: "inherit" });
if (existsSync(join(ROOT, "memory", "routing"))) {
  console.log("ℹ memory/routing/ is a leftover from the removed routing-prompt feature — safe to delete.");
}
console.log("Done. Layout: memory/ (the default graph) + memory-graphs/<name>/ (shared graphs).");
