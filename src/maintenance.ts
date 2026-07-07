import { loadAllEntries } from "./ingest.js";
import { indexStatus, findSimilar } from "./store.js";
import { lexicalStatus } from "./lexical.js";
import type { MemoryEntry } from "./schema.js";
import { analyzeGraphHygiene, writeGraphMaintenanceAudit } from "./graph-maintenance.js";
import { buildChainIndex, entryStatus, type ChainAnnotation } from "./chains.js";

/**
 * Read-only hygiene report: digest debt (scopes with many unsummarized raw
 * entries → suggested `memory digest` commands), index health, and slug
 * hygiene (likely-duplicate people/team slugs). Never writes anything.
 */

interface Scope {
  kind: "person" | "quarter" | "tag";
  key: string;
  uncovered: number;
}

function quarterOf(date: string): string {
  const [y, m] = date.split("-");
  return `${y}-Q${Math.floor((Number(m) - 1) / 3) + 1}`;
}

function digestDebt(entries: MemoryEntry[], threshold: number): Scope[] {
  const raw = entries.filter((e) => e.type !== "summary");
  // Every raw entry already cited by some summary's `sources` is "covered".
  const covered = new Set(
    entries.filter((e) => e.type === "summary").flatMap((e) => e.sources ?? []),
  );
  const uncovered = raw.filter((e) => !covered.has(e.id));

  const counts = new Map<string, Scope>();
  const bump = (kind: Scope["kind"], key: string) => {
    const mapKey = `${kind}:${key}`;
    const s = counts.get(mapKey) ?? { kind, key, uncovered: 0 };
    s.uncovered++;
    counts.set(mapKey, s);
  };
  for (const e of uncovered) {
    for (const p of e.people) bump("person", p);
    for (const t of e.tags) bump("tag", t);
    bump("quarter", quarterOf(e.date));
  }
  return [...counts.values()]
    .filter((s) => s.uncovered >= threshold)
    .sort((a, b) => b.uncovered - a.uncovered);
}

/** "clearly related" for bge-small — well below the 0.92 near-duplicate bar. */
const CHAIN_SUGGESTION_MIN_SIM = 0.6;

interface ChainSuggestion {
  openId: string;
  laterId: string;
  sim: number;
  shared: string[];
}

/**
 * Likely missing timeline links: for every still-open pending-decision/todo,
 * later entries that are semantically close AND share a person or tag but sit
 * in a different (or no) chain. Each suggestion prints a ready-to-run `link`.
 */
async function unlinkedChainSuggestions(
  entries: MemoryEntry[],
  chainIndex: Map<string, ChainAnnotation>,
): Promise<ChainSuggestion[]> {
  const open = entries.filter((e) => entryStatus(e, chainIndex)?.status === "open");
  const byId = new Map(entries.map((e) => [e.id, e] as const));
  const componentOf = (id: string): string => chainIndex.get(id)?.latest.id ?? id;

  const out: ChainSuggestion[] = [];
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
      const shared = [
        ...e.people.filter((p) => o.people.includes(p)),
        ...e.tags.filter((t) => o.tags.includes(t)),
      ];
      if (shared.length === 0) continue;
      out.push({ openId: o.id, laterId: e.id, sim: hit.sim, shared });
    }
  }
  return out.sort((a, b) => b.sim - a.sim);
}

export async function runMaintenance(threshold: number): Promise<void> {
  const entries = await loadAllEntries();

  console.log("## Digest debt");
  const debt = digestDebt(entries, threshold);
  if (debt.length === 0) {
    console.log(`(no scope has ≥${threshold} unsummarized entries)`);
  } else {
    for (const s of debt) {
      const flag = s.kind === "person" ? "--person" : s.kind === "tag" ? "--tag" : "--quarter";
      console.log(
        `npx tsx src/cli.ts digest ${flag} ${s.key}   # ${s.uncovered} unsummarized entries`,
      );
    }
  }

  console.log("\n## Index health");
  const idx = await indexStatus();
  console.log(
    `entries ${idx.totalEntries} · indexed ${idx.indexedEntries} · stale ${idx.staleEntries} · missing ${idx.missingEntries} · chunks ${idx.chunkRows} (${idx.embedderId ?? "no index"})`,
  );
  const lex = await lexicalStatus();
  console.log(lex ? `lexical: ${lex.docs} docs, ${lex.terms} terms` : "lexical: (missing)");
  if (idx.staleEntries + idx.missingEntries > 0 || !lex || lex.docs !== idx.totalEntries) {
    console.log("→ fix: npx tsx src/cli.ts index");
  }

  console.log("\n## Connectors");
  const { loadConnectors } = await import("./connectors.js");
  const connectors = await loadConnectors();
  const broken = connectors.filter((c) => c.error);
  if (connectors.length === 0) {
    console.log("(no connector files under connectors/)");
  } else if (broken.length === 0) {
    console.log(`${connectors.length} valid (${connectors.map((c) => c.name).join(", ")})`);
  } else {
    for (const c of broken) console.log(`✗ ${c.name}: ${c.error!.split("\n")[0]}`);
    console.log("→ fix: npx tsx src/cli.ts connectors");
  }

  console.log("\n## Possible unlinked chains");
  const chainIndex = buildChainIndex(entries);
  const dangling = [...chainIndex.entries()].filter(([, a]) => a.dangling?.length);
  for (const [id, a] of dangling) {
    console.log(`⚠ ${id} follows missing entr${a.dangling!.length === 1 ? "y" : "ies"}: ${a.dangling!.join(", ")}`);
  }
  const hasOpen = entries.some((e) => entryStatus(e, chainIndex)?.status === "open");
  if (!hasOpen) {
    console.log("(no open pending-decisions/todos)");
  } else if (idx.chunkRows === 0) {
    console.log("(index is empty — run: npx tsx src/cli.ts index)");
  } else {
    const suggestions = await unlinkedChainSuggestions(entries, chainIndex);
    if (suggestions.length === 0) {
      console.log("(no likely-related later entries for the open items)");
    } else {
      for (const s of suggestions) {
        console.log(
          `npx tsx src/cli.ts link ${s.laterId} --follows ${s.openId}   # sim ${s.sim.toFixed(2)} · shared: ${s.shared.join(", ")}`,
        );
      }
    }
  }

  console.log("\n## Slug hygiene");
  const audit = analyzeGraphHygiene(entries);
  await writeGraphMaintenanceAudit(audit);
  if (audit.suggestions.length === 0) {
    console.log("(no suspiciously-similar slugs)");
  } else {
    for (const s of audit.suggestions) {
      console.log(
        `${s.kind}: '${s.from}' (${s.fromCount}) → '${s.to}' (${s.toCount})` +
          ` — confidence ${s.confidence.toFixed(2)}, affected ${s.affectedEntries}, last seen ${s.lastSeen ?? "n/a"}`,
      );
      console.log(`  reasons: ${s.reasons.join("; ")}`);
      console.log(
        `  preview: npx tsx src/cli.ts slugs merge --kind ${s.kind} --from ${s.from} --to ${s.to} --dry-run`,
      );
    }
  }
}
