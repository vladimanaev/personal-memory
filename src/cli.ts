#!/usr/bin/env -S npx tsx
import { parseArgs } from "node:util";
import { dirname, relative } from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { FrontmatterSchema, type Frontmatter } from "./schema.js";
import {
  loadAllEntries,
  makeId,
  writeEntry,
  writeEntryAll,
  entryPath,
  hashEntry,
  findEntryBySourceIds,
  normalizeSourceId,
  ROOT,
} from "./ingest.js";
import { search, findSimilar, syncIndex, applyFilters, type SearchCompleteness, type SearchFilters } from "./store.js";
import { PRIVATE_GRAPH, sharedGraphs, type GraphId, type MemoryEntry } from "./schema.js";
import {
  createGraph,
  ensureStore,
  listGraphStores,
  loadGraphManifest,
  requireGraph,
  validateContainment,
} from "./graphs.js";
import { copyEntry, moveEntry, removeEntry, syncGraphs } from "./membership.js";
import { commitMemoryRepo } from "./memory-git.js";
import { buildChainIndex, entryStatus, validateFollowsTargets, type ChainAnnotation } from "./chains.js";
import { applyChainLink, dismissSlugSuggestion, mergeSlugs, proposeSlugMerge, slugUsage, type SlugKind } from "./graph-maintenance.js";
import { recall, type RecallReport } from "./recall.js";

const rel = (p: string) => relative(ROOT, p);
const list = (s?: string) =>
  (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const today = () => new Date().toISOString().slice(0, 10);

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

function filtersFrom(values: Record<string, unknown>): SearchFilters {
  return {
    person: (values.person as string) || undefined,
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
  if (chain && chain.latest.id !== self.id) {
    lines.push(`⤷ superseded by: ${chain.latest.id} (${chain.latest.type} · ${chain.latest.date})`);
  }
  const status = chain?.status ?? (self.type === "pending-decision" || self.type === "todo" ? "open" : undefined);
  if (status) {
    lines.push(`status: ${status === "resolved" && chain?.resolvedBy ? `resolved by ${chain.resolvedBy}` : status}`);
  }
  return lines;
}

/** ` [open]` / ` [resolved → id]` marker for pending-decision/todo listings. */
function statusSuffix(e: MemoryEntry, chainIndex: Map<string, ChainAnnotation>): string {
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
    },
    allowPositionals: false,
  });

  const date = (values.date as string) || today();
  const title = values.title as string;
  if (!title) throw new Error("--title is required");
  const body = (values.body as string) || (await readStdin());
  if (!body) throw new Error("provide --body or pipe the body via stdin");

  const sourceIds = list(values["source-ids"] as string).map(normalizeSourceId);
  const capturedConnectors = await resolveCapturedConnectors(sourceIds, list(values.connector as string));
  const uniq = (xs: string[]) => [...new Set(xs)];
  const requestedGraph: GraphId = values.graph ? requireGraph(values.graph) : PRIVATE_GRAPH;
  const entries = await loadAllEntries();

  // --- resolve the target: an existing entry to update in place, or a new one ---
  let target: MemoryEntry | undefined;
  if (values.update) {
    target = entries.find((e) => e.id === values.update);
    if (!target) throw new Error(`--update: no entry with id '${values.update}'`);
  } else if (sourceIds.length) {
    target = findEntryBySourceIds(entries, sourceIds);
    if (target) {
      const matched = sourceIds.find((s) => (target!.source_ids ?? []).includes(s));
      console.log(`↻ matches existing ${target.id} via ${matched}`);
    }
  }

  // An update keeps the entry's own membership — a re-capture must never
  // silently relocate an entry between graphs. Reclassify explicitly instead.
  const graphs: string[] = target ? target.graphs : [requestedGraph];
  if (target && values.graph && !target.graphs.includes(requestedGraph)) {
    console.log(
      `↻ ${target.id} lives in [${target.graphs.join(",")}] — --graph ${requestedGraph} ignored; ` +
        `use 'cli.ts copy|move ${target.id} --to ${requestedGraph}' to reclassify`,
    );
  }

  // --- semantic guard for genuinely new captures (no source-id / --update match) ---
  if (!target && !values["force-new"]) {
    const minSim = values["dup-threshold"] ? Number(values["dup-threshold"]) : undefined;
    const similar = await findSimilar(`${title}\n${body}`, minSim ? { minSim } : {});
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
    validateFollowsTargets(entries, { id: sourceId, date: sourceDate }, follows);
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
        },
  );

  // --- a brand-new id must be unique across ALL stores (chains/index/move key by id) ---
  if (!target) {
    const collision = entries.find((e) => e.id === fm.id);
    if (collision) {
      throw new Error(
        `id '${fm.id}' already exists (graphs: ${collision.graphs.join(",")}; ${rel(collision.path)})\n` +
          `  refresh it with --update ${fm.id}, or pick a distinct --id`,
      );
    }
  }

  // --- containment guard: a shared-graph entry only references fellow members ---
  {
    const byId = new Map(entries.map((e) => [e.id, e]));
    validateContainment(byId, { id: fm.id, graphs }, [
      ...(fm.follows ?? []),
      ...(fm.sources ?? []),
    ]);
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
    // Refresh EVERY materialization so the copy-sync invariant holds.
    const written = await writeEntryAll(fm, body, graphs);
    path = written[PRIVATE_GRAPH] ?? Object.values(written)[0]!;
  } else {
    if (requestedGraph !== PRIVATE_GRAPH) await ensureStore(requestedGraph);
    path = await writeEntry(fm, body, requestedGraph);
  }
  const stats = await syncIndex();
  const label = sharedGraphs({ graphs }).length ? ` [${sharedGraphs({ graphs }).join(",")}]` : "";
  console.log(`✓ ${target ? "updated" : "created"} ${fm.id}${label}`);
  console.log(`  ${rel(path)}`);
  console.log(`  indexed (+${stats.added} changed, ${stats.unchanged} unchanged)`);
  const captured = await markCapturedConnectors(capturedConnectors);
  if (captured.length) console.log(`  connector captured: ${captured.join(", ")}`);

  // Standing distribution rules auto-apply to fresh private captures; a rule
  // failure must never fail the capture itself.
  if (!target && requestedGraph === PRIVATE_GRAPH) {
    try {
      const { applyRules } = await import("./graph-rules.js");
      const report = await applyRules({ ids: [fm.id] });
      for (const line of report.actions) console.log(`  → rule: ${line}`);
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
    const issues =
      report.drift.length + report.homeViolations.length + report.containmentViolations.length;
    console.log(
      issues === 0
        ? "✓ all graphs consistent"
        : `${issues} issue${issues === 1 ? "" : "s"} (${report.repaired.length} repaired)`,
    );
    if (issues > report.repaired.length) process.exitCode = 2;
    return;
  }
  if (sub === "list" || sub === undefined) {
    const entries = await loadAllEntries();
    for (const store of listGraphStores()) {
      const count = entries.filter((e) => e.graphs.includes(store.graph)).length;
      const manifest = store.graph === PRIVATE_GRAPH ? null : await loadGraphManifest(store);
      const label =
        store.graph === PRIVATE_GRAPH
          ? "(built-in — the default home of every capture)"
          : manifest?.error
            ? `⚠ invalid manifest: ${manifest.error}`
            : (manifest?.fm?.display_name ?? manifest?.body?.split("\n")[0] ?? "");
      console.log(`● ${store.graph.padEnd(14)} ${String(count).padStart(4)} entries  ${rel(store.dir)}  ${label}`);
    }
    return;
  }
  throw new Error("usage: memory graphs [list] | graphs create <slug> [--display-name …] [--description …] | graphs sync [--dry-run]");
}

