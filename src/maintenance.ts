import { loadAllEntries } from "./ingest.js";
import { indexStatus } from "./store.js";
import { lexicalStatus } from "./lexical.js";
import type { MemoryEntry } from "./schema.js";
import { analyzeGraphHygiene, writeGraphMaintenanceAudit } from "./graph-maintenance.js";

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
