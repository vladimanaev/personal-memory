import { test } from "node:test";
import assert from "node:assert/strict";
import { groupEntries, hashEntry, type FileEntry } from "./ingest.js";

function file(partial: Partial<FileEntry> & Pick<FileEntry, "id" | "graph" | "hash">): FileEntry {
  return {
    date: "2026-01-01",
    type: "note",
    title: partial.id,
    people: [],
    teams: [],
    tags: [],
    body: "body",
    path: `/repo/${partial.graph === "default" ? "memory" : `memory-graphs/${partial.graph}`}/entries/2026/01/${partial.id}.md`,
    ...partial,
  } as FileEntry;
}

test("groupEntries: single-store files become single-membership entries", () => {
  const { entries, drift } = groupEntries([file({ id: "a", graph: "default", hash: "h1" })]);
  assert.equal(drift.length, 0);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0]!.graphs, ["default"]);
  assert.equal(entries[0]!.paths["default"], entries[0]!.path);
  assert.equal(hashEntry(entries[0]!), "h1"); // memoized from the file, never recomputed
});

test("groupEntries: identical copies group into one logical entry, private home first", () => {
  const { entries } = groupEntries([
    file({ id: "a", graph: "team-x", hash: "h1" }),
    file({ id: "a", graph: "default", hash: "h1" }),
  ]);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0]!.graphs, ["default", "team-x"]);
  assert.match(entries[0]!.path, /\/memory\/entries\//); // home = private copy
  assert.equal(Object.keys(entries[0]!.paths).length, 2);
});

test("groupEntries: drifted copies throw by default with the repair hint", () => {
  const files = [
    file({ id: "a", graph: "default", hash: "h1" }),
    file({ id: "a", graph: "team-x", hash: "h2" }),
  ];
  assert.throws(() => groupEntries(files), /drifted apart[\s\S]*graphs sync/);
});

test("groupEntries: collect mode reports drift without producing the entry", () => {
  const files = [
    file({ id: "a", graph: "default", hash: "h1" }),
    file({ id: "a", graph: "team-x", hash: "h2" }),
    file({ id: "b", graph: "default", hash: "h3" }),
  ];
  const { entries, drift } = groupEntries(files, "collect");
  assert.deepEqual(entries.map((e) => e.id), ["b"]);
  assert.equal(drift.length, 1);
  assert.equal(drift[0]!.id, "a");
  assert.deepEqual(drift[0]!.copies.map((c) => c.graph).sort(), ["default", "team-x"]);
});

test("groupEntries: home falls back to the sole copy when not a private member", () => {
  const { entries } = groupEntries([file({ id: "a", graph: "team-x", hash: "h1" })]);
  assert.deepEqual(entries[0]!.graphs, ["team-x"]);
  assert.match(entries[0]!.path, /memory-graphs\/team-x/);
});
