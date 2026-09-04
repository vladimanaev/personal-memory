import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGraph, projectGraph, presetTypes } from "./graph-model.js";
import { computeFit, createSim, fnv1a, initPositions, mulberry32 } from "./graph-sim.js";

/** @import { GraphEntry, GNode, GEdge } from "./graph-model.js" */

/** @param {Partial<GraphEntry> & Pick<GraphEntry, "id">} partial @returns {GraphEntry} */
function entry(partial) {
  return { date: "2026-01-01", type: "note", title: partial.id, people: [], teams: [], tags: [], ...partial };
}

/**
 * Build a projection the way the view does, links counted included.
 * @param {GraphEntry[]} entries
 * @returns {{ nodes: GNode[], edges: GEdge[] }}
 */
function project(entries) {
  const model = buildGraph(entries);
  const { nodes, edges } = projectGraph(model, presetTypes("people"), {}, {});
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const n of nodes) n.links = 0;
  for (const e of edges) {
    const a = byId.get(e.a);
    const b = byId.get(e.b);
    if (a) a.links++;
    if (b) b.links++;
  }
  initPositions(nodes, new Map());
  return { nodes, edges };
}

/** A hub wired to `leaves` entries — the shape that used to diverge.
 * @param {number} leaves */
function hubCorpus(leaves) {
  return Array.from({ length: leaves }, (_, i) =>
    entry({ id: `e${i}`, people: ["hub", `p${i}`] }),
  );
}

/** @param {GNode[]} nodes */
function allFinite(nodes) {
  return nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y));
}

/** @param {GNode[]} nodes */
function extent(nodes) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) {
    x0 = Math.min(x0, n.x); x1 = Math.max(x1, n.x);
    y0 = Math.min(y0, n.y); y1 = Math.max(y1, n.y);
  }
  return Math.max(x1 - x0, y1 - y0);
}

// ---------- seeding ----------

test("fnv1a and mulberry32 are stable across calls", () => {
  assert.equal(fnv1a("p:jane"), fnv1a("p:jane"));
  assert.notEqual(fnv1a("p:jane"), fnv1a("p:amir"));
  const a = mulberry32(42), b = mulberry32(42);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
});

test("initPositions seeds deterministically and honours cached positions", () => {
  const one = project([entry({ id: "a", people: ["jane", "amir"] })]);
  const two = project([entry({ id: "a", people: ["jane", "amir"] })]);
  assert.deepEqual(one.nodes.map((n) => [n.x, n.y]), two.nodes.map((n) => [n.x, n.y]));

  const cached = new Map([["p:jane", { x: 11, y: 22 }]]);
  initPositions(one.nodes, cached);
  const jane = /** @type {GNode} */ (one.nodes.find((n) => n.id === "p:jane"));
  assert.deepEqual([jane.x, jane.y], [11, 22]);
});

test("seed order does not depend on the caller's array order", () => {
  const { nodes } = project([entry({ id: "a", people: ["jane", "amir", "raz"] })]);
  const before = new Map(nodes.map((n) => [n.id, [n.x, n.y]]));
  const shuffled = [...nodes].reverse();
  initPositions(shuffled, new Map());
  for (const n of shuffled) assert.deepEqual([n.x, n.y], before.get(n.id));
});

// ---------- stability ----------

test("a high-degree hub does not diverge", () => {
  // Regression: the spring strength 1/min(deg) applied in full to both endpoints
  // meant a hub with hundreds of links accumulated hundreds of full-strength
  // pulls per tick. The old hard clamp to a 1200x800 box hid it; without the
  // clamp the layout ran away to NaN within ~30 ticks.
  const { nodes, edges } = project(hubCorpus(300));
  const hub = /** @type {GNode} */ (nodes.find((n) => n.id === "p:hub"));
  assert.ok(hub.links > 250, `expected a real hub, got ${hub.links} links`);

  const sim = createSim(nodes, edges);
  let alpha = 1;
  for (let i = 0; i < 250; i++) {
    sim.step(alpha);
    alpha *= 0.985;
  }
  sim.writeBack(nodes);
  assert.ok(allFinite(nodes), "layout must stay finite");
  assert.ok(extent(nodes) < 20000, `layout should stay bounded, spans ${Math.round(extent(nodes))}`);
});

