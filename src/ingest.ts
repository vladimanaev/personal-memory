import { createHash } from "node:crypto";
import { readFile, readdir, mkdir, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import matter from "gray-matter";
import {
  FrontmatterSchema,
  DEFAULT_GRAPH,
  sortGraphs,
  type Frontmatter,
  type MemoryEntry,
} from "./schema.js";
import { graphOfPath, listGraphStores, storeFor, type GraphId } from "./graphs.js";

export const ROOT = process.cwd();
export const MEMORY_DIR = storeFor(DEFAULT_GRAPH).dir;
export const ENTRIES_DIR = storeFor(DEFAULT_GRAPH).entriesDir;
export const SUMMARIES_DIR = storeFor(DEFAULT_GRAPH).summariesDir;
export const INDEX_DIR = join(ROOT, ".index");

// Hashes memoized by the entry-cache loader so sync never recomputes them.
const hashMemo = new WeakMap<MemoryEntry, string>();

/** The canonical content hash: frontmatter (minus `updated`) + body. */
function hashOf(fm: Frontmatter, body: string): string {
  const { updated: _u, ...rest } = fm;
  const h = createHash("sha256");
  h.update(JSON.stringify({ ...rest, body }));
  return h.digest("hex").slice(0, 16);
}

/** Stable content hash for incremental indexing (frontmatter + body). */
export function hashEntry(e: MemoryEntry): string {
  const memo = hashMemo.get(e);
  if (memo) return memo;
  const hash = hashOf(frontmatterOf(e), e.body);
  hashMemo.set(e, hash);
  return hash;
}

function frontmatterOf(e: MemoryEntry): Frontmatter {
  // `updated` is excluded so a refresh-date bump never churns the index and so
  // content-equality can be tested via the hash alone. `graphs`/`paths` are
  // excluded because membership is derived from location — copying or moving
  // an entry between stores must never change its content hash.
  const { body: _b, path: _p, updated: _u, graphs: _g, paths: _ps, ...fm } = e;
  return fm;
}

/**
 * Normalize a canonical external source id to `scheme:rest` (scheme lowercased).
 * Throws on a malformed id so bad ids never silently become non-matching keys.
 */
export function normalizeSourceId(raw: string): string {
  const s = raw.trim();
  const i = s.indexOf(":");
  if (i <= 0 || i === s.length - 1) {
    throw new Error(
      `invalid source id '${raw}' — expected '<scheme>:<rest>', e.g. slack:C123:1700000000.1 or gmail:<thread-id>`,
    );
  }
  return `${s.slice(0, i).toLowerCase()}:${s.slice(i + 1)}`;
}

/** First entry whose source_ids intersect any of `ids` (the dedup anchor). */
export function findEntryBySourceIds(
  entries: MemoryEntry[],
  ids: string[],
): MemoryEntry | undefined {
  if (ids.length === 0) return undefined;
  const want = new Set(ids);
  return entries.find((e) => (e.source_ids ?? []).some((s) => want.has(s)));
}

/** Recursively list all .md files under a directory. */
async function listMarkdown(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await listMarkdown(p)));
    else if (ent.isFile() && ent.name.endsWith(".md")) out.push(p);
  }
  return out;
}

/** One store's materialization of an entry (pre-grouping). */
export interface FileEntry extends Frontmatter {
  body: string;
  path: string;
  graph: GraphId;
  hash: string;
}

/** Parse + validate one Markdown memory file. Throws with the path on bad data. */
export async function parseEntry(path: string): Promise<FileEntry> {
  const raw = await readFile(path, "utf8");
  const { data, content } = matter(raw);
  const parsed = FrontmatterSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(
      `Invalid frontmatter in ${relative(ROOT, path)}:\n` +
        parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n"),
    );
  }
  const fm = parsed.data;
  const body = content.trim();
  return { ...fm, body, path, graph: graphOfPath(path), hash: hashOf(fm, body) };
}

// --- parsed-entry cache -------------------------------------------------
// `.index/entries-cache.json` memoizes parse + hash per file, keyed by
// (mtimeMs, size). Derived data only: delete `.index/` and it regenerates.
// Cache hits skip Zod re-validation — the file was validated when parsed.

const ENTRY_CACHE_PATH = join(INDEX_DIR, "entries-cache.json");
const ENTRY_CACHE_VERSION = 1;

