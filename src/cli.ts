#!/usr/bin/env -S npx tsx
import { parseArgs } from "node:util";
import { dirname, relative } from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { FrontmatterSchema, type Frontmatter } from "./schema.js";
import {
  makeId,
  writeEntry,
  readVariants,
  writeEntryAll,
  entryPath,
  hashEntry,
  normalizeSourceId,
  ROOT,
} from "./ingest.js";
import { search, findSimilar, openCatalogForWrite, syncIndex, type SearchCompleteness, type SearchFilters } from "./store.js";
import { DEFAULT_GRAPH, sharedGraphs, type GraphId, type MemoryEntry, type MemoryType } from "./schema.js";
import {
  createGraph,
  ensureStore,
  listGraphStores,
  loadGraphManifest,
  requireGraph,
  validateContainment,
} from "./graphs.js";
import { copyEntry, deleteGraph, moveEntry, removeEntry, syncGraphs } from "./membership.js";
import { commitMemoryRepo } from "./memory-git.js";
import { buildChainIndex, chainAncestry, entryStatus, OPEN_TYPES, validateFollowsTargets, type ChainAnnotation } from "./chains.js";
import { applyChainLink, dismissSlugSuggestion, removeChainLink, mergeSlugs, proposeSlugMerge, slugUsage, type SlugKind } from "./graph-maintenance.js";
import { recall, type RecallReport } from "./recall.js";
import { keywordPhrase } from "./recall-queries.js";
import { resolveIndexSlotDetailed } from "./index-slots.js";
import { openCatalog } from "./catalog.js";

const rel = (p: string) => relative(ROOT, p);
const list = (s?: string) =>
  (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const today = () => new Date().toISOString().slice(0, 10);
/** Today's date on the local calendar (what "overdue" means to the person reading it). */
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
/** YYYY-MM-DD that round-trips as a real calendar date (rejects 2026-02-30). */
const isRealDate = (s: string) => {
  const t = new Date(`${s}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === s;
};

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

/**
 * `--index-slot <name>` picks the index slot for this command. Resolution in
 * the engine is lazy (index-slots.ts), so exporting the flag as
 * MEMORY_INDEX_SLOT before the first store call is enough; validating here
 * turns a typo into one clear line instead of a stack trace mid-search.
 */
function applyIndexSlotFlag(values: Record<string, unknown>): void {
  const slot = values["index-slot"] as string | undefined;
  if (!slot) return;
  resolveIndexSlotDetailed({ override: slot }); // throws "unknown index slot" / "invalid index slot name"
  process.env.MEMORY_INDEX_SLOT = slot;
}

/** `--person` accepts a slug, a display name, a nickname, or a close slug (see `memory people`). */
async function filtersFrom(values: Record<string, unknown>): Promise<SearchFilters> {
  const { resolvePersonArg } = await import("./people-cli.js");
  return {
    person: await resolvePersonArg((values.person as string) || undefined),
    type: (values.type as string) || undefined,
    team: (values.team as string) || undefined,
    tag: (values.tag as string) || undefined,
    since: (values.since as string) || undefined,
    until: (values.until as string) || undefined,
    graph: values.graph ? requireGraph(values.graph) : undefined,
  };
}

/** ` [team-x,public]` membership marker — private-only entries stay unlabeled. */
function graphSuffix(e: Pick<MemoryEntry, "graphs">): string {
  const shared = sharedGraphs(e);
  return shared.length ? `  [${shared.join(",")}]` : "";
}

function positiveInt(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${label}: expected a positive integer, got '${value}'`);
  return n;
}

const ISO_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function requireUtcIsoTimestamp(value: string): string {
  if (!ISO_UTC_TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`expected UTC ISO timestamp, e.g. 2026-07-03T18:00:00Z; got '${value}'`);
  }
  return value;
}

async function resolveCapturedConnectors(sourceIds: string[], explicitNames: string[]): Promise<string[]> {
  if (sourceIds.length === 0 && explicitNames.length === 0) return [];
  const { loadConnectors } = await import("./connectors.js");
  const connectors = await loadConnectors();
  const known = new Map(connectors.filter((c) => !c.error).map((c) => [c.name, c]));
  const names = new Set<string>();
  for (const name of explicitNames) {
    const connector = known.get(name);
    if (!connector) throw new Error(`--connector: unknown or invalid connector '${name}'`);
    if (!connector.fm!.enabled) throw new Error(`--connector: connector '${name}' is disabled`);
    names.add(name);
  }
  for (const id of sourceIds) {
    const name = id.slice(0, id.indexOf(":"));
    if (known.has(name)) names.add(name);
  }
  return [...names];
}

async function markCapturedConnectors(names: string[], at?: string): Promise<string[]> {
  if (names.length === 0) return [];
  const { markConnectorsCaptured } = await import("./connectors.js");
  return markConnectorsCaptured(names, at);
}

/**
 * Timeline context lines for one hit: where the matter went after this entry
 * (so a stale state can never mislead) and whether an open item is settled.
 */
function chainStatusLines(
  chain: ChainAnnotation | undefined,
  self: { id: string; type: string },
): string[] {
  const lines: string[] = [];
  if (chain?.superseded) {
    lines.push(`⤷ superseded by: ${chain.current.id} (${chain.current.type} · ${chain.current.date})`);
  } else if (chain && chain.latest.id !== self.id) {
    lines.push(`↳ extended by: ${chain.latest.id} (${chain.latest.type} · ${chain.latest.date})`);
  }
  const status = chain?.status ?? (self.type === "pending-decision" || self.type === "todo" ? "open" : undefined);
  if (status) {
    lines.push(`status: ${status === "resolved" && chain?.resolvedBy ? `resolved by ${chain.resolvedBy}` : status}`);
  }
  return lines;
}

/** ` [open]` / ` [resolved → id]` marker for pending-decision/todo listings. */
function statusSuffix(e: Pick<MemoryEntry, "id" | "type">, chainIndex: Map<string, ChainAnnotation>): string {
  const s = entryStatus(e, chainIndex);
  if (!s) return "";
  return s.status === "resolved" ? `  [resolved → ${s.resolvedBy ?? "?"}]` : "  [open]";
}

// ---------------- commands ----------------

