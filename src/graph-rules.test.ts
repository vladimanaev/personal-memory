import { test } from "node:test";
import assert from "node:assert/strict";
import type { MemoryEntry } from "./schema.js";
import { planRules, matchRule, type GraphRule } from "./graph-rules.js";

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

const copyTag = (tag: string, graph: string): GraphRule => ({ match: { tag }, graph, mode: "copy" });
const moveType = (type: string, graph: string): GraphRule =>
  ({ match: { type }, graph, mode: "move" }) as GraphRule;

test("matchRule: tag and type AND together", () => {
  const r: GraphRule = { match: { tag: "arch", type: "decision" }, graph: "g", mode: "copy" };
  assert.equal(matchRule(entry({ id: "a", tags: ["arch"], type: "decision" }), r), true);
  assert.equal(matchRule(entry({ id: "b", tags: ["arch"], type: "note" }), r), false);
  assert.equal(matchRule(entry({ id: "c", tags: [], type: "decision" }), r), false);
});

test("planRules: copy rules union memberships, idempotently", () => {
  const e = entry({ id: "a", tags: ["arch", "shared"] });
  const plan = planRules([e], [copyTag("arch", "team-x"), copyTag("shared", "team-y"), copyTag("shared", "team-x")]);
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(
    plan.actions.sort((x, y) => x.graph.localeCompare(y.graph)),
    [
      { id: "a", action: "copy", graph: "team-x" },
      { id: "a", action: "copy", graph: "team-y" },
    ],
  );
  // already a member → no action
  const member = entry({ id: "b", tags: ["arch"], graphs: ["private", "team-x"] });
  assert.deepEqual(planRules([member], [copyTag("arch", "team-x")]).actions, []);
});

test("planRules: single move rule moves; already-exact membership is a no-op", () => {
  const e = entry({ id: "a", type: "achievement" });
  const plan = planRules([e], [moveType("achievement", "team-x")]);
  assert.deepEqual(plan.actions, [{ id: "a", action: "move", graph: "team-x" }]);
});

test("planRules: two move rules to different graphs → conflict, skipped", () => {
  const e = entry({ id: "a", tags: ["t1", "t2"] });
  const rules: GraphRule[] = [
    { match: { tag: "t1" }, graph: "x", mode: "move" },
    { match: { tag: "t2" }, graph: "y", mode: "move" },
  ];
  const plan = planRules([e], rules);
  assert.deepEqual(plan.actions, []);
  assert.equal(plan.conflicts.length, 1);
  assert.match(plan.conflicts[0]!.reason, /move rules disagree/);
});

test("planRules: move combined with copy → conflict, skipped", () => {
  const e = entry({ id: "a", tags: ["t1", "t2"] });
  const rules: GraphRule[] = [
    { match: { tag: "t1" }, graph: "x", mode: "move" },
    { match: { tag: "t2" }, graph: "y", mode: "copy" },
  ];
  const plan = planRules([e], rules);
  assert.deepEqual(plan.actions, []);
  assert.equal(plan.conflicts.length, 1);
});

test("planRules: entries that left private are never touched", () => {
  const moved = entry({ id: "a", tags: ["arch"], graphs: ["team-x"] });
  assert.deepEqual(planRules([moved], [copyTag("arch", "team-y")]).actions, []);
});