async function cmdIndex(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: { force: { type: "boolean" } },
  });
  const stats = await syncIndex({ force: Boolean(values.force) });
  console.log(
    `✓ index synced — ${stats.added} (re)embedded, ${stats.removed} removed, ${stats.unchanged} unchanged`,
  );
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
    },
    allowPositionals: true,
  });
  // Each positional is its own query phrasing; all are fused. Quote each one.
  const queries = positionals.map((q) => q.trim()).filter(Boolean);
  if (queries.length === 0) {
    throw new Error(
      'usage: memory query "<question>" ["<alt phrasing>" …] [--person X] [--type Y] [--since DATE] [-k N] [--deep]',
    );
  }
  const deep = Boolean(values.deep);
  const k = values.k ? Number(values.k) : deep ? 40 : 8;
  const hits = await search(queries, filtersFrom(values), k, { deep });
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
      "show-queries": { type: "boolean" },
      shallow: { type: "boolean" },
    },
    allowPositionals: true,
  });
  const queries = positionals.map((q) => q.trim()).filter(Boolean);
  if (queries.length === 0) {
    throw new Error(
      'usage: memory recall "<question>" ["<agent phrasing>" …] [--person X] [--type Y] [--complete] [--format json]',
    );
  }
  const format = ((values.format as string | undefined) ?? "text").toLowerCase();
  if (format !== "text" && format !== "json") throw new Error("--format must be one of: text, json");

  const report = await recall(queries, {
    filters: filtersFrom(values),
    k: positiveInt(values.k, 40, "-k"),
    deep: !values.shallow,
    noExpand: Boolean(values["no-expand"]),
    completeness: recallCompleteness(values),
    completeLimit: positiveInt(values["complete-limit"], 200, "--complete-limit"),
    requireComplete: Boolean(values["require-complete"]),
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
    },
  });
  const all = await loadAllEntries();
  const chainIndex = buildChainIndex(all);
  const entries = applyFilters(all, filtersFrom(values)).sort(
    (a, b) => b.date.localeCompare(a.date),
  );
  const limit = values.limit ? Number(values.limit) : entries.length;
  for (const e of entries.slice(0, limit)) {
    console.log(`${e.date}  ${e.type.padEnd(11)} ${e.title}${statusSuffix(e, chainIndex)}${graphSuffix(e)}  (${rel(e.path)})`);
  }
  console.log(`\n${entries.length} entr${entries.length === 1 ? "y" : "ies"}`);
}

