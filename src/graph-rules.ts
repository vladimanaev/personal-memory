import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { MEMORY_TYPES, DEFAULT_GRAPH, type MemoryEntry } from "./schema.js";
import { MEMORY_DIR } from "./ingest.js";
import { requireGraph } from "./graphs.js";
import { openCatalog } from "./catalog.js";

/**
 * Standing distribution rules: "entries matching TAG and/or TYPE belong in
 * graph G (copied, or moved)".
 *
 * A rule PROPOSES; it does not publish. Matching a rule puts an entry in that
 * graph's review queue, where the user approves it one at a time — a rule is
 * a standing opinion about what is worth looking at, not standing consent to
 * share. `mode` says what approving would do, and is carried on the queue row
 * as the proposed action.
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
export function planRules(
  entries: Pick<MemoryEntry, "id" | "tags" | "type" | "graphs">[],
  rules: GraphRule[],
): RulesPlan {
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
  /** Candidates added to a review queue. */
  queued: number;
  /** Plan actions a rule already had a pending row for, or that were otherwise moot. */
  skipped: number;
  skippedConflicts: number;
  /** Queued, but not approvable until the named entries join the graph too. */
  blocked: { id: string; graph: string; ids: string[] }[];
  /** Human-readable lines for CLI/capture output. */
  actions: string[];
}

/**
 * Turn the plan into review-queue rows (or preview it with dryRun). `ids`
 * narrows to specific entries — that is what capture passes, so a new memory
 * is judged against the rules without re-walking the corpus.
 *
 * This publishes NOTHING. It used to copy and move directly; every rule match
 * now lands in the target graph's queue for the user to approve.
 */
export async function enqueueRules(
  opts: { dryRun?: boolean; ids?: string[]; rules?: GraphRule[]; graphs?: string[] } = {},
): Promise<RulesReport & { plan: RulesPlan }> {
  const rules = opts.rules ?? (await readRules());
  const report: RulesReport & { plan: RulesPlan } = {
    queued: 0,
    skipped: 0,
    skippedConflicts: 0,
    blocked: [],
    actions: [],
    plan: { actions: [], conflicts: [] },
  };
  if (rules.length === 0) return report;
  let entries: Pick<MemoryEntry, "id" | "tags" | "type" | "graphs">[] = await (await openCatalog()).all();
  if (opts.ids) entries = entries.filter((e) => opts.ids!.includes(e.id));
  report.plan = planRules(entries, rules);
  // Planned against ALL rules (so conflict guards hold), then narrowed to the
  // target graphs the caller is actually proposing into.
  if (opts.graphs) report.plan.actions = report.plan.actions.filter((a) => opts.graphs!.includes(a.graph));
  report.skippedConflicts = report.plan.conflicts.length;
  const { enqueueMany, queueView, readQueue } = await import("./graph-queue.js");
  // A pending row (a sweep's redaction, an explicit --graph) is never replaced
  // by a rule's: enqueueMany overwrites by id+graph, so filter here. Dry-run
  // and the real run therefore agree.
  if (report.plan.actions.length > 0) {
    // Raw readQueue on purpose: queueView reconciles and would write during a dry-run.
    const pending = new Set((await readQueue()).rows.map((r) => `${r.id}\u0000${r.graph}`));
    const fresh = report.plan.actions.filter((a) => !pending.has(`${a.id}\u0000${a.graph}`));
    report.skipped += report.plan.actions.length - fresh.length;
    report.plan.actions = fresh;
  }
  if (opts.dryRun) return report;
  if (report.plan.actions.length === 0) return report;

  const results = await enqueueMany(
    report.plan.actions.map((a) => ({
      id: a.id,
      graph: a.graph,
      action: a.action,
      reason: `matched a standing distribution rule for '${a.graph}'`,
      proposedBy: "rules",
    })),
  );
  for (const r of results) {
    if (r.queued) {
      report.queued++;
      report.actions.push(`queued ${r.id} → ${r.graph}`);
    } else {
      report.skipped++;
    }
  }

  // Surface containment blockers at propose time so the user sees them on the
  // row rather than discovering them at the moment they click approve.
  const view = await queueView();
  for (const row of view.rows) {
    if (row.proposedBy === "rules" && row.blockedBy.length > 0) {
      report.blocked.push({ id: row.id, graph: row.graph, ids: row.blockedBy });
    }
  }
  return report;
}