async function cmdAdd(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      date: { type: "string" },
      type: { type: "string" },
      title: { type: "string" },
      people: { type: "string" },
      teams: { type: "string" },
      tags: { type: "string" },
      sources: { type: "string" },
      follows: { type: "string" },
      "source-ids": { type: "string" },
      connector: { type: "string" },
      body: { type: "string" },
      id: { type: "string" },
      update: { type: "string" },
      "force-new": { type: "boolean" },
      "dup-threshold": { type: "string" },
      graph: { type: "string" },
      due: { type: "string" },
    },
    allowPositionals: false,
  });

  const date = (values.date as string) || today();
  const due = values.due as string | undefined;
  if (due !== undefined && due.trim() === "") throw new Error("--due needs a date; use `memory due <id> none` to clear one");
  if (due !== undefined && !isRealDate(due)) throw new Error(`--due must be a real YYYY-MM-DD date, got '${due}'`);
  const title = values.title as string;
  if (!title) throw new Error("--title is required");
  const body = (values.body as string) || (await readStdin());
  if (!body) throw new Error("provide --body or pipe the body via stdin");

  const sourceIds = list(values["source-ids"] as string).map(normalizeSourceId);
  const capturedConnectors = await resolveCapturedConnectors(sourceIds, list(values.connector as string));
  const uniq = (xs: string[]) => [...new Set(xs)];
  const requestedGraph: GraphId = values.graph ? requireGraph(values.graph) : DEFAULT_GRAPH;
  // A capture never requires a pre-built index — see `openCatalogForWrite`.
  const catalog = await openCatalogForWrite();

  // --- resolve the target: an existing entry to update in place, or a new one ---
  let target: MemoryEntry | undefined;
  if (values.update) {
    const [meta] = await catalog.byIds([values.update as string]);
    if (!meta) throw new Error(`--update: no entry with id '${values.update}'`);
    target = (await catalog.hydrate([meta]))[0]!;
  } else if (sourceIds.length) {
    const [meta] = await catalog.bySourceIds(sourceIds);
    target = meta ? (await catalog.hydrate([meta]))[0]! : undefined;
    if (target) {
      const matched = sourceIds.find((s) => (target!.source_ids ?? []).includes(s));
      console.log(`↻ matches existing ${target.id} via ${matched}`);
    }
  }

  // An open item is settled by a NEW linked entry, never by rewriting it in
  // place (a thread's outcome shares the thread-root anchor with its todo).
  if (target && OPEN_TYPES.has(target.type) &&
    entryStatus(target, buildChainIndex(await catalog.linked()))?.status === "open") {
    const matched = values.update ? undefined : sourceIds.find((s) => (target!.source_ids ?? []).includes(s));
    // Only Slack has a per-reply id to anchor an outcome on; other sources need their own message id.
    const distinct = matched?.startsWith("slack:") ? `${matched}:<reply_ts>` : "the outcome message's own id";
    if ((values.type && values.type !== target.type) || list(values.follows as string).includes(target.id)) {
      throw new Error(
        `${matched ? `${matched} already anchors` : "--update targets"} the open ${target.type} ${target.id} — ` +
          `log the outcome as a new entry with --follows ${target.id}` +
          (matched ? ` and a distinct source id (${distinct})` : ""),
      );
    }
    if (matched) {
      // stdout, so sweeps that capture the CLI's output see it alongside the `↻ matches` line.
      console.log(`  ⚠ refreshing the open ${target.type} in place — if this capture reports its outcome, ` +
        `log a new entry with --follows ${target.id} (source id: ${distinct}) instead`);
    }
  }

  // An update keeps the entry's own membership — a re-capture must never
  // silently relocate an entry between graphs. Reclassify explicitly instead.
  // A NEW capture always homes in the default graph, even when a graph was
  // named: `--graph` now queues a candidate for review rather than writing
  // into that store, so every memory has a private home to come back to.
  const graphs: string[] = target ? target.graphs : [DEFAULT_GRAPH];
  if (target && values.graph && !target.graphs.includes(requestedGraph)) {
    console.log(
      `↻ ${target.id} lives in [${target.graphs.join(",")}] — --graph ${requestedGraph} ignored; ` +
        `use 'cli.ts copy|move ${target.id} --to ${requestedGraph}' to reclassify`,
    );
  }

  // --- semantic guard for genuinely new captures (no source-id / --update match) ---
  if (!target && !values["force-new"]) {
    const minSim = values["dup-threshold"] ? Number(values["dup-threshold"]) : undefined;
    // An outcome naturally resembles the item it settles — its --follows targets aren't duplicates.
    const settles = new Set(list(values.follows as string));
    const similar = (await findSimilar(`${title}\n${body}`, minSim ? { minSim } : {})).filter((h) => !settles.has(h.id));
    if (similar.length > 0) {
      console.error("✗ this looks like a near-duplicate of:");
      for (const h of similar) console.error(`  ${h.sim.toFixed(3)}  ${h.id} — ${h.title}`);
      console.error(
        "\nResolve: re-run with --update <id> to refresh that entry, or --force-new to add it as a distinct entry.",
      );
      process.exitCode = 2;
      return;
    }
  }

  // --- timeline links: validate new targets against the store ---
  const follows = list(values.follows as string);
  if (follows.length) {
    const sourceId = target?.id ?? ((values.id as string) || makeId(date, title));
    const sourceDate = target?.date ?? date;
    const ancestry = await chainAncestry((ids) => catalog.byIds(ids), follows);
    validateFollowsTargets(ancestry, { id: sourceId, date: sourceDate }, follows);
  }
  const mergedFollows = uniq([...(target?.follows ?? []), ...follows]);

  // --- build the final frontmatter ---
  const mergedSourceIds = uniq([...(target?.source_ids ?? []), ...sourceIds]);
  const fm: Frontmatter = FrontmatterSchema.parse(
    target
      ? {
          id: target.id,
          date: target.date, // immutable: first-seen / event date
          type: (values.type as string) || target.type,
          title,
          people: uniq([...target.people, ...list(values.people as string)]),
          teams: uniq([...target.teams, ...list(values.teams as string)]),
          tags: uniq([...target.tags, ...list(values.tags as string)]),
          ...(target.sources ? { sources: target.sources } : {}),
          ...(mergedFollows.length ? { follows: mergedFollows } : {}),
          ...(mergedSourceIds.length ? { source_ids: mergedSourceIds } : {}),
          // An inherited due is dropped when the entry is retyped out of the open types; an explicit one errors below.
          ...((due ?? (OPEN_TYPES.has(((values.type as string) || target.type) as MemoryType) ? target.due : undefined))
            ? { due: due ?? target.due } : {}),
          updated: today(),
        }
      : {
          id: (values.id as string) || makeId(date, title),
          date,
          type: (values.type as string) || "note",
          title,
          people: list(values.people as string),
          teams: list(values.teams as string),
          tags: list(values.tags as string),
          ...(values.sources ? { sources: list(values.sources as string) } : {}),
          ...(follows.length ? { follows } : {}),
          ...(sourceIds.length ? { source_ids: sourceIds } : {}),
          ...(due ? { due } : {}),
        },
  );
  if (fm.due && fm.type !== "todo" && fm.type !== "pending-decision") {
    throw new Error(`--due applies only to todo / pending-decision entries (this one is a ${fm.type})`);
  }

  // --- a brand-new id must be unique across ALL stores (chains/index/move key by id) ---
  if (!target) {
    const [collision] = await catalog.byIds([fm.id]);
    if (collision) {
      throw new Error(
        `id '${fm.id}' already exists (graphs: ${collision.graphs.join(",")}; ${rel(collision.path)})\n` +
          `  refresh it with --update ${fm.id}, or pick a distinct --id`,
      );
    }
  }

  // --- containment guard: a shared-graph entry only references fellow members ---
  {
    const refs = [...(fm.follows ?? []), ...(fm.sources ?? [])];
    const byId = new Map((await catalog.byIds(refs)).map((t) => [t.id, t]));
    validateContainment(byId, { id: fm.id, graphs }, refs);
  }

  // --- idempotency: skip a re-capture whose content is identical (hash ignores `updated`) ---
  if (target) {
    const candidate: MemoryEntry = {
      ...fm,
      body: body.trim(),
      path: target.path,
      paths: target.paths,
      graphs: target.graphs,
    };
    if (hashEntry(candidate) === hashEntry(target)) {
      console.log(`✓ unchanged ${fm.id}`);
      const captured = await markCapturedConnectors(capturedConnectors);
      if (captured.length) console.log(`  connector captured: ${captured.join(", ")}`);
      return;
    }
  }

  let path: string;
  if (target) {
    // Refresh EVERY materialization so the copy-sync invariant holds — except
    // a declared variant's body, which is a user-approved redaction: it takes
    // the new frontmatter and keeps its own words, going stale (and back into
    // the review queue) rather than being overwritten with the private text.
    const written = await writeEntryAll(fm, body, graphs, await readVariants(target.paths));
    path = written[DEFAULT_GRAPH] ?? Object.values(written)[0]!;
  } else {
    path = await writeEntry(fm, body, DEFAULT_GRAPH);
  }
  const stats = await syncIndex();
  const label = sharedGraphs({ graphs }).length ? ` [${sharedGraphs({ graphs }).join(",")}]` : "";
  console.log(`✓ ${target ? "updated" : "created"} ${fm.id}${label}`);
  console.log(`  ${rel(path)}`);
  console.log(`  indexed (+${stats.added} changed, ${stats.unchanged} unchanged)`);
  for (const s of stats.slots.slice(1)) {
    console.log(s.error ? `  ↻ slot ${s.slot} sync failed: ${s.error}` : `  ↻ synced slot ${s.slot}`);
  }
  const captured = await markCapturedConnectors(capturedConnectors);
  if (captured.length) console.log(`  connector captured: ${captured.join(", ")}`);

  // An explicitly named graph is a proposal too, so it goes through the same
  // review as everything else. Queued before the rules pass, so the user's own
  // reason is the one that sticks if a rule matches the same entry.
  if (!target && requestedGraph !== DEFAULT_GRAPH) {
    try {
      const { enqueue } = await import("./graph-queue.js");
      const res = await enqueue({
        id: fm.id,
        graph: requestedGraph,
        reason: "you asked for this graph when capturing it",
        proposedBy: "add",
      });
      console.log(
        res.queued
          ? `  → queued for '${requestedGraph}' review: memory queue list --graph ${requestedGraph}`
          : `  ⚠ not queued for '${requestedGraph}': ${res.refusal}`,
      );
    } catch (err) {
      console.warn(`  ⚠ not queued: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Standing distribution rules propose on every fresh capture — they queue a
  // candidate, they never publish. A rule failure must not fail the capture.
  if (!target) {
    try {
      const { enqueueRules } = await import("./graph-rules.js");
      const report = await enqueueRules({ ids: [fm.id] });
      for (const line of report.actions) console.log(`  → rule: ${line}`);
      if (report.queued > 0) {
        console.log(`  review queued candidates: memory queue list`);
      }
    } catch (err) {
      console.warn(`  ⚠ rules not applied: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function cmdLink(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { follows: { type: "string" } },
    allowPositionals: true,
  });
  const id = positionals[0];
  const follows = list(values.follows as string);
  if (!id || positionals.length !== 1 || follows.length === 0) {
    throw new Error("usage: memory link <id> --follows <earlier-id,…>");
  }

  const result = await applyChainLink({ laterId: id, follows });
  if (!result.changed) {
    console.log(`✓ unchanged ${id} (already follows ${follows.join(", ")})`);
    return;
  }
  console.log(`✓ linked ${id} → follows ${result.follows.join(", ")}`);
  console.log(`  ${result.path}`);
  if (result.index) {
    console.log(`  indexed (+${result.index.added} changed, ${result.index.unchanged} unchanged)`);
  }
}

async function cmdUnlink(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { follows: { type: "string" } },
    allowPositionals: true,
  });
  const id = positionals[0];
  const follows = list(values.follows as string);
  if (!id || positionals.length !== 1 || follows.length === 0) {
    throw new Error("usage: memory unlink <id> --follows <earlier-id,…>");
  }
  const result = await removeChainLink({ laterId: id, follows });
  console.log(`✓ unlinked ${id} → no longer follows ${follows.join(", ")}` +
    (result.follows.length ? ` (still follows ${result.follows.join(", ")})` : ""));
  console.log(`  ${result.path}`);
}

async function cmdDue(argv: string[]) {
  const [id, when, ...extra] = argv;
  if (!id || !when || extra.length) throw new Error("usage: memory due <id> <YYYY-MM-DD|none>");
  const due = when === "none" ? null : when;
  if (due && !isRealDate(due)) throw new Error(`due date must be a real YYYY-MM-DD date or 'none', got '${when}'`);
  const { applyDueDate } = await import("./graph-maintenance.js");
  const result = await applyDueDate({ id, due });
  if (!result.changed) {
    console.log(`✓ unchanged ${id} (${result.due ? `due ${result.due}` : "no due date"})`);
    return;
  }
  console.log(`✓ ${id} ${result.due ? `due ${result.due}` : "due date cleared"}`);
  console.log(`  ${result.path}`);
}

async function cmdRemove(argv: string[]) {
  const { positionals } = parseArgs({ args: argv, options: {}, allowPositionals: true });
  const id = positionals[0];
  if (!id) throw new Error("usage: memory remove <id>");
  const result = await removeEntry(id);
  if (result.blockedBy) {
    console.error(`✗ ${id} is referenced as a source by: ${result.blockedBy.join(", ")}`);
    console.error("  update or remove those summaries first");
    process.exitCode = 2;
    return;
  }
  if (result.followers?.length) {
    console.log(`⚠ ${id} was followed by: ${result.followers.join(", ")} — their links will dangle`);
  }
  console.log(`✓ removed ${id} from [${result.graphs.join(",")}]`);
  for (const p of result.paths) console.log(`  ${rel(p)}`);
  console.log(
    `  index synced (${result.index?.removed ?? 0} removed); prior content kept in each store's .git history`,
  );
}

async function cmdCopy(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { to: { type: "string" } },
    allowPositionals: true,
  });
  const id = positionals[0];
  if (!id || positionals.length !== 1 || !values.to) {
    throw new Error("usage: memory copy <id> --to <graph>");
  }
  const result = await copyEntry({ id, to: values.to as string });
  if (result.blockedBy) {
    console.error(`✗ ${id} references entries not in '${result.to}': ${result.blockedBy.join(", ")}`);
    console.error(`  copy those first: cli.ts copy <id> --to ${result.to}`);
    process.exitCode = 2;
    return;
  }
  if (!result.changed) {
    console.log(`✓ unchanged ${id} (already a member of '${result.to}')`);
    return;
  }
  console.log(`✓ copied ${id} → ${result.to} graph (stays private too)`);
  console.log(`  ${rel(result.path!)}`);
  console.log(`  indexed (+${result.index?.added ?? 0} changed, ${result.index?.unchanged ?? 0} unchanged)`);
}

async function cmdMove(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { to: { type: "string" } },
    allowPositionals: true,
  });
  const id = positionals[0];
  if (!id || positionals.length !== 1 || !values.to) {
    throw new Error("usage: memory move <id> --to <graph>   (replaces the entry's WHOLE membership)");
  }
  const result = await moveEntry({ id, to: values.to as string });
  if (result.blockedBy) {
    if (result.blockedBy.kind === "refs") {
      console.error(`✗ ${id} references entries not in '${result.to}': ${result.blockedBy.ids.join(", ")}`);
      console.error(`  copy or move those first (cli.ts copy <id> --to ${result.to})`);
    } else {
      console.error(`✗ entries in graphs ${id} is leaving still reference it: ${result.blockedBy.ids.join(", ")}`);
      console.error("  move those first, or keep this entry's membership");
    }
    process.exitCode = 2;
    return;
  }
  if (!result.changed) {
    console.log(`✓ unchanged ${id} (already exactly in the ${result.to} graph)`);
    return;
  }
  console.log(`✓ moved ${id} → ${result.to} graph`);
  if (result.removedFrom?.length) console.log(`  removed from: ${result.removedFrom.join(", ")}`);
  console.log(`  ${rel(result.path!)}`);
  console.log(`  indexed (+${result.index?.added ?? 0} changed, ${result.index?.unchanged ?? 0} unchanged)`);
}

