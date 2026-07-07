import { relative } from "node:path";
import { ROOT } from "./ingest.js";
import {
  DEFAULT_COMPLETE_LIMIT,
  searchDetailed,
  type QueryOrigin,
  type QuerySpec,
  type SearchCompleteness,
  type SearchFilters,
} from "./store.js";
import type { MemoryEntry } from "./schema.js";
import type { ChainAnnotation } from "./chains.js";

const ORIGIN_WEIGHTS: Record<QueryOrigin, number> = {
  primary: 1.25,
  agent: 1,
  cli: 0.6,
};

const STOPWORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "an",
  "and",
  "are",
  "as",
  "because",
  "been",
  "before",
  "did",
  "does",
  "for",
  "from",
  "has",
  "have",
  "how",
  "in",
  "into",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "our",
  "to",
  "the",
  "this",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
  "you",
]);

export interface RecallOptions {
  filters?: SearchFilters;
  k?: number;
  deep?: boolean;
  noExpand?: boolean;
  completeness?: SearchCompleteness;
  completeLimit?: number;
  requireComplete?: boolean;
}

export interface RecallHit {
  id: string;
  title: string;
  type: MemoryEntry["type"];
  date: string;
  updated?: string;
  people: string[];
  teams: string[];
  tags: string[];
  sources?: string[];
  follows?: string[];
  source_ids?: string[];
  path: string;
  relPath: string;
  score: number;
  bestChunk: string;
  /** Timeline context when the entry belongs to a `follows` chain. */
  chain?: ChainAnnotation;
  reasons?: {
    semanticRank?: number;
    lexicalRank?: number;
    matchedTerms: string[];
    retrievalSignals: string[];
  };
}

export interface RecallReport {
  queries: QuerySpec[];
  filters: SearchFilters;
  mode: SearchCompleteness;
  exhaustive: boolean;
  requireComplete: boolean;
  candidateCount: number;
  consideredCount: number;
  retrievalSignalCount: number;
  returnedCount: number;
  limitedByK: boolean;
  k: number;
  pool: number;
  chunkRows: number;
  warnings: string[];
  hits: RecallHit[];
}

function normalizeSpace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function keywordPhrase(s: string): string {
  const tokens = (s.toLowerCase().match(/[a-z0-9][a-z0-9-]*/g) ?? [])
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
  return normalizeSpace([...new Set(tokens)].join(" "));
}

function entityPhrase(s: string): string {
  const entities = s.match(/\b[A-Z][A-Za-z0-9-]*(?:\s+[A-Z][A-Za-z0-9-]*)*/g) ?? [];
  return normalizeSpace([...new Set(entities.filter((e) => !STOPWORDS.has(e.toLowerCase())))].join(" "));
}

function filterPhrase(filters: SearchFilters, keywords: string): string {
  const parts = [
    filters.type,
    filters.person,
    filters.team,
    filters.tag,
    filters.since ? `since ${filters.since}` : undefined,
    filters.until ? `until ${filters.until}` : undefined,
    keywords,
  ].filter(Boolean);
  return normalizeSpace(parts.join(" "));
}

function pushQuery(out: QuerySpec[], seen: Set<string>, text: string, origin: QueryOrigin): void {
  const normalized = normalizeSpace(text);
  const key = normalized.toLowerCase();
  if (!normalized || seen.has(key)) return;
  seen.add(key);
  out.push({ text: normalized, origin, weight: ORIGIN_WEIGHTS[origin] });
}

export function buildRecallQueries(positionals: string[], filters: SearchFilters = {}, noExpand = false): QuerySpec[] {
  const primary = normalizeSpace(positionals[0] ?? "");
  if (!primary) return [];

  const seen = new Set<string>();
  const out: QuerySpec[] = [];
  pushQuery(out, seen, primary, "primary");
  for (const phrasing of positionals.slice(1)) pushQuery(out, seen, phrasing, "agent");

  if (!noExpand) {
    const keywords = keywordPhrase(primary);
    const entities = entityPhrase(primary);
    pushQuery(out, seen, keywords, "cli");
    pushQuery(out, seen, entities, "cli");
    pushQuery(out, seen, filterPhrase(filters, keywords || entities), "cli");
  }

  return out;
}

export async function recall(positionals: string[], opts: RecallOptions = {}): Promise<RecallReport> {
  const filters = opts.filters ?? {};
  const mode = opts.completeness ?? "complete-if-small";
  const k = opts.k ?? 40;
  const completeLimit = opts.completeLimit ?? DEFAULT_COMPLETE_LIMIT;
  const queries = buildRecallQueries(positionals, filters, Boolean(opts.noExpand));
  const search = await searchDetailed(queries, filters, k, {
    deep: opts.deep ?? true,
    completeness: mode,
    completeLimit,
  });

  const warnings: string[] = [];
  if (queries.length === 0) warnings.push("No query text was provided.");
  if (opts.requireComplete && !search.report.exhaustive) {
    if (mode === "complete-if-small" && search.report.candidateCount > completeLimit) {
      warnings.push(
        `Completeness was required but not guaranteed; ${search.report.candidateCount} candidates exceed the complete limit ${completeLimit}.`,
      );
    } else {
      warnings.push(`Completeness was required but mode '${mode}' did not produce an exhaustive scan; use --complete.`);
    }
  }
  if (!search.report.exhaustive) {
    warnings.push("Recall is hybrid-ranked, not exhaustive. Add filters, use --complete, or raise --complete-limit for a stronger guarantee.");
  }
  if (search.report.limitedByK) {
    warnings.push(`Only ${search.report.returnedCount} of ${search.report.consideredCount} considered candidates are returned by -k ${k}.`);
  }

  return {
    queries: search.queries,
    filters,
    mode,
    exhaustive: search.report.exhaustive,
    requireComplete: Boolean(opts.requireComplete),
    candidateCount: search.report.candidateCount,
    consideredCount: search.report.consideredCount,
    retrievalSignalCount: search.report.retrievalSignalCount,
    returnedCount: search.report.returnedCount,
    limitedByK: search.report.limitedByK,
    k: search.report.k,
    pool: search.report.pool,
    chunkRows: search.report.chunkRows,
    warnings,
    hits: search.hits.map((h) => ({
      id: h.entry.id,
      title: h.entry.title,
      type: h.entry.type,
      date: h.entry.date,
      ...(h.entry.updated ? { updated: h.entry.updated } : {}),
      people: h.entry.people,
      teams: h.entry.teams,
      tags: h.entry.tags,
      ...(h.entry.sources?.length ? { sources: h.entry.sources } : {}),
      ...(h.entry.follows?.length ? { follows: h.entry.follows } : {}),
      ...(h.entry.source_ids?.length ? { source_ids: h.entry.source_ids } : {}),
      path: h.entry.path,
      relPath: relative(ROOT, h.entry.path),
      score: h.score,
      bestChunk: h.bestChunk,
      ...(h.chain ? { chain: h.chain } : {}),
      ...(h.reasons ? { reasons: h.reasons } : {}),
    })),
  };
}
