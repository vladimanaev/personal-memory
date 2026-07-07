import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import type { OptimizeStats } from "@lancedb/lancedb";
import { getEmbedder, type Embedder } from "./embed.js";
import { chunkEntry, displayChunkText, entrySearchText, hashEntry, loadAllEntries, INDEX_DIR } from "./ingest.js";
import { packSlugs, type MemoryEntry, type MemoryRecord } from "./schema.js";
import { readLexical, buildLexical, syncLexical, bm25Scores, tokenize } from "./lexical.js";
import { buildChainIndex, type ChainAnnotation } from "./chains.js";

const META_PATH = join(INDEX_DIR, "meta.json");
const TABLE = "memory";

/**
 * Bump when the row schema or indexing semantics change: a mismatch (including
 * a meta.json written before versioning existed) forces one clean rebuild of
 * the table from the Markdown source of truth. v2: people/teams/tags columns.
 * v3: semantic chunks include compact metadata headers.
 */
const INDEX_VERSION = 3;

interface IndexMeta {
  embedderId: string;
  dim: number;
  indexVersion?: number;
}

async function readMeta(): Promise<IndexMeta | null> {
  try {
    return JSON.parse(await readFile(META_PATH, "utf8")) as IndexMeta;
  } catch {
    return null;
  }
}

async function writeMeta(meta: IndexMeta): Promise<void> {
  await mkdir(INDEX_DIR, { recursive: true });
  await writeFile(META_PATH, JSON.stringify(meta, null, 2), "utf8");
}

async function openTable(db: lancedb.Connection) {
  const names = await db.tableNames();
  return names.includes(TABLE) ? db.openTable(TABLE) : null;
}

function sqlList(ids: string[]): string {
  // ids are validated slugs (safe charset), so simple quoting is sufficient.
  return ids.map((i) => `'${i}'`).join(", ");
}

/** Build the chunk-level records (with vectors) for a set of entries. */
async function recordsFor(entries: MemoryEntry[], embedder: Embedder): Promise<MemoryRecord[]> {
  const pending: { entry: MemoryEntry; chunkIndex: number; text: string; hash: string }[] = [];
  for (const e of entries) {
    const hash = hashEntry(e);
    chunkEntry(e).forEach((text, chunkIndex) => pending.push({ entry: e, chunkIndex, text, hash }));
  }
  const vectors = await embedder.embed(pending.map((p) => p.text));
  return pending.map((p, i) => ({
    rowId: `${p.entry.id}#${p.chunkIndex}`,
    id: p.entry.id,
    chunkIndex: p.chunkIndex,
    date: p.entry.date,
    type: p.entry.type,
    title: p.entry.title,
    path: p.entry.path,
    people: packSlugs(p.entry.people),
    teams: packSlugs(p.entry.teams),
    tags: packSlugs(p.entry.tags),
    hash: p.hash,
    text: p.text,
    vector: vectors[i]!,
  }));
}

/**
 * Incrementally sync the vector index with the Markdown source of truth.
 * Re-embeds only entries whose content hash changed; drops deleted entries.
 * Rebuilds from scratch if the embedder (model/dim) changed.
 */
export async function syncIndex(opts: { force?: boolean } = {}): Promise<{
  added: number;
  removed: number;
  unchanged: number;
}> {
  const embedder = getEmbedder();
  const entries = await loadAllEntries();
  await mkdir(INDEX_DIR, { recursive: true });
  const db = await lancedb.connect(INDEX_DIR);

  const meta = await readMeta();
  const embedderChanged = !meta || meta.embedderId !== embedder.id || meta.dim !== embedder.dim;
  const versionChanged = meta?.indexVersion !== INDEX_VERSION;
  const force = opts.force || embedderChanged || versionChanged;

  if (force) {
    const names = await db.tableNames();
    if (names.includes(TABLE)) await db.dropTable(TABLE);
  }

  let table = await openTable(db);

  // Current per-entry hashes from the index (rowId -> hash).
  const existing = new Map<string, string>(); // id -> hash
  if (table && !force) {
    const rows = (await table.query().select(["id", "hash"]).toArray()) as {
      id: string;
      hash: string;
    }[];
    for (const r of rows) existing.set(r.id, r.hash);
  }

  const wanted = new Map(entries.map((e) => [e.id, hashEntry(e)]));

  const changed = entries.filter((e) => existing.get(e.id) !== wanted.get(e.id));
  const removedIds = [...existing.keys()].filter((id) => !wanted.has(id));
  const unchanged = entries.length - changed.length;

  // Remove stale + changed rows before re-adding changed ones.
  const toDelete = [...new Set([...removedIds, ...changed.map((e) => e.id)])];
  if (table && toDelete.length > 0) {
    await table.delete(`id IN (${sqlList(toDelete)})`);
  }

  const newRecords = changed.length ? await recordsFor(changed, embedder) : [];
  if (newRecords.length > 0) {
    const rows = newRecords as unknown as Record<string, unknown>[];
    if (!table) {
      table = await db.createTable(TABLE, rows);
    } else {
      await table.add(rows);
    }
  }

  await writeMeta({ embedderId: embedder.id, dim: embedder.dim, indexVersion: INDEX_VERSION });
  await syncLexical(entries);
  return { added: changed.length, removed: removedIds.length, unchanged };
}

