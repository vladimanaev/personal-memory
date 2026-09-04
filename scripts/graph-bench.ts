#!/usr/bin/env -S npx tsx
/**
 * Graph-view benchmark. Loads the real store, builds the same projection the
 * browser builds, and reports model/projection cost, edge composition and
 * simulation cost per tick.
 *
 * Not part of `npm test` — it reads the local store, so its numbers are
 * specific to this machine and change as the store grows.
 *
 *   npm run bench:graph
 *   npm run bench:graph -- --mode all --json
 *   npm run bench:graph -- --synth 2000
 */
import { performance } from "node:perf_hooks";
import { loadAllEntries } from "../src/ingest.js";
import type { MemoryEntry } from "../src/schema.js";
import { buildGraph, entryGraphs, projectGraph, presetTypes } from "../src/ui/graph-model.js";
import type { GraphEntry, GraphMode, NodeKind } from "../src/ui/graph-model.js";
import { createSim, initPositions, mulberry32 } from "../src/ui/graph-sim.js";

type Mode = Exclude<GraphMode, "custom">;
const MODES: Mode[] = ["people", "topics", "entries"];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const asJson = process.argv.includes("--json");
const wanted = arg("mode") ?? "all";
const modes: Mode[] = wanted === "all" ? MODES : [wanted as Mode];
const synth = arg("synth") ? Number(arg("synth")) : 0;
const ticks = Number(arg("ticks") ?? 20);

/** median is the honest statistic here — a single GC pause skews a mean */
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

function time(runs: number, fn: () => void): number {
  for (let i = 0; i < 3; i++) fn(); // warm the JIT
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  return median(samples);
}

/** Mirrors app.js `graphScopedEntries` for the default graph, ghosts included. */
function scopeToDefault(entries: MemoryEntry[]): GraphEntry[] {
  const as = (e: MemoryEntry): GraphEntry => ({
    id: e.id,
    date: e.date,
    type: e.type,
    title: e.title,
    people: e.people ?? [],
    teams: e.teams ?? [],
    tags: e.tags ?? [],
    sources: e.sources,
    follows: e.follows,
    graphs: (e as { graphs?: string[] }).graphs,
    graph: (e as { graph?: string }).graph,
  });
  const all = entries.map(as);
  const scoped = all.filter((e) => entryGraphs(e).includes("default"));
  const referenced = new Set<string>();
  for (const e of scoped) {
    for (const id of e.follows ?? []) referenced.add(id);
    for (const id of e.sources ?? []) referenced.add(id);
  }
  const ghosts = all
    .filter((e) => !entryGraphs(e).includes("default") && referenced.has(e.id))
    .map((e) => ({ ...e, ghost: true }));
  return [...scoped, ...ghosts];
}

/** Synthetic corpus shaped like the real store, for growth testing. */
function synthEntries(n: number): GraphEntry[] {
  const rnd = mulberry32(0xc0ffee);
  const people = Array.from({ length: Math.max(20, Math.round(n * 0.33)) }, (_, i) => `person-${i}`);
  const tags = Array.from({ length: Math.max(40, Math.round(n * 1.35)) }, (_, i) => `tag-${i}`);
  const teams = ["core", "platform", "data"];
  const types = ["note", "meeting", "decision", "todo", "incident"];
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
  const out: GraphEntry[] = [];
  for (let i = 0; i < n; i++) {
    // member counts matched to the real store: median ~9, p95 ~15, max ~26
    const np = 1 + Math.floor(rnd() * rnd() * 12);
    const nt = 1 + Math.floor(rnd() * rnd() * 10);
    out.push({
      id: `s-${i}`,
      date: "2026-01-01",
      type: pick(types),
      title: `synthetic ${i}`,
      people: [...new Set(Array.from({ length: np }, () => pick(people)))],
      tags: [...new Set(Array.from({ length: nt }, () => pick(tags)))],
      teams: rnd() < 0.3 ? [pick(teams)] : [],
    });
  }
  return out;
}

const entries = synth > 0 ? synthEntries(synth) : scopeToDefault(await loadAllEntries());

const rows: Record<string, unknown>[] = [];