async function cmdGraphs(argv: string[]) {
  const sub = argv[0];
  if (sub === "create") {
    const { values, positionals } = parseArgs({
      args: argv.slice(1),
      options: { "display-name": { type: "string" }, description: { type: "string" } },
      allowPositionals: true,
    });
    const slug = positionals[0];
    if (!slug || positionals.length !== 1) {
      throw new Error('usage: memory graphs create <slug> [--display-name "…"] [--description "…"]');
    }
    const store = await createGraph({
      slug,
      displayName: values["display-name"] as string | undefined,
      description: values.description as string | undefined,
    });
    console.log(`✓ created graph '${store.graph}'`);
    console.log(`  ${rel(store.dir)} (own nested git repo; manifest: ${rel(store.manifestPath)})`);
    return;
  }
  if (sub === "sync") {
    const { values } = parseArgs({ args: argv.slice(1), options: { "dry-run": { type: "boolean" } } });
    const report = await syncGraphs({ dryRun: Boolean(values["dry-run"]) });
    for (const d of report.drift) {
      const state = report.repaired.includes(d.id) ? "repaired (private wins)" : "DRIFTED";
      console.log(`${state}: ${d.id}`);
      for (const c of d.copies) console.log(`  [${c.graph}] ${rel(c.path)} (${c.hash})`);
    }
    for (const v of report.homeViolations) {
      console.log(`⚠ ${v.id} is multi-member without a private home: [${v.graphs.join(",")}]`);
    }
    for (const v of report.containmentViolations) {
      console.log(`⚠ ${v.id} [${v.graph}] references non-members: ${v.targets.join(", ")}`);
    }
    for (const v of report.staleVariants) {
      console.log(
        `⚠ ${v.id} [${v.graph}] published summary predates the current entry ` +
          `(approved against ${v.declared}, now ${v.home}) — the copy is left as published`,
      );
    }
    for (const v of report.variantViolations) {
      console.log(`⚠ ${v.id} [${v.graph}] claims variant_of_hash but cannot be a variant: ${v.reason}`);
    }
    // A current variant is not an issue — it is the approved state. A stale
    // one is, because the shared graph is quietly behind the private original.
    const issues =
      report.drift.length +
      report.homeViolations.length +
      report.containmentViolations.length +
      report.staleVariants.length +
      report.variantViolations.length;
    console.log(
      issues === 0
        ? "✓ all graphs consistent"
        : `${issues} issue${issues === 1 ? "" : "s"} (${report.repaired.length} repaired)`,
    );
    if (issues > report.repaired.length) process.exitCode = 2;
    return;
  }
  if (sub === "delete") {
    const { values, positionals } = parseArgs({
      args: argv.slice(1),
      options: { confirm: { type: "boolean" } },
      allowPositionals: true,
    });
    const slug = positionals[0];
    if (!slug || positionals.length !== 1) throw new Error("usage: memory graphs delete <slug> --confirm");
    if (!values.confirm) {
      throw new Error(
        `deleting a graph is PERMANENT (its git history goes with it) — re-run with --confirm after the user explicitly approves`,
      );
    }
    const result = await deleteGraph(slug);
    if (!result.deleted) {
      console.error(`✗ '${slug}' has entries that exist NOWHERE else: ${result.soleMembers!.join(", ")}`);
      console.error(`  move them out first (cli.ts move <id> --to default), then delete`);
      process.exitCode = 2;
      return;
    }
    console.log(`✓ deleted graph '${result.slug}'`);
    if (result.copiesRemoved) console.log(`  ${result.copiesRemoved} synced copies removed (each still lives in its other graphs)`);
    if (result.rulesRemoved) console.log(`  ${result.rulesRemoved} rule(s) targeting it removed`);
    return;
  }
  if (sub === "list" || sub === undefined) {
    const entries = await (await openCatalog()).all();
    for (const store of listGraphStores()) {
      const count = entries.filter((e) => e.graphs.includes(store.graph)).length;
      const manifest = store.graph === DEFAULT_GRAPH ? null : await loadGraphManifest(store);
      const label =
        store.graph === DEFAULT_GRAPH
          ? "(built-in — the default home of every capture)"
          : manifest?.error
            ? `⚠ invalid manifest: ${manifest.error}`
            : (manifest?.fm?.display_name ?? manifest?.body?.split("\n")[0] ?? "");
      console.log(`● ${store.graph.padEnd(14)} ${String(count).padStart(4)} entries  ${rel(store.dir)}  ${label}`);
    }
    return;
  }
  throw new Error("usage: memory graphs [list] | graphs create <slug> [--display-name …] [--description …] | graphs sync [--dry-run] | graphs delete <slug> --confirm");
}

async function cmdIndex(argv: string[]) {
  // `--build` may be given with no slot name, in which case buildSlot picks
  // the default; parseArgs needs that spelled as an explicit empty value.
  const args = argv.map((a, i) => (a === "--build" && (argv[i + 1]?.startsWith("-") ?? true) ? "--build=" : a));
  const { values, positionals } = parseArgs({
    args,
    options: {
      force: { type: "boolean" },
      reembed: { type: "boolean" },
      rebuild: { type: "boolean" },
      optimize: { type: "boolean" },
      "header-batch": { type: "string" },
      build: { type: "string" },
      "dry-run": { type: "boolean" },
      activate: { type: "string" },
      prune: { type: "boolean" },
      confirm: { type: "boolean" },
    },
    allowPositionals: true,
  });
  if (positionals[0] === "slots") {
    const { slotStatus, formatSlotTable } = await import("./slot-build.js");
    console.log(formatSlotTable(await slotStatus()));
    const r = resolveIndexSlotDetailed();
    if (r.warning) console.log(`⚠ ${r.warning}`);
    return;
  }
  if (positionals.length > 0) throw new Error(`usage: memory index slots   (unknown argument '${positionals[0]}')`);
  if (values.activate !== undefined) {
    const { activateSlot } = await import("./slot-build.js");
    const r = await activateSlot(values.activate);
    if (!r.changed) {
      console.log(`✓ '${r.active.slot}' is already the active slot`);
      return;
    }
    const rollback = r.active.previous ? ` (previous: ${r.active.previous} — roll back with: index --activate previous)` : "";
    console.log(`✓ active slot: ${r.active.slot}${rollback}`);
    return;
  }
  if (values.prune) {
    const { pruneSlots } = await import("./slot-build.js");
    const r = await pruneSlots({ confirm: Boolean(values.confirm) });
    // Printed before the "nothing to prune" line too: a build in flight is the
    // one reason a directory the user can see is deliberately left alone.
    for (const k of r.kept) if (k.startsWith("in-progress build ")) console.log(`kept: ${k}`);
    if (r.removed.length === 0) {
      console.log(`(nothing to prune — only the active slot '${r.active}' exists)`);
      return;
    }
    for (const x of r.removed) {
      const what = x.interrupted ? `interrupted build '${x.slot}'` : `slot '${x.slot}'`;
      console.log(`${r.confirmed ? "✓ removed" : "would remove"} ${what}: ${x.paths.map(rel).join(", ")}`);
    }
    if (r.confirmed) {
      console.log(`kept active slot '${r.active}'; sidecars untouched`);
      return;
    }
    console.error(`\nnothing was deleted — re-run with --confirm (the active slot '${r.active}' and the judgment sidecars are never touched)`);
    process.exitCode = 2;
    return;
  }
  if (values.confirm) throw new Error("usage: --confirm applies only to: memory index --prune --confirm");
  if (values.build !== undefined) {
    // A build always writes every row into a fresh directory, so there is
    // nothing for these two to mean here — and silently ignoring them would
    // let `index --build next --reembed` look like it re-embedded the corpus.
    const stray = [...(values.rebuild ? ["--rebuild"] : []), ...(values.reembed ? ["--reembed"] : [])];
    if (stray.length > 0) {
      throw new Error(
        `usage: ${stray.join(" and ")} ${stray.length > 1 ? "apply" : "applies"} only to a sync of the active slot: memory index [--rebuild] [--reembed]   (a build writes every row anyway; pass --force to replace an already-built slot)`,
      );
    }
    const { buildSlot, formatBuildReport } = await import("./slot-build.js");
    const r = await buildSlot({ name: values.build || undefined, dryRun: Boolean(values["dry-run"]), force: Boolean(values.force) });
    if (r.skipped === "already-built") {
      console.log(
        `✓ slot '${r.slot}' is already built — rebuild it with: npx tsx src/cli.ts index --build ${r.slot} --force`,
      );
      return;
    }
    console.log(`${r.dryRun ? "(dry run) would build" : "✓ built"} slot '${r.slot}' — ${formatBuildReport(r)}`);
    // The slot is built but not activated: `--index-slot` reads it for one
    // command (MEMORY_INDEX_SLOT=<name> does the same for every command).
    if (!r.dryRun) {
      console.log(`  try it: npx tsx src/cli.ts recall "…" --index-slot ${r.slot}`);
      console.log(`  activate it later with: npx tsx src/cli.ts index --activate ${r.slot}`);
    }
    return;
  }
  if (values["dry-run"]) throw new Error("usage: --dry-run applies only to: memory index --build <slot> [--dry-run]");
  const stats = await syncIndex({ force: Boolean(values.force || values.reembed), rebuild: Boolean(values.rebuild) });
  console.log(
    `✓ index synced — ${stats.added} (re)embedded, ${stats.removed} removed, ${stats.unchanged} unchanged`,
  );
  // The active slot is stats.slots[0]; the rest are the other built slots,
  // kept in step so a slot under evaluation never drifts from the source.
  for (const s of stats.slots.slice(1)) {
    console.log(
      s.error
        ? `  ↻ slot ${s.slot} sync failed: ${s.error}`
        : `  ↻ synced slot ${s.slot} (+${s.added} changed, ${s.removed} removed)`,
    );
  }
  if (values.optimize) {
    const { optimizeIndex } = await import("./store.js");
    const r = await optimizeIndex(7, { headerBatch: positiveInt(values["header-batch"], 500, "--header-batch") });
    // `fts a/b`: a of b catalog rows are folded into the full-text index.
    const slots = r.slots
      .map((s) =>
        s.error
          ? `${s.slot} (failed: ${s.error})`
          : `${s.slot}${s.fts ? ` (fts ${s.fts.indexed}/${s.fts.indexed + s.fts.unindexed})` : ""}`,
      )
      .join(", ");
    console.log(
      `✓ optimized — headers backfilled ${r.headers.embedded}, ${r.headers.remaining} remaining${r.headers.remaining ? " (run again to continue)" : ""} · slots ${slots}`,
    );
  }
}

