#!/usr/bin/env -S npx tsx
import { parseArgs } from "node:util";
import { relative } from "node:path";
import { rm } from "node:fs/promises";
import { FrontmatterSchema, type Frontmatter } from "./schema.js";
import {
  loadAllEntries,
  makeId,
  writeEntry,
  hashEntry,
  findEntryBySourceIds,
  normalizeSourceId,
  ROOT,
} from "./ingest.js";
import { search, findSimilar, syncIndex, applyFilters, type SearchCompleteness, type SearchFilters } from "./store.js";
import type { MemoryEntry } from "./schema.js";
import { commitMemoryRepo } from "./memory-git.js";
import { validateFollowsTargets } from "./chains.js";
import { mergeSlugs, type SlugKind } from "./graph-maintenance.js";
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
  };
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

  // --- idempotency: skip a re-capture whose content is identical (hash ignores `updated`) ---
  if (target) {
    const candidate: MemoryEntry = { ...fm, body: body.trim(), path: target.path };
    if (hashEntry(candidate) === hashEntry(target)) {
      console.log(`✓ unchanged ${fm.id}`);
      const captured = await markCapturedConnectors(capturedConnectors);
      if (captured.length) console.log(`  connector captured: ${captured.join(", ")}`);
      return;
    }
  }

  const path = await writeEntry(fm, body);
  const stats = await syncIndex();
  console.log(`✓ ${target ? "updated" : "created"} ${fm.id}`);
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

  const entries = await loadAllEntries();
  const entry = entries.find((e) => e.id === id);
  if (!entry) throw new Error(`no entry with id '${id}'`);
  validateFollowsTargets(entries, entry, follows);

  const uniq = (xs: string[]) => [...new Set(xs)];
  const mergedFollows = uniq([...(entry.follows ?? []), ...follows]);
  if (mergedFollows.length === (entry.follows ?? []).length) {
    console.log(`✓ unchanged ${id} (already follows ${follows.join(", ")})`);
    return;
  }

  const { body: _b, path: _p, ...rest } = entry;
  const fm: Frontmatter = FrontmatterSchema.parse({
    ...rest,
    follows: mergedFollows,
    updated: today(),
  });
  const path = await writeEntry(fm, entry.body);
  const stats = await syncIndex();
  // The add-time auto-commit hook only fires on `add`; commit explicitly.
  await commitMemoryRepo(`Link memory: ${id} follows ${mergedFollows.join(", ")}`);
  console.log(`✓ linked ${id} → follows ${mergedFollows.join(", ")}`);
  console.log(`  ${rel(path)}`);
  console.log(`  indexed (+${stats.added} changed, ${stats.unchanged} unchanged)`);
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

  // Checkpoint first so the removed content is always recoverable from
  // memory/.git history (the add-time auto-commit may not have run).
  await commitMemoryRepo(`Checkpoint before remove: ${id}`);
  await rm(target.path);
  const stats = await syncIndex();
  await commitMemoryRepo(`Remove memory: ${id}`);
  console.log(`✓ removed ${id}`);
  console.log(`  ${rel(target.path)}`);
  console.log(`  index synced (${stats.removed} removed); prior content kept in memory/.git history`);
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
    console.log(`\n● ${h.entry.title}  [${h.entry.type} · ${h.entry.date}]  (score ${h.score.toFixed(3)})`);
    if (h.entry.people.length) console.log(`  people: ${h.entry.people.join(", ")}`);
    if (h.entry.updated) console.log(`  updated: ${h.entry.updated}`);
    if (h.entry.type === "summary" && h.entry.sources?.length) {
      const shown = h.entry.sources.slice(0, 20);
      const more = h.entry.sources.length - shown.length;
      console.log(`  sources: ${shown.join(", ")}${more > 0 ? `, … (+${more} more)` : ""}`);
    }
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
    console.log(`\n- ${h.title}  [${h.type} · ${h.date}]  (score ${h.score.toFixed(3)}${signals})`);
    if (h.people.length) console.log(`  people: ${h.people.join(", ")}`);
    if (h.updated) console.log(`  updated: ${h.updated}`);
    if (h.type === "summary" && h.sources?.length) {
      const shown = h.sources.slice(0, 20);
      const more = h.sources.length - shown.length;
      console.log(`  sources: ${shown.join(", ")}${more > 0 ? `, … (+${more} more)` : ""}`);
    }
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
      limit: { type: "string" },
    },
  });
  const entries = applyFilters(await loadAllEntries(), filtersFrom(values)).sort(
    (a, b) => b.date.localeCompare(a.date),
  );
  const limit = values.limit ? Number(values.limit) : entries.length;
  for (const e of entries.slice(0, limit)) {
    console.log(`${e.date}  ${e.type.padEnd(11)} ${e.title}  (${rel(e.path)})`);
  }
  console.log(`\n${entries.length} entr${entries.length === 1 ? "y" : "ies"}`);
}