for (const mode of modes) {
  const types: Record<NodeKind, boolean> = presetTypes(mode);
  const minTagDegree = mode === "topics" ? 2 : 1;

  const tBuild = time(10, () => void buildGraph(entries));
  const model = buildGraph(entries);
  const tProject = time(10, () => void projectGraph(model, types, {}, { minTagDegree }));
  const proj = projectGraph(model, types, {}, { minTagDegree });

  const nodes = proj.nodes;
  const edges = proj.edges;
  for (const n of nodes) n.links = 0;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const e of edges) {
    const a = byId.get(e.a);
    const b = byId.get(e.b);
    if (a) a.links++;
    if (b) b.links++;
  }

  // edge composition
  let co = 0, membership = 0, chain = 0;
  const hist = { w1: 0, w2: 0, w3to5: 0, w6plus: 0 };
  for (const e of edges) {
    const ka = byId.get(e.a)?.kind;
    const kb = byId.get(e.b)?.kind;
    if (e.chain) chain++;
    else if (ka === "entry" || kb === "entry") membership++;
    else {
      co++;
      if (e.weight === 1) hist.w1++;
      else if (e.weight === 2) hist.w2++;
      else if (e.weight <= 5) hist.w3to5++;
      else hist.w6plus++;
    }
  }

  initPositions(nodes, new Map());
  const sim = createSim(nodes, edges);

  if (process.argv.includes("--trace")) {
    // watch the layout settle: a bbox that keeps growing means the containment
    // force is losing to repulsion, which shows up as a collapsing frame rate
    let alpha = 1;
    console.log(`\n  ${mode}: tick   bbox            ms/tick`);
    for (let t = 0; t <= 150; t++) {
      const t0 = performance.now();
      sim.step(alpha);
      const ms = performance.now() - t0;
      alpha *= 0.985;
      if (t % 15 === 0 || t === 150) {
        sim.writeBack(nodes);
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const n of nodes) {
          x0 = Math.min(x0, n.x); x1 = Math.max(x1, n.x);
          y0 = Math.min(y0, n.y); y1 = Math.max(y1, n.y);
        }
        const w = Math.round(x1 - x0), h = Math.round(y1 - y0);
        console.log(`  ${String(t).padStart(9)}  ${String(w).padStart(7)} x ${String(h).padStart(7)}  ${ms.toFixed(1)}`);
      }
    }
    initPositions(nodes, new Map());
  }

  for (let i = 0; i < 5; i++) sim.step(0.5); // settle a little first
  const msPerTick = time(ticks, () => sim.step(0.5));

  const degrees = nodes.map((n) => n.links).sort((a, b) => a - b);

  rows.push({
    mode,
    entries: entries.length,
    nodes: nodes.length,
    entityNodes: nodes.filter((n) => n.kind !== "entry").length,
    entryNodes: nodes.filter((n) => n.kind === "entry").length,
    edges: edges.length,
    co,
    membership,
    chain,
    ...hist,
    maxDeg: degrees[degrees.length - 1] ?? 0,
    medDeg: degrees[degrees.length >> 1] ?? 0,
    buildMs: +tBuild.toFixed(2),
    projectMs: +tProject.toFixed(2),
    msPerTick: +msPerTick.toFixed(3),
    msPerFrame: +(msPerTick * 3).toFixed(2),
    fps: +(1000 / (msPerTick * 3)).toFixed(1),
    pairsIfNaive: nodes.length * (nodes.length - 1),
  });
}

if (asJson) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  const label = synth > 0 ? `synthetic ${synth} entries` : `real store, default graph`;
  console.log(`\ngraph bench — ${label}\n`);
  for (const r of rows) {
    console.log(`  ${String(r.mode).padEnd(8)} ${r.nodes} nodes (${r.entityNodes} entity / ${r.entryNodes} entry), ${r.edges} edges`);
    console.log(`  ${"".padEnd(8)}   edges: ${r.co} co-occurrence · ${r.membership} membership · ${r.chain} chain`);
    console.log(`  ${"".padEnd(8)}   co weights: w1=${r.w1} w2=${r.w2} w3-5=${r.w3to5} w6+=${r.w6plus}`);
    console.log(`  ${"".padEnd(8)}   degree: max ${r.maxDeg}, median ${r.medDeg}`);
    console.log(`  ${"".padEnd(8)}   buildGraph ${r.buildMs}ms · projectGraph ${r.projectMs}ms`);
    console.log(`  ${"".padEnd(8)}   sim: ${r.msPerTick} ms/tick · ${r.msPerFrame} ms/frame(x3) · ${r.fps} fps`);
    console.log(`  ${"".padEnd(8)}   (all-pairs would be ${Number(r.pairsIfNaive).toLocaleString()} interactions/tick)\n`);
  }
}