async function cmdQuery(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      person: { type: "string" },
      type: { type: "string" },
      team: { type: "string" },
      tag: { type: "string" },
      since: { type: "string" },
      until: { type: "string" },
      graph: { type: "string" },
      k: { type: "string", short: "k" },
      deep: { type: "boolean" },
      "no-cutoff": { type: "boolean" },
      rerank: { type: "boolean" },
      "index-slot": { type: "string" },
    },
    allowPositionals: true,
  });
  applyIndexSlotFlag(values);
  // Each positional is its own query phrasing; all are fused. Quote each one.
  const queries = positionals.map((q) => q.trim()).filter(Boolean);
  if (queries.length === 0) {
    throw new Error(
      'usage: memory query "<question>" ["<alt phrasing>" …] [--person X] [--type Y] [--since DATE] [-k N] [--deep]',
    );
  }
  const deep = Boolean(values.deep);
  const k = values.k ? Number(values.k) : deep ? 40 : 8;
  const hits = await search(queries, await filtersFrom(values), k, {
    deep,
    noCutoff: Boolean(values["no-cutoff"]),
    ...(values.rerank ? { rerank: true } : {}),
  });
  if (hits.length === 0) {
    console.log("(no matches)");
    return;
  }
  for (const h of hits) {
    const snippet = h.bestChunk.replace(/^#.*\n+/, "").replace(/\s+/g, " ").slice(0, 220);
    console.log(`\n● ${h.entry.title}  [${h.entry.type} · ${h.entry.date}]${graphSuffix(h.entry)}  (score ${h.score.toFixed(3)})`);
    if (h.entry.people.length) console.log(`  people: ${h.entry.people.join(", ")}`);
    if (h.entry.updated) console.log(`  updated: ${h.entry.updated}`);
    if (h.entry.type === "summary" && h.entry.sources?.length) {
      const shown = h.entry.sources.slice(0, 20);
      const more = h.entry.sources.length - shown.length;
      console.log(`  sources: ${shown.join(", ")}${more > 0 ? `, … (+${more} more)` : ""}`);
    }
    for (const line of chainStatusLines(h.chain, h.entry)) console.log(`  ${line}`);
    console.log(`  ${rel(h.entry.path)}`);
    console.log(`  ${snippet}${snippet.length >= 220 ? "…" : ""}`);
  }
}

function recallCompleteness(values: Record<string, unknown>): SearchCompleteness {
  const selected = ["complete", "complete-if-small", "no-complete"].filter((k) => Boolean(values[k]));
  if (selected.length > 1) {
    throw new Error("--complete, --complete-if-small, and --no-complete are mutually exclusive");
  }
  if (values.complete) return "complete";
  if (values["no-complete"]) return "none";
  return "complete-if-small";
}

function printRecallText(report: RecallReport, showQueries: boolean): void {
  console.log(
    `recall: mode=${report.mode} exhaustive=${report.exhaustive ? "yes" : "no"} ` +
      `candidates=${report.candidateCount} considered=${report.consideredCount} returned=${report.returnedCount}`,
  );
  if (report.warnings.length) {
    for (const warning of report.warnings) console.log(`warning: ${warning}`);
  }
  if (showQueries) {
    console.log("\nqueries:");
    for (const q of report.queries) {
      console.log(`  - [${q.origin} x${q.weight}] ${q.text}`);
    }
  }
  if (report.hits.length === 0) {
    console.log("\n(no matches)");
    return;
  }
  for (const h of report.hits) {
    const snippet = h.bestChunk.replace(/\s+/g, " ").slice(0, 220);
    const signals = h.reasons?.retrievalSignals.length ? ` via ${h.reasons.retrievalSignals.join("+")}` : "";
    console.log(`\n- ${h.title}  [${h.type} · ${h.date}]${graphSuffix(h)}  (score ${h.score.toFixed(3)}${signals})`);
    if (h.people.length) console.log(`  people: ${h.people.join(", ")}`);
    if (h.updated) console.log(`  updated: ${h.updated}`);
    if (h.type === "summary" && h.sources?.length) {
      const shown = h.sources.slice(0, 20);
      const more = h.sources.length - shown.length;
      console.log(`  sources: ${shown.join(", ")}${more > 0 ? `, … (+${more} more)` : ""}`);
    }
    for (const line of chainStatusLines(h.chain, h)) console.log(`  ${line}`);
    if (h.digestOf?.length) console.log(`  ⊕ covers: ${h.digestOf.join(", ")}`);
    if (h.coveredBy?.length) console.log(`  ⊕ digest: ${h.coveredBy.join(", ")}`);
    if (h.reasons?.matchedTerms.length) console.log(`  matched terms: ${h.reasons.matchedTerms.join(", ")}`);
    console.log(`  ${h.relPath}`);
    console.log(`  ${snippet}${snippet.length >= 220 ? "…" : ""}`);
  }
}

async function cmdRecall(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      person: { type: "string" },
      type: { type: "string" },
      team: { type: "string" },
      tag: { type: "string" },
      since: { type: "string" },
      until: { type: "string" },
      graph: { type: "string" },
      k: { type: "string", short: "k" },
      format: { type: "string" },
      complete: { type: "boolean" },
      "complete-if-small": { type: "boolean" },
      "complete-limit": { type: "string" },
      "require-complete": { type: "boolean" },
      "no-complete": { type: "boolean" },
      "no-expand": { type: "boolean" },
      "no-cutoff": { type: "boolean" },
      rerank: { type: "boolean" },
      "no-rerank": { type: "boolean" },
      "show-queries": { type: "boolean" },
      shallow: { type: "boolean" },
      "index-slot": { type: "string" },
    },
    allowPositionals: true,
  });
  applyIndexSlotFlag(values);
  const queries = positionals.map((q) => q.trim()).filter(Boolean);
  if (queries.length === 0) {
    throw new Error(
      'usage: memory recall "<question>" ["<agent phrasing>" …] [--person X] [--type Y] [--complete] [--format json]',
    );
  }
  const format = ((values.format as string | undefined) ?? "text").toLowerCase();
  if (format !== "text" && format !== "json") throw new Error("--format must be one of: text, json");

  const report = await recall(queries, {
    filters: await filtersFrom(values),
    k: positiveInt(values.k, 40, "-k"),
    deep: !values.shallow,
    noExpand: Boolean(values["no-expand"]),
    noCutoff: Boolean(values["no-cutoff"]),
    ...(values.rerank ? { rerank: true } : values["no-rerank"] ? { rerank: false } : {}),
    completeness: recallCompleteness(values),
    completeLimit: positiveInt(values["complete-limit"], 200, "--complete-limit"),
    requireComplete: Boolean(values["require-complete"]),
    // Named explicitly as well as via the env, so the reported `index` names
    // the flag's slot even if something later unset MEMORY_INDEX_SLOT.
    ...(values["index-slot"] ? { slot: values["index-slot"] as string } : {}),
  });

  if (format === "json") console.log(JSON.stringify(report, null, 2));
  else printRecallText(report, Boolean(values["show-queries"]));

  if (values["require-complete"] && !report.exhaustive) process.exitCode = 2;
}

async function cmdList(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      person: { type: "string" },
      type: { type: "string" },
      team: { type: "string" },
      tag: { type: "string" },
      since: { type: "string" },
      until: { type: "string" },
      graph: { type: "string" },
      limit: { type: "string" },
      "index-slot": { type: "string" },
    },
  });
  applyIndexSlotFlag(values);
  const catalog = await openCatalog();
  const chainIndex = buildChainIndex(await catalog.linked());
  const entries = (await catalog.filter(await filtersFrom(values))).sort(
    (a, b) => b.date.localeCompare(a.date),
  );
  const limit = values.limit ? Number(values.limit) : entries.length;
  for (const e of entries.slice(0, limit)) {
    console.log(`${e.date}  ${e.type.padEnd(11)} ${e.title}${statusSuffix(e, chainIndex)}${graphSuffix(e)}  (${rel(e.path)})`);
  }
  console.log(`\n${entries.length} entr${entries.length === 1 ? "y" : "ies"}`);
}

/** `slack:C1` matches `slack:C1` and `slack:C1:1700…` — prefixes end on a `:` boundary. */
function sourceIdMatches(sourceId: string, prefix: string): boolean {
  return sourceId === prefix || sourceId.startsWith(`${prefix}:`);
}

/** Recall ranks below this still count as query evidence without a lexical term match. */
const OPEN_SEMANTIC_TOP = 3;

/**
 * Open todo / pending-decision entries — the items a capture can settle via
 * `--follows`. Each row carries its evidence: a source-id prefix match
 * (`exact` when the prefix names a specific message/thread or equals the id,
 * `conversation` when it only names a channel/DM) and/or a recall match over
 * the given phrasings (rank among open items, matched terms). `confidence:
 * high` only for an exact source match, or the single conversation match the
 * phrasing also picks out at rank 1 with matched terms — everything else is a
 * `candidate` the caller must confirm. With neither flag nor phrasing, every
 * open item is listed.
 */
