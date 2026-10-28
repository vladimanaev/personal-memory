import { mkdir, readFile, writeFile } from "node:fs/promises";
import { relative, join } from "node:path";
import matter from "gray-matter";
import { DEFAULT_GRAPH, FrontmatterSchema, sortGraphs, type Frontmatter, type GraphId, type MemoryEntry } from "./schema.js";
import { INDEX_DIR, ROOT, readVariants, writeEntryAll } from "./ingest.js";
import { storeFor, validateContainment } from "./graphs.js";
import type { CatalogEntryMeta } from "./catalog.js";
import { requireEntry } from "./membership.js";
import { openCatalogForWrite, syncIndex } from "./store.js";
import { commitMemoryRepo } from "./memory-git.js";
import { chainAncestry, validateFollowsTargets } from "./chains.js";

export const GRAPH_MAINTENANCE_PATH = join(INDEX_DIR, "graph-maintenance.json");

export type SlugKind = "person" | "team" | "tag";

export interface SlugSuggestion {
  kind: SlugKind;
  from: string;
  to: string;
  confidence: number;
  affectedEntries: number;
  fromCount: number;
  toCount: number;
  sharedEntries: number;
  lastSeen: string | null;
  reasons: string[];
  /** "agent" = deferred from a compact-tags review; absent/"engine" = similarity engine. */
  source?: "engine" | "agent";
}

export interface SlugProposal {
  kind: SlugKind;
  from: string;
  to: string;
  reason: string;
  proposedAt: string;
}

/** A suggestion a reference source ruled out, with the directory evidence. */
export interface SourceDismissedSuggestion extends SlugSuggestion {
  sourceReason: string;
}

export interface GraphMaintenanceAudit {
  generatedAt: string;
  counts: Record<SlugKind, number>;
  suggestionCounts: Record<SlugKind, number>;
  suggestions: SlugSuggestion[];
  /**
   * @deprecated Chain link suggestions were removed. Never populated; retained
   * only so audit files written before the removal still parse.
   */
  chainSuggestions?: unknown[];
  /** Suggestions auto-dismissed by reference-source evidence — kept in the
   *  audit so a wrong dismissal stays diagnosable. Absent when none. */
  sourceDismissed?: SourceDismissedSuggestion[];
}

export interface SlugMergePreview {
  kind: SlugKind;
  from: string;
  to: string;
  affectedEntries: number;
  entries: { id: string; date: string; title: string; path: string }[];
}

export interface SlugMergeResult extends SlugMergePreview {
  dryRun: boolean;
  beforeCommit: boolean;
  afterCommit: boolean;
  index?: { added: number; removed: number; unchanged: number };
  audit?: GraphMaintenanceAudit;
}

const FIELD_BY_KIND = {
  person: "people",
  team: "teams",
  tag: "tags",
} as const satisfies Record<SlugKind, "people" | "teams" | "tags">;

interface SlugStats {
  slug: string;
  count: number;
  lastSeen: string | null;
  entryIds: Set<string>;
}

/** The slice of an entry slug accounting needs — a catalog meta satisfies it. */
export type SlugSource = Pick<MemoryEntry, "id" | "date" | "people" | "teams" | "tags">;

function countByKind(entries: SlugSource[], kind: SlugKind): Map<string, SlugStats> {
  const field = FIELD_BY_KIND[kind];
  const stats = new Map<string, SlugStats>();
  for (const entry of entries) {
    for (const slug of entry[field]) {
      let s = stats.get(slug);
      if (!s) {
        s = { slug, count: 0, lastSeen: null, entryIds: new Set() };
        stats.set(slug, s);
      }
      s.count++;
      s.entryIds.add(entry.id);
      if (!s.lastSeen || entry.date > s.lastSeen) s.lastSeen = entry.date;
    }
  }
  return stats;
}

export interface SlugUsage {
  slug: string;
  count: number;
  lastSeen: string | null;
}