interface CachedFile {
  mtimeMs: number;
  size: number;
  hash: string;
  fm: Frontmatter;
  body: string;
}

interface EntryCache {
  version: number;
  files: Record<string, CachedFile>; // key: path relative to ROOT
}

async function readEntryCache(): Promise<EntryCache> {
  try {
    const cache = JSON.parse(await readFile(ENTRY_CACHE_PATH, "utf8")) as EntryCache;
    if (cache.version === ENTRY_CACHE_VERSION && cache.files) return cache;
  } catch {
    // missing or corrupt — rebuild from scratch below
  }
  return { version: ENTRY_CACHE_VERSION, files: {} };
}

/** Load every materialization across all registered stores, via the parse cache. */
export async function loadEntryFiles(): Promise<FileEntry[]> {
  const files: string[] = [];
  for (const store of listGraphStores()) {
    files.push(...(await listMarkdown(store.entriesDir)), ...(await listMarkdown(store.summariesDir)));
  }
  const cache = await readEntryCache();
  let dirty = false;

  const seen = new Set<string>();
  const parsed = await Promise.all(
    files.map(async (path): Promise<FileEntry> => {
      const rel = relative(ROOT, path);
      seen.add(rel);
      const st = await stat(path);
      const cached = cache.files[rel];
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
        // `graph` is re-derived from the path, never trusted from the cache.
        return { ...cached.fm, body: cached.body, path, graph: graphOfPath(path), hash: cached.hash };
      }
      const file = await parseEntry(path);
      const { body: _b, path: _p, graph: _g, hash: _h, ...fm } = file;
      cache.files[rel] = {
        mtimeMs: st.mtimeMs,
        size: st.size,
        hash: file.hash,
        fm,
        body: file.body,
      };
      dirty = true;
      return file;
    }),
  );

  for (const rel of Object.keys(cache.files)) {
    if (!seen.has(rel)) {
      delete cache.files[rel];
      dirty = true;
    }
  }

  if (dirty) {
    await mkdir(INDEX_DIR, { recursive: true });
    await writeFile(ENTRY_CACHE_PATH, JSON.stringify(cache), "utf8");
  }
  return parsed;
}

/** One id whose materializations disagree in content — repair via `graphs sync`. */
export interface CopyDrift {
  id: string;
  copies: { graph: GraphId; path: string; hash: string }[];
}

/**
 * Group per-store materializations into logical entries (synced-copy
 * membership model). All copies of an id must be content-identical; a
 * mismatch is DRIFT — thrown by default (reads must never silently pick a
 * side or write repairs) or collected for `graphs sync`.
 */
export function groupEntries(
  files: FileEntry[],
  onDrift: "throw" | "collect" = "throw",
): { entries: MemoryEntry[]; drift: CopyDrift[] } {
  const byId = new Map<string, FileEntry[]>();
  for (const f of files) {
    const group = byId.get(f.id);
    if (group) group.push(f);
    else byId.set(f.id, [f]);
  }

  const entries: MemoryEntry[] = [];
  const drift: CopyDrift[] = [];
  for (const [id, group] of byId) {
    if (new Set(group.map((f) => f.hash)).size > 1) {
      const d: CopyDrift = {
        id,
        copies: group.map((f) => ({ graph: f.graph, path: f.path, hash: f.hash })),
      };
      if (onDrift === "throw") {
        throw new Error(
          `graph copies of '${id}' have drifted apart:\n` +
            d.copies.map((c) => `  - [${c.graph}] ${relative(ROOT, c.path)} (${c.hash})`).join("\n") +
            `\nRepair with: npx tsx src/cli.ts graphs sync   (the private copy wins)`,
        );
      }
      drift.push(d);
      continue;
    }
    const graphs = sortGraphs(group.map((f) => f.graph));
    const paths: Record<string, string> = {};
    for (const f of group) paths[f.graph] = f.path;
    const home = group.find((f) => f.graph === DEFAULT_GRAPH) ?? group[0]!;
    const { graph: _g, hash, ...rest } = home;
    const entry: MemoryEntry = { ...rest, path: home.path, graphs, paths };
    hashMemo.set(entry, hash);
    entries.push(entry);
  }
  return { entries, drift };
}

/** Load every memory as logical entries (grouped across stores). Throws on drift. */
export async function loadAllEntries(): Promise<MemoryEntry[]> {
  return groupEntries(await loadEntryFiles(), "throw").entries;
}

