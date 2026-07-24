import { mkdir, readFile, writeFile } from "node:fs/promises";
import { relative, join } from "node:path";
import matter from "gray-matter";
import { FrontmatterSchema, type Frontmatter, type MemoryEntry } from "./schema.js";
import { INDEX_DIR, ROOT, loadAllEntries, writeEntry } from "./ingest.js";
import { syncIndex, findSimilar } from "./store.js";
import { commitMemoryRepo } from "./memory-git.js";
import { buildChainIndex, entryStatus, validateFollowsTargets } from "./chains.js";

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

export interface ChainLinkSuggestion {
  openId: string;
  openTitle: string;
  openType: string;
  openDate: string;
  laterId: string;
  laterTitle: string;
  laterType: string;
  laterDate: string;
  sim: number;
  shared: string[];
}

export interface GraphMaintenanceAudit {
  generatedAt: string;
  counts: Record<SlugKind, number>;
  suggestionCounts: Record<SlugKind, number>;
  suggestions: SlugSuggestion[];
  /** Absent in audits written before timeline chains existed. */
  chainSuggestions?: ChainLinkSuggestion[];
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

function countByKind(entries: MemoryEntry[], kind: SlugKind): Map<string, SlugStats> {
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

export function slugUsage(entries: MemoryEntry[], kind: SlugKind): SlugUsage[] {
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

function similarity(a: string, b: string): number {
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
  entries: MemoryEntry[],
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

  suggestions.sort(
    (a, b) =>
      b.confidence - a.confidence ||
      b.affectedEntries - a.affectedEntries ||
      b.lastSeen?.localeCompare(a.lastSeen ?? "") ||
      a.kind.localeCompare(b.kind) ||
      a.from.localeCompare(b.from),
  );
  return { generatedAt, counts, suggestionCounts, suggestions };
}

/** "clearly related" for bge-small — well below the 0.92 near-duplicate bar. */
const CHAIN_SUGGESTION_MIN_SIM = 0.6;

export const CHAIN_DISMISSALS_PATH = join(INDEX_DIR, "chain-dismissals.json");

export interface ChainDismissal {
  openId: string;
  laterId: string;
  dismissedAt: string;
}

export async function readChainDismissals(): Promise<ChainDismissal[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(CHAIN_DISMISSALS_PATH, "utf8"));
    return Array.isArray(parsed) ? (parsed as ChainDismissal[]) : [];
  } catch {
    return [];
  }
}

/**
 * Persistently hide one wrong suggestion (the pair, in either role order,
 * never resurfaces). Lives in `.index/` like connector state: user judgment
 * that is cheap to re-give if the index dir is ever wiped.
 */
export async function dismissChainSuggestion(openId: string, laterId: string): Promise<GraphMaintenanceAudit> {
  const dismissals = await readChainDismissals();
  if (!dismissals.some((d) => d.openId === openId && d.laterId === laterId)) {
    dismissals.push({ openId, laterId, dismissedAt: new Date().toISOString() });
    await mkdir(INDEX_DIR, { recursive: true });
    await writeFile(CHAIN_DISMISSALS_PATH, JSON.stringify(dismissals, null, 2), "utf8");
  }
  return refreshGraphMaintenanceAudit();
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
 * chain dismissals: user judgment that is cheap to re-give if wiped.
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
  const entries = await loadAllEntries();
  const stats = countByKind(entries, kind);
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

/**
 * Slugs carried by most of the store (e.g. the owner's own person slug) say
 * nothing about two entries being the same matter — drop them as evidence.
 */
function commonSlugs(entries: MemoryEntry[]): Set<string> {
  if (entries.length < 8) return new Set();
  const counts = new Map<string, number>();
  for (const e of entries) {
    for (const s of new Set([...e.people, ...e.tags])) counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  return new Set([...counts.entries()].filter(([, n]) => n > entries.length / 2).map(([s]) => s));
}

/**
 * Likely missing timeline links: for every still-open pending-decision/todo,
 * later entries that are semantically close AND share a person or tag but sit
 * in a different (or no) chain. Needs the vector index (returns [] without it).
 */
export async function analyzeChainLinks(entries: MemoryEntry[]): Promise<ChainLinkSuggestion[]> {
  const chainIndex = buildChainIndex(entries);
  const open = entries.filter((e) => entryStatus(e, chainIndex)?.status === "open");
  if (open.length === 0) return [];
  const byId = new Map(entries.map((e) => [e.id, e] as const));
  const componentOf = (id: string): string => chainIndex.get(id)?.latest.id ?? id;
  const dismissed = new Set((await readChainDismissals()).map((d) => `${d.openId}|${d.laterId}`));
  const common = commonSlugs(entries);

  const out: ChainLinkSuggestion[] = [];
  for (const o of open) {
    const similar = await findSimilar(`${o.title}\n${o.body}`, {
      minSim: CHAIN_SUGGESTION_MIN_SIM,
      limit: 5,
    });
    for (const hit of similar) {
      const e = byId.get(hit.id);
      if (!e || e.id === o.id || e.type === "summary") continue;
      if (e.date <= o.date) continue;
      if (componentOf(e.id) === componentOf(o.id)) continue; // already chained together
      if (dismissed.has(`${o.id}|${e.id}`)) continue; // user said: wrong pair
      const shared = [
        ...e.people.filter((p) => o.people.includes(p) && !common.has(p)),
        ...e.tags.filter((t) => o.tags.includes(t) && !common.has(t)),
      ];
      if (shared.length === 0) continue;
      out.push({
        openId: o.id,
        openTitle: o.title,
        openType: o.type,
        openDate: o.date,
        laterId: e.id,
        laterTitle: e.title,
        laterType: e.type,
        laterDate: e.date,
        sim: hit.sim,
        shared,
      });
    }
  }
  return out.sort((a, b) => b.sim - a.sim);
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
  const entries = await loadAllEntries();
  const entry = entries.find((e) => e.id === opts.laterId);
  if (!entry) throw new Error(`no entry with id '${opts.laterId}'`);
  validateFollowsTargets(entries, entry, opts.follows);

  const mergedFollows = [...new Set([...(entry.follows ?? []), ...opts.follows])];
  if (mergedFollows.length === (entry.follows ?? []).length) {
    return { laterId: entry.id, follows: entry.follows ?? [], changed: false };
  }

  const { body, path: _p, ...rest } = entry;
  const fm = FrontmatterSchema.parse({
    ...rest,
    follows: mergedFollows,
    updated: new Date().toISOString().slice(0, 10),
  }) as Frontmatter;
  const path = await writeEntry(fm, body);
  const index = await syncIndex();
  // The add-time auto-commit hook only fires on `add`; commit explicitly.
  const afterCommit = await commitMemoryRepo(
    `Link memory: ${entry.id} follows ${mergedFollows.join(", ")}`,
  );
  const audit = opts.refreshAudit === false ? undefined : await refreshGraphMaintenanceAudit();
  return {
    laterId: entry.id,
    follows: mergedFollows,
    changed: true,
    path: rel(path),
    index,
    afterCommit,
    ...(audit ? { audit } : {}),
  };
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
  const entries = await loadAllEntries();
  const audit = analyzeGraphHygiene(entries, undefined, slugDismissalKeys(await readSlugDismissals()), await readSlugProposals());
  audit.chainSuggestions = await analyzeChainLinks(entries);
  await writeGraphMaintenanceAudit(audit);
  return audit;
}

function rel(path: string): string {
  return relative(ROOT, path);
}

function previewSlugMerge(entries: MemoryEntry[], kind: SlugKind, from: string, to: string, createTarget: boolean): SlugMergePreview {
  if (from === to) throw new Error("--from and --to must be different slugs");
  const field = FIELD_BY_KIND[kind];
  const targetExists = entries.some((e) => e[field].includes(to));
  if (!targetExists && !createTarget) {
    throw new Error(`target '${to}' does not exist for ${kind}s; pass --create-target to allow it`);
  }
  const affected = entries
    .filter((e) => e[field].includes(from))
    .sort((a, b) => b.date.localeCompare(a.date));
  return {
    kind,
    from,
    to,
    affectedEntries: affected.length,
    entries: affected.map((e) => ({ id: e.id, date: e.date, title: e.title, path: rel(e.path) })),
  };
}

async function writeFrontmatterMerge(entry: MemoryEntry, kind: SlugKind, from: string, to: string): Promise<void> {
  const raw = await readFile(entry.path, "utf8");
  const parsed = matter(raw);
  const field = FIELD_BY_KIND[kind];
  const data = { ...parsed.data } as Record<string, unknown>;
  const current = Array.isArray(data[field]) ? data[field].map(String) : [];
  data[field] = [...new Set(current.map((slug) => (slug === from ? to : slug)))];
  const fm = FrontmatterSchema.parse(data) as Frontmatter;
  await writeFile(entry.path, matter.stringify(parsed.content, fm), "utf8");
}

export async function mergeSlugs(opts: {
  kind: SlugKind;
  from: string;
  to: string;
  dryRun?: boolean;
  createTarget?: boolean;
  refreshAudit?: boolean;
}): Promise<SlugMergeResult> {
  const entries = await loadAllEntries();
  const preview = previewSlugMerge(entries, opts.kind, opts.from, opts.to, Boolean(opts.createTarget));
  if (opts.dryRun) {
    return { ...preview, dryRun: true, beforeCommit: false, afterCommit: false };
  }
  if (preview.affectedEntries === 0) {
    return { ...preview, dryRun: false, beforeCommit: false, afterCommit: false, index: await syncIndex() };
  }

  const beforeCommit = await commitMemoryRepo(`Checkpoint before slug merge: ${opts.kind} ${opts.from} -> ${opts.to}`);
  const affectedIds = new Set(preview.entries.map((e) => e.id));
  for (const entry of entries) {
    if (affectedIds.has(entry.id)) await writeFrontmatterMerge(entry, opts.kind, opts.from, opts.to);
  }
  const index = await syncIndex();
  const audit = opts.refreshAudit === false ? undefined : await refreshGraphMaintenanceAudit();
  const afterCommit = await commitMemoryRepo(`Merge ${opts.kind} slug: ${opts.from} -> ${opts.to}`);
  return { ...preview, dryRun: false, beforeCommit, afterCommit, index, ...(audit ? { audit } : {}) };
}