async function cmdPerson(argv: string[]) {
  const slug = argv[0];
  if (!slug || slug.startsWith("-")) throw new Error("usage: memory person <slug>");
  const entries = (await loadAllEntries())
    .filter((e) => e.people.includes(slug))
    .sort((a, b) => b.date.localeCompare(a.date));
  if (entries.length === 0) {
    console.log(`(no memories mention '${slug}')`);
    return;
  }
  console.log(`# Memories involving ${slug} (${entries.length})\n`);
  for (const e of entries) {
    console.log(`${e.date}  [${e.type}] ${e.title}  (${rel(e.path)})`);
  }
}

async function cmdDigest(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      person: { type: "string" },
      quarter: { type: "string" }, // e.g. 2026-Q2
      tag: { type: "string" },
    },
  });
  const person = values.person as string | undefined;
  const quarter = values.quarter as string | undefined;
  const tag = values.tag as string | undefined;
  if (!person && !quarter && !tag) {
    throw new Error("usage: memory digest --person <slug> | --quarter <YYYY-Qn> | --tag <slug>");
  }

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

  const path = await writeEntry(fm, body);
  await syncIndex();
  console.log(`✓ digest written: ${rel(path)}`);
  console.log(`  ${raw.length} source entries linked. Refine the Synthesis section, then re-run \`memory index\`.`);
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
  if (sub !== "merge") {
    throw new Error("usage: memory slugs merge --kind person|team|tag --from <slug> --to <slug> [--dry-run] [--create-target]");
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
  memory link <id> --follows <earlier-id,…>
            # add timeline links to an existing entry (e.g. a decision settling a pending-decision)
  memory remove <id>   # delete an entry + sync index (prior content stays in memory/.git history)
  memory index [--force]
  memory query "<question>" ["<alt phrasing>" …] [--person X] [--type Y] [--since DATE] [--until DATE] [-k N] [--deep]
            # each quoted positional is a separate phrasing; all are fused (2-4 recommended)
            # --deep: recall-over-precision preset (k=40, wider candidate pool)
  memory recall "<question>" ["<agent phrasing>" …] [--person X] [--type Y] [--since DATE] [--until DATE] [-k N]
            [--complete | --complete-if-small | --no-complete] [--require-complete] [--no-expand] [--format text|json]
            # first phrasing is primary; extras are agent-supplied; CLI adds deterministic expansions unless --no-expand
            # default: k=40, deep pools, complete-if-small (limit 200)
  memory list [--person|--type|--team|--tag|--since|--until|--limit]
  memory person <slug>
  memory digest --person <slug> | --quarter <YYYY-Qn> | --tag <slug>
  memory maintenance [--threshold N]  # read-only report: digest debt, index health, slug hygiene (default 15)
  memory slugs merge --kind person|team|tag --from <slug> --to <slug> [--dry-run] [--create-target]
            # explicit slug merge; rewrites frontmatter arrays, syncs index, checkpoints memory/.git
  memory connectors                  # list + validate connectors/<name>.md (fetch config + extraction prompt per source)
  memory connectors mark-pulled <name> [--at ISO_TIMESTAMP]
            # record that a connector sweep completed; captures are recorded by memory add
  memory connectors mark-captured <name> [--at ISO_TIMESTAMP]
            # backfill/record connector prompt usage without changing memories
  memory ui [--port N] [--no-open]   # local web UI (default port 4664; edits connector config only, never memories)
`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "add": return cmdAdd(rest);
    case "link": return cmdLink(rest);
    case "remove": return cmdRemove(rest);
    case "index": return cmdIndex(rest);
    case "query": return cmdQuery(rest);
    case "recall": return cmdRecall(rest);
    case "list": return cmdList(rest);
    case "person": return cmdPerson(rest);
    case "digest": return cmdDigest(rest);
    case "maintenance": return cmdMaintenance(rest);
    case "slugs": return cmdSlugs(rest);
    case "connectors": return cmdConnectors(rest);
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