export function slugUsage(entries: SlugSource[], kind: SlugKind): SlugUsage[] {
  return [...countByKind(entries, kind).values()]
    .map(({ slug, count, lastSeen }) => ({ slug, count, lastSeen }))
    .sort((a, b) => b.count - a.count || a.slug.localeCompare(b.slug));
}

function editDistance(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, (_, i) => {
    const row = Array<number>(b.length + 1).fill(0);
    row[0] = i;
    return row;
  });
  const first = dp[0]!;
  for (let j = 0; j <= b.length; j++) first[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const row = dp[i]!;
    const prev = dp[i - 1]!;
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j]! + 1,
        row[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length]![b.length]!;
}

export function similarity(a: string, b: string): number {
  return 1 - editDistance(a, b) / Math.max(a.length, b.length, 1);
}

function intersectionSize<T>(a: Set<T>, b: Set<T>): number {
  let n = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) n++;
  return n;
}

function jaccard(a: string[], b: string[]): number {
  const as = new Set(a);
  const bs = new Set(b);
  const inter = intersectionSize(as, bs);
  const union = new Set([...as, ...bs]).size;
  return union === 0 ? 0 : inter / union;
}

function preferredDirection(a: SlugStats, b: SlugStats): { from: SlugStats; to: SlugStats } {
  if (a.count !== b.count) return a.count < b.count ? { from: a, to: b } : { from: b, to: a };
  const at = a.slug.split("-").length;
  const bt = b.slug.split("-").length;
  if (at !== bt) return at < bt ? { from: a, to: b } : { from: b, to: a };
  return a.slug.localeCompare(b.slug) < 0 ? { from: b, to: a } : { from: a, to: b };
}

function pairSuggestion(kind: SlugKind, a: SlugStats, b: SlugStats): SlugSuggestion | null {
  const aTokens = a.slug.split("-");
  const bTokens = b.slug.split("-");
  const sim = similarity(a.slug, b.slug);
  const prefix = a.slug.startsWith(`${b.slug}-`) || b.slug.startsWith(`${a.slug}-`);
  const reordered = aTokens.length === bTokens.length && [...aTokens].sort().join("-") === [...bTokens].sort().join("-");
  const tokenOverlap = jaccard(aTokens, bTokens);
  const sharedEntries = intersectionSize(a.entryIds, b.entryIds);
  const overlapRatio = sharedEntries / Math.max(1, Math.min(a.entryIds.size, b.entryIds.size));

  let confidence = 0;
  const reasons: string[] = [];
  if (reordered) {
    confidence = Math.max(confidence, 0.92);
    reasons.push("same words reordered");
  }
  if (prefix) {
    confidence = Math.max(confidence, kind === "tag" ? 0.42 : 0.68);
    reasons.push("one slug prefixes the other");
  }
  if (sim >= 0.9) {
    confidence = Math.max(confidence, 0.72);
    reasons.push(`edit similarity ${sim.toFixed(2)}`);
  } else if (sim >= 0.82) {
    confidence = Math.max(confidence, 0.58);
    reasons.push(`edit similarity ${sim.toFixed(2)}`);
  }
  if (tokenOverlap > 0 && !reordered) {
    confidence += Math.min(0.14, tokenOverlap * 0.14);
    reasons.push(`token overlap ${tokenOverlap.toFixed(2)}`);
  }
  if (sharedEntries > 0) {
    confidence += Math.min(0.22, overlapRatio * 0.22);
    reasons.push(`${sharedEntries} shared entr${sharedEntries === 1 ? "y" : "ies"}`);
  }

  confidence = Math.min(0.98, confidence);
  if (confidence < 0.55) return null;
  if (kind === "tag" && sharedEntries === 0 && !reordered && sim < 0.84) return null;

  const { from, to } = preferredDirection(a, b);
  return {
    kind,
    from: from.slug,
    to: to.slug,
    confidence,
    affectedEntries: from.entryIds.size,
    fromCount: from.count,
    toCount: to.count,
    sharedEntries,
    lastSeen:
      from.lastSeen && to.lastSeen
        ? from.lastSeen > to.lastSeen
          ? from.lastSeen
          : to.lastSeen
        : (from.lastSeen ?? to.lastSeen),
    reasons,
  };
}