function csv(xs: string[] | undefined): string {
  return xs?.length ? xs.join(", ") : "";
}

/** Compact metadata header included in lexical and semantic retrieval text. */
export function entryMetadataText(e: MemoryEntry): string {
  const lines = [
    `title: ${e.title}`,
    `id: ${e.id}`,
    `type: ${e.type}`,
    `date: ${e.date}`,
    `people: ${csv(e.people)}`,
    `teams: ${csv(e.teams)}`,
    `tags: ${csv(e.tags)}`,
    `sources: ${csv(e.sources)}`,
    `follows: ${csv(e.follows)}`,
    `source_ids: ${csv(e.source_ids)}`,
  ];
  return lines.filter((line) => !line.endsWith(": ")).join("\n");
}

/** Full text used by the lexical index. */
export function entrySearchText(e: MemoryEntry): string {
  return `${entryMetadataText(e)}\n\nbody:\n${e.body}`.trim();
}

/**
 * Remove retrieval-only metadata so snippets shown to users stay focused on the
 * memory body.
 */
export function displayChunkText(text: string): string {
  return text
    .replace(/^# .*\n+/, "")
    .replace(/^title: .*\n/, "")
    .replace(/^id: .*\n/, "")
    .replace(/^type: .*\n/, "")
    .replace(/^date: .*\n/, "")
    .replace(/^people: .*\n/, "")
    .replace(/^teams: .*\n/, "")
    .replace(/^tags: .*\n/, "")
    .replace(/^sources: .*\n/, "")
    .replace(/^follows: .*\n/, "")
    .replace(/^source_ids: .*\n/, "")
    .replace(/^\n+body:\n/, "")
    .replace(/^body:\n/, "")
    .trim();
}

/**
 * Split an entry into embeddable chunks. Entries are short, so most produce a
 * single chunk; long bodies are split on paragraph boundaries (~1200 chars).
 * Each chunk is prefixed with metadata for retrieval context.
 */
export function chunkEntry(e: MemoryEntry, maxChars = 1200): string[] {
  const paras = e.body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let buf = "";
  for (const p of paras) {
    if (buf && buf.length + p.length + 2 > maxChars) {
      chunks.push(buf);
      buf = p;
    } else {
      buf = buf ? `${buf}\n\n${p}` : p;
    }
  }
  if (buf) chunks.push(buf);
  if (chunks.length === 0) chunks.push("");
  const metadata = entryMetadataText(e);
  return chunks.map((c) => `# ${e.title}\n\n${metadata}\n\nbody:\n${c}`.trim());
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** Build a stable, date-prefixed id from a date + title. */
export function makeId(date: string, title: string): string {
  return `${date}-${slugify(title)}`;
}

/** Target path for an entry, partitioned by year/month (summaries are flat). */
export function entryPath(fm: Frontmatter, graph: GraphId = DEFAULT_GRAPH): string {
  const store = storeFor(graph);
  if (fm.type === "summary") return join(store.summariesDir, `${fm.id}.md`);
  const [year, month] = fm.date.split("-");
  return join(store.entriesDir, year!, month!, `${fm.id}.md`);
}

/**
 * Materialize an entry's content to EVERY member store — the write primitive
 * for content mutations of existing entries (re-captures, links, slug
 * merges). One serialization, byte-identical files, so the copy-sync
 * invariant holds by construction. Returns graph → path written.
 */
export async function writeEntryAll(
  fm: Frontmatter,
  body: string,
  graphs: string[],
): Promise<Record<string, string>> {
  const file = matter.stringify(`\n${body.trim()}\n`, fm);
  const out: Record<string, string> = {};
  for (const graph of graphs) {
    const path = entryPath(fm, graph);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, file, "utf8");
    out[graph] = path;
  }
  return out;
}

/** Serialize + write a memory file (creating dirs). Returns the path written. */
export async function writeEntry(
  fm: Frontmatter,
  body: string,
  graph: GraphId = DEFAULT_GRAPH,
): Promise<string> {
  const path = entryPath(fm, graph);
  await mkdir(join(path, ".."), { recursive: true });
  // gray-matter stringify keeps key order predictable & arrays inline-friendly.
  const file = matter.stringify(`\n${body.trim()}\n`, fm);
  await writeFile(path, file, "utf8");
  return path;
}

export async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
