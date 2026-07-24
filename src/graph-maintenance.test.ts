import { test } from "node:test";
import assert from "node:assert/strict";
import type { MemoryEntry } from "./schema.js";
import { analyzeGraphHygiene, slugDismissalKeys, slugUsage } from "./graph-maintenance.js";

function entry(partial: Partial<MemoryEntry> & Pick<MemoryEntry, "id" | "date" | "type">): MemoryEntry {
  return {
    title: partial.id,
    people: [],
    teams: [],
    tags: [],
    body: "",
    path: `/entries/${partial.id}.md`,
    ...partial,
  } as MemoryEntry;
}

/** Two reordered tag slugs (confidence 0.92) + two reordered person slugs. */
function fixtures(): MemoryEntry[] {
  return [
    entry({ id: "2026-01-01-a", date: "2026-01-01", type: "note", tags: ["pixel-helper"] }),
    entry({ id: "2026-02-01-b", date: "2026-02-01", type: "note", tags: ["helper-pixel"] }),
    entry({ id: "2026-03-01-c", date: "2026-03-01", type: "note", people: ["john-smith"] }),
    entry({ id: "2026-04-01-d", date: "2026-04-01", type: "note", people: ["smith-john"] }),
  ];
}

test("baseline: reordered slugs produce tag and person suggestions", () => {
  const audit = analyzeGraphHygiene(fixtures());
  assert.equal(audit.suggestions.filter((s) => s.kind === "tag").length, 1);
  assert.equal(audit.suggestions.filter((s) => s.kind === "person").length, 1);
});

test("dismissed pair is dropped; others survive", () => {
  const base = analyzeGraphHygiene(fixtures());
  const tag = base.suggestions.find((s) => s.kind === "tag")!;
  const dismissed = slugDismissalKeys([{ kind: tag.kind, from: tag.from, to: tag.to, dismissedAt: "2026-07-24T00:00:00Z" }]);

  const audit = analyzeGraphHygiene(fixtures(), undefined, dismissed);
  assert.equal(audit.suggestions.filter((s) => s.kind === "tag").length, 0);
  assert.equal(audit.suggestions.filter((s) => s.kind === "person").length, 1);
  assert.equal(audit.suggestionCounts.tag, 0);
  assert.equal(audit.suggestionCounts.person, 1);
});

test("dismissal matches with from/to swapped", () => {
  const base = analyzeGraphHygiene(fixtures());
  const tag = base.suggestions.find((s) => s.kind === "tag")!;
  const dismissed = slugDismissalKeys([{ kind: tag.kind, from: tag.to, to: tag.from, dismissedAt: "2026-07-24T00:00:00Z" }]);

  const audit = analyzeGraphHygiene(fixtures(), undefined, dismissed);
  assert.equal(audit.suggestions.filter((s) => s.kind === "tag").length, 0);
});

test("dismissal of same slugs under another kind does not match", () => {
  const base = analyzeGraphHygiene(fixtures());
  const tag = base.suggestions.find((s) => s.kind === "tag")!;
  const dismissed = slugDismissalKeys([{ kind: "person", from: tag.from, to: tag.to, dismissedAt: "2026-07-24T00:00:00Z" }]);

  const audit = analyzeGraphHygiene(fixtures(), undefined, dismissed);
  assert.equal(audit.suggestions.filter((s) => s.kind === "tag").length, 1);
});

test("slugUsage counts tags with lastSeen, sorted by count desc then slug asc", () => {
  const usage = slugUsage(
    [
      entry({ id: "2026-01-01-a", date: "2026-01-01", type: "note", tags: ["k8s", "infra"] }),
      entry({ id: "2026-02-01-b", date: "2026-02-01", type: "note", tags: ["kubernetes"] }),
      entry({ id: "2026-03-01-c", date: "2026-03-01", type: "note", tags: ["kubernetes"] }),
      entry({ id: "2026-04-01-d", date: "2026-04-01", type: "note", tags: ["infra"], people: ["jane"] }),
    ],
    "tag",
  );
  assert.deepEqual(usage, [
    { slug: "infra", count: 2, lastSeen: "2026-04-01" },
    { slug: "kubernetes", count: 2, lastSeen: "2026-03-01" },
    { slug: "k8s", count: 1, lastSeen: "2026-01-01" },
  ]);
});

