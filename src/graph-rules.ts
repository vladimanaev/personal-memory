import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { MEMORY_TYPES, DEFAULT_GRAPH, type MemoryEntry } from "./schema.js";
import { MEMORY_DIR, loadAllEntries } from "./ingest.js";
import { requireGraph } from "./graphs.js";
import { copyEntry, moveEntry } from "./membership.js";

/**
 * Standing distribution rules: "entries matching TAG and/or TYPE belong in
 * graph G (copied, or moved)". Configuring a rule IS the user's standing
 * confirmation — rules auto-apply to fresh private captures and backfill via
 * `rules apply` (the UI previews with --dry-run first).
 *
 * The config lives INSIDE the private store so it travels with the private
 * repo, is swept by the auto-commit hook, and never leaks into shared stores.
 */
export const RULES_PATH = join(MEMORY_DIR, "graphs", "rules.json");

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "must be a lower-kebab slug");

export const GraphRuleSchema = z
  .object({
    match: z
      .object({ tag: slug.optional(), type: z.enum(MEMORY_TYPES).optional() })
      .strict()
      .refine((m) => m.tag !== undefined || m.type !== undefined, "at least one of tag/type"),
    graph: slug,
    mode: z.enum(["copy", "move"]),
  })
  .strict();

export const RulesFileSchema = z
  .object({ version: z.literal(1), rules: z.array(GraphRuleSchema) })
  .strict();

export type GraphRule = z.infer<typeof GraphRuleSchema>;

export async function readRules(): Promise<GraphRule[]> {
  let raw: string;
  try {
    raw = await readFile(RULES_PATH, "utf8");
  } catch {
    return []; // no rules configured
  }
  const parsed = RulesFileSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(
      `invalid ${RULES_PATH}:\n` +
        parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n"),
    );
  }
  for (const r of parsed.data.rules) {
    if (r.graph === DEFAULT_GRAPH) throw new Error("rules cannot target the default graph (it is the home of every entry)");
    requireGraph(r.graph); // throws when a rule references a deleted/unknown graph
  }
  return parsed.data.rules;
}

export async function writeRules(rules: GraphRule[]): Promise<string> {
  const file = RulesFileSchema.parse({ version: 1, rules });
  for (const r of file.rules) {
    if (r.graph === DEFAULT_GRAPH) throw new Error("rules cannot target the default graph (it is the home of every entry)");
    requireGraph(r.graph);
  }
  await mkdir(join(MEMORY_DIR, "graphs"), { recursive: true });
  const tmp = `${RULES_PATH}.tmp`;
  await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  await rename(tmp, RULES_PATH);
  return RULES_PATH;
}

/** All match keys AND together. */
export function matchRule(e: Pick<MemoryEntry, "tags" | "type">, r: GraphRule): boolean {
  if (r.match.tag !== undefined && !e.tags.includes(r.match.tag)) return false;
  if (r.match.type !== undefined && e.type !== r.match.type) return false;
  return true;
}

export interface PlannedAction {
  id: string;
  action: "copy" | "move";
  graph: string;
}

export interface RulesPlan {
  actions: PlannedAction[];
  /** Entries matched by conflicting rules — skipped, user resolves via rule edits. */
  conflicts: { id: string; reason: string }[];
}

/**
 * Pure reconciler over PRIVATE-HOME entries (rules never touch entries that
 * already left private). Conflict policy — conservative, always skip+warn:
 * - ≥2 move rules to different graphs: ambiguous destination.
 * - a move rule combined with ANY other matching rule: the move would strip
 *   the private home the copies depend on.
 * Copy rules union (idempotent: already-member targets are no-ops and drop
 * out of the plan).
 */
export function planRules(entries: MemoryEntry[], rules: GraphRule[]): RulesPlan {
  const actions: PlannedAction[] = [];
  const conflicts: RulesPlan["conflicts"] = [];
  for (const e of entries) {
    if (!e.graphs.includes(DEFAULT_GRAPH)) continue;
    const matching = rules.filter((r) => matchRule(e, r));
    if (matching.length === 0) continue;
    const moves = [...new Set(matching.filter((r) => r.mode === "move").map((r) => r.graph))];
    if (moves.length > 1) {
      conflicts.push({ id: e.id, reason: `move rules disagree: ${moves.join(" vs ")}` });
      continue;
    }
    if (moves.length === 1 && matching.length > 1) {
      conflicts.push({
        id: e.id,
        reason: `move to '${moves[0]}' combined with other matching rules — resolve by editing rules`,
      });
      continue;
    }
    if (moves.length === 1) {
      const to = moves[0]!;
      if (!(e.graphs.length === 1 && e.graphs[0] === to)) actions.push({ id: e.id, action: "move", graph: to });
      continue;
    }
    for (const g of [...new Set(matching.map((r) => r.graph))]) {
      if (!e.graphs.includes(g)) actions.push({ id: e.id, action: "copy", graph: g });
    }
  }
  return { actions, conflicts };
}

export interface RulesReport {
  copied: number;
  moved: number;
  skippedConflicts: number;
  blocked: { id: string; graph: string; ids: string[] }[];
  /** Human-readable lines for CLI/capture output. */
  actions: string[];
}

/** Execute the plan (or preview it with dryRun). `ids` narrows to specific entries. */
export async function applyRules(
  opts: { dryRun?: boolean; ids?: string[]; rules?: GraphRule[] } = {},
): Promise<RulesReport & { plan: RulesPlan }> {
  const rules = opts.rules ?? (await readRules());
  const report: RulesReport & { plan: RulesPlan } = {
    copied: 0,
    moved: 0,
    skippedConflicts: 0,
    blocked: [],
    actions: [],
    plan: { actions: [], conflicts: [] },
  };
  if (rules.length === 0) return report;
  let entries = await loadAllEntries();
  if (opts.ids) entries = entries.filter((e) => opts.ids!.includes(e.id));
  report.plan = planRules(entries, rules);
  report.skippedConflicts = report.plan.conflicts.length;
  if (opts.dryRun) return report;

  for (const a of report.plan.actions) {
    if (a.action === "copy") {
      const r = await copyEntry({ id: a.id, to: a.graph });
      if (r.blockedBy) report.blocked.push({ id: a.id, graph: a.graph, ids: r.blockedBy });
      else if (r.changed) {
        report.copied++;
        report.actions.push(`copied ${a.id} → ${a.graph}`);
      }
    } else {
      const r = await moveEntry({ id: a.id, to: a.graph });
      if (r.blockedBy) report.blocked.push({ id: a.id, graph: a.graph, ids: r.blockedBy.ids });
      else if (r.changed) {
        report.moved++;
        report.actions.push(`moved ${a.id} → ${a.graph}`);
      }
    }
  }
  return report;
}
