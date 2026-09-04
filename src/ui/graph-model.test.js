import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildGraph,
  entryGraphs,
  labelSet,
  modeLabel,
  nodeTip,
  presetTypes,
  projectGraph,
  trunc,
} from "./graph-model.js";

/** @import { GraphEntry, NodeKind } from "./graph-model.js" */

/** @param {Partial<GraphEntry> & Pick<GraphEntry, "id">} partial @returns {GraphEntry} */
function entry(partial) {
  return {
    date: "2026-01-01",
    type: "note",
    title: partial.id,
    people: [],
    teams: [],
    tags: [],
    ...partial,
  };
}

/** every kind on @returns {Record<NodeKind, boolean>} */
const ALL = { person: true, tag: true, team: true, entry: true };

// ---------- buildGraph ----------

test("buildGraph: entities are deduped across entries and carry degree + backing ids", () => {
  const m = buildGraph([
    entry({ id: "a", people: ["jane", "amir"], tags: ["hiring"] }),
    entry({ id: "b", people: ["jane"], teams: ["core"] }),
  ]);
  assert.equal(m.nodes.get("p:jane")?.deg, 2);
  assert.deepEqual(m.nodes.get("p:jane")?.entryIds, ["a", "b"]);
  assert.equal(m.nodes.get("p:amir")?.deg, 1);
  assert.equal(m.nodes.get("m:core")?.kind, "team");
  assert.equal(m.nodes.get("t:hiring")?.kind, "tag");
  // 2 entry nodes + jane + amir + hiring + core
  assert.equal(m.nodes.size, 6);
});

test("buildGraph: memberships list entity ids per entry, never entry ids", () => {
  const m = buildGraph([entry({ id: "a", people: ["jane"], tags: ["hiring"], teams: ["core"] })]);
  assert.deepEqual(m.memberships, [["p:jane", "t:hiring", "m:core"]]);
  assert.ok(!m.memberships.flat().some((id) => id.startsWith("e:")));
});

test("buildGraph: is deterministic — same input, deep-equal output", () => {
  const es = [
    entry({ id: "a", people: ["jane", "amir"], tags: ["x", "y"] }),
    entry({ id: "b", people: ["amir"], tags: ["y"] }),
  ];
  const one = buildGraph(es);
  const two = buildGraph(es);
  assert.deepEqual([...one.nodes.keys()], [...two.nodes.keys()]);
  assert.deepEqual(one.edges, two.edges);
  assert.deepEqual(one.memberships, two.memberships);
});

test("buildGraph: a ghost contributes its entry node alone — no memberships, no edges", () => {
  const m = buildGraph([
    entry({ id: "a", people: ["jane"], follows: ["g"] }),
    entry({ id: "g", people: ["amir"], tags: ["x"], ghost: true, graphs: ["team"] }),
  ]);
  assert.equal(m.nodes.get("e:g")?.ghost, true);
  assert.equal(m.nodes.get("e:g")?.gmemb, "team");
  assert.equal(m.nodes.has("p:amir"), false, "ghost people must not enter the model");
  assert.equal(m.memberships.length, 1, "only the non-ghost entry contributes memberships");
});

test("buildGraph: dangling follows and sources targets are dropped", () => {
  const m = buildGraph([
    entry({ id: "a", follows: ["nope"] }),
    entry({ id: "s", type: "summary", sources: ["a", "missing"] }),
  ]);
  const between = m.edges.filter((e) => e.a.startsWith("e:") && e.b.startsWith("e:"));
  assert.deepEqual(between, [{ a: "e:s", b: "e:a", weight: 1 }]);
});

test("buildGraph: follows edges are marked chain, summary→source edges are not", () => {
  const m = buildGraph([
    entry({ id: "a" }),
    entry({ id: "b", follows: ["a"] }),
    entry({ id: "s", type: "summary", sources: ["a"] }),
  ]);
  assert.equal(m.edges.find((e) => e.a === "e:b" && e.b === "e:a")?.chain, true);
  assert.equal(m.edges.find((e) => e.a === "e:s" && e.b === "e:a")?.chain, undefined);
});

