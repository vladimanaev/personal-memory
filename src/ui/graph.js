// @ts-check
/**
 * memory graph — force-directed node-link view of the store.
 * Nodes are entries, people, tags, and teams; edges are membership
 * (entry ↔ entity) plus summary→source links. With entry nodes hidden,
 * entities are linked directly by weighted co-occurrence (shared entries).
 * Hand-rolled SVG + a tiny deterministic simulation — no dependencies.
 *
 * @typedef {{ id: string, date: string, type: string, title: string,
 *             people: string[], teams: string[], tags: string[],
 *             sources?: string[] }} GraphEntry
 *
 * @typedef {"person"|"tag"|"team"|"entry"} NodeKind
 * @typedef {"people"|"topics"|"entries"|"custom"} GraphMode
 *
 * @typedef {Object} GNode
 * @property {string} id namespaced: e:<entry-id> p:<person> t:<tag> m:<team>
 * @property {NodeKind} kind
 * @property {string} label
 * @property {string} etype entry type (entry nodes only; "" for entities)
 * @property {number} deg
 * @property {number} r
 * @property {number} links edge count in the current projection (spring normalizer)
 * @property {string[]} entryIds backing entries (entities only)
 * @property {number} x
 * @property {number} y
 * @property {number} vx
 * @property {number} vy
 * @property {number|null} fx
 * @property {number|null} fy
 *
 * @typedef {{ a: string, b: string, weight: number }} GEdge
 */

const W = 1200;
const H = 800;
const PAD = 34;

/** @type {{ kind: NodeKind, plural: string }[]} */
const KINDS = [
  { kind: "person", plural: "people" },
  { kind: "tag", plural: "tags" },
  { kind: "team", plural: "teams" },
  { kind: "entry", plural: "entries" },
];

// view state survives route switches so the graph doesn't rearrange on return
const gstate = {
  /** @type {GraphMode} */
  mode: "people",
  /** @type {Record<NodeKind, boolean>} */
  types: { person: true, tag: false, team: true, entry: true },
  /** entry-type filter — only an explicit false hides, so new types stay visible */
  /** @type {Record<string, boolean>} */
  entryTypes: {},
  tagFilter: "",
  q: "",
  /** @type {string|null} */
  selected: null,
  /** @type {Map<string, { x: number, y: number }>} */
  lastPos: new Map(),
  /** camera: world coords are scaled by k then shifted by tx/ty */
  view: { k: 1, tx: 0, ty: 0 },
};

const K_MIN = 0.4;
const K_MAX = 8;

// ---------- helpers ----------

/** @param {unknown} s */
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

/** @param {string} s @param {number} [n] */
function trunc(s, n = 18) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** @param {string} str 32-bit FNV-1a — stable per-node seed */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** @param {number} seed deterministic PRNG */
function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function reducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** @param {Exclude<GraphMode, "custom">} mode @returns {Record<NodeKind, boolean>} */
function presetTypes(mode) {
  if (mode === "topics") return { person: false, tag: true, team: false, entry: false };
  if (mode === "entries") return { person: true, tag: false, team: false, entry: true };
  return { person: true, tag: false, team: true, entry: true };
}

/** @param {GraphMode} mode */
function modeLabel(mode) {
  return mode === "people" ? "people" : mode === "topics" ? "topics" : mode === "entries" ? "entries" : "custom";
}

// ---------- graph model ----------

/**
 * @param {GraphEntry[]} entries
 * @returns {{ nodes: Map<string, GNode>, edges: GEdge[], memberships: string[][] }}
 */
function buildGraph(entries) {
  /** @type {Map<string, GNode>} */
  const nodes = new Map();
  /** @type {GEdge[]} */
  const edges = [];
  /** membership lists per entry (entity node ids) — feeds co-occurrence mode */
  /** @type {string[][]} */
  const memberships = [];
  const entryIds = new Set(entries.map((e) => e.id));

  /** @param {string} id @param {NodeKind} kind @param {string} label */
  const ensure = (id, kind, label) => {
    let n = nodes.get(id);
    if (!n) {
      n = { id, kind, label, etype: "", deg: 0, r: 4, links: 0, entryIds: [], x: 0, y: 0, vx: 0, vy: 0, fx: null, fy: null };
      nodes.set(id, n);
    }
    return n;
  };

  for (const e of entries) {
    const en = ensure(`e:${e.id}`, "entry", e.title);
    en.etype = e.type;
    /** @type {string[]} */
    const members = [];
    /** @param {string[]} slugs @param {"p"|"t"|"m"} ns @param {NodeKind} kind */
    const link = (slugs, ns, kind) => {
      for (const s of slugs) {
        const node = ensure(`${ns}:${s}`, kind, s);
        node.deg++;
        node.entryIds.push(e.id);
        members.push(node.id);
        edges.push({ a: en.id, b: node.id, weight: 1 });
        en.deg++;
      }
    };
    link(e.people, "p", "person");
    link(e.tags, "t", "tag");
    link(e.teams, "m", "team");
    if (e.type === "summary" && e.sources) {
      for (const s of e.sources) {
        if (!entryIds.has(s)) continue; // dangling back-link
        edges.push({ a: en.id, b: `e:${s}`, weight: 1 });
        en.deg++;
      }
    }
    memberships.push(members);
  }

  for (const n of nodes.values()) {
    n.r = n.kind === "entry" ? 4.5 : Math.min(20, Math.max(5, 5 + 2.6 * Math.sqrt(n.deg)));
  }
  return { nodes, edges, memberships };
}

