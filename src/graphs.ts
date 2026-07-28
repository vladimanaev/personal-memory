import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { promisify } from "node:util";
import matter from "gray-matter";
import {
  GraphManifestSchema,
  DEFAULT_GRAPH,
  sortGraphs,
  type GraphId,
  type GraphManifest,
  type MemoryEntry,
} from "./schema.js";

export { DEFAULT_GRAPH, sortGraphs, type GraphId };

const execFileP = promisify(execFile);

const ROOT = process.cwd();

/** Parent directory holding every non-private graph store. */
export const GRAPHS_PARENT = "memory-graphs";

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
/** Names that can never be graph slugs (route/CLI collisions). */
const RESERVED_SLUGS = new Set([DEFAULT_GRAPH, "private", "rules", "memory"]);

/** One physical memory store (a nested git repo of Markdown entries). */
export interface Store {
  graph: GraphId;
  dir: string;
  entriesDir: string;
  summariesDir: string;
  /** `GRAPH.md` location; present but unused for the private store. */
  manifestPath: string;
}

function storeAt(graph: GraphId, dir: string): Store {
  return {
    graph,
    dir,
    entriesDir: join(dir, "entries"),
    summariesDir: join(dir, "summaries"),
    manifestPath: join(dir, "GRAPH.md"),
  };
}

/**
 * The graph registry under an arbitrary root — exported for tests. Registry =
 * directory existence: `memory/` is always the private graph; every
 * slug-shaped directory under `memory-graphs/` is a named graph.
 *
 * Refuses to run on the pre-multi-graph layout: an existing `memory-public/`
 * would otherwise be silently misclassified as private.
 */
export function storesUnder(root: string): Map<GraphId, Store> {
  if (existsSync(join(root, "memory-public"))) {
    throw new Error(
      "legacy memory-public/ layout detected — run: npx tsx scripts/migrate-graphs.ts",
    );
  }
  const stores = new Map<GraphId, Store>();
  stores.set(DEFAULT_GRAPH, storeAt(DEFAULT_GRAPH, join(root, "memory")));
  const parent = join(root, GRAPHS_PARENT);
  if (existsSync(parent)) {
    for (const ent of readdirSync(parent, { withFileTypes: true })) {
      if (ent.isDirectory() && SLUG_RE.test(ent.name) && !stores.has(ent.name)) {
        stores.set(ent.name, storeAt(ent.name, join(parent, ent.name)));
      }
    }
  }
  return stores;
}

/**
 * The default (home) store is layout-independent (always `<root>/memory`)
 * and must be resolvable WITHOUT scanning the registry — module-level
 * constants (ingest paths, git dirs) depend on it at import time, before the
 * legacy layout guard is relevant.
 */
const DEFAULT_STORE = storeAt(DEFAULT_GRAPH, join(ROOT, "memory"));

// The registry is cheap to build but read constantly; cache per process and
// invalidate on any operation that changes the set of graphs. The long-lived
// UI server must invalidate after createGraph.
let storeCache: Map<GraphId, Store> | null = null;

function stores(): Map<GraphId, Store> {
  if (!storeCache) storeCache = storesUnder(ROOT);
  return storeCache;
}

export function invalidateStoreCache(): void {
  storeCache = null;
}

/** Registry listing, private first. */
export function listGraphStores(): Store[] {
  const all = stores();
  return sortGraphs(all.keys()).map((g) => all.get(g)!);
}

export function storeFor(graph: GraphId): Store {
  if (graph === DEFAULT_GRAPH) return DEFAULT_STORE; // registry-free fast path
  const store = stores().get(graph);
  if (!store) {
    throw new Error(
      `unknown graph '${graph}' — existing: ${sortGraphs(stores().keys()).join(", ")}; ` +
        `create with: cli.ts graphs create <slug>`,
    );
  }
  return store;
}

/**
 * Which graph a file path belongs to: longest store-dir prefix wins (with a
 * trailing separator so lookalike dirs never match); anything outside every
 * registered store is private by definition.
 */