async function cmdOpen(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      source: { type: "string" },
      person: { type: "string" },
      team: { type: "string" },
      tag: { type: "string" },
      since: { type: "string" },
      until: { type: "string" },
      graph: { type: "string" },
      limit: { type: "string" },
      format: { type: "string" },
      overdue: { type: "boolean" },
      "no-due": { type: "boolean" },
      "index-slot": { type: "string" },
    },
    allowPositionals: true,
  });
  applyIndexSlotFlag(values);
  const format = ((values.format as string | undefined) ?? "text").toLowerCase();
  if (format !== "text" && format !== "json") throw new Error("--format must be one of: text, json");
  if (values.overdue && values["no-due"]) throw new Error("--overdue and --no-due are mutually exclusive");
  const queries = positionals.map((q) => q.trim()).filter(Boolean);
  // Same normalization as `add` (lowercase scheme); a bare scheme (`slack`) is rejected there.
  const prefixes = list(values.source as string).map((p) => normalizeSourceId(p.replace(/:+$/, "")));
  const limit = positiveInt(values.limit, 20, "--limit");
  const filters = await filtersFrom(values);

  const catalog = await openCatalog();
  const chainIndex = buildChainIndex(await catalog.linked());
  const isOpen = (e: Pick<MemoryEntry, "id" | "type">) => entryStatus(e, chainIndex)?.status === "open";
  const openTypes = [...OPEN_TYPES];
  const ofType = await Promise.all(openTypes.map((type) => catalog.filter({ ...filters, type })));
  let open = ofType.flat().filter(isOpen);
  // Uniqueness is judged over EVERY open item, never the filtered ones: a
  // --person/--graph/--since (or --overdue/--no-due) that hides the thread's
  // other open ask must not turn an ambiguous prefix into `exact` (which the
  // skills settle unattended).
  const narrowed = Object.values(filters).some((v) => v !== undefined) || Boolean(values.overdue || values["no-due"]);
  const everyOpen = prefixes.length > 0 && narrowed
    ? (await Promise.all(openTypes.map((type) => catalog.filter({ type })))).flat().filter(isOpen)
    : open;
  // `due` lives in the entry file, not the catalog — read it for the (few) open items.
  // An unreadable file just means "no due" for that entry; it never fails the command.
  const dueOf = new Map((await Promise.all(open.map(async (m) => {
    try { const [e] = await catalog.hydrate([m]); return e?.due ? [[m.id, e.due] as const] : []; } catch { return []; }
  }))).flat());
  const now = localToday();
  if (values.overdue) open = open.filter((e) => (dueOf.get(e.id) ?? "9999") < now);
  if (values["no-due"]) open = open.filter((e) => !dueOf.has(e.id));

  type SourceEvidence = { id: string; scope: "exact" | "conversation" };
  type QueryEvidence = { rank: number; score: number; terms: string[] };
  type Row = { id: string; type: string; date: string; title: string; people: string[]; graphs: string[];
    source_ids: string[]; path: string; snippet?: string; due?: string; overdue?: boolean;
    evidence: { source?: SourceEvidence; query?: QueryEvidence }; confidence: "high" | "candidate" };
  const rows = new Map<string, Row>();
  const row = (e: (typeof open)[number]): Row => {
    const r = rows.get(e.id) ?? { id: e.id, type: e.type, date: e.date, title: e.title, people: e.people,
      graphs: e.graphs, source_ids: e.source_ids ?? [], path: rel(e.path), evidence: {}, confidence: "candidate",
      ...(dueOf.has(e.id) ? { due: dueOf.get(e.id)!, overdue: dueOf.get(e.id)! < now } : {}) };
    rows.set(e.id, r);
    return r;
  };

  const matchesIn = (entries: typeof open, p: string) =>
    entries.flatMap((e) => {
      const id = (e.source_ids ?? []).find((s) => sourceIdMatches(s, p));
      return id ? [{ e, id }] : [];
    });

  for (const p of prefixes) {
    const matches = matchesIn(open, p);
    const unique = matchesIn(everyOpen, p).length === 1;
    // Exact: the prefix IS the anchor, or names a thread/message only one open item lives in.
    for (const { e, id } of matches) {
      const scope = id === p || (p.split(":").length >= 3 && unique) ? "exact" : "conversation";
      const r = row(e);
      if (r.evidence.source?.scope !== "exact") r.evidence.source = { id, scope };
    }
  }
  if (queries.length > 0) {
    // One exhaustive recall per open type: the type filter keeps other types
    // from crowding todos out, and covering every entry of the type keeps
    // resolved ones from doing the same. Scores from the two runs aren't
    // comparable, so ranks are per type.
    const byId = new Map(open.map((e) => [e.id, e]));
    // Recall's filter expansion adds the type name ("todo") as a phrase — only
    // terms from the caller's own phrasings count as evidence.
    const asked = keywordPhrase(queries.join(" ")).split(" ").filter(Boolean);
    const reports = await Promise.all(openTypes.map((type, i) => recall(queries, {
      filters: { ...filters, type }, k: Math.max(ofType[i]!.length, 1), deep: true,
      completeness: "complete", completeLimit: Math.max(ofType[i]!.length, 1),
    })));
    for (const report of reports) {
      report.hits.filter((h) => byId.has(h.id)).forEach((h, i) => {
        const terms = (h.reasons?.matchedTerms ?? []).filter((t) => asked.some((a) => a.startsWith(t) || t.startsWith(a)));
        // Exhaustive runs return every open item; only a lexical match or a top rank is evidence.
        if (terms.length === 0 && i >= OPEN_SEMANTIC_TOP) return;
        // With --source the phrasing ranks the conversation's items; it doesn't add other conversations.
        if (prefixes.length > 0 && !rows.has(h.id)) return;
        const r = row(byId.get(h.id)!);
        r.evidence.query = { rank: i + 1, score: Number(h.score.toFixed(4)), terms };
        if (h.bestChunk) r.snippet = h.bestChunk.slice(0, 240);
      });
    }
  } else if (prefixes.length === 0) {
    for (const e of open) row(e);
  }

  const all = [...rows.values()];
  // A person's name matches every ask in their DM — it is not evidence about the matter.
  // A term is a name only if it equals a name part or is its stem (at most 2 chars shorter):
  // "market" is not "mark", "level" is not "levi", "deploy" is not "de".
  const isName = (t: string, part: string) =>
    part === t || (t.length >= 4 && part.startsWith(t) && part.length - t.length <= 2);
  const topical = (r: Row) => (r.evidence.query?.terms ?? []).some((t) =>
    !r.people.some((slug) => slug.split("-").some((part) => isName(t, part))));
  const both = all.filter((r) => r.evidence.source && topical(r));
  for (const r of all) {
    const q = r.evidence.query;
    if (r.evidence.source?.scope === "exact" || (both.length === 1 && both[0] === r && q)) r.confidence = "high";
  }

  // High confidence first, then source evidence, then matched terms, then per-type rank, then newest.
  const rankOf = (r: Row) => r.evidence.query?.rank ?? Number.MAX_SAFE_INTEGER;
  const sorted = all.sort((a, b) =>
    Number(b.confidence === "high") - Number(a.confidence === "high") ||
    Number(Boolean(b.evidence.source)) - Number(Boolean(a.evidence.source)) ||
    (b.evidence.query?.terms.length ?? 0) - (a.evidence.query?.terms.length ?? 0) ||
    rankOf(a) - rankOf(b) ||
    // Only overdue rows jump ahead (soonest-overdue first); everything else keeps newest-first.
    Number(Boolean(b.overdue)) - Number(Boolean(a.overdue)) ||
    (a.overdue && b.overdue ? a.due!.localeCompare(b.due!) : 0) || b.date.localeCompare(a.date),
  );
  const shown = sorted.slice(0, limit);

  if (format === "json") {
    console.log(JSON.stringify({ total: sorted.length, shown: shown.length, items: shown }, null, 2));
    return;
  }
  if (shown.length === 0) {
    console.log("(no matching open items)");
    return;
  }
  for (const r of shown) {
    const ev = [
      r.evidence.source ? `source ${r.evidence.source.scope} ${r.evidence.source.id}` : "",
      r.evidence.query ? `query #${r.evidence.query.rank}${r.evidence.query.terms.length ? ` (${r.evidence.query.terms.join(", ")})` : ""}` : "",
    ].filter(Boolean).join("; ");
    const dueTag = r.due ? `  ${r.overdue ? "⚠ overdue" : "due"} ${r.due}` : "";
    console.log(`${r.date}  ${r.type.padEnd(16)} ${r.title}${graphSuffix(r)}${dueTag}  [${r.confidence}${ev ? `: ${ev}` : ""}]`);
    console.log(`    ${r.id}  (${r.path})`);
  }
  const of = sorted.length > shown.length ? ` of ${sorted.length}` : "";
  console.log(`\n${shown.length}${of} open item${sorted.length === 1 ? "" : "s"} — confirm each, then settle with: memory add … --follows <id,…>`);
}

async function cmdPerson(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { graph: { type: "string" }, "index-slot": { type: "string" } },
    allowPositionals: true,
  });
  const given = positionals[0];
  if (!given || positionals.length !== 1) throw new Error("usage: memory person <slug-or-name> [--graph <name>]");
  applyIndexSlotFlag(values);
  const slug = (await (await import("./people-cli.js")).resolvePersonArg(given))!;
  const graph = values.graph ? requireGraph(values.graph) : undefined;
  const catalog = await openCatalog();
  const chainIndex = buildChainIndex(await catalog.linked());
  const entries = (await catalog.filter({ person: slug, ...(graph ? { graph } : {}) })).sort(
    (a, b) => b.date.localeCompare(a.date),
  );
  if (entries.length === 0) {
    console.log(`(no memories mention '${slug}')`);
    return;
  }
  console.log(`# Memories involving ${slug} (${entries.length})\n`);
  for (const e of entries) {
    console.log(`${e.date}  [${e.type}] ${e.title}${statusSuffix(e, chainIndex)}${graphSuffix(e)}  (${rel(e.path)})`);
  }
}

async function cmdDigest(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      person: { type: "string" },
      quarter: { type: "string" }, // e.g. 2026-Q2
      tag: { type: "string" },
      graph: { type: "string" },
    },
  });
  const person = values.person as string | undefined;
  const quarter = values.quarter as string | undefined;
  const tag = values.tag as string | undefined;
  if (!person && !quarter && !tag) {
    throw new Error("usage: memory digest --person <slug> | --quarter <YYYY-Qn> | --tag <slug> [--graph <name>]");
  }
  // A digest lives in ONE graph. A private digest may cite sources anywhere
  // (private may reference everything); a shared-graph digest must restrict
  // its candidates to that graph's members so `sources` back-links can't leak.
  const digestGraph: GraphId = values.graph ? requireGraph(values.graph) : DEFAULT_GRAPH;

  let scope: SearchFilters = {};
  let id: string;
  let title: string;
  if (person) {
    scope = { person };
    id = `summary-person-${person}`;
    title = `Rolling summary — ${person}`;
  } else if (tag) {
    scope = { tag };
    id = `summary-tag-${tag}`;
    title = `Rolling summary — #${tag}`;
  } else {
    const [year, q] = quarter!.split("-Q");
    const start = `${year}-${String((Number(q) - 1) * 3 + 1).padStart(2, "0")}-01`;
    const endMonth = Number(q) * 3;
    const until = `${year}-${String(endMonth).padStart(2, "0")}-31`;
    scope = { since: start, until };
    id = `summary-${year}-q${q}`;
    title = `Rolling summary — ${quarter}`;
  }

  if (digestGraph !== DEFAULT_GRAPH) {
    scope = { ...scope, graph: digestGraph };
    // Ids are unique across ALL stores — a shared-graph digest gets its own
    // id so it never collides with the private digest of the same scope.
    id = id.replace(/^summary-/, `summary-${digestGraph}-`);
  }
  const raw = (await (await openCatalog()).filter(scope))
    .filter((e) => e.type !== "summary")
    .sort((a, b) => a.date.localeCompare(b.date));

  if (raw.length === 0) {
    console.log("(no raw entries match that scope — nothing to summarize)");
    return;
  }

  const bullets = raw.map((e) => `- ${e.date} — **${e.title}** (${e.type})`).join("\n");
  const body = [
    `> Rolling summary generated by \`memory digest\` on ${today()}.`,
    `> Sources are raw entries — the agent should refine the **Synthesis** section`,
    `> below into prose; the source list and back-links must stay intact.`,
    ``,
    `## Sources (${raw.length})`,
    bullets,
    ``,
    `## Synthesis`,
    `_To be written/refined by the agent: themes, evolution, open threads,`,
    `decisions, and what to watch next across the sources above._`,
  ].join("\n");

  const fm = FrontmatterSchema.parse({
    id,
    date: today(),
    type: "summary",
    title,
    people: person ? [person] : [...new Set(raw.flatMap((e) => e.people))],
    teams: [...new Set(raw.flatMap((e) => e.teams))],
    tags: tag ? [tag] : [...new Set(raw.flatMap((e) => e.tags))],
    sources: raw.map((e) => e.id),
  });

  if (digestGraph !== DEFAULT_GRAPH) await ensureStore(digestGraph);
  const path = await writeEntry(fm, body, digestGraph);
  await syncIndex();
  console.log(`✓ digest written: ${rel(path)}`);
  console.log(`  ${raw.length} source entries linked. Refine the Synthesis section, then re-run \`memory index\`.`);
}