export interface IndexStatus {
  embedderId: string | null;
  dim: number | null;
  totalEntries: number;
  indexedEntries: number;
  staleEntries: number;
  missingEntries: number;
  chunkRows: number;
}

export interface OptimizeIndexResult {
  tableExists: boolean;
  cleanupOlderThan: string;
  stats: OptimizeStats | null;
}

export async function optimizeIndex(cleanupOlderThanDays = 7): Promise<OptimizeIndexResult> {
  await mkdir(INDEX_DIR, { recursive: true });
  const db = await lancedb.connect(INDEX_DIR);
  const table = await openTable(db);
  const cleanupOlderThan = new Date(Date.now() - cleanupOlderThanDays * 24 * 60 * 60 * 1000);
  if (!table) {
    return { tableExists: false, cleanupOlderThan: cleanupOlderThan.toISOString(), stats: null };
  }
  const stats = await table.optimize({ cleanupOlderThan });
  return { tableExists: true, cleanupOlderThan: cleanupOlderThan.toISOString(), stats };
}

/**
 * Read-only index health check: compares the Markdown source of truth against
 * the LanceDB index by content hash. Never loads the embedder.
 */
export async function indexStatus(): Promise<IndexStatus> {
  const entries = await loadAllEntries();
  const meta = await readMeta();
  const base: IndexStatus = {
    embedderId: meta?.embedderId ?? null,
    dim: meta?.dim ?? null,
    totalEntries: entries.length,
    indexedEntries: 0,
    staleEntries: 0,
    missingEntries: entries.length,
    chunkRows: 0,
  };

  let table: lancedb.Table | null = null;
  try {
    const db = await lancedb.connect(INDEX_DIR);
    table = await openTable(db);
  } catch {
    return base;
  }
  if (!table) return base;

  const rows = (await table.query().select(["id", "hash"]).toArray()) as {
    id: string;
    hash: string;
  }[];
  const indexed = new Map<string, string>();
  for (const r of rows) indexed.set(r.id, r.hash);

  let indexedEntries = 0;
  let staleEntries = 0;
  let missingEntries = 0;
  for (const e of entries) {
    const hash = indexed.get(e.id);
    if (hash === undefined) missingEntries++;
    else if (hash === hashEntry(e)) indexedEntries++;
    else staleEntries++;
  }

  return { ...base, indexedEntries, staleEntries, missingEntries, chunkRows: rows.length };
}

export interface SearchFilters {
  person?: string;
  type?: string;
  team?: string;
  tag?: string;
  since?: string; // ISO date inclusive
  until?: string; // ISO date inclusive
}

export type QueryOrigin = "primary" | "agent" | "cli";

export interface QuerySpec {
  text: string;
  origin: QueryOrigin;
  weight: number;
}

export type SearchCompleteness = "auto" | "complete" | "complete-if-small" | "none";

export interface SearchHitReason {
  semanticRank?: number;
  lexicalRank?: number;
  matchedTerms: string[];
  retrievalSignals: string[];
}

export interface SearchHit {
  entry: MemoryEntry;
  score: number;
  bestChunk: string;
  /** Timeline context when the entry belongs to a `follows` chain. */
  chain?: ChainAnnotation;
  reasons?: SearchHitReason;
}

export interface SearchReport {
  filters: SearchFilters;
  completeness: SearchCompleteness;
  exhaustive: boolean;
  candidateCount: number;
  consideredCount: number;
  retrievalSignalCount: number;
  returnedCount: number;
  limitedByK: boolean;
  k: number;
  pool: number;
  chunkRows: number;
}

export interface SearchResult {
  queries: QuerySpec[];
  hits: SearchHit[];
  report: SearchReport;
}

