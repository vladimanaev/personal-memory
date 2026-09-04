// @ts-check
/**
 * Graph view — pure model layer. No DOM, no module state.
 *
 * Entries are projected into a node-link model: nodes are entries, people, tags
 * and teams; edges are membership (entry ↔ entity), summary→source links and
 * `follows` chain links. With entry nodes hidden, entities are linked directly
 * by weighted co-occurrence (shared entries).
 *
 * Everything here is a pure function of its arguments, so it is importable by
 * both the browser (raw ES module) and `node --test`.
 *
 * @typedef {{ id: string, date: string, type: string, title: string,
 *             people: string[], teams: string[], tags: string[],
 *             sources?: string[], follows?: string[],
 *             graphs?: string[], graph?: string, ghost?: boolean,
 *             chain?: { prev: string[], next: string[],
 *                       latest: { id: string, type: string, date: string },
 *                       resolvedBy?: string, status?: "open"|"resolved",
 *                       dangling?: string[] } }} GraphEntry
 *
 * @typedef {"person"|"tag"|"team"|"entry"} NodeKind
 * @typedef {"people"|"topics"|"entries"|"custom"} GraphMode
 *
 * @typedef {Object} GNode
 * @property {string} id namespaced: e:<entry-id> p:<person> t:<tag> m:<team>
 * @property {NodeKind} kind
 * @property {string} label
 * @property {string} etype entry type (entry nodes only; "" for entities)
 * @property {boolean} ghost entry from another graph shown in the private view for a cross-graph edge
 * @property {string} gmemb ghost's non-private memberships, comma-joined (ghost nodes only)
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
 * @typedef {{ a: string, b: string, weight: number, chain?: boolean }} GEdge
 *
 * @typedef {{ nodes: Map<string, GNode>, edges: GEdge[], memberships: string[][] }} GraphModel
 */

/** @type {{ kind: NodeKind, plural: string }[]} */
export const KINDS = [
  { kind: "person", plural: "people" },
  { kind: "tag", plural: "tags" },
  { kind: "team", plural: "teams" },
  { kind: "entry", plural: "entries" },
];

/** how many tag labels the topics view draws */
export const MAX_TOPIC_LABELS = 14;

// ---------- small helpers ----------

/** @param {unknown} s */
export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

/** @param {string} s @param {number} [n] */
export function trunc(s, n = 18) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** An entry's graph memberships, tolerating the pre-multigraph shape.
 * @param {GraphEntry} e @returns {string[]} */
export function entryGraphs(e) {
  return e.graphs ?? [e.graph === "private" ? "default" : (e.graph ?? "default")];
}

/** @param {Exclude<GraphMode, "custom">} mode @returns {Record<NodeKind, boolean>} */
export function presetTypes(mode) {
  if (mode === "topics") return { person: false, tag: true, team: false, entry: false };
  if (mode === "entries") return { person: true, tag: false, team: false, entry: true };
  return { person: true, tag: false, team: true, entry: true };
}

/** @param {GraphMode} mode */
export function modeLabel(mode) {
  return mode === "people" ? "people" : mode === "topics" ? "topics" : mode === "entries" ? "entries" : "custom";
}

/** hover/aria text for a node — shared by the tooltip and the a11y mirror list
 * @param {GNode} n */
export function nodeTip(n) {
  return n.kind === "entry"
    ? `${n.label} — ${n.etype}${n.ghost ? ` · ${n.gmemb} graph` : ""}`
    : `${n.label} — ${n.kind} — ${n.deg} entr${n.deg === 1 ? "y" : "ies"}`;
}

// ---------- graph model ----------

/**
 * @param {GraphEntry[]} entries
 * @returns {GraphModel}
 */
export function buildGraph(entries) {
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
      n = { id, kind, label, etype: "", ghost: false, gmemb: "", deg: 0, r: 4, links: 0, entryIds: [], x: 0, y: 0, vx: 0, vy: 0, fx: null, fy: null };
      nodes.set(id, n);
    }
    return n;
  };

  for (const e of entries) {
    const en = ensure(`e:${e.id}`, "entry", e.title);
    en.etype = e.type;
    // ghost = an entry from another graph surfaced only so a private chain edge
    // has a target; it contributes its entry node alone, no memberships/co-occurrence
    if (e.ghost) {
      en.ghost = true;
      en.gmemb = entryGraphs(e).filter((g) => g !== "default").join(", ") || "other";
      continue;
    }
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
    if (e.follows) {
      for (const f of e.follows) {
        if (!entryIds.has(f)) continue; // dangling chain link
        edges.push({ a: en.id, b: `e:${f}`, weight: 1, chain: true });
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
 * @param {GraphModel} model
 * @param {Record<NodeKind, boolean>} types
 * @param {Record<string, boolean>} entryTypes
 * @param {{ minTagDegree?: number, keepTag?: string }} [opts]
 * @returns {{ nodes: GNode[], edges: GEdge[], hasCo: boolean }}
 */
export function projectGraph(model, types, entryTypes, opts = {}) {
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

/**
 * Which nodes carry a persistent label. People/entries views label every person;
 * the topics view labels only the strongest tags (labels there would otherwise
 * cover the whole canvas).
 * @param {GNode[]} ns @param {GraphMode} mode @param {number} [limit]
 * @returns {Set<string>}
 */
export function labelSet(ns, mode, limit = MAX_TOPIC_LABELS) {
  if (mode !== "topics") {
    return new Set(ns.filter((n) => n.kind === "person").map((n) => n.id));
  }
  return new Set(
    ns
      .filter((n) => n.kind === "tag")
      .sort((a, b) => b.deg - a.deg || b.links - a.links || a.label.localeCompare(b.label))
      .slice(0, limit)
      .map((n) => n.id),
  );
}