test("buildGraph: entry nodes keep a fixed radius, entities scale with degree", () => {
  const m = buildGraph([
    entry({ id: "a", people: ["hub"] }),
    entry({ id: "b", people: ["hub"] }),
    entry({ id: "c", people: ["hub", "leaf"] }),
  ]);
  assert.equal(m.nodes.get("e:a")?.r, 4.5);
  const hub = /** @type {number} */ (m.nodes.get("p:hub")?.r);
  const leaf = /** @type {number} */ (m.nodes.get("p:leaf")?.r);
  assert.ok(hub > leaf, "a 3-entry person should outsize a 1-entry person");
  assert.ok(hub <= 20, "radius is clamped at 20");
});

// ---------- projectGraph ----------

test("projectGraph: co-occurrence weight counts shared entries", () => {
  const m = buildGraph([
    entry({ id: "a", people: ["jane", "amir"] }),
    entry({ id: "b", people: ["jane", "amir"] }),
    entry({ id: "c", people: ["jane", "raz"] }),
  ]);
  const p = projectGraph(m, { person: true, tag: false, team: false, entry: false }, {});
  const find = (x, y) => p.edges.find((e) => (e.a === x && e.b === y) || (e.a === y && e.b === x));
  assert.equal(find("p:jane", "p:amir")?.weight, 2);
  assert.equal(find("p:jane", "p:raz")?.weight, 1);
  assert.equal(find("p:amir", "p:raz"), undefined);
});

test("projectGraph: every returned edge has both endpoints in the returned node set", () => {
  const m = buildGraph([
    entry({ id: "a", people: ["jane"], tags: ["x"], teams: ["core"] }),
    entry({ id: "b", people: ["amir"], tags: ["x"] }),
  ]);
  for (const types of [
    ALL,
    { person: true, tag: false, team: true, entry: true },
    { person: false, tag: true, team: false, entry: false },
    { person: true, tag: true, team: true, entry: false },
  ]) {
    const p = projectGraph(m, types, {});
    const ids = new Set(p.nodes.map((n) => n.id));
    for (const e of p.edges) {
      assert.ok(ids.has(e.a) && ids.has(e.b), `dangling edge ${e.a}->${e.b} for ${JSON.stringify(types)}`);
    }
  }
});

test("projectGraph: minTagDegree prunes weak tags, keepTag exempts one", () => {
  const m = buildGraph([
    entry({ id: "a", tags: ["common", "rare"] }),
    entry({ id: "b", tags: ["common"] }),
  ]);
  const types = { person: false, tag: true, team: false, entry: false };
  const pruned = projectGraph(m, types, {}, { minTagDegree: 2 });
  assert.deepEqual(pruned.nodes.map((n) => n.id), ["t:common"]);

  const kept = projectGraph(m, types, {}, { minTagDegree: 2, keepTag: "rare" });
  assert.deepEqual(kept.nodes.map((n) => n.id).sort(), ["t:common", "t:rare"]);
});

test("projectGraph: only an explicit false hides an entry type, so new types stay visible", () => {
  const m = buildGraph([entry({ id: "a", type: "todo" }), entry({ id: "b", type: "note" })]);
  const shown = projectGraph(m, ALL, { todo: true });
  assert.equal(shown.nodes.length, 2, "an unlisted type is visible");
  const hidden = projectGraph(m, ALL, { todo: false });
  assert.deepEqual(hidden.nodes.map((n) => n.id), ["e:b"]);
});