async function cmdPromote(argv: string[]) {
  const sub = argv[0];
  const { dismissPromotion, promotionCandidates, readPromotionDismissals } = await import("./promote.js");

  if (sub === "dismiss") {
    const { values, positionals } = parseArgs({
      args: argv.slice(1),
      options: { reason: { type: "string" }, graph: { type: "string" } },
      allowPositionals: true,
    });
    const id = positionals[0];
    if (!id || positionals.length !== 1) {
      throw new Error('usage: memory promote dismiss <id> [--graph <name>] [--reason "…"]');
    }
    if (!values.graph) throw new Error("--graph <name> is required (which graph was this declined for?)");
    const graph = requireGraph(values.graph as string);
    const d = await dismissPromotion(id, graph, values.reason as string | undefined);
    console.log(`✓ ${d.id} won't be proposed for '${graph}' again unless its content changes`);
    return;
  }

  if (sub === "candidates" || sub === undefined) {
    const { values } = parseArgs({
      args: sub ? argv.slice(1) : argv,
      options: {
        to: { type: "string" },
        since: { type: "string" },
        until: { type: "string" },
        limit: { type: "string" },
      },
    });
    if (!values.to) throw new Error("--to <graph> is required — memory graphs list shows the registry");
    const graph = requireGraph(values.to as string);
    if (graph === DEFAULT_GRAPH) throw new Error("promotion targets a shared graph — the default graph is the source");
    const entries = await (await openCatalog()).all();
    const candidates = promotionCandidates(entries, await readPromotionDismissals(), {
      graph,
      since: values.since as string | undefined,
      until: values.until as string | undefined,
    });
    const limit = values.limit ? positiveInt(values.limit, candidates.length, "--limit") : candidates.length;
    for (const c of candidates.slice(0, limit)) {
      const blocked = c.blockedBy.length ? `  [blocked by non-member refs: ${c.blockedBy.join(", ")}]` : "";
      console.log(`${c.date}  ${c.type.padEnd(11)} ${c.id}${blocked}`);
    }
    console.log(
      `\n${candidates.length} candidate${candidates.length === 1 ? "" : "s"} for '${graph}' ` +
        `(not yet reviewed; apply the graph's eligibility criteria before proposing any)`,
    );
    return;
  }

  throw new Error(
    'usage: memory promote candidates [--to <graph>] [--since DATE] [--until DATE] [--limit N] | promote dismiss <id> [--graph <name>] [--reason "…"]',
  );
}

async function cmdQueue(argv: string[]) {
  const sub = argv[0];
  const q = await import("./graph-queue.js");

  const relDate = (iso?: string): string => (iso ? iso.slice(0, 10) : "—");

  if (sub === "list" || sub === undefined) {
    const { values } = parseArgs({
      args: sub ? argv.slice(1) : argv,
      options: {
        graph: { type: "string" },
        state: { type: "string" },
        limit: { type: "string" },
        json: { type: "boolean" },
      },
    });
    const graph = values.graph ? requireGraph(values.graph as string) : undefined;
    const view = await q.queueView(graph ? { graph } : {});
    const state = values.state as string | undefined;
    let rows = view.rows;
    if (state === "stale") rows = rows.filter((r) => r.state === "stale");
    else if (state === "blocked") rows = rows.filter((r) => r.blockedBy.length > 0);
    else if (state === "ready") rows = rows.filter((r) => r.state === "ready" && r.blockedBy.length === 0);
    else if (state && state !== "all") throw new Error("--state must be ready|stale|blocked|all");
    const limit = values.limit ? positiveInt(values.limit, rows.length, "--limit") : rows.length;
    rows = rows.slice(0, limit);

    if (values.json) {
      // Deliberately without the summary text: a routine driving the loop
      // should not spray drafted redactions through its logs. `queue show`
      // carries the body when it is actually needed.
      console.log(
        JSON.stringify({
          generatedAt: view.generatedAt,
          totalPending: view.totalPending,
          graphs: view.graphs,
          items: rows.map(({ summary, ...r }) => ({ ...r, hasSummary: summary !== undefined })),
        }),
      );
      return;
    }

    for (const r of rows) {
      const marks = [
        r.summary !== undefined ? (r.state === "stale" ? "summary(STALE)" : "summary") : "raw",
        r.action === "move" ? "move" : "",
        r.blockedBy.length ? `blocked by ${r.blockedBy.join(", ")}` : "",
      ].filter(Boolean);
      console.log(`${r.date}  ${r.type.padEnd(16)} ${r.id}  [${r.graph}]  ${marks.join(" · ")}`);
      console.log(`    ${r.proposedBy}: ${r.reason}`);
    }
    if (rows.length === 0) console.log("nothing pending");
    for (const g of view.graphs) {
      console.log(
        `\n${g.graph}: ${g.pending} pending` +
          (g.stale ? `, ${g.stale} stale` : "") +
          (g.blocked ? `, ${g.blocked} blocked` : "") +
          ` · ${g.members} members · reviewed ${relDate(g.lastReviewedAt)}` +
          ` · swept through ${g.sweptThrough ?? "never"}`,
      );
    }
    if (rows.length > 0) {
      console.log(`\nApprove one at a time: memory queue approve <id> --graph <name> [--summary]`);
    }
    return;
  }

  if (sub === "show") {
    const { values, positionals } = parseArgs({
      args: argv.slice(1),
      options: { graph: { type: "string" }, json: { type: "boolean" } },
      allowPositionals: true,
    });
    const id = positionals[0];
    if (!id || !values.graph) throw new Error("usage: memory queue show <id> --graph <name> [--json]");
    const row = await q.requireRow(id, requireGraph(values.graph as string));
    if (values.json) {
      console.log(JSON.stringify(row));
      return;
    }
    console.log(`${row.id}  [${row.graph}]  ${row.date}  ${row.type}`);
    console.log(`  ${row.title}`);
    console.log(`  proposed by ${row.proposedBy} at ${row.proposedAt}`);
    console.log(`  why: ${row.reason}`);
    if (row.blockedBy.length) console.log(`  blocked by: ${row.blockedBy.join(", ")}`);
    if (row.summary !== undefined) {
      console.log(`\n  --- proposed shared wording${row.state === "stale" ? " (STALE — the entry changed since this was drafted)" : ""} ---`);
      for (const line of row.summary.split("\n")) console.log(`  ${line}`);
      console.log(`\n  the private entry itself: ${rel(row.path)}`);
    }
    return;
  }

  if (sub === "add") {
    const { values, positionals } = parseArgs({
      args: argv.slice(1),
      options: {
        to: { type: "string" },
        action: { type: "string" },
        reason: { type: "string" },
        "summary-file": { type: "string" },
        "proposed-by": { type: "string" },
        force: { type: "boolean" },
        json: { type: "boolean" },
      },
      allowPositionals: true,
    });
    const id = positionals[0];
    if (!id || !values.to || !values.reason) {
      throw new Error(
        'usage: memory queue add <id> --to <graph> --reason "…" [--action copy|move] [--summary-file <path|->] [--proposed-by <label>] [--force]',
      );
    }
    const action = (values.action as string | undefined) ?? "copy";
    if (action !== "copy" && action !== "move") throw new Error("--action must be copy or move");
    // A redaction is usually several paragraphs; a file keeps it out of the
    // shell's quoting rules (and out of the command text hooks scan).
    let summary: string | undefined;
    const file = values["summary-file"] as string | undefined;
    if (file) {
      const { readFile } = await import("node:fs/promises");
      summary = (file === "-" ? await readStdin() : await readFile(file, "utf8")).trim();
      if (!summary) throw new Error(`--summary-file ${file} is empty`);
    }
    const res = await q.enqueue({
      id,
      graph: requireGraph(values.to as string),
      action,
      reason: values.reason as string,
      proposedBy: (values["proposed-by"] as string | undefined) ?? "agent",
      ...(summary ? { summary } : {}),
      force: Boolean(values.force),
    });
    if (values.json) {
      console.log(JSON.stringify(res));
      if (!res.queued) process.exitCode = 2;
      return;
    }
    if (!res.queued) {
      console.log(`– not queued: ${res.refusal}`);
      process.exitCode = 2;
      return;
    }
    if (res.replacedSummary) console.log(`⚠ replaced an earlier proposal that carried a drafted summary`);
    console.log(`✓ queued ${res.id} → ${res.graph} (${action}${summary ? ", with a summary" : ""})`);
    console.log(`  review it: memory queue list --graph ${res.graph}`);
    return;
  }

  if (sub === "approve") {
    const { values, positionals } = parseArgs({
      args: argv.slice(1),
      options: { graph: { type: "string" }, summary: { type: "boolean" }, json: { type: "boolean" } },
      allowPositionals: true,
    });
    const id = positionals[0];
    if (!id || !values.graph) {
      throw new Error("usage: memory queue approve <id> --graph <name> [--summary]");
    }
    const res = await q.approveCandidate({
      id,
      graph: requireGraph(values.graph as string),
      variant: values.summary ? "summary" : "raw",
    });
    if (values.json) {
      console.log(JSON.stringify(res));
      return;
    }
    console.log(
      `✓ ${res.action === "move" ? "moved" : "copied"} ${res.id} → ${res.graph}` +
        (res.variantOf ? " (the approved summary, not the entry's own wording)" : ""),
    );
    console.log(`  ${rel(res.path)}`);
    return;
  }

  if (sub === "dismiss") {
    const { values, positionals } = parseArgs({
      args: argv.slice(1),
      options: { graph: { type: "string" }, reason: { type: "string" } },
      allowPositionals: true,
    });
    const id = positionals[0];
    if (!id || !values.graph) {
      throw new Error('usage: memory queue dismiss <id> --graph <name> [--reason "…"]');
    }
    const graph = requireGraph(values.graph as string);
    await q.dismissCandidate({ id, graph, reason: values.reason as string | undefined });
    console.log(`✓ ${id} won't be proposed for '${graph}' again unless its content changes`);
    return;
  }

  if (sub === "sweep") {
    const { values } = parseArgs({
      args: argv.slice(1),
      options: { graph: { type: "string" }, through: { type: "string" }, force: { type: "boolean" } },
    });
    if (!values.graph) throw new Error("usage: memory queue sweep --graph <name> [--through YYYY-MM-DD] [--force]");
    const graph = requireGraph(values.graph as string);
    const p = await q.markSwept(graph, {
      through: values.through as string | undefined,
      force: Boolean(values.force),
    });
    console.log(`✓ ${graph} swept through ${p.sweptThrough}`);
    return;
  }

  throw new Error(
    "usage: memory queue list|show|add|approve|dismiss|sweep — see memory --help",
  );
}

