#!/usr/bin/env -S npx tsx
import { parseArgs } from "node:util";
import { dirname, relative } from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { FrontmatterSchema, type Frontmatter } from "./schema.js";
import {
  loadAllEntries,
  makeId,
  writeEntry,
  entryPath,
  hashEntry,
  findEntryBySourceIds,
  normalizeSourceId,
  ROOT,
} from "./ingest.js";
import { search, findSimilar, syncIndex, applyFilters, type SearchCompleteness, type SearchFilters } from "./store.js";
import type { GraphId, MemoryEntry } from "./schema.js";
import { ensureStore, parseGraphId, storeFor, validateCrossGraphLinks } from "./graphs.js";
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
    graph: values.graph ? parseGraphId(values.graph) : undefined,
  };
}

/** ` [public]` marker for listings — private entries stay unlabeled (the default). */
function graphSuffix(e: Pick<MemoryEntry, "graph">): string {
  return e.graph === "public" ? "  [public]" : "";
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
  const requestedGraph: GraphId = values.graph ? parseGraphId(values.graph) : "private";
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

  // An update stays in the entry's own store — a re-capture must never
  // silently relocate an entry between graphs. Reclassify explicitly instead.
  const graph: GraphId = target?.graph ?? requestedGraph;
  if (target && values.graph && requestedGraph !== target.graph) {
    console.log(
      `↻ ${target.id} lives in the ${target.graph} graph — --graph ${requestedGraph} ignored; ` +
        `use 'cli.ts move ${target.id} --to ${requestedGraph}' to reclassify`,
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

  // --- a brand-new id must be unique across BOTH stores (chains/index/move key by id) ---
  if (!target) {
    const collision = entries.find((e) => e.id === fm.id);
    if (collision) {
      throw new Error(
        `id '${fm.id}' already exists in the ${collision.graph} graph (${rel(collision.path)})\n` +
          `  refresh it with --update ${fm.id}, or pick a distinct --id`,
      );
    }
  }

  // --- cross-graph guard: a public entry must never reference private ids ---
  if (graph === "public") {
    const byId = new Map(entries.map((e) => [e.id, e]));
    validateCrossGraphLinks(byId, { id: fm.id, graph }, [
      ...(fm.follows ?? []),
      ...(fm.sources ?? []),
    ]);
  }

  // --- idempotency: skip a re-capture whose content is identical (hash ignores `updated`) ---
  if (target) {
    const candidate: MemoryEntry = { ...fm, body: body.trim(), path: target.path, graph: target.graph };
    if (hashEntry(candidate) === hashEntry(target)) {
      console.log(`✓ unchanged ${fm.id}`);
      const captured = await markCapturedConnectors(capturedConnectors);
      if (captured.length) console.log(`  connector captured: ${captured.join(", ")}`);
      return;
    }
  }

  if (graph === "public") await ensureStore("public");
  const path = await writeEntry(fm, body, graph);
  const stats = await syncIndex();
  console.log(`✓ ${target ? "updated" : "created"} ${fm.id}${graph === "public" ? " [public]" : ""}`);
  console.log(`  ${rel(path)}`);
  console.log(`  indexed (+${stats.added} changed, ${stats.unchanged} unchanged)`);
  const captured = await markCapturedConnectors(capturedConnectors);
  if (captured.length) console.log(`  connector captured: ${captured.join(", ")}`);
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
  const entries = await loadAllEntries();
  const target = entries.find((e) => e.id === id);
  if (!target) throw new Error(`no entry with id '${id}'`);

  const referrers = entries.filter((e) => e.sources?.includes(id));
  if (referrers.length) {
    console.error(`✗ ${id} is referenced as a source by: ${referrers.map((e) => e.id).join(", ")}`);
    console.error("  update or remove those summaries first");
    process.exitCode = 2;
    return;
  }

  // Chain links tolerate dangling targets (maintenance reports them), so a
  // followed entry can still be removed — but say what gets orphaned.
  const followers = entries.filter((e) => e.follows?.includes(id));
  if (followers.length) {
    console.log(`⚠ ${id} is followed by: ${followers.map((e) => e.id).join(", ")} — their links will dangle`);
  }

  // Checkpoint first so the removed content is always recoverable from the
  // entry's OWN store history (the add-time auto-commit may not have run).
  const storeDir = storeFor(target.graph).dir;
  await commitMemoryRepo(`Checkpoint before remove: ${id}`, storeDir);
  await rm(target.path);
  const stats = await syncIndex();
  await commitMemoryRepo(`Remove memory: ${id}`, storeDir);
  console.log(`✓ removed ${id}`);
  console.log(`  ${rel(target.path)}`);
  console.log(`  index synced (${stats.removed} removed); prior content kept in ${rel(storeDir)}/.git history`);
}

async function cmdMove(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { to: { type: "string" } },
    allowPositionals: true,
  });
  const id = positionals[0];
  if (!id || positionals.length !== 1 || !values.to) {
    throw new Error("usage: memory move <id> --to private|public");
  }
  const to = parseGraphId(values.to);
  const entries = await loadAllEntries();
  const target = entries.find((e) => e.id === id);
  if (!target) throw new Error(`no entry with id '${id}'`);
  if (target.graph === to) {
    console.log(`✓ unchanged ${id} (already in the ${to} graph)`);
    return;
  }

  // Direction preconditions — the public store must never reference a private id.
  if (to === "public") {
    const byId = new Map(entries.map((e) => [e.id, e]));
    const refs = [...(target.follows ?? []), ...(target.sources ?? [])];
    const violators = refs.filter((r) => {
      const t = byId.get(r);
      return t !== undefined && t.graph === "private";
    });
    if (violators.length) {
      console.error(`✗ ${id} references private entries: ${violators.join(", ")}`);
      console.error("  move those public first (or keep this entry private)");
      process.exitCode = 2;
      return;
    }
  } else {
    const publicReferrers = entries.filter(
      (e) => e.graph === "public" && ((e.follows?.includes(id) ?? false) || (e.sources?.includes(id) ?? false)),
    );
    if (publicReferrers.length) {
      console.error(
        `✗ public entries reference ${id}: ${publicReferrers.map((e) => e.id).join(", ")}`,
      );
      console.error("  move those private first (or leave this entry public)");
      process.exitCode = 2;
      return;
    }
  }

  const from = target.graph;
  await ensureStore(to);
  // Checkpoint both repos so the move is fully undoable from either side.
  await commitMemoryRepo(`Checkpoint before move: ${id}`, storeFor(from).dir);
  await commitMemoryRepo(`Checkpoint before move: ${id}`, storeFor(to).dir);

  // Relocate the file bytes verbatim — id, date, and content hash stay
  // identical; only the store (and therefore the graph) changes.
  const raw = await readFile(target.path, "utf8");
  const dest = entryPath(target, to);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, raw, "utf8");
  await rm(target.path);

  const stats = await syncIndex();
  // The public repo's history never mentions the other graph — its messages
  // are plain add/remove; the private repo records the move destination.
  const msgFor = (g: GraphId) =>
    g === "public"
      ? to === "public"
        ? `Add memory: ${id}`
        : `Remove memory: ${id}`
      : `Move memory: ${id} → ${to}`;
  await commitMemoryRepo(msgFor(from), storeFor(from).dir);
  await commitMemoryRepo(msgFor(to), storeFor(to).dir);
  console.log(`✓ moved ${id} → ${to} graph`);
  console.log(`  ${rel(dest)}`);
  console.log(`  indexed (+${stats.added} changed, ${stats.unchanged} unchanged)`);
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
  if (!slug || positionals.length !== 1) throw new Error("usage: memory person <slug> [--graph private|public]");
  const graph = values.graph ? parseGraphId(values.graph) : undefined;
  const all = await loadAllEntries();
  const chainIndex = buildChainIndex(all);
  const entries = all
    .filter((e) => e.people.includes(slug) && (!graph || e.graph === graph))
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
    throw new Error("usage: memory digest --person <slug> | --quarter <YYYY-Qn> | --tag <slug> [--graph private|public]");
  }
  // A digest lives in one graph. A PRIVATE digest may cite sources from both
  // graphs (private→public links are fine); a PUBLIC digest must restrict its
  // candidates to public entries so its `sources` back-links can't leak.
  const digestGraph: GraphId = values.graph ? parseGraphId(values.graph) : "private";

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
    // Ids are unique across BOTH stores — a public digest gets its own id so
    // it never collides with the private digest of the same scope.
    id = id.replace(/^summary-/, "summary-public-");
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

  if (digestGraph === "public") await ensureStore("public");
  const path = await writeEntry(fm, body, digestGraph);
  await syncIndex();
  console.log(`✓ digest written: ${rel(path)}`);
  console.log(`  ${raw.length} source entries linked. Refine the Synthesis section, then re-run \`memory index\`.`);
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
            [--graph private|public]  # which graph to file a NEW entry in (default private;
                                      # updates stay in their entry's graph — reclassify with 'move')
  memory link <id> --follows <earlier-id,…>
            # add timeline links to an existing entry (e.g. a decision settling a pending-decision)
            # a PUBLIC entry can never follow a private one (link direction is enforced)
  memory remove <id>   # delete an entry + sync index (prior content stays in its store's git history)
  memory move <id> --to private|public
            # reclassify an entry between graphs; validates link direction, checkpoints both repos
  memory index [--force]
  memory query "<question>" ["<alt phrasing>" …] [--person X] [--type Y] [--since DATE] [--until DATE] [--graph G] [-k N] [--deep]
            # each quoted positional is a separate phrasing; all are fused (2-4 recommended)
            # --deep: recall-over-precision preset (k=40, wider candidate pool)
  memory recall "<question>" ["<agent phrasing>" …] [--person X] [--type Y] [--since DATE] [--until DATE] [--graph G] [-k N]
            [--complete | --complete-if-small | --no-complete] [--require-complete] [--no-expand] [--format text|json]
            # first phrasing is primary; extras are agent-supplied; CLI adds deterministic expansions unless --no-expand
            # default: k=40, deep pools, complete-if-small (limit 200)
            # --graph private|public scopes to one graph; default searches BOTH (public hits labeled)
  memory list [--person|--type|--team|--tag|--since|--until|--graph|--limit]
  memory person <slug> [--graph private|public]
  memory digest --person <slug> | --quarter <YYYY-Qn> | --tag <slug> [--graph private|public]
            # public digest: candidates restricted to public entries; written to the public store
  memory maintenance [--threshold N]  # read-only report: digest debt, index health, slug hygiene (default 15)
  memory slugs list --kind person|team|tag [--min-count N]
            # vocabulary with usage counts (for tag compaction / slug reuse)
  memory slugs merge --kind person|team|tag --from <slug> --to <slug> [--dry-run] [--create-target]
            # explicit slug merge; rewrites frontmatter arrays, syncs index, checkpoints memory/.git
  memory slugs propose --kind person|team|tag --from <slug> --to <slug> --reason "…"
            # defer a merge decision: shows as a suggestion in maintenance + web UI until merged/ignored
  memory slugs dismiss --kind person|team|tag --from <slug> --to <slug>
            # permanently hide a wrong merge suggestion from maintenance
  memory routing                     # show + validate the graph-routing prompt (template vs private override)
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
