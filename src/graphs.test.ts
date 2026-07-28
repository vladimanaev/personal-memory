import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryEntry } from "./schema.js";
import { sortGraphs } from "./schema.js";
import { graphOfPath, storesUnder, validateContainment } from "./graphs.js";
import { hashEntry } from "./ingest.js";

function tempRoot(withGraphs: string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), "pm-graphs-"));
  mkdirSync(join(root, "memory", "entries"), { recursive: true });
  for (const g of withGraphs) {
    mkdirSync(join(root, "memory-graphs", g, "entries"), { recursive: true });
  }
  return root;
}

function entry(
  partial: Partial<MemoryEntry> & Pick<MemoryEntry, "id" | "graphs">,
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
    ...partial,
  } as MemoryEntry;
}

test("sortGraphs: private first, then lexicographic, deduped", () => {
  assert.deepEqual(sortGraphs(["zeta", "private", "acme", "acme"]), ["private", "acme", "zeta"]);
  assert.deepEqual(sortGraphs(["beta", "alpha"]), ["alpha", "beta"]);
});

test("storesUnder: private + slug-shaped dirs under memory-graphs/", () => {
  const root = tempRoot(["public", "team-x"]);
  try {
    const stores = storesUnder(root);
    assert.deepEqual(sortGraphs(stores.keys()), ["private", "public", "team-x"]);
    assert.equal(stores.get("team-x")!.dir, join(root, "memory-graphs", "team-x"));
    assert.equal(stores.get("private")!.dir, join(root, "memory"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("storesUnder: legacy memory-public layout is refused", () => {
  const root = tempRoot();
  mkdirSync(join(root, "memory-public"));
  try {
    assert.throws(() => storesUnder(root), /migrate-graphs/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("graphOfPath: store prefixes resolve; outside paths and lookalikes are private", () => {
  const root = tempRoot(["team-x"]);
  try {
    const stores = storesUnder(root);
    assert.equal(graphOfPath(join(root, "memory", "entries", "a.md"), stores), "private");
    assert.equal(graphOfPath(join(root, "memory-graphs", "team-x", "entries", "a.md"), stores), "team-x");
    assert.equal(graphOfPath(join(root, "memory-graphs-old", "a.md"), stores), "private");
    assert.equal(graphOfPath("/somewhere/else.md", stores), "private");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hash stability: membership never participates in the content hash", () => {
  const a = entry({ id: "2026-01-01-x", graphs: ["private"] });
  const b = entry({
    id: "2026-01-01-x",
    graphs: ["private", "team-x"],
    paths: { private: "/p", "team-x": "/t" },
  });
  assert.equal(hashEntry(a), hashEntry(b));
});

function byIdOf(...entries: MemoryEntry[]): Map<string, MemoryEntry> {
  return new Map(entries.map((e) => [e.id, e]));
}

test("containment: private-only sources may reference anything", () => {
  const byId = byIdOf(entry({ id: "t1", graphs: ["private"] }), entry({ id: "t2", graphs: ["team-x"] }));
  assert.doesNotThrow(() =>
    validateContainment(byId, { id: "src", graphs: ["private"] }, ["t1", "t2"]),
  );
});

test("containment: shared member may only reference fellow members", () => {
  const member = entry({ id: "t-in", graphs: ["private", "team-x"] });
  const outsider = entry({ id: "t-out", graphs: ["private"] });
  const byId = byIdOf(member, outsider);
  assert.doesNotThrow(() =>
    validateContainment(byId, { id: "src", graphs: ["private", "team-x"] }, ["t-in"]),
  );
  assert.throws(
    () => validateContainment(byId, { id: "src", graphs: ["private", "team-x"] }, ["t-in", "t-out"]),
    /member of graph 'team-x' but references entries that are not: t-out/,
  );
});

test("containment: every shared membership is checked", () => {
  const inX = entry({ id: "t", graphs: ["private", "team-x"] });
  const byId = byIdOf(inX);
  assert.throws(
    () => validateContainment(byId, { id: "src", graphs: ["private", "team-x", "team-y"] }, ["t"]),
    /member of graph 'team-y'/,
  );
});

test("containment: unknown target ids are ignored (existence checked elsewhere)", () => {
  assert.doesNotThrow(() =>
    validateContainment(new Map(), { id: "src", graphs: ["team-x"] }, ["ghost-id"]),
  );
});