export function graphOfPath(absPath: string, s: Map<GraphId, Store> = stores()): GraphId {
  let best: { graph: GraphId; len: number } | null = null;
  for (const store of s.values()) {
    if (absPath === store.dir || absPath.startsWith(store.dir + sep)) {
      if (!best || store.dir.length > best.len) best = { graph: store.graph, len: store.dir.length };
    }
  }
  return best?.graph ?? DEFAULT_GRAPH;
}

/** Validate a CLI/API-supplied graph name against the registry. */
export function requireGraph(v: unknown): GraphId {
  if (typeof v !== "string" || !SLUG_RE.test(v)) {
    throw new Error(`invalid graph '${String(v)}' — expected a lower-kebab graph name`);
  }
  storeFor(v); // throws with the registry listing on miss
  return v;
}

/** Validate a slug for graph CREATION (shape, not reserved, not existing). */
export function parseNewGraphSlug(v: unknown): string {
  if (typeof v !== "string" || !SLUG_RE.test(v)) {
    throw new Error(`invalid graph slug '${String(v)}' — must be lower-kebab (a-z, 0-9, -)`);
  }
  if (RESERVED_SLUGS.has(v)) throw new Error(`'${v}' is a reserved name`);
  if (stores().has(v)) throw new Error(`graph '${v}' already exists`);
  return v;
}

function storeReadme(graph: GraphId): string {
  return `# ${graph} — shareable memory graph

One named graph of a personal-memory store. Every entry in this repo was
deliberately placed here as appropriate for this graph's audience (see
GRAPH.md); it is fully self-contained and never references anything outside
this graph — not even by id.

The search index is a derived artifact and is never stored here; rebuild it
from these Markdown files with \`npx tsx src/cli.ts index\`.
`;
}

function manifestFile(fm: GraphManifest, body: string): string {
  return matter.stringify(`\n${body.trim()}\n`, fm);
}

/**
 * Seed body for a new graph's GRAPH.md: the user's description followed by a
 * generic eligibility template agents consult before placing anything here.
 * Fully editable afterwards (by hand or the web UI).
 */
function seedManifestBody(slug: string, description?: string): string {
  return `${description?.trim() || `Shared memory graph '${slug}'.`}

## Eligibility — what belongs in this graph

An entry qualifies ONLY when ALL of these hold (edit to fit this audience):

- The user could hand this graph's whole store to its audience unedited.
- It is about work artifacts, not people's behavior or performance: announced
  decisions and their rationale, technical learnings, project facts,
  processes — never feelings, 1:1s, hiring, compensation, health, or
  anything shared in confidence.
- Every named person appears only in a neutral factual role and is never
  evaluated.

Doubt disqualifies: when unsure, the entry stays in the default graph.
Wrong placements are corrected with \`memory copy|move <id> --to <graph>\`,
never by editing files.`;
}

/**
 * Make sure a store exists on disk. For non-private graphs this also
 * initializes the nested git repo, README, and GRAPH.md the first time, so
 * write paths self-heal on a fresh checkout. The private store is expected
 * to pre-exist; only its directories are ensured.
 */
export async function ensureStore(graph: GraphId): Promise<Store> {
  const store = storeFor(graph);
  await mkdir(store.entriesDir, { recursive: true });
  await mkdir(store.summariesDir, { recursive: true });
  if (graph !== DEFAULT_GRAPH && !existsSync(join(store.dir, ".git"))) {
    if (!existsSync(store.manifestPath)) {
      await writeFile(
        store.manifestPath,
        manifestFile(GraphManifestSchema.parse({ name: graph }), seedManifestBody(graph)),
        "utf8",
      );
    }
    const readme = join(store.dir, "README.md");
    if (!existsSync(readme)) await writeFile(readme, storeReadme(graph), "utf8");
    await execFileP("git", ["-C", store.dir, "init", "-q"]);
    await execFileP("git", ["-C", store.dir, "add", "-A", "."]);
    await execFileP("git", ["-C", store.dir, "commit", "-q", "-m", `Initialize memory graph: ${graph}`]);
  }
  return store;
}

