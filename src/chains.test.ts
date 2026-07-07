import { test } from "node:test";
import assert from "node:assert/strict";
import type { MemoryEntry } from "./schema.js";
import { buildChainIndex, entryStatus, validateFollowsTargets } from "./chains.js";

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

test("no follows anywhere → empty index", () => {
  const idx = buildChainIndex([
    entry({ id: "2026-01-01-a", date: "2026-01-01", type: "note" }),
    entry({ id: "2026-02-01-b", date: "2026-02-01", type: "decision" }),
  ]);
  assert.equal(idx.size, 0);
});

test("linear chain: note → pending-decision → decision", () => {
  const idx = buildChainIndex([
    entry({ id: "2026-01-01-note", date: "2026-01-01", type: "note" }),
    entry({ id: "2026-02-01-pending", date: "2026-02-01", type: "pending-decision", follows: ["2026-01-01-note"] }),
    entry({ id: "2026-03-01-decision", date: "2026-03-01", type: "decision", follows: ["2026-02-01-pending"] }),
  ]);

  const note = idx.get("2026-01-01-note")!;
  assert.deepEqual(note.next, ["2026-02-01-pending"]);
  assert.equal(note.latest.id, "2026-03-01-decision");
  assert.equal(note.status, undefined); // notes carry no status

  const pending = idx.get("2026-02-01-pending")!;
  assert.deepEqual(pending.prev, ["2026-01-01-note"]);
  assert.equal(pending.status, "resolved");
  assert.equal(pending.resolvedBy, "2026-03-01-decision");
  assert.equal(pending.latest.id, "2026-03-01-decision");

  const decision = idx.get("2026-03-01-decision")!;
  assert.equal(decision.latest.id, "2026-03-01-decision");
  assert.equal(decision.status, undefined);
});

test("open pending-decision with no descendants stays open", () => {
  const idx = buildChainIndex([
    entry({ id: "2026-01-01-note", date: "2026-01-01", type: "note" }),
    entry({ id: "2026-02-01-pending", date: "2026-02-01", type: "pending-decision", follows: ["2026-01-01-note"] }),
  ]);
  const pending = idx.get("2026-02-01-pending")!;
  assert.equal(pending.status, "open");
  assert.equal(pending.resolvedBy, undefined);
  assert.equal(pending.latest.id, "2026-02-01-pending");
});

test("multi-parent: one decision resolves two pending items", () => {
  const idx = buildChainIndex([
    entry({ id: "2026-01-01-p1", date: "2026-01-01", type: "pending-decision" }),
    entry({ id: "2026-01-02-p2", date: "2026-01-02", type: "todo" }),
    entry({ id: "2026-02-01-d", date: "2026-02-01", type: "decision", follows: ["2026-01-01-p1", "2026-01-02-p2"] }),
  ]);
  assert.equal(idx.get("2026-01-01-p1")!.resolvedBy, "2026-02-01-d");
  assert.equal(idx.get("2026-01-02-p2")!.resolvedBy, "2026-02-01-d");
  assert.equal(idx.get("2026-01-02-p2")!.status, "resolved");
  assert.deepEqual(idx.get("2026-02-01-d")!.prev.sort(), ["2026-01-01-p1", "2026-01-02-p2"]);
});

test("resolvedBy prefers nearest decision descendant over nearer non-decision", () => {
  const idx = buildChainIndex([
    entry({ id: "2026-01-01-pending", date: "2026-01-01", type: "pending-decision" }),
    entry({ id: "2026-02-01-note", date: "2026-02-01", type: "note", follows: ["2026-01-01-pending"] }),
    entry({ id: "2026-03-01-decision", date: "2026-03-01", type: "decision", follows: ["2026-02-01-note"] }),
  ]);
  assert.equal(idx.get("2026-01-01-pending")!.resolvedBy, "2026-03-01-decision");
});

test("open item followed only by notes: resolved by latest descendant", () => {
  const idx = buildChainIndex([
    entry({ id: "2026-01-01-todo", date: "2026-01-01", type: "todo" }),
    entry({ id: "2026-02-01-note", date: "2026-02-01", type: "note", follows: ["2026-01-01-todo"] }),
  ]);
  const todo = idx.get("2026-01-01-todo")!;
  assert.equal(todo.status, "resolved");
  assert.equal(todo.resolvedBy, "2026-02-01-note");
});

test("same-day chain resolves by topology, not date", () => {
  const idx = buildChainIndex([
    entry({ id: "2026-05-05-pending", date: "2026-05-05", type: "pending-decision" }),
    entry({ id: "2026-05-05-decision", date: "2026-05-05", type: "decision", follows: ["2026-05-05-pending"] }),
  ]);
  const pending = idx.get("2026-05-05-pending")!;
  assert.equal(pending.status, "resolved");
  assert.equal(pending.resolvedBy, "2026-05-05-decision");
  assert.equal(pending.latest.id, "2026-05-05-decision");
});

test("latest uses updated when newer than date", () => {
  const idx = buildChainIndex([
    entry({ id: "2026-01-01-a", date: "2026-01-01", type: "note", updated: "2026-06-01" }),
    entry({ id: "2026-03-01-b", date: "2026-03-01", type: "note", follows: ["2026-01-01-a"] }),
  ]);
  // a was refreshed (2026-06-01) after b's date → a is the latest state
  assert.equal(idx.get("2026-03-01-b")!.latest.id, "2026-01-01-a");
});