async function cmdRules(argv: string[]) {
  const sub = argv[0];
  const { readRules, enqueueRules, matchRule } = await import("./graph-rules.js");

  if (sub === "apply") {
    const { values } = parseArgs({ args: argv.slice(1), options: { "dry-run": { type: "boolean" } } });
    const dryRun = Boolean(values["dry-run"]);
    const report = await enqueueRules({ dryRun });
    for (const c of report.plan.conflicts) console.log(`⚠ skipped ${c.id}: ${c.reason}`);
    if (dryRun) {
      for (const a of report.plan.actions) console.log(`would queue ${a.id} → ${a.graph} (${a.action})`);
      console.log(`\n${report.plan.actions.length} candidate(s), ${report.plan.conflicts.length} conflict(s) — dry run, nothing queued`);
      return;
    }
    for (const line of report.actions) console.log(`✓ ${line}`);
    for (const b of report.blocked) {
      console.log(`⚠ ${b.id} → ${b.graph} is queued but references non-members: ${b.ids.join(", ")}`);
    }
    console.log(
      `\n${report.queued} queued, ${report.skipped} skipped, ${report.skippedConflicts} conflict(s), ${report.blocked.length} blocked`,
    );
    if (report.queued > 0) console.log(`Review them: memory queue list`);
    return;
  }

  if (sub === "list" || sub === undefined) {
    const rules = await readRules();
    if (rules.length === 0) {
      console.log("(no rules configured — memory/graphs/rules.json)");
      return;
    }
    const entries = await (await openCatalog()).all();
    for (const r of rules) {
      const match = [r.match.tag ? `tag #${r.match.tag}` : "", r.match.type ? `type ${r.match.type}` : ""]
        .filter(Boolean)
        .join(" + ");
      const n = entries.filter(
        (e) => e.graphs.includes(DEFAULT_GRAPH) && matchRule({ tags: e.tags, type: e.type }, r),
      ).length;
      console.log(`● ${match}  →  ${r.graph}  (${r.mode})   matches ${n} private entr${n === 1 ? "y" : "ies"}`);
    }
    return;
  }

  throw new Error("usage: memory rules [list] | rules apply [--dry-run]");
}

async function cmdMaintenance(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: { threshold: { type: "string" } },
  });
  const threshold = values.threshold ? Number(values.threshold) : 15;
  if (!Number.isInteger(threshold) || threshold < 1) {
    throw new Error(`--threshold: expected a positive integer, got '${values.threshold}'`);
  }
  const { runMaintenance } = await import("./maintenance.js");
  await runMaintenance(threshold);
}

function requireSlugKind(value: unknown): SlugKind {
  if (value === "person" || value === "team" || value === "tag") return value;
  throw new Error("--kind must be one of: person, team, tag");
}

async function cmdSlugs(argv: string[]) {
  const sub = argv[0];
  if (sub === "list") return cmdSlugsList(argv.slice(1));
  if (sub === "dismiss") return cmdSlugsDismiss(argv.slice(1));
  if (sub === "propose") return cmdSlugsPropose(argv.slice(1));
  if (sub !== "merge") {
    throw new Error(
      "usage: memory slugs list --kind person|team|tag [--min-count N]\n" +
        "       memory slugs merge --kind person|team|tag --from <slug> --to <slug> [--dry-run] [--create-target]\n" +
        "       memory slugs propose --kind person|team|tag --from <slug> --to <slug> --reason \"…\"\n" +
        "       memory slugs dismiss --kind person|team|tag --from <slug> --to <slug>",
    );
  }
  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      kind: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      "dry-run": { type: "boolean" },
      "create-target": { type: "boolean" },
    },
  });
  const kind = requireSlugKind(values.kind);
  const from = values.from as string | undefined;
  const to = values.to as string | undefined;
  if (!from || !to) throw new Error("slugs merge requires --from and --to");

  const result = await mergeSlugs({
    kind,
    from,
    to,
    dryRun: Boolean(values["dry-run"]),
    createTarget: Boolean(values["create-target"]),
  });

  const verb = result.dryRun ? "would merge" : "merged";
  console.log(`✓ ${verb} ${kind} '${from}' → '${to}'`);
  console.log(`  affected entries: ${result.affectedEntries}`);
  for (const e of result.entries.slice(0, 20)) {
    console.log(`  ${e.date}  ${e.id}  (${e.path})`);
  }
  if (result.entries.length > 20) console.log(`  … +${result.entries.length - 20} more`);
  if (!result.dryRun && result.index) {
    console.log(`  index synced (+${result.index.added} changed, ${result.index.unchanged} unchanged)`);
    console.log(
      `  memory repo checkpoints: before=${result.beforeCommit ? "committed" : "clean/absent"} after=${
        result.afterCommit ? "committed" : "clean/absent"
      }`,
    );
  }
}

async function cmdSlugsList(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      kind: { type: "string" },
      "min-count": { type: "string" },
    },
  });
  const kind = requireSlugKind(values.kind);
  const minCount = positiveInt(values["min-count"], 1, "--min-count");

  const entries = await (await openCatalog()).all();
  const usage = slugUsage(entries, kind).filter((s) => s.count >= minCount);
  for (const s of usage) {
    console.log(`${String(s.count).padStart(4)}  ${s.slug}  (last seen ${s.lastSeen ?? "n/a"})`);
  }
  console.log(`${usage.length} ${kind} slug${usage.length === 1 ? "" : "s"} across ${entries.length} entries`);
}

async function cmdSlugsPropose(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      kind: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      reason: { type: "string" },
    },
  });
  const kind = requireSlugKind(values.kind);
  const from = values.from as string | undefined;
  const to = values.to as string | undefined;
  const reason = (values.reason as string | undefined)?.trim();
  if (!from || !to) throw new Error("slugs propose requires --from and --to");
  if (!reason) throw new Error("slugs propose requires --reason (shown with the suggestion in the maintenance screen)");

  await proposeSlugMerge(kind, from, to, reason);
  console.log(`✓ proposed ${kind} merge '${from}' → '${to}' — deferred to the maintenance screen (memory ui) and \`memory maintenance\``);
  console.log(`  it stays suggested until merged or ignored there; reason: ${reason}`);
}

async function cmdSlugsDismiss(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      kind: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
    },
  });
  const kind = requireSlugKind(values.kind);
  const from = values.from as string | undefined;
  const to = values.to as string | undefined;
  if (!from || !to) throw new Error("slugs dismiss requires --from and --to");

  await dismissSlugSuggestion(kind, from, to);
  console.log(`✓ dismissed ${kind} suggestion '${from}' → '${to}' (won't be suggested again; stored in .index/slug-dismissals.json)`);
}

async function cmdConnectorsMarkPulled(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { at: { type: "string" } },
    allowPositionals: true,
  });
  const name = positionals[0];
  if (!name || positionals.length !== 1) {
    throw new Error("usage: memory connectors mark-pulled <name> [--at ISO_TIMESTAMP]");
  }
  const at = requireUtcIsoTimestamp((values.at as string | undefined) ?? new Date().toISOString());
  const { loadConnectors, markConnectorPulled } = await import("./connectors.js");
  const connector = (await loadConnectors()).find((c) => c.name === name);
  if (!connector) throw new Error(`unknown connector '${name}'`);
  if (connector.error) throw new Error(`connector '${name}' is invalid: ${connector.error.split("\n")[0]}`);
  if (!connector.fm!.enabled) throw new Error(`connector '${name}' is disabled`);
  if (!connector.fm!.fetch) throw new Error(`connector '${name}' is push-only and cannot be marked pulled`);
  const state = await markConnectorPulled(name, at);
  console.log(`✓ marked ${name} pulled at ${state.last_pulled}`);
}

async function cmdConnectorsMarkCaptured(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { at: { type: "string" } },
    allowPositionals: true,
  });
  const name = positionals[0];
  if (!name || positionals.length !== 1) {
    throw new Error("usage: memory connectors mark-captured <name> [--at ISO_TIMESTAMP]");
  }
  const at = requireUtcIsoTimestamp((values.at as string | undefined) ?? new Date().toISOString());
  const captured = await resolveCapturedConnectors([], [name]);
  await markCapturedConnectors(captured, at);
  console.log(`✓ marked ${name} captured at ${at}`);
}

async function cmdConnectors(argv: string[]) {
  if (argv[0] === "mark-pulled") return cmdConnectorsMarkPulled(argv.slice(1));
  if (argv[0] === "mark-captured") return cmdConnectorsMarkCaptured(argv.slice(1));
  if (argv.length > 0) {
    throw new Error(
      "usage: memory connectors [mark-pulled <name> [--at ISO_TIMESTAMP] | mark-captured <name> [--at ISO_TIMESTAMP]]",
    );
  }

  const { loadConnectors, loadConnectorState, relConnector } = await import("./connectors.js");
  const [connectors, state] = await Promise.all([loadConnectors(), loadConnectorState()]);
  if (connectors.length === 0) {
    console.log("(no connector files under connectors/ or memory/connectors/)");
    return;
  }
  let invalid = 0;
  for (const c of connectors) {
    if (c.error) {
      invalid++;
      console.log(`✗ ${c.name}  (${relConnector(c.path)})`);
      for (const line of c.error.split("\n")) console.log(`    ${line}`);
      continue;
    }
    const fm = c.fm!;
    const pulled = state[c.name]?.last_pulled ?? "never pulled";
    const captured = state[c.name]?.last_captured ?? "never captured";
    const mode = fm.fetch ? "pull" : "push";
    const preview = (c.body ?? "").split("\n").find((l) => l.trim() && !l.startsWith("#")) ?? "";
    console.log(
      `${fm.enabled ? "●" : "○"} ${c.name.padEnd(12)} ${mode}  ${fm.source_id_scheme}` +
        (c.origin === "override" ? "  [private override]" : ""),
    );
    console.log(`    last pulled: ${fm.fetch ? pulled : "n/a (push-only)"}`);
    console.log(`    last captured: ${captured}`);
    if (preview) console.log(`    ${preview.trim().slice(0, 100)}`);
  }
  console.log(
    `\n${connectors.length - invalid}/${connectors.length} valid` +
      (invalid ? " — fix the files above (schema is strict)" : ""),
  );
  if (invalid) process.exitCode = 1;
}