async function cmdPerson(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { graph: { type: "string" } },
    allowPositionals: true,
  });
  const slug = positionals[0];
  if (!slug || positionals.length !== 1) throw new Error("usage: memory person <slug> [--graph <name>]");
  const graph = values.graph ? requireGraph(values.graph) : undefined;
  const all = await loadAllEntries();
  const chainIndex = buildChainIndex(all);
  const entries = all
    .filter((e) => e.people.includes(slug) && (!graph || e.graphs.includes(graph)))
    .sort((a, b) => b.date.localeCompare(a.date));
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
  const digestGraph: GraphId = values.graph ? requireGraph(values.graph) : PRIVATE_GRAPH;

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

  if (digestGraph === "public") {
    scope = { ...scope, graph: "public" };
    // Ids are unique across ALL stores — a shared-graph digest gets its own
    // id so it never collides with the private digest of the same scope.
    id = id.replace(/^summary-/, `summary-${digestGraph}-`);
  }
  const raw = applyFilters(await loadAllEntries(), scope)
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

  if (digestGraph !== PRIVATE_GRAPH) await ensureStore(digestGraph);
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
    const graph = requireGraph((values.graph as string | undefined) ?? "public");
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
    const graph = requireGraph((values.to as string | undefined) ?? "public");
    if (graph === PRIVATE_GRAPH) throw new Error("promotion targets a shared graph — private is the source");
    const entries = await loadAllEntries();
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

async function cmdRules(argv: string[]) {
  const sub = argv[0];
  const { readRules, applyRules, matchRule } = await import("./graph-rules.js");

  if (sub === "apply") {
    const { values } = parseArgs({ args: argv.slice(1), options: { "dry-run": { type: "boolean" } } });
    const dryRun = Boolean(values["dry-run"]);
    const report = await applyRules({ dryRun });
    for (const c of report.plan.conflicts) console.log(`⚠ skipped ${c.id}: ${c.reason}`);
    if (dryRun) {
      for (const a of report.plan.actions) console.log(`would ${a.action} ${a.id} → ${a.graph}`);
      console.log(`\n${report.plan.actions.length} action(s), ${report.plan.conflicts.length} conflict(s) — dry run, nothing changed`);
      return;
    }
    for (const line of report.actions) console.log(`✓ ${line}`);
    for (const b of report.blocked) {
      console.log(`✗ blocked ${b.id} → ${b.graph}: references non-members ${b.ids.join(", ")}`);
    }
    console.log(
      `\n${report.copied} copied, ${report.moved} moved, ${report.skippedConflicts} conflict(s), ${report.blocked.length} blocked`,
    );
    return;
  }

  if (sub === "list" || sub === undefined) {
    const rules = await readRules();
    if (rules.length === 0) {
      console.log("(no rules configured — memory/graphs/rules.json)");
      return;
    }
    const entries = await loadAllEntries();
    for (const r of rules) {
      const match = [r.match.tag ? `tag #${r.match.tag}` : "", r.match.type ? `type ${r.match.type}` : ""]
        .filter(Boolean)
        .join(" + ");
      const n = entries.filter((e) => e.graphs.includes(PRIVATE_GRAPH) && matchRule(e, r)).length;
      console.log(`● ${match}  →  ${r.graph}  (${r.mode})   matches ${n} private entr${n === 1 ? "y" : "ies"}`);
    }
    return;
  }

  throw new Error("usage: memory rules [list] | rules apply [--dry-run]");
}