/**
 * Project the full model onto the enabled node kinds. Direct entity↔entity
 * co-occurrence links (weighted by shared entries) are always present — the
 * entries chip only adds/removes the entry-node layer and its membership edges.
 * @param {{ nodes: Map<string, GNode>, edges: GEdge[], memberships: string[][] }} model
 * @param {Record<NodeKind, boolean>} types
 * @param {Record<string, boolean>} entryTypes
 * @param {{ minTagDegree?: number, keepTag?: string }} [opts]
 * @returns {{ nodes: GNode[], edges: GEdge[], hasCo: boolean }}
 */
function projectGraph(model, types, entryTypes, opts = {}) {
  const visible = [...model.nodes.values()].filter(
    (n) =>
      types[n.kind] &&
      (n.kind !== "entry" || entryTypes[n.etype] !== false) &&
      (n.kind !== "tag" || n.deg >= (opts.minTagDegree ?? 1) || n.label === opts.keepTag),
  );
  const ids = new Set(visible.map((n) => n.id));
  /** @type {Map<string, GEdge>} */
  const co = new Map();
  for (const members of model.memberships) {
    const vis = members.filter((id) => ids.has(id));
    for (let i = 0; i < vis.length; i++) {
      for (let j = i + 1; j < vis.length; j++) {
        const a = /** @type {string} */ (vis[i]);
        const b = /** @type {string} */ (vis[j]);
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        const edge = co.get(key);
        if (edge) edge.weight++;
        else co.set(key, { a, b, weight: 1 });
      }
    }
  }
  const edges = [...co.values()];
  if (types.entry) edges.push(...model.edges.filter((e) => ids.has(e.a) && ids.has(e.b)));
  return { nodes: visible, edges, hasCo: co.size > 0 };
}

// ---------- simulation ----------

/** @param {GNode[]} nodes seeded/warm-started, iterated in sorted-id order for determinism */
function initPositions(nodes) {
  for (const n of [...nodes].sort((a, b) => a.id.localeCompare(b.id))) {
    const p = gstate.lastPos.get(n.id);
    if (p) {
      n.x = p.x;
      n.y = p.y;
    } else {
      const rnd = mulberry32(fnv1a(n.id));
      const th = rnd() * Math.PI * 2;
      const rad = 60 + rnd() * Math.min(W, H) * 0.34;
      n.x = W / 2 + Math.cos(th) * rad;
      n.y = H / 2 + Math.sin(th) * rad;
    }
    n.vx = 0;
    n.vy = 0;
  }
}

/**
 * One tick: pairwise repulsion (O(n²), fine ≤ ~400 nodes), link springs,
 * weak centering, collision push, damped integration. Pinned nodes (fx/fy)
 * follow the pointer instead.
 * @param {GNode[]} nodes @param {GEdge[]} edges @param {Map<string, GNode>} byId
 * @param {number} alpha
 */