test("slugUsage respects kind and returns empty for unused kind", () => {
  const entries = [entry({ id: "2026-01-01-a", date: "2026-01-01", type: "note", tags: ["k8s"] })];
  assert.deepEqual(slugUsage(entries, "person"), []);
  assert.deepEqual(slugUsage([], "tag"), []);
});

test("slugDismissalKeys produces both role orders", () => {
  const keys = slugDismissalKeys([{ kind: "tag", from: "a", to: "b", dismissedAt: "2026-07-24T00:00:00Z" }]);
  assert.deepEqual([...keys].sort(), ["tag|a|b", "tag|b|a"]);
});

/** k8s/kubernetes: semantically identical but beyond the engine's edit-similarity reach. */
function proposalFixtures(): MemoryEntry[] {
  return [
    entry({ id: "2026-01-01-a", date: "2026-01-01", type: "note", tags: ["k8s"] }),
    entry({ id: "2026-02-01-b", date: "2026-02-01", type: "note", tags: ["kubernetes"] }),
    entry({ id: "2026-03-01-c", date: "2026-03-01", type: "note", tags: ["k8s", "kubernetes"] }),
  ];
}

const PROPOSAL = { kind: "tag", from: "k8s", to: "kubernetes", reason: "same concept", proposedAt: "2026-07-24T00:00:00Z" } as const;

test("agent proposal surfaces as a suggestion with computed counts", () => {
  const base = analyzeGraphHygiene(proposalFixtures());
  assert.equal(base.suggestions.length, 0);

  const audit = analyzeGraphHygiene(proposalFixtures(), undefined, undefined, [PROPOSAL]);
  assert.equal(audit.suggestions.length, 1);
  const s = audit.suggestions[0]!;
  assert.equal(s.kind, "tag");
  assert.equal(s.from, "k8s");
  assert.equal(s.to, "kubernetes");
  assert.equal(s.source, "agent");
  assert.equal(s.fromCount, 2);
  assert.equal(s.toCount, 2);
  assert.equal(s.sharedEntries, 1);
  assert.equal(s.affectedEntries, 2);
  assert.equal(s.lastSeen, "2026-03-01");
  assert.ok(s.reasons.join(" ").includes("same concept"));
  assert.equal(audit.suggestionCounts.tag, 1);
});

test("dismissed proposal is excluded, either role order", () => {
  for (const [from, to] of [
    ["k8s", "kubernetes"],
    ["kubernetes", "k8s"],
  ] as const) {
    const dismissed = slugDismissalKeys([{ kind: "tag", from, to, dismissedAt: "2026-07-24T00:00:00Z" }]);
    const audit = analyzeGraphHygiene(proposalFixtures(), undefined, dismissed, [PROPOSAL]);
    assert.equal(audit.suggestions.length, 0);
  }
});

test("proposal whose from or to slug no longer exists is excluded", () => {
  const onlyKubernetes = [entry({ id: "2026-02-01-b", date: "2026-02-01", type: "note", tags: ["kubernetes"] })];
  assert.equal(analyzeGraphHygiene(onlyKubernetes, undefined, undefined, [PROPOSAL]).suggestions.length, 0);

  const onlyK8s = [entry({ id: "2026-01-01-a", date: "2026-01-01", type: "note", tags: ["k8s"] })];
  assert.equal(analyzeGraphHygiene(onlyK8s, undefined, undefined, [PROPOSAL]).suggestions.length, 0);
});

test("proposal duplicating an engine suggestion is not double-reported", () => {
  const entries = fixtures();
  const base = analyzeGraphHygiene(entries);
  const engine = base.suggestions.find((s) => s.kind === "tag")!;
  const audit = analyzeGraphHygiene(entries, undefined, undefined, [
    { kind: "tag", from: engine.to, to: engine.from, reason: "dup", proposedAt: "2026-07-24T00:00:00Z" },
  ]);
  assert.equal(audit.suggestions.filter((s) => s.kind === "tag").length, 1);
  assert.notEqual(audit.suggestions.find((s) => s.kind === "tag")!.source, "agent");
});
