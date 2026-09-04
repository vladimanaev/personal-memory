// @ts-check
/**
 * Graph view — layout kernel. No DOM, no module state.
 *
 * A deterministic force layout: seeded placement, Barnes–Hut repulsion, link
 * springs, weak centering, soft radial containment, grid-based collision
 * separation, damped integration.
 *
 * Everything runs over preallocated typed arrays indexed in a canonical node
 * order, so a tick allocates nothing and the same kernel can drive the main
 * thread, a worker, or a Node benchmark.
 *
 * Cost per tick is O(n log n) rather than the O(n²) the naive all-pairs form
 * would give: repulsion goes through a quadtree and collision through a uniform
 * grid. At ~870 nodes that is ~50k interactions per tick instead of ~750k.
 *
 * @import { GNode, GEdge } from "./graph-model.js"
 */

/** world extent the layout is seeded and centered in */
export const W = 1200;
export const H = 800;
export const PAD = 34;

/** Barnes–Hut opening angle. Higher than the classic 0.5 because this is a
 *  picture, not physics — 0.9 roughly halves the work with no visible change. */
const THETA = 0.9;
const THETA2 = THETA * THETA;

/** quadtree depth cap — coincident bodies would otherwise subdivide forever */
const MAX_DEPTH = 20;

/** charge constant, matching the original all-pairs kernel */
const CHARGE = 70;
/** minimum squared distance, so coincident nodes don't fling each other away */
const MIN_D2 = 36;

/** extra clearance between node discs */
const COLLIDE_GAP = 14;
/** collision grid cell: the largest possible separation is 20 + 20 + 14 */
const COLLIDE_CELL = 54;

/** pull toward the world centre */
const CENTER_STRENGTH = 0.004;
/** strength of the soft boundary, applied only to the overshoot beyond R0 */
const CONTAIN_STRENGTH = 0.04;
/** velocity retained per tick */
const DAMPING = 0.85;
/** hard cap on per-tick displacement — a safety rail against divergence */
const MAX_SPEED = 120;

// ---------- deterministic seeding ----------

/** @param {string} str 32-bit FNV-1a — stable per-node seed */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** @param {number} seed deterministic PRNG */
export function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Codepoint order, not `localeCompare`. The layout is meant to be reproducible,
 * and `localeCompare` is ICU/locale dependent — it can order the same two ids
 * differently on two machines, which changes float accumulation order and so
 * the settled layout.
 * @param {string} a @param {string} b
 */