/** Create a brand-new named graph: directory, GRAPH.md, git repo, initial commit. */
export async function createGraph(opts: {
  slug: string;
  displayName?: string;
  description?: string;
}): Promise<Store> {
  const slug = parseNewGraphSlug(opts.slug);
  const dir = join(ROOT, GRAPHS_PARENT, slug);
  const store = storeAt(slug, dir);
  await mkdir(store.entriesDir, { recursive: true });
  await mkdir(store.summariesDir, { recursive: true });
  const fm = GraphManifestSchema.parse({
    name: slug,
    ...(opts.displayName ? { display_name: opts.displayName } : {}),
    created: new Date().toISOString().slice(0, 10),
  });
  await writeFile(
    store.manifestPath,
    manifestFile(fm, seedManifestBody(slug, opts.description)),
    "utf8",
  );
  await writeFile(join(dir, "README.md"), storeReadme(slug), "utf8");
  await execFileP("git", ["-C", dir, "init", "-q"]);
  await execFileP("git", ["-C", dir, "add", "-A", "."]);
  await execFileP("git", ["-C", dir, "commit", "-q", "-m", `Initialize memory graph: ${slug}`]);
  invalidateStoreCache();
  return storeFor(slug);
}

/** Parse + validate one graph's GRAPH.md; null when absent (e.g. private). */
export async function loadGraphManifest(
  store: Store,
): Promise<{ fm?: GraphManifest; body?: string; raw: string; error?: string } | null> {
  if (!existsSync(store.manifestPath)) return null;
  const raw = await readFile(store.manifestPath, "utf8");
  try {
    const { data, content } = matter(raw);
    const parsed = GraphManifestSchema.safeParse(data);
    if (!parsed.success) {
      throw new Error(
        parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
      );
    }
    if (parsed.data.name !== store.graph) {
      throw new Error(`manifest name '${parsed.data.name}' must equal the directory slug '${store.graph}'`);
    }
    return { fm: parsed.data, body: content.trim(), raw };
  } catch (err) {
    return { raw, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Validated write of a graph's GRAPH.md (atomic tmp+rename semantics not needed — single small file). */
export async function writeGraphManifest(graph: GraphId, raw: string): Promise<string> {
  const store = storeFor(graph);
  if (graph === DEFAULT_GRAPH) throw new Error("the private graph has no manifest");
  const { data } = matter(raw);
  const parsed = GraphManifestSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(
      `invalid graph manifest:\n` +
        parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n"),
    );
  }
  if (parsed.data.name !== graph) {
    throw new Error(`manifest name '${parsed.data.name}' must equal the directory slug '${graph}'`);
  }
  await writeFile(store.manifestPath, raw, "utf8");
  return store.manifestPath;
}

/**
 * Enforce the CONTAINMENT invariant: every non-private graph is fully
 * self-contained — an entry that is a member of graph g may only reference
 * (`follows` / `sources`) entries that are ALSO members of g, so a
 * handed-over store leaks nothing and dangles nothing. The private graph is
 * exempt (it is never handed over, and may reference anything). Ids missing
 * from `byId` are ignored here (existence is validated separately).
 */
export function validateContainment(
  byId: Map<string, Pick<MemoryEntry, "graphs">>,
  source: { id: string; graphs: string[] },
  targets: string[],
): void {
  for (const g of source.graphs) {
    if (g === DEFAULT_GRAPH) continue;
    const violations = targets.filter((id) => {
      const t = byId.get(id);
      return t !== undefined && !t.graphs.includes(g);
    });
    if (violations.length > 0) {
      throw new Error(
        `entry '${source.id}' is a member of graph '${g}' but references entries that are not: ${violations.join(", ")}\n` +
          `(each shared graph must be self-contained. Either copy the targets first —\n` +
          ` cli.ts copy <id> --to ${g} — or keep this entry out of '${g}'.)`,
      );
    }
  }
}