/** Deferred agent judgment, not a similarity score — high but below reorder-certainty. */
const AGENT_PROPOSAL_CONFIDENCE = 0.9;

export function analyzeGraphHygiene(
  entries: SlugSource[],
  generatedAt = new Date().toISOString(),
  dismissed: Set<string> = new Set(),
  proposals: SlugProposal[] = [],
): GraphMaintenanceAudit {
  const suggestions: SlugSuggestion[] = [];
  const counts = { person: 0, team: 0, tag: 0 };
  const suggestionCounts = { person: 0, team: 0, tag: 0 };
  const statsByKind = new Map<SlugKind, Map<string, SlugStats>>();

  for (const kind of ["person", "team", "tag"] as const) {
    const byKind = countByKind(entries, kind);
    statsByKind.set(kind, byKind);
    const stats = [...byKind.values()].sort((a, b) => a.slug.localeCompare(b.slug));
    counts[kind] = stats.length;
    for (let i = 0; i < stats.length; i++) {
      for (let j = i + 1; j < stats.length; j++) {
        const a = stats[i]!;
        const b = stats[j]!;
        const suggestion = pairSuggestion(kind, a, b);
        if (suggestion && !dismissed.has(`${kind}|${suggestion.from}|${suggestion.to}`)) {
          suggestions.push(suggestion);
          suggestionCounts[kind]++;
        }
      }
    }
  }

  const engineKeys = new Set(suggestions.flatMap((s) => [`${s.kind}|${s.from}|${s.to}`, `${s.kind}|${s.to}|${s.from}`]));
  for (const p of proposals) {
    if (dismissed.has(`${p.kind}|${p.from}|${p.to}`) || engineKeys.has(`${p.kind}|${p.from}|${p.to}`)) continue;
    const from = statsByKind.get(p.kind)?.get(p.from);
    const to = statsByKind.get(p.kind)?.get(p.to);
    if (!from || !to) continue; // already merged/renamed away — proposal is moot
    engineKeys.add(`${p.kind}|${p.from}|${p.to}`).add(`${p.kind}|${p.to}|${p.from}`);
    const sharedEntries = [...from.entryIds].filter((id) => to.entryIds.has(id)).length;
    suggestions.push({
      kind: p.kind,
      from: p.from,
      to: p.to,
      confidence: AGENT_PROPOSAL_CONFIDENCE,
      affectedEntries: from.count,
      fromCount: from.count,
      toCount: to.count,
      sharedEntries,
      lastSeen:
        from.lastSeen && to.lastSeen
          ? from.lastSeen > to.lastSeen
            ? from.lastSeen
            : to.lastSeen
          : (from.lastSeen ?? to.lastSeen),
      reasons: [`agent proposal: ${p.reason}`],
      source: "agent",
    });
    suggestionCounts[p.kind]++;
  }

  suggestions.sort(compareSuggestions);
  return { generatedAt, counts, suggestionCounts, suggestions };
}

function compareSuggestions(a: SlugSuggestion, b: SlugSuggestion): number {
  return (
    b.confidence - a.confidence ||
    b.affectedEntries - a.affectedEntries ||
    b.lastSeen?.localeCompare(a.lastSeen ?? "") ||
    a.kind.localeCompare(b.kind) ||
    a.from.localeCompare(b.from)
  );
}

/**
 * Let an enabled reference source pass judgment on the audit's person/team
 * merge suggestions (see sources.ts): pairs resolving to distinct directory
 * ids move to `sourceDismissed`, pairs resolving to the same identity get a
 * confidence boost and a re-sort. Every audit that gets persisted goes
 * through here — the CLI report, the UI's refresh paths, and scheduled
 * maintenance must never disagree about what the directory said. Any
 * source-layer failure (unreadable files included) returns the audit
 * unchanged: sources are an optional enhancement, never a gate.
 */
