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
    paths: {},
    graphs: ["private"],
    ...partial,
  } as MemoryEntry;
}

function dismissal(e: MemoryEntry, graph = "public"): PromotionDismissal {
  return { id: e.id, graph, hash: hashEntry(e), dismissedAt: "2026-01-02T00:00:00Z" };
}

test("candidates: private-home non-members only, newest first", () => {
  const out = promotionCandidates(
    [
      entry({ id: "a", date: "2026-01-01" }),
      entry({ id: "b", date: "2026-02-01" }),
      entry({ id: "already", graphs: ["private", "public"] }),
      entry({ id: "moved-out", graphs: ["team-x"] }),
    ],
    [],
    { graph: "public" },
  );
  assert.deepEqual(out.map((c) => c.id), ["b", "a"]);
});

test("candidates: dismissed at current hash is hidden; content change resurfaces it", () => {
  const a = entry({ id: "a" });
  assert.deepEqual(promotionCandidates([a], [dismissal(a)], { graph: "public" }), []);
  const edited = entry({ id: "a", body: "new body" });
  assert.deepEqual(
    promotionCandidates([edited], [dismissal(a)], { graph: "public" }).map((c) => c.id),
    ["a"],
  );
});

test("candidates: dismissals are per target graph; legacy records default to public", () => {
  const a = entry({ id: "a" });
  const legacy: PromotionDismissal = {
    id: "a",
    hash: hashEntry(a),
    dismissedAt: "2026-01-02T00:00:00Z",
  };
  assert.deepEqual(promotionCandidates([a], [legacy], { graph: "public" }), []);
  assert.deepEqual(
    promotionCandidates([a], [legacy], { graph: "team-x" }).map((c) => c.id),
    ["a"],
  );
  assert.deepEqual(promotionCandidates([a], [dismissal(a, "team-x")], { graph: "team-x" }), []);
});

test("candidates: date window filters apply", () => {
  const out = promotionCandidates(
    [entry({ id: "old", date: "2026-01-01" }), entry({ id: "new", date: "2026-06-01" })],
    [],
    { graph: "public", since: "2026-05-01" },
  );
  assert.deepEqual(out.map((c) => c.id), ["new"]);
});

test("candidates: non-member follows/sources are reported as blockers", () => {
  const target = entry({ id: "t-private" });
  const member = entry({ id: "t-member", graphs: ["private", "public"] });
  const c = entry({ id: "c", follows: ["t-private", "t-member"] });
  const out = promotionCandidates([c, target, member], [], { graph: "public" });
  assert.deepEqual(out.find((x) => x.id === "c")?.blockedBy, ["t-private"]);
});