test("projectGraph: hiding an entry type does NOT change co-occurrence weights", () => {
  // Pins the quirk the projection cache depends on: `memberships` holds no entry
  // ids, so the entry-type filter cannot reach the co-occurrence pass. If this
  // ever changes, the co-occurrence cache layer must be re-keyed on entryTypes.
  const m = buildGraph([
    entry({ id: "a", type: "meeting", people: ["jane", "amir"] }),
    entry({ id: "b", type: "note", people: ["jane", "amir"] }),
  ]);
  const co = (entryTypes) =>
    projectGraph(m, ALL, entryTypes).edges.find((e) => e.a === "p:jane" && e.b === "p:amir");
  assert.equal(co({})?.weight, 2);
  assert.equal(co({ meeting: false })?.weight, 2);
});

test("projectGraph: hasCo reports whether any co-occurrence edge exists", () => {
  const solo = buildGraph([entry({ id: "a", people: ["jane"] })]);
  assert.equal(projectGraph(solo, ALL, {}).hasCo, false);
  const pair = buildGraph([entry({ id: "a", people: ["jane", "amir"] })]);
  assert.equal(projectGraph(pair, ALL, {}).hasCo, true);
});

test("projectGraph: the entries chip adds the entry layer on top of co-occurrence", () => {
  const m = buildGraph([entry({ id: "a", people: ["jane", "amir"] })]);
  const without = projectGraph(m, { person: true, tag: false, team: false, entry: false }, {});
  const with_ = projectGraph(m, { person: true, tag: false, team: false, entry: true }, {});
  assert.equal(without.edges.length, 1, "just the jane–amir co-occurrence edge");
  assert.equal(with_.edges.length, 3, "plus two entry→person membership edges");
});

// ---------- small helpers ----------

test("entryGraphs tolerates the pre-multigraph shape", () => {
  assert.deepEqual(entryGraphs(entry({ id: "a", graphs: ["default", "team"] })), ["default", "team"]);
  assert.deepEqual(entryGraphs(entry({ id: "a", graph: "private" })), ["default"]);
  assert.deepEqual(entryGraphs(entry({ id: "a" })), ["default"]);
});

test("presetTypes and modeLabel agree with the three mode buttons", () => {
  assert.deepEqual(presetTypes("people"), { person: true, tag: false, team: true, entry: true });
  assert.deepEqual(presetTypes("topics"), { person: false, tag: true, team: false, entry: false });
  assert.deepEqual(presetTypes("entries"), { person: true, tag: false, team: false, entry: true });
  assert.equal(modeLabel("custom"), "custom");
});

test("trunc keeps short labels whole and ellipsizes long ones to n chars", () => {
  assert.equal(trunc("short"), "short");
  assert.equal(trunc("a".repeat(30)).length, 18);
  assert.ok(trunc("a".repeat(30)).endsWith("…"));
});

test("nodeTip reads differently for entries, ghosts and entities", () => {
  const m = buildGraph([
    entry({ id: "a", type: "todo", title: "ship it", people: ["jane"] }),
    entry({ id: "g", ghost: true, graphs: ["team"], type: "note", title: "elsewhere" }),
  ]);
  assert.equal(nodeTip(/** @type {any} */ (m.nodes.get("e:a"))), "ship it — todo");
  assert.equal(nodeTip(/** @type {any} */ (m.nodes.get("e:g"))), "elsewhere — note · team graph");
  assert.equal(nodeTip(/** @type {any} */ (m.nodes.get("p:jane"))), "jane — person — 1 entry");
});

test("labelSet labels every person outside topics, and only the top tags inside it", () => {
  const m = buildGraph([
    entry({ id: "a", people: ["jane", "amir"], tags: ["x", "y", "z"] }),
    entry({ id: "b", tags: ["x", "y"] }),
    entry({ id: "c", tags: ["x"] }),
  ]);
  const nodes = projectGraph(m, ALL, {}).nodes;
  assert.deepEqual([...labelSet(nodes, "people")].sort(), ["p:amir", "p:jane"]);
  // topics ranks by degree: x(3) > y(2) > z(1)
  assert.deepEqual([...labelSet(nodes, "topics", 2)], ["t:x", "t:y"]);
});