export async function reconcileGraphAudit(
  audit: GraphMaintenanceAudit,
  getSources?: () => Promise<import("./sources.js").SourceFile[]>,
  run?: import("./sources.js").LookupRunner,
): Promise<GraphMaintenanceAudit> {
  try {
    const { loadSources, reconcileSuggestions } = await import("./sources.js");
    const sources = await (getSources ? getSources() : loadSources());
    const { kept, dismissed } = await reconcileSuggestions(audit.suggestions, sources, run);
    audit.suggestions = kept.sort(compareSuggestions);
    for (const { suggestion } of dismissed) audit.suggestionCounts[suggestion.kind]--;
    if (dismissed.length > 0) {
      audit.sourceDismissed = dismissed.map(({ suggestion, reason }) => ({
        ...suggestion,
        sourceReason: reason,
      }));
    }
  } catch {
    // fall through with the heuristic audit untouched
  }
  return audit;
}
export const SLUG_DISMISSALS_PATH = join(INDEX_DIR, "slug-dismissals.json");

export interface SlugDismissal {
  kind: SlugKind;
  from: string;
  to: string;
  dismissedAt: string;
}

export async function readSlugDismissals(): Promise<SlugDismissal[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(SLUG_DISMISSALS_PATH, "utf8"));
    return Array.isArray(parsed) ? (parsed as SlugDismissal[]) : [];
  } catch {
    return [];
  }
}

/**
 * Both role orders per record: `preferredDirection` can swap from/to when
 * usage counts shift, and a dismissed pair must never resurface either way.
 */
export function slugDismissalKeys(dismissals: SlugDismissal[]): Set<string> {
  const keys = new Set<string>();
  for (const d of dismissals) {
    keys.add(`${d.kind}|${d.from}|${d.to}`);
    keys.add(`${d.kind}|${d.to}|${d.from}`);
  }
  return keys;
}

/**
 * Persistently hide one wrong merge suggestion. Lives in `.index/` like
 * connector state: user judgment that is cheap to re-give if wiped.
 */
export async function dismissSlugSuggestion(kind: SlugKind, from: string, to: string): Promise<GraphMaintenanceAudit> {
  const dismissals = await readSlugDismissals();
  if (!dismissals.some((d) => d.kind === kind && d.from === from && d.to === to)) {
    dismissals.push({ kind, from, to, dismissedAt: new Date().toISOString() });
    await mkdir(INDEX_DIR, { recursive: true });
    await writeFile(SLUG_DISMISSALS_PATH, JSON.stringify(dismissals, null, 2), "utf8");
  }
  return refreshGraphMaintenanceAudit();
}

export const SLUG_PROPOSALS_PATH = join(INDEX_DIR, "slug-proposals.json");

export async function readSlugProposals(): Promise<SlugProposal[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(SLUG_PROPOSALS_PATH, "utf8"));
    return Array.isArray(parsed) ? (parsed as SlugProposal[]) : [];
  } catch {
    return [];
  }
}

/**
 * Defer an agent-judged merge to the maintenance screen instead of deciding in
 * chat. The proposal surfaces as a regular merge suggestion (source: "agent")
 * until it is merged (from-slug gone), ignored (dismissal), or moot.
 */
export async function proposeSlugMerge(kind: SlugKind, from: string, to: string, reason: string): Promise<GraphMaintenanceAudit> {
  if (from === to) throw new Error("--from and --to must be different slugs");
  const stats = countByKind(await (await openCatalogForWrite()).all(), kind);
  for (const slug of [from, to]) {
    if (!stats.has(slug)) throw new Error(`${kind} '${slug}' does not exist — proposals must reference existing slugs`);
  }
  if (slugDismissalKeys(await readSlugDismissals()).has(`${kind}|${from}|${to}`)) {
    throw new Error(`${kind} pair '${from}' / '${to}' was previously dismissed as a wrong match — not re-proposing`);
  }
  const proposals = await readSlugProposals();
  if (!proposals.some((p) => p.kind === kind && ((p.from === from && p.to === to) || (p.from === to && p.to === from)))) {
    proposals.push({ kind, from, to, reason, proposedAt: new Date().toISOString() });
    await mkdir(INDEX_DIR, { recursive: true });
    await writeFile(SLUG_PROPOSALS_PATH, JSON.stringify(proposals, null, 2), "utf8");
  }
  return refreshGraphMaintenanceAudit();
}