test("the soft boundary keeps a settled layout bounded without clamping", () => {
  const { nodes, edges } = project(hubCorpus(120));
  const sim = createSim(nodes, edges);
  let alpha = 1;
  for (let i = 0; i < 200; i++) { sim.step(alpha); alpha *= 0.985; }
  sim.writeBack(nodes);
  const settled = extent(nodes);
  for (let i = 0; i < 200; i++) sim.step(0.05);
  sim.writeBack(nodes);
  // a soft boundary lets the layout breathe but must not let it drift away
  assert.ok(extent(nodes) < settled * 2 + 500, "settled layout must not keep growing");
});

test("nodes are not pinned to a box — the layout may exceed the old 1200x800", () => {
  const { nodes, edges } = project(hubCorpus(200));
  const sim = createSim(nodes, edges);
  let alpha = 1;
  for (let i = 0; i < 200; i++) { sim.step(alpha); alpha *= 0.985; }
  sim.writeBack(nodes);
  // The old kernel clamped every coordinate into [34, 1166] x [34, 766], so
  // overflowing nodes came to rest *exactly* on a boundary value — that is what
  // drew the rows of circles along the frame. Spreading past those bounds is
  // now expected and fine; sitting precisely on them is the symptom.
  const onOldWall = nodes.filter(
    (n) => n.x === 34 || n.x === 1166 || n.y === 34 || n.y === 766,
  );
  assert.equal(onOldWall.length, 0, `${onOldWall.length} nodes rest exactly on the old clamp boundary`);
});

test("a graph of coincident nodes does not blow up the quadtree", () => {
  // Every node starts at the same point only if seeding is bypassed; force it
  // to exercise the max-depth / coincident-body path.
  const { nodes, edges } = project(hubCorpus(60));
  for (const n of nodes) { n.x = 500; n.y = 400; }
  const sim = createSim(nodes, edges);
  for (let i = 0; i < 40; i++) sim.step(1);
  sim.writeBack(nodes);
  assert.ok(allFinite(nodes));
});

// ---------- determinism ----------

test("two runs of the same projection settle identically", () => {
  const corpus = () => [
    entry({ id: "a", people: ["jane", "amir"], teams: ["core"] }),
    entry({ id: "b", people: ["amir", "raz"] }),
    entry({ id: "c", people: ["jane", "raz", "tal"] }),
    entry({ id: "d", people: ["tal"] }),
  ];
  /** @param {GNode[]} nodes @param {GEdge[]} edges */
  const settle = (nodes, edges) => {
    const sim = createSim(nodes, edges);
    let alpha = 1;
    for (let i = 0; i < 120; i++) { sim.step(alpha); alpha *= 0.985; }
    sim.writeBack(nodes);
    return nodes.map((n) => `${n.id}:${n.x.toFixed(6)},${n.y.toFixed(6)}`).sort();
  };
  const one = project(corpus());
  const two = project(corpus());
  assert.deepEqual(settle(one.nodes, one.edges), settle(two.nodes, two.edges));
});

test("the settled layout does not depend on node or edge array order", () => {
  // Node order is canonicalized inside the kernel precisely so the view's
  // arbitrary projection order cannot change the picture.
  const corpus = () => [
    entry({ id: "a", people: ["jane", "amir"] }),
    entry({ id: "b", people: ["amir", "raz"] }),
    entry({ id: "c", people: ["jane", "raz"] }),
  ];
  /** @param {boolean} reversed */
  const settle = (reversed) => {
    const { nodes, edges } = project(corpus());
    const ns = reversed ? [...nodes].reverse() : nodes;
    const sim = createSim(ns, edges);
    let alpha = 1;
    for (let i = 0; i < 120; i++) { sim.step(alpha); alpha *= 0.985; }
    sim.writeBack(ns);
    return [...ns].map((n) => `${n.id}:${n.x.toFixed(6)},${n.y.toFixed(6)}`).sort();
  };
  assert.deepEqual(settle(false), settle(true));
});

// ---------- pinning ----------

test("a pinned node stays exactly where it was put, and unpin releases it", () => {
  const { nodes, edges } = project(hubCorpus(30));
  const sim = createSim(nodes, edges);
  sim.pin("p:hub", 900, 250);
  for (let i = 0; i < 30; i++) sim.step(0.4);
  sim.writeBack(nodes);
  const hub = /** @type {GNode} */ (nodes.find((n) => n.id === "p:hub"));
  assert.deepEqual([hub.x, hub.y], [900, 250]);

  sim.unpin("p:hub");
  for (let i = 0; i < 30; i++) sim.step(0.4);
  sim.writeBack(nodes);
  const moved = /** @type {GNode} */ (nodes.find((n) => n.id === "p:hub"));
  assert.notDeepEqual([moved.x, moved.y], [900, 250]);
});