function byId(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Seed or warm-start positions. Iterated in canonical id order for determinism.
 * @param {GNode[]} nodes
 * @param {Map<string, { x: number, y: number }>} lastPos cached positions, if any
 */
export function initPositions(nodes, lastPos) {
  for (const n of [...nodes].sort((a, b) => byId(a.id, b.id))) {
    const p = lastPos.get(n.id);
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

// ---------- quadtree ----------

/**
 * A linear quadtree in preallocated typed arrays, rebuilt every tick.
 *
 * The repulsion between two bodies is `CHARGE · rᵢ · rⱼ · α / d²`. Because `rᵢ`
 * factors out, what a cell has to aggregate is **Σ r** — a radius-mass — with a
 * radius-weighted centroid. That is ordinary Barnes–Hut with `m = r`, not with
 * `m = 1`, and getting it wrong makes hubs behave like leaves.
 */
function createTree() {
  let cap = 0;
  return {
    /** child node index per quadrant, -1 when absent; a node is a leaf iff child[4k] === -1 */
    child: new Int32Array(0),
    /** first body in this leaf's list, -1 when empty or internal */
    head: new Int32Array(0),
    /** next body in the same leaf list, -1 at the end */
    next: new Int32Array(0),
    /** Σ r over the subtree */
    rsum: new Float64Array(0),
    /** radius-weighted centroid (accumulated as Σ r·x, divided in finalize) */
    cx: new Float64Array(0),
    cy: new Float64Array(0),
    count: 0,
    x0: 0,
    y0: 0,
    size: 1,
    /** Grow to hold `nodeCap` cells, preserving what is already there.
     * Typed arrays swallow out-of-bounds writes silently, so an under-sized
     * tree does not throw — it produces cells whose children read back as 0,
     * i.e. a cycle through the root, and the layout diverges to NaN. Always
     * grow before writing.
     * @param {number} nodeCap @param {number} bodyCap */
    reserve(nodeCap, bodyCap) {
      if (nodeCap > cap) {
        const next = Math.max(nodeCap, cap * 2, 64);
        const child = new Int32Array(next * 4);
        const head = new Int32Array(next);
        const rsum = new Float64Array(next);
        const cx = new Float64Array(next);
        const cy = new Float64Array(next);
        child.set(this.child);
        head.set(this.head);
        rsum.set(this.rsum);
        cx.set(this.cx);
        cy.set(this.cy);
        this.child = child;
        this.head = head;
        this.rsum = rsum;
        this.cx = cx;
        this.cy = cy;
        cap = next;
      }
      if (this.next.length < bodyCap) this.next = new Int32Array(bodyCap);
    },
  };
}

/** @typedef {ReturnType<typeof createTree>} Tree */

/** @param {Tree} t @returns {number} index of a fresh empty leaf */
function newTreeNode(t) {
  if (t.count >= t.head.length) t.reserve(t.count + 1, 0);
  const k = t.count++;
  t.child[4 * k] = -1;
  t.child[4 * k + 1] = -1;
  t.child[4 * k + 2] = -1;
  t.child[4 * k + 3] = -1;
  t.head[k] = -1;
  t.rsum[k] = 0;
  t.cx[k] = 0;
  t.cy[k] = 0;
  return k;
}

/**
 * @param {Tree} t
 * @param {Float32Array} x @param {Float32Array} y @param {Float32Array} r
 * @param {number} n
 */
function buildTree(t, x, y, r, n) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const xi = x[i], yi = y[i];
    if (xi < x0) x0 = xi;
    if (xi > x1) x1 = xi;
    if (yi < y0) y0 = yi;
    if (yi > y1) y1 = yi;
  }
  // a square root cell keeps quadrant arithmetic exact and simple
  const size = Math.max(x1 - x0, y1 - y0, 1) * 1.0001;
  // a single insert can split at several levels, adding 4 cells each time, so
  // this is a starting size only — newTreeNode grows past it when it has to
  t.reserve(8 * n + 64, n);
  t.count = 0;
  t.x0 = x0;
  t.y0 = y0;
  t.size = size;
  newTreeNode(t);

  for (let i = 0; i < n; i++) {
    const xi = x[i], yi = y[i], ri = r[i];
    let node = 0;
    let nx0 = x0, ny0 = y0, nsize = size, depth = 0;
    for (;;) {
      t.rsum[node] += ri;
      t.cx[node] += ri * xi;
      t.cy[node] += ri * yi;

      if (t.child[4 * node] !== -1) {
        // internal: descend
        const half = nsize / 2;
        const east = xi >= nx0 + half ? 1 : 0;
        const south = yi >= ny0 + half ? 1 : 0;
        const q = south * 2 + east;
        if (east) nx0 += half;
        if (south) ny0 += half;
        nsize = half;
        node = t.child[4 * node + q];
        depth++;
        continue;
      }

      const j = t.head[node];
      if (j === -1) {
        t.head[node] = i;
        t.next[i] = -1;
        break;
      }
      if (depth >= MAX_DEPTH || (x[j] === xi && y[j] === yi)) {
        // coincident or too deep — share the leaf; the force pass walks the list
        t.next[i] = j;
        t.head[node] = i;
        break;
      }

      // split this leaf, push the sitting body one level down, then keep going
      t.head[node] = -1;
      const half = nsize / 2;
      for (let q = 0; q < 4; q++) t.child[4 * node + q] = newTreeNode(t);
      const je = x[j] >= nx0 + half ? 1 : 0;
      const js = y[j] >= ny0 + half ? 1 : 0;
      const jq = t.child[4 * node + js * 2 + je];
      t.head[jq] = j;
      t.next[j] = -1;
      t.rsum[jq] = r[j];
      t.cx[jq] = r[j] * x[j];
      t.cy[jq] = r[j] * y[j];
      // loop again; the node is internal now, so the branch above descends
    }
  }

  for (let k = 0; k < t.count; k++) {
    const m = t.rsum[k];
    if (m > 0) {
      t.cx[k] /= m;
      t.cy[k] /= m;
    }
  }
}

// ---------- the simulation ----------

/**
 * Build a reusable simulation over a projection. Node order is canonical
 * (codepoint by id), independent of the caller's array order.
 *
 * @param {GNode[]} nodes
 * @param {GEdge[]} edges
 */
export function createSim(nodes, edges) {
  const ordered = [...nodes].sort((a, b) => byId(a.id, b.id));
  const n = ordered.length;
  /** @type {Map<string, number>} */
  const index = new Map();
  for (let i = 0; i < n; i++) index.set(/** @type {GNode} */ (ordered[i]).id, i);

  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const vx = new Float64Array(n);
  const vy = new Float64Array(n);
  const r = new Float32Array(n);
  const links = new Float64Array(n);
  /** 0 person, 1 tag, 2 team, 3 entry — only "is it an entry" matters to the springs */
  const isEntry = new Uint8Array(n);
  const pinned = new Uint8Array(n);
  const px = new Float32Array(n);
  const py = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const node = /** @type {GNode} */ (ordered[i]);
    x[i] = node.x;
    y[i] = node.y;
    vx[i] = node.vx;
    vy[i] = node.vy;
    r[i] = node.r;
    links[i] = node.links;
    isEntry[i] = node.kind === "entry" ? 1 : 0;
  }

  // edges as index pairs, dangling endpoints dropped up front
  const ea = new Int32Array(edges.length);
  const eb = new Int32Array(edges.length);
  const erest = new Float32Array(edges.length);
  let m = 0;
  for (const e of edges) {
    const a = index.get(e.a);
    const b = index.get(e.b);
    if (a === undefined || b === undefined) continue;
    ea[m] = a;
    eb[m] = b;
    // rest length depends only on the endpoint kinds and the weight, so it is
    // hoisted out of the per-tick loop
    const co = isEntry[a] === 0 && isEntry[b] === 0;
    erest[m] = co ? 120 + 40 / e.weight : isEntry[a] === 1 && isEntry[b] === 1 ? 110 : 85;
    m++;
  }

  const tree = createTree();
  // quadtree walk stack, allocated once and grown only if a walk gets deep
  let stack = new Int32Array(256);
  let sizes = new Float64Array(256);
  let sx0 = new Float64Array(256);
  let sy0 = new Float64Array(256);
  // collision grid, allocated once and refilled per tick
  let cellStart = new Int32Array(0);
  let cursor = new Int32Array(0);
  let items = new Int32Array(n);
  let gcols = 0, grows = 0, gx0 = 0, gy0 = 0;

  // The soft boundary grows with the graph instead of being a fixed box, and
  // it is an ellipse matched to the viewport's aspect rather than a circle.
  // A circular boundary produces a square layout, and framing a square inside
  // a 3:2 viewport is limited by height — it wasted a third of the width and
  // forced the camera down to ~0.47 zoom. The semi-axes below keep the same
  // enclosed area (RX·RY = R0²) while giving the layout the frame's shape.
  const R0 = Math.max(200, 0.5 * Math.sqrt(Math.max(n, 1)) * 46);
  // The boundary is stretched further than the target ratio on purpose:
  // repulsion is isotropic and constantly pulls the blob back toward square,
  // so a boundary of W/H squared settles into a layout of about W/H. Measured
  // on the real store: this fills 1067x704 of the usable 1132x732, where a
  // circular boundary managed only 724x718.
  const ASPECT = W / H;
  const RX = R0 * ASPECT;
  const RY = R0 / ASPECT;

  /** @param {number} alpha */
  function repulsion(alpha) {
    if (n < 2) return;
    buildTree(tree, x, y, r, n);
    const { child, head, next, rsum, cx, cy } = tree;
    for (let i = 0; i < n; i++) {
      const xi = x[i], yi = y[i], ri = r[i];
      let ax = 0, ay = 0;
      let sp = 0;
      stack[sp] = 0;
      sizes[sp] = tree.size;
      sx0[sp] = tree.x0;
      sy0[sp] = tree.y0;
      sp++;
      while (sp > 0) {
        sp--;
        const node = stack[sp];
        const nsize = sizes[sp];
        const nx0 = sx0[sp];
        const ny0 = sy0[sp];
        const mass = rsum[node];
        if (mass === 0) continue;
        const dx = cx[node] - xi;
        const dy = cy[node] - yi;
        const d2 = dx * dx + dy * dy;
        const internal = child[4 * node] !== -1;
        // A cell that contains this body must never be approximated: its mass
        // and centroid include the body, so the aggregate would have the body
        // pushing itself, which compounds every tick into a runaway. At
        // THETA = 0.9 the distance test alone does not exclude that case (a
        // body can sit up to √2·size from its own cell's centroid), so test
        // containment explicitly.
        const inside =
          xi >= nx0 && xi <= nx0 + nsize && yi >= ny0 && yi <= ny0 + nsize;
        if (internal && !inside && nsize * nsize < THETA2 * d2) {
          // far enough: the whole cell acts as one body of radius-mass `mass`
          const dd = Math.max(d2, MIN_D2);
          const d = Math.sqrt(dd);
          const push = (CHARGE * ri * mass * alpha) / dd;
          ax -= (push * dx) / d;
          ay -= (push * dy) / d;
          continue;
        }
        if (internal) {
          if (sp + 4 > stack.length) {
            const grow = stack.length * 2;
            const s2 = new Int32Array(grow); s2.set(stack); stack = s2;
            const z2 = new Float64Array(grow); z2.set(sizes); sizes = z2;
            const a2 = new Float64Array(grow); a2.set(sx0); sx0 = a2;
            const b2 = new Float64Array(grow); b2.set(sy0); sy0 = b2;
          }
          const half = nsize / 2;
          for (let q = 0; q < 4; q++) {
            stack[sp] = child[4 * node + q];
            sizes[sp] = half;
            sx0[sp] = nx0 + (q & 1 ? half : 0);
            sy0[sp] = ny0 + (q & 2 ? half : 0);
            sp++;
          }
          continue;
        }
        for (let j = head[node]; j !== -1; j = next[j]) {
          if (j === i) continue;
          const jx = x[j] - xi;
          const jy = y[j] - yi;
          const dd = Math.max(jx * jx + jy * jy, MIN_D2);
          const d = Math.sqrt(dd);
          const push = (CHARGE * ri * r[j] * alpha) / dd;
          ax -= (push * jx) / d;
          ay -= (push * jy) / d;
        }
      }
      vx[i] += ax;
      vy[i] += ay;
    }
  }

  /** @param {number} alpha */
  function springs(alpha) {
    for (let k = 0; k < m; k++) {
      const a = ea[k], b = eb[k];
      const dx = x[b] - x[a];
      const dy = y[b] - y[a];
      const d = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
      // Strength is normalized by the smaller endpoint's link count, and the
      // displacement is then split between the endpoints in inverse proportion
      // to their degree (d3-force's `bias`). Both halves are needed: without
      // the bias, one spring pull is applied in full to a hub as well as to a
      // leaf, so a node with 800+ links accumulates 800 full-strength pulls in
      // a single tick and the layout diverges. The old hard clamp to the 1200
      // × 800 box hid this by truncating every runaway each tick.
      const la = links[a], lb = links[b];
      const tot = la + lb || 1;
      const strength = 1 / Math.max(1, Math.min(la, lb));
      const f = (0.08 * strength * alpha * (d - erest[k])) / d;
      const shareA = lb / tot; // the heavier endpoint moves less
      const shareB = la / tot;
      vx[a] += f * dx * shareA;
      vy[a] += f * dy * shareA;
      vx[b] -= f * dx * shareB;
      vy[b] -= f * dy * shareB;
    }
  }

  /** @param {number} alpha */
  function centerAndContain(alpha) {
    const cx0 = W / 2, cy0 = H / 2;
    for (let i = 0; i < n; i++) {
      vx[i] += (cx0 - x[i]) * CENTER_STRENGTH * alpha;
      vy[i] += (cy0 - y[i]) * CENTER_STRENGTH * alpha;
      // soft boundary: pull back in proportion to the overshoot only, so nothing
      // ever snaps and nothing plasters itself against a wall
      const dx = x[i] - cx0;
      const dy = y[i] - cy0;
      const ex = dx / RX;
      const ey = dy / RY;
      const q = Math.sqrt(ex * ex + ey * ey); // 1 on the boundary ellipse
      if (q > 1) {
        // push back along the ellipse normal, scaled by how far outside it is
        const gx = dx / (RX * RX);
        const gy = dy / (RY * RY);
        const gl = Math.sqrt(gx * gx + gy * gy) || 1;
        const pull = CONTAIN_STRENGTH * alpha * (q - 1) * R0;
        vx[i] -= (pull * gx) / gl;
        vy[i] -= (pull * gy) / gl;
      }
    }
  }

  function collide() {
    if (n < 2) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < n; i++) {
      if (x[i] < x0) x0 = x[i];
      if (x[i] > x1) x1 = x[i];
      if (y[i] < y0) y0 = y[i];
      if (y[i] > y1) y1 = y[i];
    }
    const cols = Math.max(1, Math.min(2048, Math.ceil((x1 - x0) / COLLIDE_CELL) + 1));
    const rows = Math.max(1, Math.min(2048, Math.ceil((y1 - y0) / COLLIDE_CELL) + 1));
    if (cols !== gcols || rows !== grows || cellStart.length !== cols * rows + 1) {
      cellStart = new Int32Array(cols * rows + 1);
      gcols = cols;
      grows = rows;
    } else {
      cellStart.fill(0);
    }
    gx0 = x0;
    gy0 = y0;

    /** @param {number} i */
    const cellOf = (i) => {
      const c = Math.min(cols - 1, Math.max(0, ((x[i] - gx0) / COLLIDE_CELL) | 0));
      const rw = Math.min(rows - 1, Math.max(0, ((y[i] - gy0) / COLLIDE_CELL) | 0));
      return rw * cols + c;
    };

    // counting sort bodies into cells
    for (let i = 0; i < n; i++) cellStart[cellOf(i) + 1]++;
    for (let c = 0; c < cols * rows; c++) cellStart[c + 1] += cellStart[c];
    if (items.length < n) items = new Int32Array(n);
    if (cursor.length < cols * rows) cursor = new Int32Array(cols * rows);
    else cursor.fill(0, 0, cols * rows);
    for (let i = 0; i < n; i++) {
      const c = cellOf(i);
      items[cellStart[c] + cursor[c]++] = i;
    }

    /** @param {number} a @param {number} b */
    const resolve = (a, b) => {
      const dx = x[b] - x[a];
      const dy = y[b] - y[a];
      const d = Math.max(Math.sqrt(dx * dx + dy * dy), 0.01);
      const min = r[a] + r[b] + COLLIDE_GAP;
      if (d >= min) return;
      const shift = (min - d) / 2 / d;
      x[a] -= shift * dx;
      y[a] -= shift * dy;
      x[b] += shift * dx;
      y[b] += shift * dy;
    };

    // half-stencil: own cell (index-ordered) plus E, SW, S, SE — every adjacent
    // pair is therefore visited exactly once, matching the all-pairs semantics
    for (let rw = 0; rw < rows; rw++) {
      for (let c = 0; c < cols; c++) {
        const cell = rw * cols + c;
        const s = cellStart[cell];
        const e = cellStart[cell + 1];
        for (let p = s; p < e; p++) {
          const a = items[p];
          for (let q = p + 1; q < e; q++) resolve(a, items[q]);
        }
        /** @param {number} nc @param {number} nr */
        const other = (nc, nr) => {
          if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) return;
          const oc = nr * cols + nc;
          const os = cellStart[oc];
          const oe = cellStart[oc + 1];
          for (let p = s; p < e; p++) {
            const a = items[p];
            for (let q = os; q < oe; q++) resolve(a, items[q]);
          }
        };
        other(c + 1, rw);
        other(c - 1, rw + 1);
        other(c, rw + 1);
        other(c + 1, rw + 1);
      }
    }
  }

  function integrate() {
    for (let i = 0; i < n; i++) {
      if (pinned[i]) {
        x[i] = px[i];
        y[i] = py[i];
        vx[i] = 0;
        vy[i] = 0;
        continue;
      }
      vx[i] *= DAMPING;
      vy[i] *= DAMPING;
      // Safety rail, not a tuning knob: the forces above are stable, but a
      // pathological graph should degrade into a poor layout rather than into
      // NaN coordinates that blank the view.
      const speed = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i]);
      if (speed > MAX_SPEED) {
        const k = MAX_SPEED / speed;
        vx[i] *= k;
        vy[i] *= k;
      }
      x[i] += vx[i];
      y[i] += vy[i];
    }
  }

  return {
    get length() {
      return n;
    },
    /** @param {number} alpha */
    step(alpha) {
      repulsion(alpha);
      springs(alpha);
      centerAndContain(alpha);
      collide();
      integrate();
    },
    /** copy positions back onto the node objects the view draws from
     * @param {GNode[]} target */
    writeBack(target) {
      for (const node of target) {
        const i = index.get(node.id);
        if (i === undefined) continue;
        node.x = x[i];
        node.y = y[i];
        node.vx = vx[i];
        node.vy = vy[i];
      }
    },
    /** @param {string} id @param {number} nx @param {number} ny */
    pin(id, nx, ny) {
      const i = index.get(id);
      if (i === undefined) return;
      pinned[i] = 1;
      px[i] = nx;
      py[i] = ny;
      x[i] = nx;
      y[i] = ny;
    },
    /** @param {string} id */
    unpin(id) {
      const i = index.get(id);
      if (i !== undefined) pinned[i] = 0;
    },
  };
}