export interface ChainLinkResult {
  laterId: string;
  follows: string[];
  changed: boolean;
  path?: string;
  index?: { added: number; removed: number; unchanged: number };
  afterCommit?: boolean;
  audit?: GraphMaintenanceAudit;
}

/**
 * Add validated `follows` links to an existing entry — the one sanctioned
 * write path for links outside `add` (used by `cli.ts link` and the UI's
 * maintenance screen). Validates targets, syncs the index, commits
 * `memory/.git`, and refreshes the audit so an accepted suggestion disappears.
 */
export async function applyChainLink(opts: {
  laterId: string;
  follows: string[];
  refreshAudit?: boolean;
}): Promise<ChainLinkResult> {
  const catalog = await openCatalogForWrite();
  const entry = await requireEntry(catalog, opts.laterId);
  // The cycle check walks each target's ancestry, so only the chain around the
  // new links has to be loaded — not the corpus.
  const ancestry = await chainAncestry((ids) => catalog.byIds(ids), opts.follows);
  validateFollowsTargets([entry, ...ancestry], entry, opts.follows);
  // A shared-graph member must never gain a link outside its graphs.
  const targets = await catalog.byIds(opts.follows);
  validateContainment(new Map(targets.map((t) => [t.id, t])), entry, opts.follows);

  const mergedFollows = [...new Set([...(entry.follows ?? []), ...opts.follows])];
  if (mergedFollows.length === (entry.follows ?? []).length) {
    return { laterId: entry.id, follows: entry.follows ?? [], changed: false };
  }

  return writeFollows(entry, mergedFollows, `Link memory: ${entry.id} follows ${mergedFollows.join(", ")}`, opts.refreshAudit);
}

/** Rewrite an entry's `follows` in every graph it lives in, sync, and commit each member store. */
async function writeFollows(
  entry: Awaited<ReturnType<typeof requireEntry>>,
  follows: string[],
  message: string,
  refreshAudit?: boolean,
): Promise<ChainLinkResult> {
  const { body, path: _p, graphs, paths, follows: _f, variants: _v, ...rest } = entry;
  const fm = FrontmatterSchema.parse({
    ...rest,
    ...(follows.length ? { follows } : {}),
    updated: new Date().toISOString().slice(0, 10),
  }) as Frontmatter;
  // A declared variant takes the new frontmatter but keeps its approved body.
  const written = await writeEntryAll(fm, body, graphs, await readVariants(paths));
  const path = written[DEFAULT_GRAPH] ?? Object.values(written)[0]!;
  const index = await syncIndex();
  // The add-time auto-commit hook only fires on `add`; commit every member
  // store explicitly (the file changed in all of them).
  let afterCommit = false;
  for (const g of graphs) {
    afterCommit = (await commitMemoryRepo(message, storeFor(g).dir)) || afterCommit;
  }
  const audit = refreshAudit === false ? undefined : await refreshGraphMaintenanceAudit();
  return { laterId: entry.id, follows, changed: true, path: rel(path), index, afterCommit, ...(audit ? { audit } : {}) };
}

/**
 * Remove `follows` links from an existing entry — the undo for a link that
 * was wrong (e.g. an outcome chained to an item it doesn't settle). The
 * earlier entry regains `[open]` if nothing else follows it.
 */
export async function removeChainLink(opts: {
  laterId: string;
  follows: string[];
  refreshAudit?: boolean;
}): Promise<ChainLinkResult> {
  const catalog = await openCatalogForWrite();
  const entry = await requireEntry(catalog, opts.laterId);
  const current = entry.follows ?? [];
  const missing = opts.follows.filter((id) => !current.includes(id));
  if (missing.length) throw new Error(`${entry.id} does not follow ${missing.join(", ")}`);
  const kept = current.filter((id) => !opts.follows.includes(id));
  return writeFollows(entry, kept, `Unlink memory: ${entry.id} no longer follows ${opts.follows.join(", ")}`, opts.refreshAudit);
}

