import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MemoryEntry } from "./schema.js";
import { INDEX_DIR, hashEntry, loadAllEntries } from "./ingest.js";

/**
 * Public-graph promotion review state. Capture always lands in the PRIVATE
 * graph; entries reach the public graph only through a user-confirmed
 * promotion review (`cli.ts move <id> --to public`, driven by the
 * promote-public skill). This module provides the mechanical half of that
 * review: the candidate list and the "user said no" memory.
 *
 * Dismissals are keyed by (id, content hash): declining an entry hides it
 * from future candidate lists AS LONG AS its content is unchanged — a
 * substantive update makes it eligible for review again. Like the slug/chain
 * dismissals, this is user judgment stored in `.index/` (cheap to re-give if
 * the index dir is ever wiped).
 */
export const PROMOTION_DISMISSALS_PATH = join(INDEX_DIR, "promotion-dismissals.json");

export interface PromotionDismissal {
  id: string;
  /** Content hash at dismissal time — a changed entry is re-proposed. */
  hash: string;
  dismissedAt: string;
  reason?: string;
}

export interface PromotionCandidate {
  id: string;
  date: string;
  type: string;
  title: string;
  path: string;
  /** Private ids this entry references — it cannot move until they do. */
  blockedBy: string[];
}

export async function readPromotionDismissals(): Promise<PromotionDismissal[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(PROMOTION_DISMISSALS_PATH, "utf8"));
    return Array.isArray(parsed) ? (parsed as PromotionDismissal[]) : [];
  } catch {
    return [];
  }
}

async function writePromotionDismissals(dismissals: PromotionDismissal[]): Promise<void> {
  await mkdir(INDEX_DIR, { recursive: true });
  const tmp = `${PROMOTION_DISMISSALS_PATH}.tmp`;
  await writeFile(tmp, `${JSON.stringify(dismissals, null, 2)}\n`, "utf8");
  await rename(tmp, PROMOTION_DISMISSALS_PATH);
}

/** Record "keep this private" for an entry at its CURRENT content. */
export async function dismissPromotion(id: string, reason?: string): Promise<PromotionDismissal> {
  const entries = await loadAllEntries();
  const entry = entries.find((e) => e.id === id);
  if (!entry) throw new Error(`no entry with id '${id}'`);
  if (entry.graph === "public") throw new Error(`'${id}' is already in the public graph`);
  const dismissal: PromotionDismissal = {
    id,
    hash: hashEntry(entry),
    dismissedAt: new Date().toISOString(),
    ...(reason ? { reason } : {}),
  };
  const rest = (await readPromotionDismissals()).filter((d) => d.id !== id);
  await writePromotionDismissals([...rest, dismissal]);
  return dismissal;
}

/**
 * The mechanical promotion prefilter: private entries not dismissed at their
 * current content. Semantic eligibility (the routing prompt) is the agent's
 * judgment, applied on top of this list — never here.
 */
export function promotionCandidates(
  entries: MemoryEntry[],
  dismissals: PromotionDismissal[],
  opts: { since?: string; until?: string } = {},
): PromotionCandidate[] {
  const dismissedHash = new Map(dismissals.map((d) => [d.id, d.hash]));
  const byId = new Map(entries.map((e) => [e.id, e]));
  return entries
    .filter((e) => e.graph === "private")
    .filter((e) => (opts.since ? e.date >= opts.since : true))
    .filter((e) => (opts.until ? e.date <= opts.until : true))
    .filter((e) => dismissedHash.get(e.id) !== hashEntry(e))
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((e) => ({
      id: e.id,
      date: e.date,
      type: e.type,
      title: e.title,
      path: e.path,
      blockedBy: [...(e.follows ?? []), ...(e.sources ?? [])].filter(
        (id) => byId.get(id)?.graph === "private",
      ),
    }));
}
