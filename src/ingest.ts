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
  const { updated: _u, variant_of_hash: _v, ...rest } = fm;
  const h = createHash("sha256");
  h.update(JSON.stringify({ ...rest, body }));
  return h.digest("hex").slice(0, 16);
}

/**
 * Hash of a body alone — the anchor a declared variant records in its
 * `variant_of_hash`. Body-only so a frontmatter change (a tag merge, a new
 * chain link) propagates to the variant without marking it stale; only a
 * change to the words themselves means the published redaction is out of date.
 */
export function hashBody(body: string): string {
  return createHash("sha256").update(body.trim()).digest("hex").slice(0, 16);
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
  // an entry between stores must never change its content hash. `variants` is
  // excluded for the same reason: publishing a redaction into a shared graph
  // is a membership event, and if it moved the logical hash it would churn the
  // index and invalidate every promotion dismissal keyed on that hash.
  const { body: _b, path: _p, updated: _u, graphs: _g, paths: _ps, variants: _v, ...fm } = e;
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
  if (s.includes("|")) throw new Error(`invalid source id '${raw}' — must not contain '|'`);
  return `${s.slice(0, i).toLowerCase()}:${s.slice(i + 1)}`;
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

/**
 * Whether any store holds at least one entry file. A directory listing only —
 * nothing is parsed and no cache is written — so a read path can tell "this
 * store is empty" apart from "this store has entries but no index yet".
 */
export async function hasAnyEntryFile(): Promise<boolean> {
  for (const store of listGraphStores()) {
    if ((await listMarkdown(store.entriesDir)).length > 0) return true;
    if ((await listMarkdown(store.summariesDir)).length > 0) return true;
  }
  return false;
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
 * A declared variant whose home body has changed since it was approved. The
 * published copy is still valid — it is simply behind — so this is reported,
 * never repaired: overwriting a redaction with the home's raw bytes is the
 * exact leak the variant mechanism exists to prevent.
 */
export interface StaleVariant {
  id: string;
  graph: GraphId;
  path: string;
  /** The home body hash the copy was approved against. */
  declared: string;
  /** The home body hash now. */
  home: string;
}

/**
 * A copy claiming to be a variant that cannot be one: `variant_of_hash` on the
 * default-graph file (the home is not a variant of itself), or on a copy whose
 * entry has no home at all (nothing to diverge from). Reported, never honored.
 */
export interface VariantViolation {
  id: string;
  graph: GraphId;
  path: string;
  reason: "home-declares-variant" | "no-home";
}

/**
 * Group per-store materializations into logical entries (synced-copy
 * membership model). Copies of an id must be content-identical UNLESS a
 * shared-graph copy declares `variant_of_hash` — a user-approved redaction
 * published through the review queue. An undeclared mismatch is DRIFT —
 * thrown by default (reads must never silently pick a side or write repairs)
 * or collected for `graphs sync`.
 *
 * A declared variant never throws, even when its home has moved on: the
 * published copy is still a valid thing to have shared, just behind. It comes
 * back in `staleVariants` for `graphs sync` to report and the review queue to
 * re-propose.
 */
export function groupEntries(
  files: FileEntry[],
  onDrift: "throw" | "collect" = "throw",
): {
  entries: MemoryEntry[];
  drift: CopyDrift[];
  staleVariants: StaleVariant[];
  variantViolations: VariantViolation[];
} {
  const byId = new Map<string, FileEntry[]>();
  for (const f of files) {
    const group = byId.get(f.id);
    if (group) group.push(f);
    else byId.set(f.id, [f]);
  }

  const entries: MemoryEntry[] = [];
  const drift: CopyDrift[] = [];
  const staleVariants: StaleVariant[] = [];
  const variantViolations: VariantViolation[] = [];
  for (const [id, group] of byId) {
    // A variant is only meaningful against a private home to diverge from, and
    // the home itself can never be one. Anything else claiming to be a variant
    // is demoted to a plain copy, so it still faces the drift check below
    // rather than using the field to hide a real mismatch.
    const homeFile = group.find((f) => f.graph === DEFAULT_GRAPH);
    const variantFiles: FileEntry[] = [];
    const plain: FileEntry[] = [];
    for (const f of group) {
      if (f.variant_of_hash === undefined) {
        plain.push(f);
      } else if (f.graph === DEFAULT_GRAPH) {
        variantViolations.push({ id, graph: f.graph, path: f.path, reason: "home-declares-variant" });
        plain.push(f);
      } else if (!homeFile) {
        variantViolations.push({ id, graph: f.graph, path: f.path, reason: "no-home" });
        plain.push(f);
      } else {
        variantFiles.push(f);
      }
    }

    if (new Set(plain.map((f) => f.hash)).size > 1) {
      const d: CopyDrift = {
        id,
        copies: plain.map((f) => ({ graph: f.graph, path: f.path, hash: f.hash })),
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
    // The logical entry is always the home's content — including its body, so
    // the index and every hash-keyed decision stay anchored to the private
    // original rather than to whichever redaction happens to exist.
    const home = homeFile ?? plain[0] ?? group[0]!;
    const { graph: _g, hash, ...rest } = home;
    const entry: MemoryEntry = { ...rest, path: home.path, graphs, paths };

    if (variantFiles.length > 0) {
      const homeBodyHash = hashBody(home.body);
      const variants: Record<string, string> = {};
      for (const f of variantFiles) {
        const declared = f.variant_of_hash!;
        variants[f.graph] = declared;
        if (declared !== homeBodyHash) {
          staleVariants.push({ id, graph: f.graph, path: f.path, declared, home: homeBodyHash });
        }
      }
      entry.variants = variants;
    }

    hashMemo.set(entry, hash);
    entries.push(entry);
  }
  return { entries, drift, staleVariants, variantViolations };
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

/**
 * How many times the title is repeated in the lexical text (BM25 has no
 * field weighting). 1 = the established text; the evaluation harness sets
 * MEMORY_LEXICAL_TITLE_REPEAT to measure alternatives. Recorded in the
 * lexical index file so a change triggers an in-process rebuild.
 */
export const LEXICAL_TITLE_REPEAT = Math.max(1, Math.floor(Number(process.env.MEMORY_LEXICAL_TITLE_REPEAT ?? 1)) || 1);

/** Full text used by the lexical index. */
export function entrySearchText(e: MemoryEntry, titleRepeat: number = LEXICAL_TITLE_REPEAT): string {
  const extraTitles = titleRepeat > 1 ? `${Array(titleRepeat - 1).fill(`title: ${e.title}`).join("\n")}\n` : "";
  return `${extraTitles}${entryMetadataText(e)}\n\nbody:\n${e.body}`.trim();
}

/**
 * Title + metadata only — the text behind the header leg's per-entry vector,
 * so a short, title-like question matches the entry it names instead of
 * being diluted by a long body.
 */
export function headerText(e: MemoryEntry): string {
  return `# ${e.title}\n\n${entryMetadataText(e)}`;
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
 * merges, due dates). Takes the entry's `paths` map: the graphs to write are
 * its keys, and the declared variants among them are read from it.
 *
 * Copies are byte-identical EXCEPT a shared copy declaring `variant_of_hash`,
 * which takes the new frontmatter and keeps its own approved body. Returns
 * graph → path written.
 */
export async function writeEntryAll(
  fm: Frontmatter,
  body: string,
  paths: Record<string, string>,
): Promise<Record<string, string>> {
  // Variants are read HERE, from the one map the caller already has, rather
  // than taken as an argument. Twice now a caller has forgotten to pass them
  // — the slug merge, and the due-date command — and each time the result was
  // a declared variant's approved redaction being overwritten with the
  // private body, silently, because rebuilding its frontmatter also dropped
  // `variant_of_hash` and left `graphs sync` with nothing to notice. An
  // optional argument whose absence means "republish private text" is not a
  // safe API, and a REQUIRED one would only have turned the next mistake into
  // a caller passing `{}`. Deriving the graph list from the same map closes
  // the gap entirely: there is no longer anything to get wrong.
  const variants = await readVariants(paths);
  const { variant_of_hash: _v, ...plainFm } = fm;
  const file = matter.stringify(`\n${body.trim()}\n`, plainFm);
  const out: Record<string, string> = {};
  for (const graph of Object.keys(paths)) {
    const path = entryPath(fm, graph);
    await mkdir(join(path, ".."), { recursive: true });
    const declared = variants[graph];
    if (declared === undefined) {
      await writeFile(path, file, "utf8");
      out[graph] = path;
      continue;
    }
    // A declared variant's body is a user-approved redaction — writing the
    // home's body over it would push private wording into a shared store,
    // which is the exact leak the variant mechanism exists to prevent. Sync
    // the frontmatter so tag merges and chain links still propagate, and keep
    // `variant_of_hash` at the home revision it was approved against, so a
    // changed home leaves the copy *stale* and the review queue re-proposes it.
    const existing = matter(await readFile(path, "utf8"));
    await writeFile(
      path,
      matter.stringify(`\n${existing.content.trim()}\n`, { ...plainFm, variant_of_hash: declared }),
      "utf8",
    );
    out[graph] = path;
  }
  return out;
}

/**
 * Read which of an entry's copies are declared variants, graph → the home
 * body hash each was approved against.
 *
 * `groupEntries` fills `MemoryEntry.variants` on the file-loading path, but
 * entries that come from the catalog (every single-entry write path:
 * copy, move, `add --update`, chain links) are built from index rows and have
 * no such field. Those act on one entry at a time, so reading its handful of
 * copies is cheap — and getting it wrong means overwriting a published
 * redaction with private text, so it is never worth guessing.
 */
export async function readVariants(paths: Record<string, string>): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [graph, path] of Object.entries(paths)) {
    if (graph === DEFAULT_GRAPH) continue;
    try {
      const declared = matter(await readFile(path, "utf8")).data["variant_of_hash"];
      if (typeof declared === "string" && declared) out[graph] = declared;
    } catch {
      // unreadable copy — `graphs sync` is the place that reports it
    }
  }
  return out;
}

/**
 * Serialize a declared variant: the entry's own frontmatter plus
 * `variant_of_hash`, over a replacement body. Everything that makes the copy
 * the *same* memory — id, date, type, title, people, tags, `follows`,
 * `sources` — is carried over unchanged, which is what keeps containment,
 * chains and dedup coherent across the two bodies.
 */
export function serializeVariant(e: MemoryEntry, body: string, variantOf: string): string {
  const fm = frontmatterOf(e);
  return matter.stringify(`\n${body.trim()}\n`, { ...fm, variant_of_hash: variantOf });
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