export async function writeGraphMaintenanceAudit(audit: GraphMaintenanceAudit): Promise<void> {
  await mkdir(INDEX_DIR, { recursive: true });
  await writeFile(GRAPH_MAINTENANCE_PATH, JSON.stringify(audit, null, 2), "utf8");
}

export async function readGraphMaintenanceAudit(): Promise<GraphMaintenanceAudit | null> {
  try {
    return JSON.parse(await readFile(GRAPH_MAINTENANCE_PATH, "utf8")) as GraphMaintenanceAudit;
  } catch {
    return null;
  }
}

export async function refreshGraphMaintenanceAudit(): Promise<GraphMaintenanceAudit> {
  const entries = await (await openCatalogForWrite()).all();
  const audit = await reconcileGraphAudit(
    analyzeGraphHygiene(entries, undefined, slugDismissalKeys(await readSlugDismissals()), await readSlugProposals()),
  );
  await writeGraphMaintenanceAudit(audit);
  return audit;
}

function rel(path: string): string {
  return relative(ROOT, path);
}

function previewSlugMerge(entries: CatalogEntryMeta[], kind: SlugKind, from: string, to: string, createTarget: boolean): SlugMergePreview {
  if (from === to) throw new Error("--from and --to must be different slugs");
  const field = FIELD_BY_KIND[kind];
  const targetExists = entries.some((e) => e[field].includes(to));
  if (!targetExists && !createTarget) {
    throw new Error(`target '${to}' does not exist for ${kind}s; pass --create-target to allow it`);
  }
  // Newest first, id as the tie-break: without it same-day entries keep the
  // catalog's order, which is table order on a new-format slot and corpus
  // order on the legacy one — the printed preview would differ per slot.
  const affected = entries
    .filter((e) => e[field].includes(from))
    .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
  return {
    kind,
    from,
    to,
    affectedEntries: affected.length,
    entries: affected.map((e) => ({ id: e.id, date: e.date, title: e.title, path: rel(e.path) })),
  };
}

async function writeFrontmatterMerge(entry: Pick<MemoryEntry, "path" | "paths">, kind: SlugKind, from: string, to: string): Promise<void> {
  // The slug change comes from the private home, and every copy takes it —
  // but a declared variant keeps its OWN body. This used to write one
  // serialization to every path on the premise that the copies were
  // byte-identical; a variant is the case where they are not, and rebuilding
  // its frontmatter from the home would also drop `variant_of_hash`, so the
  // copy would stop announcing itself as a variant and `graphs sync` would
  // report a clean corpus over published private text.
  const raw = await readFile(entry.path, "utf8");
  const parsed = matter(raw);
  const field = FIELD_BY_KIND[kind];
  const data = { ...parsed.data } as Record<string, unknown>;
  const current = Array.isArray(data[field]) ? data[field].map(String) : [];
  data[field] = [...new Set(current.map((slug) => (slug === from ? to : slug)))];
  const fm = FrontmatterSchema.parse(data) as Frontmatter;
  await writeEntryAll(fm, parsed.content, Object.keys(entry.paths), await readVariants(entry.paths));
}

export interface TagEditResult {
  id: string;
  before: string[];
  after: string[];
  added: string[];
  removed: string[];
  changed: boolean;
  dryRun: boolean;
  /** Graphs holding a copy of the entry (home first). */
  graphs: string[];
  path?: string;
  index?: { added: number; removed: number; unchanged: number };
  afterCommit?: boolean;
}

/**
 * Add and/or remove tags on ONE entry in place — title, body, links, dates,
 * sources and memberships are untouched; only `tags` and `updated` change.
 * Every copy takes the new frontmatter (a declared variant keeps its own body
 * and `variant_of_hash`, see writeEntryAll), the index is re-synced, and each
 * member store is committed. Adding or removing nothing new is a no-op.
 */
