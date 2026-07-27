import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { promisify } from "node:util";
import { GRAPH_IDS, type GraphId, type MemoryEntry } from "./schema.js";

export { GRAPH_IDS, type GraphId };

const execFileP = promisify(execFile);

const ROOT = process.cwd();

/** One physical memory store (a nested git repo of Markdown entries). */
export interface Store {
  graph: GraphId;
  dir: string;
  entriesDir: string;
  summariesDir: string;
}

function storeAt(graph: GraphId, dir: string): Store {
  return { graph, dir, entriesDir: join(dir, "entries"), summariesDir: join(dir, "summaries") };
}

/** Store layouts under an arbitrary root — exported for tests (no chdir needed). */
export function storesUnder(root: string): Record<GraphId, Store> {
  return {
    private: storeAt("private", join(root, "memory")),
    public: storeAt("public", join(root, "memory-public")),
  };
}

const STORES = storesUnder(ROOT);

export function storeFor(graph: GraphId): Store {
  return STORES[graph];
}

/**
 * Which graph a file path belongs to. Checks the public store's prefix with a
 * trailing separator so `memory-public/…` never false-matches `memory/…` (or
 * vice versa); anything outside the public store is private by definition.
 */
export function graphOfPath(absPath: string, stores: Record<GraphId, Store> = STORES): GraphId {
  return absPath === stores.public.dir || absPath.startsWith(stores.public.dir + sep)
    ? "public"
    : "private";
}

/** Validate a CLI-supplied graph value; throws a readable error otherwise. */
export function parseGraphId(v: unknown): GraphId {
  if (v === "private" || v === "public") return v;
  throw new Error(`invalid graph '${String(v)}' — expected 'private' or 'public'`);
}

const PUBLIC_README = `# memory-public

Shareable memory graph — the public half of a personal-memory store. Every
entry in this repo was deliberately routed here as safe to share; it must
never reference anything in the private graph (not even by id).

The search index is a derived artifact and is never stored here; rebuild it
from these Markdown files with \`npx tsx src/cli.ts index\`.
`;

/**
 * Make sure a store exists on disk. For the public store this also
 * initializes its own nested git repo (with a committed README) the first
 * time, so `add --graph public` self-heals on a fresh checkout. The private
 * store is expected to pre-exist; only its directories are ensured.
 */
export async function ensureStore(graph: GraphId): Promise<Store> {
  const store = storeFor(graph);
  await mkdir(store.entriesDir, { recursive: true });
  await mkdir(store.summariesDir, { recursive: true });
  if (graph === "public" && !existsSync(join(store.dir, ".git"))) {
    await execFileP("git", ["-C", store.dir, "init", "-q"]);
    const readme = join(store.dir, "README.md");
    if (!existsSync(readme)) await writeFile(readme, PUBLIC_README, "utf8");
    await execFileP("git", ["-C", store.dir, "add", "-A", "."]);
    await execFileP("git", ["-C", store.dir, "commit", "-q", "-m", "Initialize public memory graph"]);
  }
  return store;
}

/**
 * Enforce the cross-graph link direction: PRIVATE entries may reference public
 * ones, but a PUBLIC entry must never reference a private id — a handed-over
 * public store must leak nothing, not even ids. `targets` are the referenced
 * entry ids (`follows` + `sources`); ids missing from `byId` are ignored here
 * (existence is validated separately).
 */
export function validateCrossGraphLinks(
  byId: Map<string, MemoryEntry>,
  source: { id: string; graph: GraphId },
  targets: string[],
): void {
  if (source.graph !== "public") return;
  const violations = targets.filter((id) => byId.get(id)?.graph === "private");
  if (violations.length > 0) {
    throw new Error(
      `public entry '${source.id}' cannot reference private entries: ${violations.join(", ")}\n` +
        `(private→public links are fine; the reverse would leak private ids into the shareable store.\n` +
        ` Either keep this entry private, or move the targets public first: cli.ts move <id> --to public)`,
    );
  }
}