/** @typedef {ReturnType<typeof createSim>} Sim */

/**
 * Camera transform that frames `nodes` inside the W×H viewport.
 *
 * This deliberately does NOT touch the layout. The previous version rescaled
 * every node's position to fit, but left the radii alone — so a settled layout
 * of 1539×1543 was multiplied by 0.47 while the discs stayed full size, which
 * halved the gap between neighbours and produced the dense, overlapping first
 * paint. The collision pass separates nodes by `ra + rb + 14`; squashing the
 * coordinates afterwards throws that away. Zooming the camera scales positions
 * and radii together, so the spacing the layout worked out is preserved.
 *
 * @param {GNode[]} nodes
 * @param {number} kMin @param {number} kMax
 * @returns {{ k: number, tx: number, ty: number }}
 */
export function computeFit(nodes, kMin, kMax) {
  if (nodes.length === 0) return { k: 1, tx: 0, ty: 0 };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) {
    x0 = Math.min(x0, n.x - n.r);
    y0 = Math.min(y0, n.y - n.r);
    x1 = Math.max(x1, n.x + n.r);
    y1 = Math.max(y1, n.y + n.r + 14); // room for the label line
  }
  const bw = Math.max(x1 - x0, 1);
  const bh = Math.max(y1 - y0, 1);
  const k = Math.min(kMax, Math.max(kMin, Math.min((W - 2 * PAD) / bw, (H - 2 * PAD) / bh)));
  return { k, tx: W / 2 - k * ((x0 + x1) / 2), ty: H / 2 - k * ((y0 + y1) / 2) };
}