test("dangling follows target is filtered from prev and reported", () => {
  const idx = buildChainIndex([
    entry({ id: "2026-02-01-b", date: "2026-02-01", type: "note", follows: ["2026-01-01-gone", "2026-01-15-real"] }),
    entry({ id: "2026-01-15-real", date: "2026-01-15", type: "note" }),
  ]);
  const b = idx.get("2026-02-01-b")!;
  assert.deepEqual(b.prev, ["2026-01-15-real"]);
  assert.deepEqual(b.dangling, ["2026-01-01-gone"]);
});

test("hand-built cycle terminates and still answers", () => {
  const idx = buildChainIndex([
    entry({ id: "2026-01-01-a", date: "2026-01-01", type: "pending-decision", follows: ["2026-02-01-b"] }),
    entry({ id: "2026-02-01-b", date: "2026-02-01", type: "decision", follows: ["2026-01-01-a"] }),
  ]);
  const a = idx.get("2026-01-01-a")!;
  assert.equal(a.status, "resolved");
  assert.equal(a.resolvedBy, "2026-02-01-b");
  assert.equal(a.latest.id, "2026-02-01-b");
});

test("cross-year chain links normally", () => {
  const idx = buildChainIndex([
    entry({ id: "2025-12-20-pending", date: "2025-12-20", type: "pending-decision" }),
    entry({ id: "2026-01-05-decision", date: "2026-01-05", type: "decision", follows: ["2025-12-20-pending"] }),
  ]);
  assert.equal(idx.get("2025-12-20-pending")!.resolvedBy, "2026-01-05-decision");
});

test("summary in a chain never gets a status", () => {
  const idx = buildChainIndex([
    entry({ id: "2026-01-01-pending", date: "2026-01-01", type: "pending-decision" }),
    entry({ id: "2026-02-01-summary", date: "2026-02-01", type: "summary", follows: ["2026-01-01-pending"] }),
  ]);
  assert.equal(idx.get("2026-02-01-summary")!.status, undefined);
  assert.equal(idx.get("2026-01-01-pending")!.status, "resolved");
});

test("entryStatus: unlinked pending-decision is open; notes have no status", () => {
  const pending = entry({ id: "2026-03-01-lonely", date: "2026-03-01", type: "pending-decision" });
  const note = entry({ id: "2026-03-02-note", date: "2026-03-02", type: "note" });
  const idx = buildChainIndex([pending, note]);
  assert.deepEqual(entryStatus(pending, idx), { status: "open" });
  assert.equal(entryStatus(note, idx), undefined);
});

test("entryStatus: chained pending-decision reports resolver", () => {
  const pending = entry({ id: "2026-01-01-p", date: "2026-01-01", type: "pending-decision" });
  const decision = entry({ id: "2026-02-01-d", date: "2026-02-01", type: "decision", follows: ["2026-01-01-p"] });
  const idx = buildChainIndex([pending, decision]);
  assert.deepEqual(entryStatus(pending, idx), { status: "resolved", resolvedBy: "2026-02-01-d" });
});

test("validateFollowsTargets: accepts a valid earlier target", () => {
  const entries = [
    entry({ id: "2026-01-01-pending", date: "2026-01-01", type: "pending-decision" }),
  ];
  validateFollowsTargets(entries, { id: "2026-02-01-decision", date: "2026-02-01" }, ["2026-01-01-pending"]);
});

test("validateFollowsTargets: same-day target is allowed", () => {
  const entries = [entry({ id: "2026-05-05-pending", date: "2026-05-05", type: "pending-decision" })];
  validateFollowsTargets(entries, { id: "2026-05-05-decision", date: "2026-05-05" }, ["2026-05-05-pending"]);
});

test("validateFollowsTargets: unknown target rejected", () => {
  assert.throws(
    () => validateFollowsTargets([], { id: "2026-02-01-a", date: "2026-02-01" }, ["2026-01-01-gone"]),
    /no entry with id '2026-01-01-gone'/,
  );
});

test("validateFollowsTargets: self-link rejected", () => {
  const entries = [entry({ id: "2026-01-01-a", date: "2026-01-01", type: "note" })];
  assert.throws(
    () => validateFollowsTargets(entries, { id: "2026-01-01-a", date: "2026-01-01" }, ["2026-01-01-a"]),
    /itself/,
  );
});

test("validateFollowsTargets: later-dated target rejected", () => {
  const entries = [entry({ id: "2026-03-01-future", date: "2026-03-01", type: "note" })];
  assert.throws(
    () => validateFollowsTargets(entries, { id: "2026-02-01-a", date: "2026-02-01" }, ["2026-03-01-future"]),
    /must not be newer/,
  );
});

test("validateFollowsTargets: cycle rejected (target already follows the source)", () => {
  const entries = [
    entry({ id: "2026-01-01-a", date: "2026-01-01", type: "note" }),
    entry({ id: "2026-01-01-b", date: "2026-01-01", type: "note", follows: ["2026-01-01-a"] }),
  ];
  // a --follows b would close the loop a → b → a
  assert.throws(
    () => validateFollowsTargets(entries, { id: "2026-01-01-a", date: "2026-01-01" }, ["2026-01-01-b"]),
    /cycle/,
  );
});

test("entries outside any chain are absent from the index", () => {
  const idx = buildChainIndex([
    entry({ id: "2026-01-01-a", date: "2026-01-01", type: "note" }),
    entry({ id: "2026-02-01-b", date: "2026-02-01", type: "note", follows: ["2026-01-01-a"] }),
    entry({ id: "2026-03-01-lonely", date: "2026-03-01", type: "pending-decision" }),
  ]);
  assert.equal(idx.has("2026-03-01-lonely"), false);
  assert.equal(idx.has("2026-01-01-a"), true);
});