async function cmdSources(argv: string[]) {
  if (argv.length > 0) throw new Error("usage: memory sources");
  const { loadSources, relSource } = await import("./sources.js");
  const sources = await loadSources();
  if (sources.length === 0) {
    console.log("(no source files under sources/ or memory/sources/)");
    return;
  }
  let invalid = 0;
  for (const s of sources) {
    if (s.error) {
      invalid++;
      console.log(`✗ ${s.name}  (${relSource(s.path)})`);
      for (const line of s.error.split("\n")) console.log(`    ${line}`);
      continue;
    }
    const fm = s.fm!;
    const preview = (s.body ?? "").split("\n").find((l) => l.trim() && !l.startsWith("#")) ?? "";
    console.log(
      `${fm.enabled ? "●" : "○"} ${s.name.padEnd(12)} ${fm.kind}  ${fm.lookup.command}` +
        (s.origin === "override" ? "  [private override]" : ""),
    );
    if (fm.lookup.refresh) {
      console.log(
        `    refresh: ${fm.lookup.refresh}` +
          (fm.lookup.cache_ttl_days ? ` (cache ttl ${fm.lookup.cache_ttl_days}d)` : ""),
      );
    }
    if (preview) console.log(`    ${preview.trim().slice(0, 100)}`);
  }
  console.log(
    `\n${sources.length - invalid}/${sources.length} valid` +
      (invalid ? " — fix the files above (schema is strict)" : ""),
  );
  if (invalid) process.exitCode = 1;
}

async function cmdUi(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: "string" },
      "no-open": { type: "boolean" },
    },
  });
  const port = values.port ? Number(values.port) : 4664;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`--port: invalid port '${values.port}'`);
  }
  const { startServer } = await import("./server.js");
  await startServer({ port, open: !values["no-open"] });
}

// ---------------- dispatch ----------------

const HELP = `memory — local personal-memory RAG

Usage:
  memory add --title "…" --type 1on1 --people a,b [--date YYYY-MM-DD] [--tags …] --body "…"
            # types: event|decision|todo|pending-decision|1on1|hiring|incident|achievement|feedback|meeting|note|summary
            [--source-ids slack:C123:1700000000.1,gmail:<thread-id>]  # dedup anchor
            [--connector raw-capture]  # extraction prompt/source used for capture bookkeeping
            [--follows <id,…>]   # timeline link: this entry develops/settles the listed earlier entries
            [--due YYYY-MM-DD]   # todo / pending-decision only: when it is due (infer from the content)
            [--update <id>]      # refresh a specific entry in place
            [--force-new]        # bypass the near-duplicate guard
            [--dup-threshold N]  # cosine threshold for the guard (default 0.92)
            [--graph <name>]     # file a NEW entry in that graph (default private; reserved for an
                                 # EXPLICIT user request — updates keep their entry's membership)
  memory link <id> --follows <earlier-id,…>
            # add timeline links to an existing entry (e.g. a decision settling a pending-decision)
            # containment is enforced: a shared-graph entry only references fellow members
  memory unlink <id> --follows <earlier-id,…>
            # remove wrong timeline links (an outcome chained to an item it doesn't settle);
            # the earlier entry shows [open] again unless something else follows it
  memory remove <id>   # delete ALL of an entry's copies + sync index (content stays in each repo's history)
  memory copy <id> --to <graph>
            # add membership: materialize the entry into another graph (it stays private too);
            # every copy is kept in sync automatically on later updates
  memory move <id> --to <graph>
            # replace the entry's WHOLE membership with <graph> (removes every other copy);
            # move --to private = full repatriation. Containment validated both directions
  memory graphs [list]                 # registry: private + every memory-graphs/<slug>/ store
  memory graphs create <slug> [--display-name "…"] [--description "…"]
  memory graphs sync [--dry-run]       # detect + repair drifted copies (default copy wins), report violations
  memory graphs delete <slug> --confirm  # PERMANENT: blocked while entries exist only there; user must approve
  memory rules [list]                  # standing distribution rules (memory/graphs/rules.json)
  memory rules apply [--dry-run]       # reconcile all rules against existing private entries
  memory index [--force|--reembed] [--rebuild] [--optimize [--header-batch N]]   # --rebuild: rebuild the synced slots' catalog/lexical tables reusing vectors; --reembed (= --force): drop and re-embed; --optimize compacts + backfills title vectors (memory_headers) in bounded batches
  memory index --build [<slot>] [--dry-run] [--force]       # build a complete new-format index beside the current one (vectors reused; never activates)
            # the slot name defaults to 'next' (or 'main' when the store has no index at all)
  memory index --activate <slot|previous>                   # switch the active slot (writes .index/active.json; the old one is kept as 'previous')
  memory index --prune [--confirm]                          # delete non-active slots' derived artifacts (never sidecars; plan only without --confirm)
  memory index slots                                        # status table: name, format, state, entries, chunks, last sync
  memory query "<question>" ["<alt phrasing>" …] [--person X] [--type Y] [--since DATE] [--until DATE] [--graph <name>] [-k N] [--deep] [--no-cutoff] [--index-slot <name>]
            # each quoted positional is a separate phrasing; all are fused (2-4 recommended)
            # --deep: recall-over-precision preset (k=40, wider candidate pool)
  memory recall "<question>" ["<agent phrasing>" …] [--person X] [--type Y] [--since DATE] [--until DATE] [--graph G] [-k N] [--index-slot <name>]
            [--complete | --complete-if-small | --no-complete] [--require-complete] [--no-expand] [--no-cutoff] [--rerank|--no-rerank] [--format text|json]
            # --rerank: opt-in second pass through a local cross-encoder (MEMORY_RERANK=1 to default on; ~1-2 s, one-time model download)
            # first phrasing is primary; extras are agent-supplied; CLI adds deterministic expansions unless --no-expand
            # default: k=40, deep pools, complete-if-small (limit 200)
            # --graph <name> scopes to one graph's members; default searches ALL (shared memberships labeled)
            # --index-slot <name>: query another built index slot (A/B before \`index --activate\`); MEMORY_INDEX_SLOT=<name> does the same
  memory list [--person|--type|--team|--tag|--since|--until|--graph|--limit]
  memory open ["<phrasing>" …] [--source <prefix,…>] [--person X] [--since DATE] [--graph G] [--limit N] [--format text|json]
            # unresolved todo / pending-decision entries a new capture may settle (pass confirmed ids to --follows);
            # --source: narrowest prefix first (slack:C1:<thread_ts> = exact; slack:D123 = whole conversation);
            # each row shows its evidence + confidence (high|candidate); --since/--until filter the OPEN item's date
            # [--overdue | --no-due]: only items past their due date / without one (for due-date backfill)
  memory due <id> <YYYY-MM-DD|none>   # set/clear an open todo / pending-decision's due date (all graph copies)
  memory person <slug> [--graph <name>]
  memory digest --person <slug> | --quarter <YYYY-Qn> | --tag <slug> [--graph <name>]
            # shared-graph digest: candidates restricted to that graph's members; written there (id summary-<graph>-…)
  memory maintenance [--threshold N]  # read-only report: digest debt, index health, slug hygiene (default 15)
  memory slugs list --kind person|team|tag [--min-count N]
            # vocabulary with usage counts (for tag compaction / slug reuse)
  memory slugs merge --kind person|team|tag --from <slug> --to <slug> [--dry-run] [--create-target]
            # explicit slug merge; rewrites frontmatter arrays, syncs index, checkpoints memory/.git
  memory slugs propose --kind person|team|tag --from <slug> --to <slug> --reason "…"
            # defer a merge decision: shows as a suggestion in maintenance + web UI until merged/ignored
  memory slugs dismiss --kind person|team|tag --from <slug> --to <slug>
            # permanently hide a wrong merge suggestion from maintenance
  memory promote candidates [--to <graph>] [--since DATE] [--until DATE] [--limit N]
            # private entries awaiting promotion review for <graph> (default public)
  memory promote dismiss <id> [--graph <name>] [--reason "…"]   # record "not for that graph" — hidden until content changes
  memory queue list [--graph <name>] [--state ready|stale|blocked|all] [--limit N] [--json]
            # candidates waiting on you, per graph, with each proposer's reasoning
  memory queue show <id> --graph <name> [--json]        # one candidate in full, including any proposed shared wording
  memory queue add <id> --to <graph> --reason "…" [--action copy|move] [--summary-file <path|->] [--proposed-by <label>] [--force]
            # propose a candidate (what a sweep routine calls); --summary-file offers redacted wording to publish instead
  memory queue approve <id> --graph <name> [--summary]  # publish it — --summary uses the proposed wording, else the entry's own
  memory queue dismiss <id> --graph <name> [--reason "…"]       # decline — hidden until the entry's content changes
  memory queue sweep --graph <name> [--through YYYY-MM-DD] [--force]
            # record how far a routine has swept, so the next one resumes there
  memory people alias <slug> --add "Name" [--add "Nick"] [--remove "Name"] [--display "Full Name"] [--create]
            # nicknames/display names for a person slug (memory/people/<slug>.md, private store only);
            # questions and --person then resolve "Zhenya" → evgenia-ivanova
  memory people list [--min-count N] | people show <slug-or-name>
  memory eval add-golden "<query>" ["<agent phrasing>" …] --expect <id,…> [filters] [--must-outrank <winner>:<loser>]… [--absent <id,…>]
            # save a user-confirmed retrieval expectation to the private golden set (memory/eval/golden.json)
  memory eval list | eval remove-golden <id>
  memory eval run [--compare] [--baseline <path>] [--save-baseline] [--json <out>] [--only <id-prefix>]
            # score the live store against the golden set; --compare (vs memory/eval/baseline.json) exits 2 on regression
  memory connectors                  # list + validate connectors/<name>.md (fetch config + extraction prompt per source)
  memory connectors mark-pulled <name> [--at ISO_TIMESTAMP]
            # record that a connector sweep completed; captures are recorded by memory add
  memory connectors mark-captured <name> [--at ISO_TIMESTAMP]
            # backfill/record connector prompt usage without changing memories
  memory sources                     # list + validate sources/<name>.md (reference directories consulted by
                                     # maintenance slug hygiene and by agents before minting new slugs)
  memory ui [--port N] [--no-open]   # local web UI (default port 4664; memory writes limited to connector config
                                     # and slug merges — all via the same validated CLI code paths)
`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "add": return cmdAdd(rest);
    case "link": return cmdLink(rest);
    case "unlink": return cmdUnlink(rest);
    case "due": return cmdDue(rest);
    case "remove": return cmdRemove(rest);
    case "move": return cmdMove(rest);
    case "copy": return cmdCopy(rest);
    case "graphs": return cmdGraphs(rest);
    case "rules": return cmdRules(rest);
    case "index": return cmdIndex(rest);
    case "query": return cmdQuery(rest);
    case "recall": return cmdRecall(rest);
    case "list": return cmdList(rest);
    case "open": return cmdOpen(rest);
    case "person": return cmdPerson(rest);
    case "digest": return cmdDigest(rest);
    case "maintenance": return cmdMaintenance(rest);
    case "slugs": return cmdSlugs(rest);
    case "connectors": return cmdConnectors(rest);
    case "promote": return cmdPromote(rest);
    case "queue": return cmdQueue(rest);
    case "eval": return (await import("./eval-cli.js")).cmdEval(rest);
    case "people": return (await import("./people-cli.js")).cmdPeople(rest);
    case "sources": return cmdSources(rest);
    case "ui": return cmdUi(rest);
    case undefined:
    case "help":
    case "-h":
    case "--help":
      console.log(HELP);
      return;
    default:
      console.error(`unknown command: ${cmd}\n\n${HELP}`);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