async function cmdRouting() {
  const { loadRouting } = await import("./routing.js");
  const routing = await loadRouting();
  if (!routing) {
    console.error("✗ no routing prompt found (expected routing/graph-routing.md or memory/routing/graph-routing.md)");
    process.exitCode = 1;
    return;
  }
  if (routing.error) {
    console.error(`✗ ${routing.name}  [${routing.origin}]  ${rel(routing.path)}`);
    console.error(`  ${routing.error.split("\n").join("\n  ")}`);
    process.exitCode = 1;
    return;
  }
  const fm = routing.fm!;
  console.log(`✓ ${routing.name}  [${routing.origin}]  ${rel(routing.path)}`);
  console.log(`  enabled: ${fm.enabled}   default_graph: ${fm.default_graph}`);
  console.log(
    routing.origin === "template"
      ? "  (generic template — personal rules go in the override: memory/routing/graph-routing.md)"
      : "  (private override — fully replaces the template)",
  );
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

  const entries = await loadAllEntries();
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
            [--update <id>]      # refresh a specific entry in place
            [--force-new]        # bypass the near-duplicate guard
            [--dup-threshold N]  # cosine threshold for the guard (default 0.92)
            [--graph <name>]     # file a NEW entry in that graph (default private; reserved for an
                                 # EXPLICIT user request — updates keep their entry's membership)
  memory link <id> --follows <earlier-id,…>
            # add timeline links to an existing entry (e.g. a decision settling a pending-decision)
            # containment is enforced: a shared-graph entry only references fellow members
  memory remove <id>   # delete ALL of an entry's copies + sync index (content stays in each repo's history)
  memory copy <id> --to <graph>
            # add membership: materialize the entry into another graph (it stays private too);
            # every copy is kept in sync automatically on later updates
  memory move <id> --to <graph>
            # replace the entry's WHOLE membership with <graph> (removes every other copy);
            # move --to private = full repatriation. Containment validated both directions
  memory graphs [list]                 # registry: private + every memory-graphs/<slug>/ store
  memory graphs create <slug> [--display-name "…"] [--description "…"]
  memory graphs sync [--dry-run]       # detect + repair drifted copies (private wins), report violations
  memory rules [list]                  # standing distribution rules (memory/graphs/rules.json)
  memory rules apply [--dry-run]       # reconcile all rules against existing private entries
  memory index [--force]
  memory query "<question>" ["<alt phrasing>" …] [--person X] [--type Y] [--since DATE] [--until DATE] [--graph <name>] [-k N] [--deep]
            # each quoted positional is a separate phrasing; all are fused (2-4 recommended)
            # --deep: recall-over-precision preset (k=40, wider candidate pool)
  memory recall "<question>" ["<agent phrasing>" …] [--person X] [--type Y] [--since DATE] [--until DATE] [--graph G] [-k N]
            [--complete | --complete-if-small | --no-complete] [--require-complete] [--no-expand] [--format text|json]
            # first phrasing is primary; extras are agent-supplied; CLI adds deterministic expansions unless --no-expand
            # default: k=40, deep pools, complete-if-small (limit 200)
            # --graph <name> scopes to one graph's members; default searches ALL (shared memberships labeled)
  memory list [--person|--type|--team|--tag|--since|--until|--graph|--limit]
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
  memory routing                     # show + validate the public-eligibility prompt (template vs private override)
  memory promote candidates [--to <graph>] [--since DATE] [--until DATE] [--limit N]
            # private entries awaiting promotion review for <graph> (default public)
  memory promote dismiss <id> [--graph <name>] [--reason "…"]   # record "not for that graph" — hidden until content changes
  memory connectors                  # list + validate connectors/<name>.md (fetch config + extraction prompt per source)
  memory connectors mark-pulled <name> [--at ISO_TIMESTAMP]
            # record that a connector sweep completed; captures are recorded by memory add
  memory connectors mark-captured <name> [--at ISO_TIMESTAMP]
            # backfill/record connector prompt usage without changing memories
  memory ui [--port N] [--no-open]   # local web UI (default port 4664; memory writes limited to connector config,
                                     # slug merges, and chain links — all via the same validated CLI code paths)
`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "add": return cmdAdd(rest);
    case "link": return cmdLink(rest);
    case "remove": return cmdRemove(rest);
    case "move": return cmdMove(rest);
    case "copy": return cmdCopy(rest);
    case "graphs": return cmdGraphs(rest);
    case "rules": return cmdRules(rest);
    case "index": return cmdIndex(rest);
    case "query": return cmdQuery(rest);
    case "recall": return cmdRecall(rest);
    case "list": return cmdList(rest);
    case "person": return cmdPerson(rest);
    case "digest": return cmdDigest(rest);
    case "maintenance": return cmdMaintenance(rest);
    case "slugs": return cmdSlugs(rest);
    case "connectors": return cmdConnectors(rest);
    case "routing": return cmdRouting();
    case "promote": return cmdPromote(rest);
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
