import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { MemoryEntry } from "./schema.js";
import { graphOfPath, parseGraphId, storesUnder, validateCrossGraphLinks } from "./graphs.js";
import { hashEntry } from "./ingest.js";

const stores = storesUnder("/repo");

function entry(
  partial: Partial<MemoryEntry> & Pick<MemoryEntry, "id" | "graph">,
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
    ...partial,
  } as MemoryEntry;
}

test("graphOfPath: private store and outside paths are private", () => {
  assert.equal(graphOfPath(join("/repo", "memory", "entries", "a.md"), stores), "private");
  assert.equal(graphOfPath("/somewhere/else.md", stores), "private");
});

test("graphOfPath: public store paths are public", () => {
  assert.equal(graphOfPath(join("/repo", "memory-public", "entries", "a.md"), stores), "public");
  assert.equal(graphOfPath(join("/repo", "memory-public"), stores), "public");
});

test("graphOfPath: memory-public prefix never bleeds into lookalike dirs", () => {
  // `memory-public-old/` shares the `memory-public` prefix but is NOT the store.
  assert.equal(graphOfPath(join("/repo", "memory-public-old", "a.md"), stores), "private");
});

test("parseGraphId accepts only the two graphs", () => {
  assert.equal(parseGraphId("private"), "private");
  assert.equal(parseGraphId("public"), "public");
  assert.throws(() => parseGraphId("shared"), /invalid graph/);
  assert.throws(() => parseGraphId(undefined), /invalid graph/);
});

test("hash stability: graph never participates in the content hash", () => {
  const priv = entry({ id: "2026-01-01-x", graph: "private" });
  const pub = entry({
    id: "2026-01-01-x",
    graph: "public",
    path: "/repo/memory-public/entries/2026/01/2026-01-01-x.md",
  });
  // Same content, different store/path → identical hash, so a `move` between
  // graphs never re-chunks and pre-split hashes stay valid.
  assert.equal(hashEntry(priv), hashEntry(pub));
});

function byIdOf(...entries: MemoryEntry[]): Map<string, MemoryEntry> {
  return new Map(entries.map((e) => [e.id, e]));
}

test("cross-graph links: private may reference anything", () => {
  const pubTarget = entry({ id: "t-pub", graph: "public" });
  const privTarget = entry({ id: "t-priv", graph: "private" });
  const byId = byIdOf(pubTarget, privTarget);
  assert.doesNotThrow(() =>
    validateCrossGraphLinks(byId, { id: "src", graph: "private" }, ["t-pub", "t-priv"]),
  );
});

test("cross-graph links: public → public is fine", () => {
  const byId = byIdOf(entry({ id: "t-pub", graph: "public" }));
  assert.doesNotThrow(() =>
    validateCrossGraphLinks(byId, { id: "src", graph: "public" }, ["t-pub"]),
  );
});

test("cross-graph links: public → private is forbidden and names the violators", () => {
  const byId = byIdOf(entry({ id: "t-priv", graph: "private" }), entry({ id: "t-pub", graph: "public" }));
  assert.throws(
    () => validateCrossGraphLinks(byId, { id: "src", graph: "public" }, ["t-pub", "t-priv"]),
    /cannot reference private entries: t-priv/,
  );
});

test("cross-graph links: unknown target ids are ignored (existence checked elsewhere)", () => {
  assert.doesNotThrow(() =>
    validateCrossGraphLinks(new Map(), { id: "src", graph: "public" }, ["ghost-id"]),
  );
});