function simStep(nodes, edges, byId, alpha) {
  for (let i = 0; i < nodes.length; i++) {
    const a = /** @type {GNode} */ (nodes[i]);
    for (let j = i + 1; j < nodes.length; j++) {
      const b = /** @type {GNode} */ (nodes[j]);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d2 = Math.max(dx * dx + dy * dy, 36);
      const d = Math.sqrt(d2);
      // radius-scaled charge: hubs repel far harder than leaves, which keeps
      // the high-degree clique at the core from collapsing into a puck
      const push = (70 * a.r * b.r * alpha) / d2;
      const ux = dx / d;
      const uy = dy / d;
      a.vx -= push * ux;
      a.vy -= push * uy;
      b.vx += push * ux;
      b.vy += push * uy;
    }
  }
  for (const e of edges) {
    const a = byId.get(e.a);
    const b = byId.get(e.b);
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
    // spring strength is normalized by the smaller endpoint's link count
    // (the d3-force trick) — otherwise hub nodes' many springs overwhelm
    // repulsion and contract the core into a puck
    const isCo = a.kind !== "entry" && b.kind !== "entry"; // direct entity link
    const rest = isCo ? 120 + 40 / e.weight : a.kind === "entry" && b.kind === "entry" ? 110 : 85;
    const s = 1 / Math.max(1, Math.min(a.links, b.links));
    const f = 0.08 * s * alpha * (d - rest);
    const ux = dx / d;
    const uy = dy / d;
    a.vx += f * ux;
    a.vy += f * uy;
    b.vx -= f * ux;
    b.vy -= f * uy;
  }
  for (const n of nodes) {
    n.vx += (W / 2 - n.x) * 0.008 * alpha;
    n.vy += (H / 2 - n.y) * 0.008 * alpha;
  }
  for (let i = 0; i < nodes.length; i++) {
    const a = /** @type {GNode} */ (nodes[i]);
    for (let j = i + 1; j < nodes.length; j++) {
      const b = /** @type {GNode} */ (nodes[j]);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.max(Math.sqrt(dx * dx + dy * dy), 0.01);
      const min = a.r + b.r + 14;
      if (d < min) {
        const shift = (min - d) / 2;
        const ux = dx / d;
        const uy = dy / d;
        a.x -= shift * ux;
        a.y -= shift * uy;
        b.x += shift * ux;
        b.y += shift * uy;
      }
    }
  }
  for (const n of nodes) {
    if (n.fx !== null && n.fy !== null) {
      n.x = n.fx;
      n.y = n.fy;
      n.vx = 0;
      n.vy = 0;
      continue;
    }
    n.vx *= 0.85;
    n.vy *= 0.85;
    n.x = Math.min(W - PAD, Math.max(PAD, n.x + n.vx));
    n.y = Math.min(H - PAD, Math.max(PAD, n.y + n.vy));
  }
}

/** rescale settled positions to fill the viewBox — the zoom/pan substitute
 * @param {GNode[]} nodes */
function fitToView(nodes) {
  if (nodes.length === 0) return;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) {
    x0 = Math.min(x0, n.x - n.r);
    y0 = Math.min(y0, n.y - n.r);
    x1 = Math.max(x1, n.x + n.r);
    y1 = Math.max(y1, n.y + n.r + 14); // room for the label line
  }
  const s = Math.min((W - 2 * PAD) / Math.max(x1 - x0, 1), (H - 2 * PAD) / Math.max(y1 - y0, 1), 1.5);
  const ox = (W - (x1 - x0) * s) / 2 - x0 * s;
  const oy = (H - (y1 - y0) * s) / 2 - y0 * s;
  for (const n of nodes) {
    n.x = n.x * s + ox;
    n.y = n.y * s + oy;
  }
}

// ---------- markup ----------

/** 12×12 legend glyph per kind, currentColor — the chips double as the legend
 * @param {NodeKind} kind */
function glyph(kind) {
  const shape =
    kind === "person"
      ? `<circle cx="6" cy="6" r="4.2" fill="currentColor"/>`
      : kind === "tag"
        ? `<circle cx="6" cy="6" r="3.6" fill="none" stroke="currentColor" stroke-width="1.6"/>`
        : kind === "team"
          ? `<rect x="1.8" y="1.8" width="8.4" height="8.4" rx="2" fill="currentColor"/>`
          : `<circle cx="6" cy="6" r="2.4" fill="currentColor"/>`;
  return `<svg class="gglyph" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">${shape}</svg>`;
}

/** @param {GNode} n @param {boolean} labeled */
function nodeMarkup(n, labeled) {
  const tip =
    n.kind === "entry"
      ? `${n.label} — ${n.etype}`
      : `${n.label} — ${n.kind} — ${n.deg} entr${n.deg === 1 ? "y" : "ies"}`;
  const shape =
    n.kind === "team"
      ? `<rect class="nshape" x="${-n.r}" y="${-n.r}" width="${2 * n.r}" height="${2 * n.r}" rx="3"/>`
      : `<circle class="nshape" r="${n.r}"/>`;
  const label = `<text class="glabel" y="${n.r + 12}" text-anchor="middle">${esc(trunc(n.label))}</text>`;
  const typeClass = n.kind === "entry" && n.etype !== "" ? ` gt-${n.etype}` : "";
  return `<g class="gnode gn-${n.kind}${typeClass}${labeled ? " has-label" : ""}" data-node="${esc(n.id)}" tabindex="0" role="button"
    data-tip="${esc(tip)}" aria-label="${esc(tip)}">${shape}${label}</g>`;
}