export async function applyTagEdit(opts: {
  id: string;
  add?: string[];
  remove?: string[];
  dryRun?: boolean;
}): Promise<TagEditResult> {
  const add = [...new Set(opts.add ?? [])];
  const remove = [...new Set(opts.remove ?? [])];
  const both = add.filter((t) => remove.includes(t));
  if (both.length) throw new Error(`tag in both --add and --remove: ${both.join(", ")}`);
  for (const t of [...add, ...remove]) FrontmatterSchema.shape.tags.parse([t]);

  const catalog = await openCatalogForWrite();
  const entry = await requireEntry(catalog, opts.id);
  const before = [...entry.tags];
  const added = add.filter((t) => !before.includes(t));
  const removed = remove.filter((t) => before.includes(t));
  const after = [...before.filter((t) => !removed.includes(t)), ...added];
  const graphs = sortGraphs(entry.graphs) as GraphId[];
  const base = { id: entry.id, before, after, added, removed, graphs, dryRun: Boolean(opts.dryRun) };
  if (!added.length && !removed.length) return { ...base, changed: false };
  if (opts.dryRun) return { ...base, changed: true };

  const parsed = matter(await readFile(entry.path, "utf8"));
  const fm = FrontmatterSchema.parse({
    ...parsed.data,
    tags: after,
    updated: new Date().toISOString().slice(0, 10),
  }) as Frontmatter;
  const written = await writeEntryAll(fm, parsed.content, Object.keys(entry.paths), await readVariants(entry.paths));
  const path = written[DEFAULT_GRAPH] ?? Object.values(written)[0]!;
  const index = await syncIndex();
  const message = `Tag memory: ${entry.id}` + (added.length ? ` +${added.join(",")}` : "") + (removed.length ? ` -${removed.join(",")}` : "");
  let afterCommit = false;
  for (const g of graphs) {
    afterCommit = (await commitMemoryRepo(message, storeFor(g).dir)) || afterCommit;
  }
  return { ...base, changed: true, path: rel(path), index, afterCommit };
}

export async function mergeSlugs(opts: {
  kind: SlugKind;
  from: string;
  to: string;
  dryRun?: boolean;
  createTarget?: boolean;
  refreshAudit?: boolean;
}): Promise<SlugMergeResult> {
  const catalog = await openCatalogForWrite();
  // The whole vocabulary, not just the `from` matches: the target-exists check
  // has to see every entry carrying `to`.
  const metas = await catalog.all();
  const preview = previewSlugMerge(metas, opts.kind, opts.from, opts.to, Boolean(opts.createTarget));
  if (opts.dryRun) {
    return { ...preview, dryRun: true, beforeCommit: false, afterCommit: false };
  }
  if (preview.affectedEntries === 0) {
    return { ...preview, dryRun: false, beforeCommit: false, afterCommit: false, index: await syncIndex() };
  }

  const affectedIds = new Set(preview.entries.map((e) => e.id));
  const affected = metas.filter((e) => affectedIds.has(e.id));
  // A merge can touch entries across MANY stores — checkpoint and commit each
  // affected store so every side has its own undo point.
  const affectedGraphs = sortGraphs(affected.flatMap((e) => e.graphs)) as GraphId[];
  let beforeCommit = false;
  for (const g of affectedGraphs) {
    beforeCommit =
      (await commitMemoryRepo(
        `Checkpoint before slug merge: ${opts.kind} ${opts.from} -> ${opts.to}`,
        storeFor(g).dir,
      )) || beforeCommit;
  }
  for (const entry of affected) {
    await writeFrontmatterMerge(entry, opts.kind, opts.from, opts.to);
  }
  const index = await syncIndex();
  const audit = opts.refreshAudit === false ? undefined : await refreshGraphMaintenanceAudit();
  let afterCommit = false;
  for (const g of affectedGraphs) {
    afterCommit =
      (await commitMemoryRepo(`Merge ${opts.kind} slug: ${opts.from} -> ${opts.to}`, storeFor(g).dir)) ||
      afterCommit;
  }
  return { ...preview, dryRun: false, beforeCommit, afterCommit, index, ...(audit ? { audit } : {}) };
}