function matchesFilters(e: MemoryEntry, f: SearchFilters): boolean {
  if (f.person && !e.people.includes(f.person)) return false;
  if (f.team && !e.teams.includes(f.team)) return false;
  if (f.tag && !e.tags.includes(f.tag)) return false;
  if (f.type && e.type !== f.type) return false;
  if (f.since && e.date < f.since) return false;
  if (f.until && e.date > f.until) return false;
  return true;
}

/** Shared metadata filter — the single JS authority over the source of truth. */
export function applyFilters(entries: MemoryEntry[], f: SearchFilters): MemoryEntry[] {
  return entries.filter((e) => matchesFilters(e, f));
}

function hasAnyFilter(f: SearchFilters): boolean {
  return Boolean(f.person || f.team || f.tag || f.type || f.since || f.until);
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * SQL prefilter mirroring `matchesFilters`, so vector-search truncation
 * happens INSIDE the filtered candidate space. Values failing validation are
 * skipped here (never interpolated); `matchesFilters` still enforces them.
 */
function whereClause(f: SearchFilters): string | undefined {
  const parts: string[] = [];
  if (f.type && SLUG_RE.test(f.type)) parts.push(`type = '${f.type}'`);
  if (f.since && DATE_RE.test(f.since)) parts.push(`date >= '${f.since}'`);
  if (f.until && DATE_RE.test(f.until)) parts.push(`date <= '${f.until}'`);
  if (f.person && SLUG_RE.test(f.person)) parts.push(`people LIKE '%|${f.person}|%'`);
  if (f.team && SLUG_RE.test(f.team)) parts.push(`teams LIKE '%|${f.team}|%'`);
  if (f.tag && SLUG_RE.test(f.tag)) parts.push(`tags LIKE '%|${f.tag}|%'`);
  return parts.length ? parts.join(" AND ") : undefined;
}

function rankToRRF(ids: string[], k0 = 60): Map<string, number> {
  const m = new Map<string, number>();
  ids.forEach((id, i) => m.set(id, 1 / (k0 + i + 1)));
  return m;
}

interface RankList {
  kind: "semantic" | "lexical";
  query: QuerySpec;
  ids: string[];
}

export interface SearchOptions {
  /** Recall-over-precision preset: wider candidate pools (callers also raise k). */
  deep?: boolean;
  completeness?: SearchCompleteness;
  completeLimit?: number;
}

/**
 * Filtered result sets at or below this size take the exhaustive path: every
 * matching entry enters the ranking, so a filtered query cannot miss — only
 * order (and `k`) limits what is printed.
 */
const EXHAUSTIVE_LIMIT = 200;

/** Max recency multiplier bonus (2%) and its e-folding age in days. */
const RECENCY_EPS = 0.02;
const RECENCY_DECAY_DAYS = 90;

export const DEFAULT_COMPLETE_LIMIT = EXHAUSTIVE_LIMIT;

function querySpecs(queries: string[] | QuerySpec[]): QuerySpec[] {
  return queries
    .map((q, i) =>
      typeof q === "string"
        ? { text: q, origin: (i === 0 ? "primary" : "agent") as QueryOrigin, weight: 1 }
        : q,
    )
    .map((q) => ({ ...q, text: q.text.trim(), weight: Number.isFinite(q.weight) ? q.weight : 1 }))
    .filter((q) => q.text && q.weight > 0);
}

function shouldExhaustivelyAppend(
  filters: SearchFilters,
  candidateCount: number,
  completeness: SearchCompleteness,
  completeLimit: number,
): boolean {
  if (candidateCount === 0) return false;
  if (completeness === "complete") return true;
  if (completeness === "complete-if-small") return candidateCount <= completeLimit;
  if (completeness === "auto") return hasAnyFilter(filters) && candidateCount <= completeLimit;
  return false;
}

function bestRank(lists: RankList[], id: string, kind: RankList["kind"]): number | undefined {
  let best: number | undefined;
  for (const list of lists) {
    if (list.kind !== kind) continue;
    const rank = list.ids.indexOf(id);
    if (rank === -1) continue;
    const oneBased = rank + 1;
    if (best === undefined || oneBased < best) best = oneBased;
  }
  return best;
}

function matchedTerms(entry: MemoryEntry, qs: QuerySpec[]): string[] {
  const entryTerms = new Set(tokenize(entrySearchText(entry)));
  const terms = new Set<string>();
  for (const q of qs) {
    for (const term of tokenize(q.text)) {
      if (entryTerms.has(term)) terms.add(term);
    }
  }
  return [...terms].sort();
}

/**
 * Hybrid search: semantic (vector) + lexical (BM25), fused via Reciprocal Rank
 * Fusion. Accepts multiple query phrasings — every phrasing contributes a
 * semantic and a lexical ranking list and all lists are fused. Metadata
 * filters constrain candidates BEFORE truncation (SQL prefilter + exhaustive
 * path), so filtered queries don't silently drop matches.
 */
export async function searchDetailed(
  queries: string[] | QuerySpec[],
  filters: SearchFilters = {},
  k = 8,
  opts: SearchOptions = {},
): Promise<SearchResult> {
  const qs = querySpecs(queries);
  const completeness = opts.completeness ?? "auto";
  const completeLimit = opts.completeLimit ?? DEFAULT_COMPLETE_LIMIT;
  if (qs.length === 0) {
    return {
      queries: [],
      hits: [],
      report: {
        filters,
        completeness,
        exhaustive: false,
        candidateCount: 0,
        consideredCount: 0,
        retrievalSignalCount: 0,
        returnedCount: 0,
        limitedByK: false,
        k,
        pool: 0,
        chunkRows: 0,
      },
    };
  }

  const entries = await loadAllEntries();
  const byId = new Map(entries.map((e) => [e.id, e]));
  const filtered = applyFilters(entries, filters);
  if (filtered.length === 0) {
    return {
      queries: qs,
      hits: [],
      report: {
        filters,
        completeness,
        exhaustive: false,
        candidateCount: 0,
        consideredCount: 0,
        retrievalSignalCount: 0,
        returnedCount: 0,
        limitedByK: false,
        k,
        pool: 0,
        chunkRows: 0,
      },
    };
  }
  const filteredIds = new Set(filtered.map((e) => e.id));
  const exhaustive = shouldExhaustivelyAppend(filters, filtered.length, completeness, completeLimit);

  const db = await lancedb.connect(INDEX_DIR);
  const table = await openTable(db);

  // Candidate pool scales with the corpus so the vector leg's truncation
  // horizon grows as the store does (the old fixed 40 was a recall ceiling).
  const chunkRows = table ? await table.countRows() : 0;
  const mult = opts.deep ? 12 : 8;
  const pool = exhaustive
    ? Math.min(4096, Math.max(filtered.length * 8, 40))
    : Math.min(512, Math.max(k * mult, 40, Math.ceil(chunkRows / 20)));
  const where = whereClause(filters);

  // --- semantic ranking lists, one per phrasing (best chunk per entry) ---
  const bestChunk = new Map<string, string>();
  const rankLists: RankList[] = [];
  if (table && chunkRows > 0) {
    const embedder = getEmbedder();
    const vecs = await embedder.embed(qs.map((q) => q.text));
    for (const [i, qvec] of vecs.entries()) {
      const query = qs[i]!;
      let vq = table.search(qvec) as lancedb.VectorQuery;
      if (where) vq = vq.where(where) as lancedb.VectorQuery;
      const rows = (await vq.limit(pool).toArray()) as { id: string; text: string }[];
      const ids: string[] = [];
      for (const r of rows) {
        if (!filteredIds.has(r.id)) continue; // JS filter is the authority
        if (!ids.includes(r.id)) {
          ids.push(r.id);
          if (!bestChunk.has(r.id)) bestChunk.set(r.id, r.text);
        }
      }
      rankLists.push({ kind: "semantic", query, ids });
    }
  }

  // --- lexical ranking lists, one per phrasing, within the filtered set ---
  const lexIdx = (await readLexical()) ?? buildLexical(entries);
  for (const q of qs) {
    const scores = bm25Scores(q.text, lexIdx);
    const ids = [...scores.entries()]
      .filter(([id]) => filteredIds.has(id))
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id);
    rankLists.push({ kind: "lexical", query: q, ids });
  }

  // --- reciprocal rank fusion across all lists ---
  const fused = new Map<string, number>();
  for (const list of rankLists) {
    for (const [id, s] of rankToRRF(list.ids)) {
      fused.set(id, (fused.get(id) ?? 0) + s * list.query.weight);
    }
  }

  // Mild recency boost: at most +2%, decaying over ~3 months of age (by
  // max(date, updated)). Sized to break genuine near-ties toward the newer
  // entry while staying below the ~0.3-1% adjacent-rank RRF gap × a few
  // lists, so any entry with a real relevance lead is untouchable.
  const now = Date.now();
  for (const [id, score] of fused) {
    const e = byId.get(id);
    if (!e) continue;
    const ref = e.updated && e.updated > e.date ? e.updated : e.date;
    const ageDays = Math.max(0, (now - Date.parse(ref)) / 86_400_000);
    fused.set(id, score * (1 + RECENCY_EPS * Math.exp(-ageDays / RECENCY_DECAY_DAYS)));
  }

  let ranked = [...fused.entries()]
    .filter(([id]) => byId.has(id))
    .sort((a, b) => b[1] - a[1])
    .map(([id, score]) => ({ id, score }));
  const retrievalSignalCount = ranked.length;

  if (exhaustive) {
    // Recall guarantee: append filter-matching entries with no retrieval
    // signal (newest first) so nothing is droppable before the k-cut.
    const present = new Set(ranked.map((r) => r.id));
    const rest = filtered
      .filter((e) => !present.has(e.id))
      .sort((a, b) => b.date.localeCompare(a.date))
      .map((e) => ({ id: e.id, score: 0 }));
    ranked = [...ranked, ...rest];
  }

  const consideredCount = exhaustive ? filtered.length : retrievalSignalCount;
  const chainIndex = buildChainIndex(entries);
  const hits = ranked.slice(0, k).map(({ id, score }) => {
    const entry = byId.get(id)!;
    const chain = chainIndex.get(id);
    const semanticRank = bestRank(rankLists, id, "semantic");
    const lexicalRank = bestRank(rankLists, id, "lexical");
    const retrievalSignals = [
      ...(semanticRank !== undefined ? ["semantic"] : []),
      ...(lexicalRank !== undefined ? ["lexical"] : []),
      ...(score === 0 && exhaustive ? ["complete-scan"] : []),
    ];
    return {
      entry,
      score,
      bestChunk: displayChunkText(bestChunk.get(id) ?? entry.body.slice(0, 300)),
      ...(chain ? { chain } : {}),
      reasons: {
        ...(semanticRank !== undefined ? { semanticRank } : {}),
        ...(lexicalRank !== undefined ? { lexicalRank } : {}),
        matchedTerms: matchedTerms(entry, qs),
        retrievalSignals,
      },
    };
  });
  return {
    queries: qs,
    hits,
    report: {
      filters,
      completeness,
      exhaustive,
      candidateCount: filtered.length,
      consideredCount,
      retrievalSignalCount,
      returnedCount: hits.length,
      limitedByK: ranked.length > k,
      k,
      pool,
      chunkRows,
    },
  };
}