test("pin and unpin ignore ids that are not in the projection", () => {
  const { nodes, edges } = project(hubCorpus(5));
  const sim = createSim(nodes, edges);
  assert.doesNotThrow(() => {
    sim.pin("p:nobody", 1, 2);
    sim.unpin("p:nobody");
  });
});

// ---------- writeBack ----------

test("writeBack only touches nodes the sim knows about", () => {
  const { nodes, edges } = project(hubCorpus(10));
  const sim = createSim(nodes, edges);
  for (let i = 0; i < 10; i++) sim.step(0.5);
  /** @type {GNode} */
  const stranger = { ...(/** @type {GNode} */ (nodes[0])), id: "p:stranger", x: 7, y: 9 };
  sim.writeBack([...nodes, stranger]);
  assert.deepEqual([stranger.x, stranger.y], [7, 9]);
});

test("an empty or single-node projection is a no-op, not a crash", () => {
  const empty = createSim([], []);
  assert.doesNotThrow(() => empty.step(1));
  assert.equal(empty.length, 0);

  const { nodes, edges } = project([entry({ id: "a", people: ["solo"] })]);
  const one = createSim(nodes.slice(0, 1), edges.slice(0, 0));
  assert.doesNotThrow(() => one.step(1));
});

// ---------- framing ----------

test("computeFit frames the layout without moving a single node", () => {
  // Regression: the old fitToView multiplied every node position by a scale
  // factor to squeeze the layout into the 1200x800 viewBox, but left the radii
  // alone. A settled layout of ~1540 wide was squashed by ~0.47, halving the
  // gap between neighbours while the discs stayed full size — the dense,
  // overlapping first paint. Framing belongs to the camera.
  const { nodes, edges } = project(hubCorpus(80));
  const sim = createSim(nodes, edges);
  let alpha = 1;
  for (let i = 0; i < 200; i++) { sim.step(alpha); alpha *= 0.985; }
  sim.writeBack(nodes);

  const before = nodes.map((n) => [n.x, n.y]);
  const view = computeFit(nodes, 0.4, 8);
  assert.deepEqual(nodes.map((n) => [n.x, n.y]), before, "computeFit must not touch the layout");
  assert.ok(view.k > 0 && Number.isFinite(view.k));
  assert.ok(Number.isFinite(view.tx) && Number.isFinite(view.ty));
});

test("computeFit brings the whole layout inside the viewport", () => {
  const { nodes, edges } = project(hubCorpus(120));
  const sim = createSim(nodes, edges);
  let alpha = 1;
  for (let i = 0; i < 220; i++) { sim.step(alpha); alpha *= 0.985; }
  sim.writeBack(nodes);

  const { k, tx, ty } = computeFit(nodes, 0.4, 8);
  for (const n of nodes) {
    const sx = n.x * k + tx;
    const sy = n.y * k + ty;
    assert.ok(sx >= -1 && sx <= 1201, `node ${n.id} at screen x ${sx.toFixed(0)}`);
    assert.ok(sy >= -1 && sy <= 801, `node ${n.id} at screen y ${sy.toFixed(0)}`);
  }
});

test("computeFit honours the zoom clamps and handles an empty projection", () => {
  assert.deepEqual(computeFit([], 0.4, 8), { k: 1, tx: 0, ty: 0 });
  const { nodes } = project(hubCorpus(4));
  // a tiny layout would want to zoom far in; kMax must cap it
  const view = computeFit(nodes, 0.4, 2);
  assert.ok(view.k <= 2 && view.k >= 0.4);
});

test("the settled layout roughly matches the viewport's aspect", () => {
  // A circular boundary yields a square layout, which wastes a third of the
  // width when framed in a 3:2 viewport. The boundary is an ellipse for this.
  const { nodes, edges } = project(hubCorpus(200));
  const sim = createSim(nodes, edges);
  let alpha = 1;
  for (let i = 0; i < 260; i++) { sim.step(alpha); alpha *= 0.985; }
  sim.writeBack(nodes);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) {
    x0 = Math.min(x0, n.x); x1 = Math.max(x1, n.x);
    y0 = Math.min(y0, n.y); y1 = Math.max(y1, n.y);
  }
  const ratio = (x1 - x0) / (y1 - y0);
  assert.ok(ratio > 1.15, `layout should be wider than tall, got ${ratio.toFixed(2)}`);
});
