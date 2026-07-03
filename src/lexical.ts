import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { INDEX_DIR, hashEntry } from "./ingest.js";
import type { MemoryEntry } from "./schema.js";

/**
 * Persistent lexical (BM25) index — the keyword leg of hybrid search.
 * Stored at `.index/lexical.json`; derived data, keyed by the same content
 * hashes as the vector index, self-syncs against the Markdown source of truth
 * (a version bump or deleted file just triggers a rebuild).
 */

const LEXICAL_PATH = join(INDEX_DIR, "lexical.json");
const LEXICAL_VERSION = 1;

interface LexDoc {
  id: string;
  hash: string;
  /** Token count (post-stemming) — the BM25 document length. */
  len: number;
}

export interface LexicalIndex {
  version: number;
  /** null = tombstone of a removed/re-indexed doc; ordinals stay stable. */
  docs: (LexDoc | null)[];
  /** term -> [docOrdinal, termFrequency][] (live ordinals only). */
  postings: Record<string, [number, number][]>;
}

/**
 * Light s-stemmer: enough to make "decisions" match "decision" and "hired"
 * match "hiring"→"hir"… precision loss is fine — BM25 is one RRF leg, and the
 * semantic leg covers meaning. Applied at index AND query time.
 */
export function stem(t: string): string {
  if (t.length > 4 && t.endsWith("ies")) return t.slice(0, -3) + "y";
  if (t.length > 5 && t.endsWith("ing")) return t.slice(0, -3);
  if (t.length > 4 && t.endsWith("ed")) return t.slice(0, -2);
  if (t.length > 4 && t.endsWith("es")) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  return t;
}

export function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((t) => t.length > 1)
    .map(stem);
}

function emptyIndex(): LexicalIndex {
  return { version: LEXICAL_VERSION, docs: [], postings: {} };
}

export async function readLexical(): Promise<LexicalIndex | null> {
  try {
    const idx = JSON.parse(await readFile(LEXICAL_PATH, "utf8")) as LexicalIndex;
    if (idx.version === LEXICAL_VERSION && Array.isArray(idx.docs) && idx.postings) return idx;
  } catch {
    // missing or corrupt — caller falls back / sync rebuilds
  }
  return null;
}

function addDoc(idx: LexicalIndex, e: MemoryEntry): void {
  const terms = tokenize(`${e.title} ${e.body}`);
  const ord = idx.docs.length;
  idx.docs.push({ id: e.id, hash: hashEntry(e), len: terms.length });
  const tf = new Map<string, number>();
  for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);
  for (const [t, f] of tf) (idx.postings[t] ??= []).push([ord, f]);
}

/** Build an index over `entries` in memory (also the search-time fallback). */
export function buildLexical(entries: MemoryEntry[]): LexicalIndex {
  const idx = emptyIndex();
  for (const e of entries) addDoc(idx, e);
  return idx;
}

/**
 * Incrementally sync the lexical index with the current entries: re-tokenizes
 * only changed/new docs, tombstones removed ones, compacts (full rebuild in
 * memory) when tombstones pile up. Returns true if anything changed.
 */
export async function syncLexical(entries: MemoryEntry[]): Promise<boolean> {
  let idx = (await readLexical()) ?? emptyIndex();

  const wanted = new Map(entries.map((e) => [e.id, hashEntry(e)]));
  const drop = new Set<number>();
  const fresh = new Set<string>();
  idx.docs.forEach((d, ord) => {
    if (!d) return;
    if (wanted.get(d.id) === d.hash) fresh.add(d.id);
    else {
      drop.add(ord);
      idx.docs[ord] = null;
    }
  });
  const toAdd = entries.filter((e) => !fresh.has(e.id));

  if (drop.size === 0 && toAdd.length === 0) return false;

  if (drop.size > 0) {
    for (const term of Object.keys(idx.postings)) {
      const kept = idx.postings[term]!.filter(([ord]) => !drop.has(ord));
      if (kept.length === 0) delete idx.postings[term];
      else idx.postings[term] = kept;
    }
  }
  for (const e of toAdd) addDoc(idx, e);

  const tombstones = idx.docs.filter((d) => !d).length;
  if (tombstones > idx.docs.length / 4) idx = buildLexical(entries);

  await mkdir(INDEX_DIR, { recursive: true });
  await writeFile(LEXICAL_PATH, JSON.stringify(idx), "utf8");
  return true;
}

/**
 * BM25 scores for `query` (k1=1.5, b=0.75), reading only the query terms'
 * postings. Returns id -> score for docs with any matching term.
 */
export function bm25Scores(query: string, idx: LexicalIndex): Map<string, number> {
  const qTerms = [...new Set(tokenize(query))];
  const live = idx.docs.filter((d): d is LexDoc => d !== null);
  const N = live.length || 1;
  const avgdl = live.reduce((s, d) => s + d.len, 0) / N || 1;
  const k1 = 1.5;
  const b = 0.75;
  const scores = new Map<string, number>();
  for (const t of qTerms) {
    const plist = idx.postings[t];
    if (!plist) continue;
    const n = plist.length;
    const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
    for (const [ord, f] of plist) {
      const d = idx.docs[ord];
      if (!d) continue;
      const dl = d.len || 1;
      const add = idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (dl / avgdl))));
      scores.set(d.id, (scores.get(d.id) ?? 0) + add);
    }
  }
  return scores;
}

/** Read-only health for `memory maintenance`. */
export async function lexicalStatus(): Promise<{ docs: number; terms: number } | null> {
  const idx = await readLexical();
  if (!idx) return null;
  return {
    docs: idx.docs.filter(Boolean).length,
    terms: Object.keys(idx.postings).length,
  };
}