export async function search(
  queries: string[],
  filters: SearchFilters = {},
  k = 8,
  opts: SearchOptions = {},
): Promise<SearchHit[]> {
  return (await searchDetailed(queries, filters, k, opts)).hits;
}

export interface SimilarHit {
  id: string;
  title: string;
  /** Cosine similarity in [0,1]; 1 = identical direction. */
  sim: number;
}

/**
 * Pure semantic near-duplicate lookup: embed `text`, cosine-search the index,
 * and return entries whose best chunk scores `>= minSim`. Used by the add path
 * to guard against silently re-capturing an entry that has no source id.
 * Unlike `search`, this exposes an absolute (thresholdable) similarity.
 */
export async function findSimilar(
  text: string,
  opts: { limit?: number; minSim?: number } = {},
): Promise<SimilarHit[]> {
  const { limit = 5, minSim = 0.92 } = opts;
  const db = await lancedb.connect(INDEX_DIR);
  const table = await openTable(db);
  if (!table) return [];

  const embedder = getEmbedder();
  const [qvec] = await embedder.embed([text]);
  // `search(vector)` is typed as Query | VectorQuery; a vector arg yields a
  // VectorQuery at runtime, which is what exposes distanceType().
  const vq = table.search(qvec!) as lancedb.VectorQuery;
  // Generous pool: near-duplicates rank at the very top by construction, but
  // multi-chunk entries crowding the head must not push a real dup past the cap.
  const rows = (await vq
    .distanceType("cosine")
    .limit(Math.max(limit * 20, 100))
    .toArray()) as { id: string; title: string; _distance: number }[];

  // Best (smallest-distance) chunk per entry, then threshold + cap.
  const best = new Map<string, SimilarHit>();
  for (const r of rows) {
    const sim = 1 - r._distance;
    const prev = best.get(r.id);
    if (!prev || sim > prev.sim) best.set(r.id, { id: r.id, title: r.title, sim });
  }
  return [...best.values()]
    .filter((h) => h.sim >= minSim)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, limit);
}
