import { test } from "node:test";
import assert from "node:assert/strict";
import type { MemoryEntry } from "./schema.js";
import { promotionCandidates, type PromotionDismissal } from "./promote.js";
import { hashEntry } from "./ingest.js";

function entry(
  partial: Partial<MemoryEntry> & Pick<MemoryEntry, "id">,
): MemoryEntry {
  return {
    date: "2026-01-01",
    type: "note",
    title: partial.id,
    people: [],
    teams: [],
    tags: [],
    body: "body",
    path: `/repo/memory/entries/2026/01/${partial.id}.md`,
    graph: "private",
    ...partial,
  } as MemoryEntry;
}

function dismissal(e: MemoryEntry): PromotionDismissal {
  return { id: e.id, hash: hashEntry(e), dismissedAt: "2026-01-02T00:00:00Z" };
}

test("candidates: only private entries, newest first", () => {
  const out = promotionCandidates(
    [
      entry({ id: "a", date: "2026-01-01" }),
      entry({ id: "b", date: "2026-02-01" }),
      entry({ id: "p", graph: "public", path: "/repo/memory-public/entries/2026/01/p.md" }),
    ],
    [],
  );
  assert.deepEqual(out.map((c) => c.id), ["b", "a"]);
});

test("candidates: dismissed at current hash is hidden; content change resurfaces it", () => {
  const a = entry({ id: "a" });
  assert.deepEqual(promotionCandidates([a], [dismissal(a)]), []);
  const edited = entry({ id: "a", body: "new body" });
  assert.deepEqual(promotionCandidates([edited], [dismissal(a)]).map((c) => c.id), ["a"]);
});

test("candidates: date window filters apply", () => {
  const out = promotionCandidates(
    [entry({ id: "old", date: "2026-01-01" }), entry({ id: "new", date: "2026-06-01" })],
    [],
    { since: "2026-05-01" },
  );
  assert.deepEqual(out.map((c) => c.id), ["new"]);
});

test("candidates: private follows/sources are reported as blockers", () => {
  const target = entry({ id: "t-private" });
  const pubTarget = entry({ id: "t-public", graph: "public", path: "/repo/memory-public/entries/2026/01/t.md" });
  const c = entry({ id: "c", follows: ["t-private", "t-public"] });
  const out = promotionCandidates([c, target, pubTarget], []);
  assert.deepEqual(out.find((x) => x.id === "c")?.blockedBy, ["t-private"]);
});
