import { readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DEFAULT_GRAPH, sortGraphs, type MemoryEntry } from "./schema.js";
import { entryPath, loadAllEntries, loadEntryFiles, groupEntries, type CopyDrift } from "./ingest.js";
import { ensureStore, requireGraph, storeFor, validateContainment } from "./graphs.js";
import { syncIndex } from "./store.js";
import { commitMemoryRepo } from "./memory-git.js";

/**
 * The sanctioned membership write paths (synced-copy model): copy an entry
 * into another graph, move it (replace its whole membership), remove all
 * materializations, and repair drift. Used by the CLI and the UI server —
 * never reimplemented elsewhere.
 */

export interface SyncStats {
  added: number;
  removed: number;
  unchanged: number;
}

export interface CopyResult {
  id: string;
  to: string;
  changed: boolean;
  path?: string;
  blockedBy?: string[];
  index?: SyncStats;
}

/** Add membership in `to` by materializing the home copy there. */
export async function copyEntry(opts: { id: string; to: string }): Promise<CopyResult> {
  const to = requireGraph(opts.to);
  if (to === DEFAULT_GRAPH) {
    throw new Error("copy --to private is meaningless — use 'move <id> --to private' to repatriate");
  }
  const entries = await loadAllEntries();
  const entry = entries.find((e) => e.id === opts.id);
  if (!entry) throw new Error(`no entry with id '${opts.id}'`);
  if (!entry.graphs.includes(DEFAULT_GRAPH)) {
    throw new Error(
      `'${opts.id}' is not a private member (graphs: ${entry.graphs.join(", ")}) — ` +
        `copies originate from private; move it back first`,
    );
  }
  if (entry.graphs.includes(to)) return { id: entry.id, to, changed: false };

  // Containment: everything this entry references must already be in `to`.
  const byId = new Map(entries.map((e) => [e.id, e]));
  const refs = [...(entry.follows ?? []), ...(entry.sources ?? [])];
  const blockedBy = refs.filter((r) => {
    const t = byId.get(r);
    return t !== undefined && !t.graphs.includes(to);
  });
  if (blockedBy.length > 0) return { id: entry.id, to, changed: false, blockedBy };

  await ensureStore(to);
  await commitMemoryRepo(`Checkpoint before copy: ${entry.id}`, storeFor(to).dir);
  const raw = await readFile(entry.path, "utf8"); // home bytes, verbatim
  const dest = entryPath(entry, to);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, raw, "utf8");
  const index = await syncIndex();
  await commitMemoryRepo(`Add memory: ${entry.id}`, storeFor(to).dir);
  return { id: entry.id, to, changed: true, path: dest, index };
}

export interface MoveResult {
  id: string;
  to: string;
  changed: boolean;
  path?: string;
  removedFrom?: string[];
  blockedBy?: { kind: "refs" | "referrers"; ids: string[] };
  index?: SyncStats;
}

/**
 * Move = replace the ENTIRE membership set with `{to}`. Every other copy is
 * removed (multi-member moves list the removals). Preconditions:
 * - outbound (to ≠ private): all referenced entries must be members of `to`;
 * - inbound: no referrer may hold a non-private membership the entry is
 *   leaving (that store would dangle/leak).
 */
export async function moveEntry(opts: { id: string; to: string }): Promise<MoveResult> {
  const to = requireGraph(opts.to);
  const entries = await loadAllEntries();
  const entry = entries.find((e) => e.id === opts.id);
  if (!entry) throw new Error(`no entry with id '${opts.id}'`);
  if (entry.graphs.length === 1 && entry.graphs[0] === to) {
    return { id: entry.id, to, changed: false };
  }

  const byId = new Map(entries.map((e) => [e.id, e]));
  if (to !== DEFAULT_GRAPH) {
    const refs = [...(entry.follows ?? []), ...(entry.sources ?? [])];
    const violators = refs.filter((r) => {
      const t = byId.get(r);
      return t !== undefined && !t.graphs.includes(to);
    });
    if (violators.length > 0) {
      return { id: entry.id, to, changed: false, blockedBy: { kind: "refs", ids: violators } };
    }
  }
  const leaving = entry.graphs.filter((g) => g !== to);
  const blockingReferrers = entries.filter((e) => {
    if (e.id === entry.id) return false;
    const refsEntry = (e.follows?.includes(entry.id) ?? false) || (e.sources?.includes(entry.id) ?? false);
    if (!refsEntry) return false;
    // A referrer blocks when it sits in a non-private graph the entry is leaving.
    return e.graphs.some((g) => g !== DEFAULT_GRAPH && leaving.includes(g));
  });
  if (blockingReferrers.length > 0) {
    return {
      id: entry.id,
      to,
      changed: false,
      blockedBy: { kind: "referrers", ids: blockingReferrers.map((e) => e.id) },
    };
  }

  const affected = sortGraphs([...entry.graphs, to]);
  await ensureStore(to);
  for (const g of affected) {
    await commitMemoryRepo(`Checkpoint before move: ${entry.id}`, storeFor(g).dir);
  }

  const raw = await readFile(entry.path, "utf8");
  const dest = entryPath(entry, to);
  if (!entry.graphs.includes(to)) {
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, raw, "utf8");
  }
  const removedFrom: string[] = [];
  for (const g of entry.graphs) {
    if (g === to) continue;
    await rm(entry.paths[g]!);
    removedFrom.push(g);
  }

  const index = await syncIndex();
  // Shared repos get context-free messages; only the private repo records
  // where the entry went.
  for (const g of affected) {
    const msg =
      g === DEFAULT_GRAPH
        ? `Move memory: ${entry.id} → ${to}`
        : g === to
          ? `Add memory: ${entry.id}`
          : `Remove memory: ${entry.id}`;
    await commitMemoryRepo(msg, storeFor(g).dir);
  }
  return { id: entry.id, to, changed: true, path: dest, removedFrom, index };
}

