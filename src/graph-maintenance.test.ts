import { test } from "node:test";
import assert from "node:assert/strict";
import type { MemoryEntry } from "./schema.js";
import { analyzeGraphHygiene, slugDismissalKeys } from "./graph-maintenance.js";

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

test("slugDismissalKeys produces both role orders", () => {
  const keys = slugDismissalKeys([{ kind: "tag", from: "a", to: "b", dismissedAt: "2026-07-24T00:00:00Z" }]);
  assert.deepEqual([...keys].sort(), ["tag|a|b", "tag|b|a"]);
});