// ---------- view ----------

/**
 * @param {HTMLElement} mainEl
 * @param {GraphEntry[]} entries
 * @param {{ typeOrder?: string[], openEntry?: (id: string) => void }} [opts]
 *   typeOrder: canonical entry-type display order (app.js TYPE_ORDER)
 */
export function renderGraphView(mainEl, entries, opts = {}) {
  const typeOrder = opts.typeOrder ?? [];
  const openEntry = opts.openEntry ?? ((id) => {
    location.hash = `#/entry/${encodeURIComponent(id)}`;
  });
  if (entries.length === 0) {
    mainEl.innerHTML = `<div class="empty">the record is empty — log a first memory with <code>memory add</code> or <code>/remember</code>, then run <code>memory index</code></div>`;
    return;
  }

  const entryByRawId = new Map(entries.map((e) => [e.id, e]));

  /** @param {(e: GraphEntry) => string[]} pick */
  const countValues = (pick) => {
    /** @type {Map<string, number>} */
    const counts = new Map();
    for (const e of entries) for (const v of pick(e)) counts.set(v, (counts.get(v) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  };
  const tagCounts = countValues((e) => e.tags);

  /** @returns {GraphEntry[]} */
  const graphEntries = () =>
    gstate.tagFilter ? entries.filter((e) => e.tags.includes(gstate.tagFilter)) : entries;

  /** @param {GraphEntry[]} scoped */
  const typeCountsFor = (scoped) => {
    /** @type {Map<string, number>} */
    const counts = new Map();
    for (const e of scoped) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
    return counts;
  };

  /** @type {Record<NodeKind, number>} */
  const kindCounts = { person: 0, tag: 0, team: 0, entry: 0 };
  const initialModel = buildGraph(entries);
  for (const n of initialModel.nodes.values()) kindCounts[n.kind]++;

  /** @param {Record<NodeKind, number>} counts */
  const kindChips = (counts) => KINDS.map(
    ({ kind, plural }) =>
      `<button class="chip gtype" data-kind="${kind}" aria-pressed="${gstate.types[kind]}">${glyph(kind)}${plural}<span class="n">${counts[kind]}</span></button>`,
  ).join("");
  const modeButtons = /** @type {Exclude<GraphMode, "custom">[]} */ (["people", "topics", "entries"])
    .map((mode) => `<button class="gmode" data-mode="${mode}" aria-pressed="${gstate.mode === mode}">${mode}</button>`)
    .join("");
  const tagSelect = `
        <label class="gtag-control">
          <span class="k">tag</span>
          <select id="gtag" aria-label="filter graph by tag">
            <option value="">all tags</option>
            ${tagCounts
              .map(
                ([tag, n]) =>
                  `<option value="${esc(tag)}" ${gstate.tagFilter === tag ? "selected" : ""}>${esc(tag)} (${n})</option>`,
              )
              .join("")}
          </select>
        </label>`;
  const typeLegend = `
        <div class="gtypelegend" id="gtypelegend" role="group" aria-label="filter entry types" hidden>
          <span class="k">entry types</span>
          <div class="chips gchips" id="gtypes"></div>
        </div>`;
  const canvas = `
      <div class="graph-canvas">
        <svg id="gcanvas" viewBox="0 0 ${W} ${H}" role="group" aria-label="memory graph">
          <g id="gview">
            <g id="gedges"></g>
            <g id="gnodes"></g>
          </g>
        </svg>
        <div class="gzoom">
          <button class="gzbtn" id="gz-in" aria-label="zoom in">+</button>
          <button class="gzbtn" id="gz-out" aria-label="zoom out">−</button>
          <button class="gzbtn" id="gz-fit" aria-label="reset zoom">fit</button>
        </div>
        <div class="graph-detail" id="graph-detail"></div>
        <div class="gempty" id="gempty" hidden>nothing to show — enable a node type</div>
      </div>`;

  mainEl.innerHTML = `
    <div class="graph-layout">
      <div class="graph-toolbar">
        <div class="graph-filters">
          <div class="gpresets" role="group" aria-label="graph view">${modeButtons}</div>
          ${tagSelect}
          <div class="chips gchips" role="group" aria-label="filter node types">${kindChips(kindCounts)}</div>
          ${typeLegend}
        </div>
        <div class="gsum" id="gsum"></div>
      </div>
      ${canvas}
    </div>`;

  const svg = /** @type {SVGSVGElement} */ (/** @type {unknown} */ (mainEl.querySelector("#gcanvas")));
  const viewG = /** @type {SVGGElement} */ (/** @type {unknown} */ (mainEl.querySelector("#gview")));
  const edgesG = /** @type {SVGGElement} */ (/** @type {unknown} */ (mainEl.querySelector("#gedges")));
  const nodesG = /** @type {SVGGElement} */ (/** @type {unknown} */ (mainEl.querySelector("#gnodes")));
  const sumEl = /** @type {HTMLElement} */ (mainEl.querySelector("#gsum"));
  const emptyEl = /** @type {HTMLElement} */ (mainEl.querySelector("#gempty"));
  const detailEl = /** @type {HTMLElement} */ (mainEl.querySelector("#graph-detail"));
  const legendEl = /** @type {HTMLElement} */ (mainEl.querySelector("#gtypelegend"));
  const typesEl = /** @type {HTMLElement} */ (mainEl.querySelector("#gtypes"));

  // current projection + element refs (rebuilt on chip toggles)
  /** @type {GNode[]} */
  let nodes = [];
  /** @type {GEdge[]} */
  let edges = [];
  let hasCo = false;
  /** @type {Map<string, GNode>} */
  let byId = new Map();
  /** @type {Map<string, Element>} */
  let nodeEls = new Map();
  /** @type {Element[]} */
  let edgeEls = [];
  /** @type {Map<string, Set<string>>} */
  let neighbors = new Map();

  let raf = 0;
  let alpha = 0;
  /** @type {string|null} */
  let draggingId = null;

  function draw() {
    for (const n of nodes) {
      const el = nodeEls.get(n.id);
      if (el) el.setAttribute("transform", `translate(${n.x.toFixed(1)} ${n.y.toFixed(1)})`);
    }
    for (let i = 0; i < edges.length; i++) {
      const e = /** @type {GEdge} */ (edges[i]);
      const el = edgeEls[i];
      const a = byId.get(e.a);
      const b = byId.get(e.b);
      if (!el || !a || !b) continue;
      el.setAttribute("x1", a.x.toFixed(1));
      el.setAttribute("y1", a.y.toFixed(1));
      el.setAttribute("x2", b.x.toFixed(1));
      el.setAttribute("y2", b.y.toFixed(1));
    }
  }

  function savePos() {
    for (const n of nodes) gstate.lastPos.set(n.id, { x: n.x, y: n.y });
  }

  /** @param {number} n */
  function tickTimes(n) {
    for (let i = 0; i < n && alpha > 0.02; i++) {
      simStep(nodes, edges, byId, alpha);
      alpha *= 0.985;
    }
  }

  /** @param {{ alpha?: number, fit?: boolean }} [opts] */
  function startSim(opts = {}) {
    alpha = opts.alpha ?? 1;
    const fit = opts.fit !== false;
    cancelAnimationFrame(raf);
    if (reducedMotion()) {
      tickTimes(300);
      if (fit) fitToView(nodes);
      draw();
      savePos();
      return;
    }
    const loop = () => {
      if (!svg.isConnected) return; // view was replaced mid-animation
      tickTimes(3);
      draw();
      if (alpha > 0.02) {
        raf = requestAnimationFrame(loop);
      } else {
        if (fit && draggingId === null) {
          fitToView(nodes);
          draw();
        }
        savePos();
      }
    };
    raf = requestAnimationFrame(loop);
  }

  function updateHighlights() {
    const q = gstate.q.trim().toLowerCase();
    const sel = gstate.selected;
    const hood = sel ? (neighbors.get(sel) ?? new Set()) : null;
    /** @type {Set<string>} */
    const hitIds = new Set();
    for (const n of nodes) {
      const el = nodeEls.get(n.id);
      if (!el) continue;
      const hit = q !== "" && n.label.toLowerCase().includes(q);
      const hot = sel !== null && (n.id === sel || hood?.has(n.id) === true);
      const dim = (q !== "" && !hit) || (sel !== null && !hot);
      if (hit) hitIds.add(n.id);
      el.classList.toggle("is-hit", hit);
      el.classList.toggle("is-hot", hot);
      el.classList.toggle("is-dim", dim);
    }
    for (let i = 0; i < edges.length; i++) {
      const e = /** @type {GEdge} */ (edges[i]);
      const el = edgeEls[i];
      if (!el) continue;
      const hot = sel !== null && (e.a === sel || e.b === sel);
      const searchDim = q !== "" && (!hitIds.has(e.a) || !hitIds.has(e.b));
      el.classList.toggle("is-hot", hot);
      el.classList.toggle("is-dim", searchDim || (sel !== null && !hot));
    }
  }

  function renderDetail() {
    const n = gstate.selected ? byId.get(gstate.selected) : null;
    if (!n || n.kind === "entry") {
      detailEl.hidden = true;
      detailEl.innerHTML = "";
      return;
    }
    detailEl.hidden = false;
    const rows = [...new Set(n.entryIds)]
      .map((id) => entryByRawId.get(id))
      .filter((e) => e !== undefined)
      .sort((a, b) => b.date.localeCompare(a.date))
      .map(
        (e) =>
          `<a class="gentry" href="#/entry/${encodeURIComponent(e.id)}"><span class="gdate">${esc(e.date)}</span><span class="badge tdot gt-${esc(e.type)}">${esc(e.type)}</span>${esc(trunc(e.title, 34))}</a>`,
      )
      .join("");
    detailEl.innerHTML = `
      <div class="gdetail-head">
        <div>
          <span class="k">${esc(n.kind)}</span>
          <div class="gname">${esc(n.label)}</div>
        </div>
        <button class="gzbtn gclose" type="button" aria-label="close details">×</button>
      </div>
      <div class="gcount">${n.deg} entr${n.deg === 1 ? "y" : "ies"}</div>
      <div class="gentries">${rows}</div>`;
  }

  /** the type legend filters entry nodes only — hidden while the entry layer is off */
  /** @param {GraphEntry[]} scoped */
  function renderTypeLegend(scoped) {
    const typeCounts = typeCountsFor(scoped);
    const typeList = [
      ...typeOrder.filter((t) => typeCounts.has(t)),
      ...[...typeCounts.keys()].filter((t) => !typeOrder.includes(t)),
    ];
    legendEl.hidden = !gstate.types.entry;
    typesEl.innerHTML = typeList
      .map(
        (t) =>
          `<button class="chip gtchip gt-${esc(t)}" data-etype="${esc(t)}" aria-pressed="${gstate.entryTypes[t] !== false}">
            <svg class="gglyph" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="2.8" fill="currentColor"/></svg>${esc(t)}<span class="n">${typeCounts.get(t)}</span>
          </button>`,
      )
      .join("");
  }

  /** @param {{ nodes: Map<string, GNode> }} model */
  function syncToolbar(model) {
    /** @type {Record<NodeKind, number>} */
    const counts = { person: 0, tag: 0, team: 0, entry: 0 };
    for (const n of model.nodes.values()) counts[n.kind]++;
    for (const { kind } of KINDS) {
      const chip = mainEl.querySelector(`.gtype[data-kind="${kind}"]`);
      chip?.setAttribute("aria-pressed", String(gstate.types[kind]));
      const n = chip?.querySelector(".n");
      if (n) n.textContent = String(counts[kind]);
    }
    mainEl.querySelectorAll(".gmode").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.getAttribute("data-mode") === gstate.mode));
    });
    const tag = mainEl.querySelector("#gtag");
    if (tag instanceof HTMLSelectElement && tag.value !== gstate.tagFilter) tag.value = gstate.tagFilter;
  }

  /** @param {GNode[]} ns */
  function labelSet(ns) {
    const kind = gstate.mode === "topics" ? "tag" : "person";
    const limit = gstate.mode === "topics" ? 14 : 12;
    return new Set(
      ns
        .filter((n) => n.kind === kind)
        .sort((a, b) => b.deg - a.deg || b.links - a.links || a.label.localeCompare(b.label))
        .slice(0, limit)
        .map((n) => n.id),
    );
  }

  /** rebuild the projection + SVG contents (initial render and chip toggles) */
  function refresh() {
    const scopedEntries = graphEntries();
    const model = buildGraph(scopedEntries);
    const proj = projectGraph(model, gstate.types, gstate.entryTypes, {
      minTagDegree: gstate.mode === "topics" ? 2 : 1,
      keepTag: gstate.tagFilter,
    });
    nodes = proj.nodes;
    edges = proj.edges;
    hasCo = proj.hasCo;
    byId = new Map(nodes.map((n) => [n.id, n]));
    if (gstate.selected && !byId.has(gstate.selected)) gstate.selected = null;

    for (const n of nodes) n.links = 0;
    for (const e of edges) {
      const a = byId.get(e.a);
      const b = byId.get(e.b);
      if (a) a.links++;
      if (b) b.links++;
    }

    neighbors = new Map();
    for (const e of edges) {
      let sa = neighbors.get(e.a);
      if (!sa) neighbors.set(e.a, (sa = new Set()));
      let sb = neighbors.get(e.b);
      if (!sb) neighbors.set(e.b, (sb = new Set()));
      sa.add(e.b);
      sb.add(e.a);
    }

    const labeled = labelSet(nodes);
    /** an edge wears the hue of its most salient endpoint kind
     * @param {GEdge} e @returns {NodeKind} */
    const edgeKind = (e) => {
      const ka = byId.get(e.a)?.kind ?? "entry";
      const kb = byId.get(e.b)?.kind ?? "entry";
      for (const k of /** @type {NodeKind[]} */ (["person", "team", "tag"])) {
        if (ka === k || kb === k) return k;
      }
      return "entry";
    };
    edgesG.innerHTML = edges
      .map(
        (e, i) =>
          `<line class="gedge ge-${edgeKind(e)}" data-edge="${i}" stroke-width="${
            byId.get(e.a)?.kind !== "entry" && byId.get(e.b)?.kind !== "entry"
              ? Math.min(1 + 0.6 * (e.weight - 1), 3).toFixed(1)
              : "1"
          }"/>`,
      )
      .join("");
    nodesG.innerHTML = nodes.map((n) => nodeMarkup(n, labeled.has(n.id))).join("");
    nodeEls = new Map();
    for (const el of nodesG.querySelectorAll(".gnode")) {
      const id = el.getAttribute("data-node");
      if (id) nodeEls.set(id, el);
    }
    edgeEls = [...edgesG.querySelectorAll(".gedge")];

    emptyEl.hidden = nodes.length > 0;
    const scope = gstate.tagFilter ? ` · #${gstate.tagFilter}` : "";
    sumEl.textContent = `${modeLabel(gstate.mode)}${scope} · ${scopedEntries.length} entries · ${nodes.length} nodes · ${edges.length} links${
      hasCo ? " · shared entries" : ""
    }`;

    syncToolbar(model);
    renderTypeLegend(scopedEntries);
    initPositions(nodes);
    updateHighlights();
    renderDetail();
    draw();
    // cold start settles from alpha 1; warm starts (positions cached) need less
    const warm = nodes.length > 0 && nodes.every((n) => gstate.lastPos.has(n.id));
    if (nodes.length > 0) startSim({ alpha: warm ? 0.5 : 1 });
  }

  // ---------- interactions ----------

  mainEl.querySelectorAll(".gmode").forEach((button) => {
    button.addEventListener("click", () => {
      const mode = /** @type {Exclude<GraphMode, "custom"> | null} */ (button.getAttribute("data-mode"));
      if (mode !== "people" && mode !== "topics" && mode !== "entries") return;
      gstate.mode = mode;
      gstate.types = presetTypes(mode);
      gstate.selected = null;
      refresh();
    });
  });

  const tagSelectEl = mainEl.querySelector("#gtag");
  if (tagSelectEl instanceof HTMLSelectElement) {
    tagSelectEl.addEventListener("change", () => {
      gstate.tagFilter = tagSelectEl.value;
      gstate.selected = null;
      refresh();
    });
  }

  mainEl.querySelectorAll(".gtype").forEach((chip) => {
    chip.addEventListener("click", () => {
      const kind = /** @type {NodeKind} */ (chip.getAttribute("data-kind"));
      gstate.mode = "custom";
      gstate.types[kind] = !gstate.types[kind];
      refresh();
    });
  });

  // delegated: the chips container is re-filled by renderTypeLegend
  typesEl.addEventListener("click", (ev) => {
    const chip = ev.target instanceof Element ? ev.target.closest(".gtchip") : null;
    const t = chip?.getAttribute("data-etype");
    if (!chip || !t) return;
    gstate.entryTypes[t] = gstate.entryTypes[t] === false;
    refresh();
  });

  const qInput = document.getElementById("gq");
  if (qInput instanceof HTMLInputElement) {
    qInput.value = gstate.q;
    qInput.addEventListener("input", () => {
      gstate.q = qInput.value;
      updateHighlights();
    });
  }

  detailEl.addEventListener("click", (ev) => {
    const close = ev.target instanceof Element ? ev.target.closest(".gclose") : null;
    if (!close) return;
    gstate.selected = null;
    updateHighlights();
    renderDetail();
  });

  /** @param {string} id */
  function activate(id) {
    const n = byId.get(id);
    if (!n) return;
    if (n.kind === "entry") {
      openEntry(id.slice(2));
      return;
    }
    gstate.selected = gstate.selected === id ? null : id;
    updateHighlights();
    renderDetail();
  }

  // ---------- camera (wheel zoom, background pan, buttons) ----------

  function applyView() {
    const v = gstate.view;
    viewG.setAttribute("transform", `translate(${v.tx.toFixed(2)} ${v.ty.toFixed(2)}) scale(${v.k.toFixed(3)})`);
  }
  applyView();

  /** outer svg (viewBox) coords for a pointer event */
  /** @param {{ clientX: number, clientY: number }} ev @returns {{ x: number, y: number } | null} */
  function toSvgPoint(ev) {
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  }

  /** world (simulation) coords — the camera transform undone */
  /** @param {{ clientX: number, clientY: number }} ev @returns {{ x: number, y: number } | null} */
  function toWorldPoint(ev) {
    const p = toSvgPoint(ev);
    if (!p) return null;
    const v = gstate.view;
    return { x: (p.x - v.tx) / v.k, y: (p.y - v.ty) / v.k };
  }

  /** zoom by factor f keeping the svg-space point (px,py) fixed */
  /** @param {number} f @param {number} px @param {number} py */
  function zoomBy(f, px, py) {
    const v = gstate.view;
    const k = Math.min(K_MAX, Math.max(K_MIN, v.k * f));
    if (k === v.k) return;
    v.tx = px - ((px - v.tx) / v.k) * k;
    v.ty = py - ((py - v.ty) / v.k) * k;
    v.k = k;
    applyView();
  }

  svg.addEventListener(
    "wheel",
    (ev) => {
      ev.preventDefault();
      const p = toSvgPoint(ev);
      if (p) zoomBy(Math.exp(-ev.deltaY * 0.002), p.x, p.y);
    },
    { passive: false },
  );

  /** @param {string} sel @param {() => void} fn */
  const onClick = (sel, fn) => /** @type {HTMLElement} */ (mainEl.querySelector(sel)).addEventListener("click", fn);
  onClick("#gz-in", () => zoomBy(1.4, W / 2, H / 2));
  onClick("#gz-out", () => zoomBy(1 / 1.4, W / 2, H / 2));
  onClick("#gz-fit", () => {
    gstate.view = { k: 1, tx: 0, ty: 0 };
    applyView();
  });

  let downX = 0;
  let downY = 0;
  let moved = false;
  let panning = false;

  svg.addEventListener("pointerdown", (ev) => {
    downX = ev.clientX;
    downY = ev.clientY;
    moved = false;
    const g = ev.target instanceof Element ? ev.target.closest(".gnode") : null;
    if (g) {
      const id = g.getAttribute("data-node");
      if (!id || !byId.has(id)) return;
      draggingId = id;
    } else {
      panning = true; // background press drags the camera
    }
    svg.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  });

  let lastPan = { x: 0, y: 0 };

  svg.addEventListener("pointermove", (ev) => {
    if (draggingId === null && !panning) return;
    if (!moved && Math.hypot(ev.clientX - downX, ev.clientY - downY) < 4) return;
    if (panning) {
      const p = toSvgPoint(ev);
      if (!p) return;
      if (!moved) lastPan = p;
      moved = true;
      gstate.view.tx += p.x - lastPan.x;
      gstate.view.ty += p.y - lastPan.y;
      lastPan = p;
      applyView();
      return;
    }
    const n = draggingId !== null ? byId.get(draggingId) : undefined;
    const p = toWorldPoint(ev);
    if (!n || !p) return;
    moved = true;
    n.fx = Math.min(W - PAD, Math.max(PAD, p.x));
    n.fy = Math.min(H - PAD, Math.max(PAD, p.y));
    if (reducedMotion()) {
      // no animated re-heat: apply the move with a few synchronous ticks
      alpha = 0.1;
      tickTimes(4);
      draw();
    } else if (alpha <= 0.02) {
      startSim({ alpha: 0.3, fit: false });
    } else {
      alpha = Math.max(alpha, 0.3);
    }
  });

  svg.addEventListener("pointerup", (ev) => {
    const wasDragging = draggingId;
    if (wasDragging !== null) {
      const n = byId.get(wasDragging);
      if (n) {
        n.fx = null;
        n.fy = null;
      }
      draggingId = null;
    }
    panning = false;
    if (svg.hasPointerCapture(ev.pointerId)) svg.releasePointerCapture(ev.pointerId);
    if (moved) {
      if (wasDragging !== null) savePos();
      return;
    }
    if (wasDragging !== null) {
      activate(wasDragging); // clean press on a node = click
    } else if (gstate.selected !== null) {
      gstate.selected = null; // background click deselects
      updateHighlights();
      renderDetail();
    }
  });

  mainEl.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && gstate.selected !== null) {
      gstate.selected = null;
      updateHighlights();
      renderDetail();
      return;
    }
    if (ev.key !== "Enter" && ev.key !== " ") return;
    const g = ev.target instanceof Element ? ev.target.closest(".gnode") : null;
    const id = g?.getAttribute("data-node");
    if (id) {
      ev.preventDefault();
      activate(id);
    }
  });

  refresh();
}