export interface RemoveResult {
  id: string;
  paths: string[];
  graphs: string[];
  blockedBy?: string[];
  followers?: string[];
  index?: SyncStats;
}

/** Delete every materialization of an entry (content stays in each repo's history). */
export async function removeEntry(id: string): Promise<RemoveResult> {
  const entries = await loadAllEntries();
  const target = entries.find((e) => e.id === id);
  if (!target) throw new Error(`no entry with id '${id}'`);

  const referrers = entries.filter((e) => e.sources?.includes(id));
  if (referrers.length) {
    return { id, paths: [], graphs: target.graphs, blockedBy: referrers.map((e) => e.id) };
  }
  const followers = entries.filter((e) => e.follows?.includes(id)).map((e) => e.id);

  for (const g of target.graphs) {
    await commitMemoryRepo(`Checkpoint before remove: ${id}`, storeFor(g).dir);
  }
  const paths = target.graphs.map((g) => target.paths[g]!);
  for (const p of paths) await rm(p);
  const index = await syncIndex();
  for (const g of target.graphs) {
    await commitMemoryRepo(`Remove memory: ${id}`, storeFor(g).dir);
  }
  return { id, paths, graphs: target.graphs, followers, index };
}

export interface SyncGraphsReport {
  drift: CopyDrift[];
  repaired: string[];
  /** Multi-member entries missing their private home (report-only). */
  homeViolations: { id: string; graphs: string[] }[];
  /** Containment violations across the corpus (report-only). */
  containmentViolations: { id: string; graph: string; targets: string[] }[];
}

/**
 * Corpus-wide consistency check + drift repair. Drifted copies are repaired
 * by rewriting every non-private copy from the private bytes (private wins),
 * checkpointed per store. Home/containment violations are reported, never
 * auto-fixed (they need a human decision: copy targets or move entries).
 */
export async function syncGraphs(opts: { dryRun?: boolean } = {}): Promise<SyncGraphsReport> {
  const files = await loadEntryFiles();
  const { entries, drift } = groupEntries(files, "collect");

  const homeViolations = entries
    .filter((e) => e.graphs.length > 1 && !e.graphs.includes(DEFAULT_GRAPH))
    .map((e) => ({ id: e.id, graphs: e.graphs }));

  const byId = new Map(entries.map((e) => [e.id, e]));
  const containmentViolations: SyncGraphsReport["containmentViolations"] = [];
  for (const e of entries) {
    for (const g of e.graphs) {
      if (g === DEFAULT_GRAPH) continue;
      const refs = [...(e.follows ?? []), ...(e.sources ?? [])];
      const bad = refs.filter((r) => {
        const t = byId.get(r);
        return t !== undefined && !t.graphs.includes(g);
      });
      if (bad.length) containmentViolations.push({ id: e.id, graph: g, targets: bad });
    }
  }

  const repaired: string[] = [];
  if (!opts.dryRun) {
    for (const d of drift) {
      const home = d.copies.find((c) => c.graph === DEFAULT_GRAPH);
      if (!home) continue; // no private copy to win — report-only (shows as drift)
      const raw = await readFile(home.path, "utf8");
      const others = d.copies.filter((c) => c.graph !== DEFAULT_GRAPH);
      for (const c of others) {
        await commitMemoryRepo(`Checkpoint before graph sync: ${d.id}`, storeFor(c.graph).dir);
      }
      for (const c of others) await writeFile(c.path, raw, "utf8");
      for (const c of others) {
        await commitMemoryRepo(`Sync memory: ${d.id}`, storeFor(c.graph).dir);
      }
      repaired.push(d.id);
    }
    if (repaired.length) await syncIndex();
  }
  return { drift, repaired, homeViolations, containmentViolations };
}
