// @ts-check
import { renderGraphView } from "./graph.js";

/**
 * memory ui — vanilla JS SPA. One /api/data fetch feeds everything;
 * /api/search runs the CLI's hybrid semantic search on demand.
 *
 * @typedef {Object} Entry
 * @property {string} id
 * @property {string} date
 * @property {string} type
 * @property {string} title
 * @property {string[]} people
 * @property {string[]} teams
 * @property {string[]} tags
 * @property {string[]} [sources]
 * @property {string[]} [source_ids]
 * @property {string} [updated]
 * @property {string} body
 * @property {string} path
 *
 * @typedef {Object} IndexStatus
 * @property {string|null} embedderId
 * @property {number|null} dim
 * @property {number} totalEntries
 * @property {number} indexedEntries
 * @property {number} staleEntries
 * @property {number} missingEntries
 * @property {number} chunkRows
 *
 * @typedef {Object} Hit
 * @property {string} id
 * @property {number} score
 * @property {string} bestChunk
 *
 * @typedef {{ type: string, person: string, team: string, tag: string, since: string, until: string }} Facets
 *
 * @typedef {Object} Connector
 * @property {string} name
 * @property {"template"|"override"} [origin]
 * @property {string} [path]
 * @property {boolean} enabled
 * @property {string} [source_id_scheme]
 * @property {Record<string, unknown>} [fetch]
 * @property {string} [last_pulled]
 * @property {string} [body]
 * @property {string} raw
 * @property {string} [error]
 */

const TYPE_ORDER = [
  "event", "decision", "1on1", "hiring", "incident",
  "achievement", "feedback", "meeting", "note", "summary",
];

const state = {
  loaded: false,
  error: "",
  /** @type {Entry[]} */
  entries: [],
  /** @type {IndexStatus|null} */
  index: null,
  q: "",
  /** @type {"instant"|"semantic"} */
  mode: "instant",
  /** deep recall: wider candidate pools, ~40 results to sift */
  deep: false,
  searching: false,
  /** run a semantic search as soon as the entries view mounts (header search) */
  semanticOnArrive: false,
  /** semantic-search failure notice, shown once in the result meta line */
  notice: "",
  /** @type {Hit[]|null} */
  hits: null,
  /** @type {Facets} */
  facets: { type: "", person: "", team: "", tag: "", since: "", until: "" },
  /** @type {Connector[]|null} lazy-loaded on first visit; null = not fetched */
  connectors: null,
};

// ---------- helpers ----------

/** @param {unknown} s */
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

/** @param {string} sel @returns {HTMLElement} */
function $(sel) {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`missing element ${sel}`);
  return /** @type {HTMLElement} */ (el);
}

/** @param {Entry[]} entries @param {(e: Entry) => string[]} pick */
function countBy(entries, pick) {
  /** @type {Map<string, number>} */
  const m = new Map();
  for (const e of entries) for (const k of pick(e)) m.set(k, (m.get(k) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** escape text, wrapping case-insensitive matches of q in <mark> */
/** @param {string} raw @param {string} q */
function hi(raw, q) {
  if (!q) return esc(raw);
  const lower = raw.toLowerCase();
  const needle = q.toLowerCase();
  /** @type {string[]} */
  const out = [];
  let i = 0;
  for (;;) {
    const at = lower.indexOf(needle, i);
    if (at === -1) break;
    out.push(esc(raw.slice(i, at)), `<mark>${esc(raw.slice(at, at + q.length))}</mark>`);
    i = at + q.length;
  }
  out.push(esc(raw.slice(i)));
  return out.join("");
}

/** @param {string} body strip markdown syntax for a plain-text snippet */
function snippet(body, len = 180) {
  const text = body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^[#>\-*\d.]+\s*/gm, "")
    .replace(/[*_`[\]()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > len ? `${text.slice(0, len)}…` : text;
}

// ---------- markdown mini-renderer (escape first, then transform) ----------

/** @param {string} line inline transforms on already-escaped text */
function inline(line) {
  return line
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|\W)\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" rel="noopener" target="_blank">$1</a>');
}

/** @param {string} md */
function renderMarkdown(md) {
  const lines = esc(md).split("\n");
  /** @type {string[]} */
  const out = [];
  /** @type {"p"|"ul"|"ol"|"quote"|"code"|null} */
  let block = null;
  /** @type {string[]} */
  let buf = [];

  function flush() {
    if (!block || buf.length === 0) {
      block = null;
      buf = [];
      return;
    }
    if (block === "p") out.push(`<p>${buf.map(inline).join("<br>")}</p>`);
    if (block === "ul") out.push(`<ul>${buf.map((l) => `<li>${inline(l)}</li>`).join("")}</ul>`);
    if (block === "ol") out.push(`<ol>${buf.map((l) => `<li>${inline(l)}</li>`).join("")}</ol>`);
    if (block === "quote") out.push(`<blockquote><p>${buf.map(inline).join("<br>")}</p></blockquote>`);
    if (block === "code") out.push(`<pre><code>${buf.join("\n")}</code></pre>`);
    block = null;
    buf = [];
  }

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (block === "code") {
      if (/^```/.test(line)) flush();
      else buf.push(line);
      continue;
    }
    if (/^```/.test(line)) {
      flush();
      block = "code";
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h && h[1] && h[2] !== undefined) {
      flush();
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
      continue;
    }
    if (/^(---|\*\*\*)\s*$/.test(line)) {
      flush();
      out.push("<hr>");
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    const li = line.match(/^\s*[-*]\s+(.*)$/);
    const oli = line.match(/^\s*\d+\.\s+(.*)$/);
    const q = line.match(/^&gt;\s?(.*)$/);
    if (li && li[1] !== undefined) {
      if (block !== "ul") flush();
      block = "ul";
      buf.push(li[1]);
    } else if (oli && oli[1] !== undefined) {
      if (block !== "ol") flush();
      block = "ol";
      buf.push(oli[1]);
    } else if (q && q[1] !== undefined) {
      if (block !== "quote") flush();
      block = "quote";
      buf.push(q[1]);
    } else {
      if (block !== "p") flush();
      block = "p";
      buf.push(line.trim());
    }
  }
  flush();
  return out.join("\n");
}

/**
 * Split leading YAML frontmatter from a markdown file. Non-greedy so an
 * `---` hr later in the body isn't swallowed; no match (missing or
 * unclosed fence) means the whole text is body.
 * @param {string} text
 * @returns {{ fm: string | null, body: string }}
 */
function splitFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
  return m ? { fm: m[1], body: text.slice(m[0].length) } : { fm: null, body: text };
}

// ---------- routing ----------

/** @returns {{ view: "overview" } | { view: "entries" } | { view: "entry", id: string } | { view: "graph" } | { view: "connectors" } | { view: "connector", name: string }} */
function route() {
  const h = location.hash;
  if (h.startsWith("#/entry/")) return { view: "entry", id: decodeURIComponent(h.slice(8)) };
  if (h.startsWith("#/entries")) return { view: "entries" };
  if (h.startsWith("#/graph")) return { view: "graph" };
  if (h.startsWith("#/connector/")) return { view: "connector", name: decodeURIComponent(h.slice(12)) };
  if (h.startsWith("#/connectors")) return { view: "connectors" };
  return { view: "overview" };
}

// ---------- shared render pieces ----------

function renderHeader() {
  const r = route();
  const idx = state.index;
  let status = "";
  if (idx) {
    const model = (idx.embedderId ?? "").split("/").pop() ?? "?";
    if (idx.chunkRows === 0) {
      status = `<span class="status warn">not indexed — run <code>memory index</code></span>`;
    } else if (idx.staleEntries + idx.missingEntries > 0) {
      status = `<span class="status warn">${idx.staleEntries + idx.missingEntries} stale — run <code>memory index</code></span>`;
    } else {
      status = `<span class="status ok" title="all ${idx.totalEntries} entries indexed · ${esc(model)} · ${idx.dim}d">indexed ${idx.indexedEntries}/${idx.totalEntries}</span>`;
    }
  }
  $("#header").innerHTML = `
    <a class="wordmark" href="#/">Personal Memory</a>
    <nav>
      <a href="#/" ${r.view === "overview" ? 'aria-current="page"' : ""}>Overview</a>
      <a href="#/entries" ${r.view === "entries" || r.view === "entry" ? 'aria-current="page"' : ""}>Entries</a>
      <a href="#/graph" ${r.view === "graph" ? 'aria-current="page"' : ""}>Graph</a>
      <a href="#/connectors" ${r.view === "connectors" || r.view === "connector" ? 'aria-current="page"' : ""}>Connectors</a>
    </nav>
    <span class="header-spacer"></span>
    ${r.view !== "entries" ? `<input class="hq" id="hq" type="search" placeholder="search the record" aria-label="search the record" />` : ""}
    ${status}
    <button class="tbtn" id="tbtn" aria-label="switch theme" title="switch theme">
      <svg class="i-sun" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M4.9 4.9l2.2 2.2M16.9 16.9l2.2 2.2M2 12h3M19 12h3M4.9 19.1l2.2-2.2M16.9 7.1l2.2-2.2"/></svg>
      <svg class="i-moon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
    </button>`;
  $("#tbtn").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("memory-theme", next);
  });
  const hq = document.getElementById("hq");
  if (hq instanceof HTMLInputElement) {
    hq.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" || !hq.value.trim()) return;
      state.q = hq.value.trim();
      state.mode = "instant";
      state.hits = null;
      state.notice = "";
      state.semanticOnArrive = true;
      location.hash = "#/entries";
    });
  }
}

// ---------- SVG mini-charts (single hue, dependency-free) ----------

/** round a max up to a clean tick step (1/2/5 × 10^k) */
/** @param {number} v @param {number} [ticks] */
function niceScale(v, ticks = 4) {
  const raw = Math.max(1, Math.ceil(v / ticks));
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  return { max: Math.ceil(v / step) * step, step };
}

/** horizontal bar: 4px rounded data-end, square at the baseline */
/** @param {number} x @param {number} y @param {number} w @param {number} h */
function rbar(x, y, w, h) {
  const r = Math.min(4, w, h / 2);
  return `M${x} ${y} h${w - r} a${r} ${r} 0 0 1 ${r} ${r} v${h - 2 * r} a${r} ${r} 0 0 1 ${-r} ${r} h${-(w - r)} z`;
}

/** column: 4px rounded cap, square at the baseline */
/** @param {number} x @param {number} y @param {number} w @param {number} h */
function rcol(x, y, w, h) {
  const r = Math.min(4, h, w / 2);
  return `M${x} ${y + r} a${r} ${r} 0 0 1 ${r} ${-r} h${w - 2 * r} a${r} ${r} 0 0 1 ${r} ${r} v${h - r} h${-w} z`;
}

/** @param {{ t: string, n: number }[]} byType */
function typeBarChart(byType) {
  const W = 760;
  const labelW = 108;
  const x0 = labelW + 14;
  const plotW = W - x0 - 48;
  const band = 27;
  const barH = 10;
  const padTop = 4;
  const baseY = padTop + byType.length * band;
  const H = baseY + 20;
  const { max, step } = niceScale(Math.max(...byType.map((x) => x.n)));
  const sx = (/** @type {number} */ v) => (v / max) * plotW;
  let grid = "";
  for (let v = step; v <= max; v += step) {
    grid += `<line class="gridline" x1="${x0 + sx(v)}" y1="${padTop}" x2="${x0 + sx(v)}" y2="${baseY}"/>
      <text class="tick" x="${x0 + sx(v)}" y="${baseY + 14}" text-anchor="middle">${v}</text>`;
  }
  const rows = byType
    .map((x, i) => {
      const yb = padTop + i * band;
      const y = yb + (band - barH) / 2;
      const w = Math.max(2, sx(x.n));
      const tip = `${x.n} ${esc(x.t)} entr${x.n === 1 ? "y" : "ies"}`;
      return `<g class="mark" tabindex="0" role="img" data-tip="${tip}" aria-label="${tip}">
        <rect class="hband" x="0" y="${yb}" width="${W}" height="${band}"/>
        <text class="cat" x="${labelW}" y="${yb + band / 2}" text-anchor="end" dominant-baseline="central">${esc(x.t)}</text>
        <path class="sbar" d="${rbar(x0, y, w, barH)}"/>
        <text class="val" x="${x0 + w + 8}" y="${yb + band / 2}" dominant-baseline="central">${x.n}</text>
      </g>`;
    })
    .join("");
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="entries by type">
    ${grid}
    <line class="axis" x1="${x0}" y1="${padTop}" x2="${x0}" y2="${baseY}"/>
    ${rows}
  </svg>`;
}

/** @param {{ m: string, n: number }[]} months */
function monthColChart(months) {
  const W = 760;
  const x0 = 30;
  const plotTop = 12;
  const baseY = 128;
  const labelY = 148;
  const H = 156;
  const plotW = W - x0 - 8;
  const { max, step } = niceScale(Math.max(...months.map((x) => x.n)), 3);
  const sy = (/** @type {number} */ v) => (v / max) * (baseY - plotTop);
  const band = plotW / months.length;
  const cw = Math.min(20, Math.max(6, band * 0.6));
  let grid = `<text class="tick" x="${x0 - 6}" y="${baseY}" text-anchor="end" dominant-baseline="central">0</text>`;
  for (let v = step; v <= max; v += step) {
    const y = baseY - sy(v);
    grid += `<line class="gridline" x1="${x0}" y1="${y}" x2="${W - 4}" y2="${y}"/>
      <text class="tick" x="${x0 - 6}" y="${y}" text-anchor="end" dominant-baseline="central">${v}</text>`;
  }
  const labelStep = Math.ceil(months.length / 12);
  const capLabels = months.length <= 12;
  const cols = months
    .map((x, i) => {
      const cx = x0 + i * band + band / 2;
      const h = Math.max(2, sy(x.n));
      const tip = `${x.n} entr${x.n === 1 ? "y" : "ies"} in ${esc(x.m)}`;
      return `<g class="mark" tabindex="0" role="img" data-tip="${tip}" aria-label="${tip}">
        <rect class="hband" x="${x0 + i * band}" y="${plotTop - 8}" width="${band}" height="${baseY - plotTop + 8}"/>
        <path class="sbar" d="${rcol(cx - cw / 2, baseY - h, cw, h)}"/>
        ${capLabels ? `<text class="val" x="${cx}" y="${baseY - h - 7}" text-anchor="middle">${x.n}</text>` : ""}
        ${i % labelStep === 0 ? `<text class="tick" x="${cx}" y="${labelY}" text-anchor="middle">${esc(x.m.slice(2))}</text>` : ""}
      </g>`;
    })
    .join("");
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="entries per month">
    ${grid}
    <line class="axis" x1="${x0}" y1="${baseY}" x2="${W - 4}" y2="${baseY}"/>
    ${cols}
  </svg>`;
}

const MONTH_FMT = new Intl.DateTimeFormat("en", { month: "long", year: "numeric" });

/** @param {string} key YYYY-MM */
function monthName(key) {
  return MONTH_FMT.format(new Date(`${key}-01T00:00:00`));
}

/** one ledger line — shared by entries list and overview recent feed */
/** @param {{ entry: Entry, score?: number, chunk?: string }} row @param {string} hiQ @param {{ compact?: boolean }} [opts] */
function ledgerRow({ entry: e, score, chunk }, hiQ, opts = {}) {
  const chips = [...e.people, ...e.teams, ...e.tags.map((t) => `#${t}`)]
    .map((c) => `<span class="chip mini">${esc(c)}</span>`)
    .join("");
  // summary rows surface their sources (rows are single-target links, so these
  // are display-only here — the detail page has the clickable versions)
  const srcs =
    e.type === "summary" && e.sources?.length
      ? [
          ...e.sources.slice(0, 4).map((s) => `<span class="chip mini src">${esc(s)}</span>`),
          e.sources.length > 4 ? `<span class="chip mini src">+${e.sources.length - 4} more</span>` : "",
        ].join("")
      : "";
  return `
    <a class="lrow" href="#/entry/${encodeURIComponent(e.id)}">
      <span class="ldate">${esc(e.date)}</span>
      <span class="lmain">
        <span class="ltop">
          <span class="badge">${esc(e.type)}</span>
          <span class="ltitle">${hi(e.title, hiQ)}</span>
          ${score !== undefined ? `<span class="score">${score.toFixed(3)}</span>` : ""}
        </span>
        <span class="lsnippet">${hi(snippet(chunk ?? e.body), hiQ)}</span>
        ${opts.compact || !srcs ? "" : `<span class="lmeta lsources"><span class="k-inline">sources</span>${srcs}</span>`}
        ${opts.compact ? "" : `<span class="lmeta">${chips}${pathWithCopy(e.path)}</span>`}
      </span>
    </a>`;
}

/** @param {string} key @param {string} value @param {number} [n] */
function chip(key, value, n) {
  return `<button class="chip" data-fk="${esc(key)}" data-fv="${esc(value)}">${esc(value)}${
    n !== undefined ? `<span class="n">${n}</span>` : ""
  }</button>`;
}

/** @param {string} path */
function pathWithCopy(path) {
  return `<span class="path">${esc(path)}</span><button class="copy" data-copy="${esc(path)}" aria-label="copy path ${esc(path)}">copy</button>`;
}

// ---------- overview ----------

function renderOverview() {
  const es = state.entries;
  if (es.length === 0) {
    $("#main").innerHTML = `<div class="empty">the record is empty — log a first memory with <code>memory add</code> or <code>/remember</code>, then run <code>memory index</code></div>`;
    return;
  }
  const people = countBy(es, (e) => e.people);
  const teams = countBy(es, (e) => e.teams);
  const tags = countBy(es, (e) => e.tags);
  const dates = es.map((e) => e.date).sort();
  const span = dates.length ? `${dates[0]} → ${dates[dates.length - 1]}` : "—";

  // person → { n, last } for the people ledger
  /** @type {Map<string, { n: number, last: string }>} */
  const pstats = new Map();
  for (const e of es)
    for (const p of e.people) {
      const s = pstats.get(p) ?? { n: 0, last: "" };
      s.n++;
      if (e.date > s.last) s.last = e.date;
      pstats.set(p, s);
    }
  const psorted = [...pstats.entries()].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]));
  const ptop = psorted.slice(0, 12);
  const prest = psorted.slice(12);

  // by-type bars, schema enum order, non-zero only
  const byType = TYPE_ORDER.map((t) => ({ t, n: es.filter((e) => e.type === t).length })).filter(
    (x) => x.n > 0,
  );

  // per-month columns over the full contiguous range
  /** @type {{ m: string, n: number }[]} */
  const months = [];
  if (dates.length) {
    const first = dates[0] ?? "";
    const last = dates[dates.length - 1] ?? "";
    let [y, m] = [Number(first.slice(0, 4)), Number(first.slice(5, 7))];
    const end = `${last.slice(0, 7)}`;
    for (;;) {
      const key = `${y}-${String(m).padStart(2, "0")}`;
      months.push({ m: key, n: es.filter((e) => e.date.startsWith(key)).length });
      if (key === end || months.length > 240) break;
      m++;
      if (m > 12) {
        m = 1;
        y++;
      }
    }
  }

  const colophon = [
    `<b>${es.length}</b> entries`,
    `<b>${people.length}</b> people`,
    teams.length ? `<b>${teams.length}</b> teams` : null,
    `<b>${tags.length}</b> tags`,
    `<b>${esc(span)}</b>`,
  ]
    .filter(Boolean)
    .join(`<span class="sep">·</span>`);

  $("#main").innerHTML = `
    <div class="colophon">${colophon}</div>

    <h2>Recent</h2>
    <div class="ledger l-top">${es.slice(0, 6).map((e) => ledgerRow({ entry: e }, "", { compact: true })).join("")}</div>
    <div class="see-all"><a href="#/entries">all entries →</a></div>

    <h2>By type</h2>
    <div class="card">${typeBarChart(byType)}</div>

    <h2>Entries over time</h2>
    <div class="card">${monthColChart(months)}</div>

    <h2>People</h2>
    <div class="ptable">
      <div class="prow phead"><span>person</span><span class="n">entries</span><span class="last">last seen</span></div>
      ${ptop
        .map(
          ([p, s]) =>
            `<div class="prow"><span><button class="plink" data-fk="person" data-fv="${esc(p)}">${esc(p)}</button></span><span class="n">${s.n}</span><span class="last">${esc(s.last)}</span></div>`,
        )
        .join("")}
    </div>
    ${
      prest.length
        ? `<details class="more-people"><summary>+ ${prest.length} more people</summary><div class="chips">${prest
            .map(([p, s]) => chip("person", p, s.n))
            .join("")}</div></details>`
        : ""
    }

    <h2>Tags</h2>
    <div class="chips">${tags.map(([t, n]) => chip("tag", t, n)).join("")}</div>

    <h2>Teams</h2>
    <div class="chips">${teams.length ? teams.map(([t, n]) => chip("team", t, n)).join("") : '<span class="empty">no teams yet</span>'}</div>
  `;
}

// ---------- entries ----------

/** @param {Entry[]} entries */
function applyFacets(entries) {
  const f = state.facets;
  return entries.filter((e) => {
    if (f.person && !e.people.includes(f.person)) return false;
    if (f.team && !e.teams.includes(f.team)) return false;
    if (f.tag && !e.tags.includes(f.tag)) return false;
    if (f.type && e.type !== f.type) return false;
    if (f.since && e.date < f.since) return false;
    if (f.until && e.date > f.until) return false;
    return true;
  });
}

/** @returns {{ entry: Entry, score?: number, chunk?: string }[]} */
function visibleEntries() {
  if (state.mode === "semantic" && state.hits) {
    const byId = new Map(state.entries.map((e) => [e.id, e]));
    return state.hits
      .map((h) => {
        const entry = byId.get(h.id);
        return entry ? { entry, score: h.score, chunk: h.bestChunk } : null;
      })
      .filter((x) => x !== null)
      .filter((x) => applyFacets([x.entry]).length > 0);
  }
  const q = state.q.trim().toLowerCase();
  let es = applyFacets(state.entries);
  if (q) {
    es = es.filter((e) =>
      `${e.title}\n${e.body}\n${e.tags.join(" ")}\n${e.people.join(" ")}\n${e.teams.join(" ")}`
        .toLowerCase()
        .includes(q),
    );
  }
  return es.map((entry) => ({ entry }));
}

function hasActiveFilters() {
  return Boolean(state.q.trim() || Object.values(state.facets).some((v) => v));
}

function renderResults() {
  if (state.searching) {
    $("#result-meta").innerHTML = `semantic search for “${esc(state.q)}”…`;
    $("#results").innerHTML = `<div class="ledger l-top">${Array.from(
      { length: 3 },
      () =>
        `<div class="skel-row"><span class="bar date-bar"></span><span class="lines"><span class="bar w40"></span><span class="bar w75"></span></span></div>`,
    ).join("")}</div>`;
    return;
  }
  const rows = visibleEntries();
  const notice = state.notice ? `<span class="notice">${esc(state.notice)}</span> · ` : "";
  const meta =
    state.mode === "semantic"
      ? `${rows.length} semantic match${rows.length === 1 ? "" : "es"} for “${esc(state.q)}” — ranked by relevance${state.deep ? " · deep" : ""}`
      : `${rows.length} entr${rows.length === 1 ? "y" : "ies"}`;
  $("#result-meta").innerHTML = notice + meta;
  const hiQ = state.mode === "instant" ? state.q.trim() : "";
  let emptyHtml;
  if (state.entries.length === 0) {
    emptyHtml = `<div class="empty">the record is empty — log a first memory with <code>memory add</code> or <code>/remember</code></div>`;
  } else if (state.mode === "semantic") {
    emptyHtml = `<div class="empty">no semantic matches — try different words, or <kbd>Esc</kbd> for instant filtering</div>`;
  } else {
    emptyHtml = `<div class="empty">nothing matches${
      hasActiveFilters() ? `<button class="chip" data-clear-filters>clear search &amp; filters</button>` : ""
    }</div>`;
  }
  if (!rows.length) {
    $("#results").innerHTML = emptyHtml;
    return;
  }
  if (state.mode === "semantic") {
    // ranked list — relevance order, no calendar grouping
    $("#results").innerHTML = `<div class="ledger l-top">${rows.map((r) => ledgerRow(r, hiQ)).join("")}</div>`;
    return;
  }
  // browse mode — a ledger grouped by month, newest first
  /** @type {{ key: string, rows: typeof rows }[]} */
  const groups = [];
  for (const row of rows) {
    const key = row.entry.date.slice(0, 7);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.rows.push(row);
    else groups.push({ key, rows: [row] });
  }
  $("#results").innerHTML = groups
    .map(
      (g) => `
      <section class="lgroup">
        <h3 class="month-head">${esc(monthName(g.key))} <span class="n">${g.rows.length}</span></h3>
        <div class="ledger">${g.rows.map((r) => ledgerRow(r, hiQ)).join("")}</div>
      </section>`,
    )
    .join("");
}

async function runSemantic() {
  const q = state.q.trim();
  if (!q) return;
  state.mode = "semantic";
  state.searching = true;
  state.notice = "";
  state.hits = null;
  renderResults();
  // `;` separates alternative phrasings — the server fuses all of them
  const phrasings = q.split(";").map((s) => s.trim()).filter(Boolean);
  const params = new URLSearchParams({ k: state.deep ? "40" : "12" });
  if (state.deep) params.set("deep", "1");
  for (const p of phrasings) params.append("q", p);
  for (const [k, v] of Object.entries(state.facets)) if (v) params.set(k, v);
  try {
    const res = await fetch(`/api/search?${params}`);
    if (!res.ok) throw new Error(`search failed (${res.status})`);
    const data = await res.json();
    state.hits = data.hits;
  } catch (err) {
    state.mode = "instant";
    state.hits = null;
    state.notice = "semantic search failed — showing instant matches";
    console.error(err);
  }
  state.searching = false;
  renderResults();
}

function renderEntries() {
  const f = state.facets;
  /** @param {string} name @param {string[]} opts @param {string} cur */
  const sel = (name, opts, cur) => `
    <select data-facet="${name}" aria-label="${name}">
      <option value="">${name}: all</option>
      ${opts.map((o) => `<option value="${esc(o)}" ${o === cur ? "selected" : ""}>${esc(o)}</option>`).join("")}
    </select>`;

  const people = countBy(state.entries, (e) => e.people).map(([k]) => k);
  const teams = countBy(state.entries, (e) => e.teams).map(([k]) => k);
  const tags = countBy(state.entries, (e) => e.tags).map(([k]) => k);
  const typeCounts = TYPE_ORDER.map((t) => ({ t, n: state.entries.filter((e) => e.type === t).length })).filter(
    (x) => x.n > 0,
  );

  $("#main").innerHTML = `
    <div class="searchbar">
      <input id="q" type="search" placeholder="filter as you type — Enter for semantic search" value="${esc(state.q)}" autocomplete="off" />
      <button id="deep-toggle" class="deep-toggle" aria-pressed="${state.deep}" title="deep recall — ~40 generously-ranked candidates to sift">deep</button>
    </div>
    <div class="search-hint">type to filter instantly · <kbd>Enter</kbd> semantic search · <kbd>;</kbd> separates phrasings, all fused · <kbd>Esc</kbd> clear · <kbd>/</kbd> focuses search from anywhere</div>
    <div class="type-chips" role="group" aria-label="filter by type">
      <button class="chip" data-ftype="" aria-pressed="${f.type === ""}">all</button>
      ${typeCounts
        .map(
          (x) =>
            `<button class="chip" data-ftype="${esc(x.t)}" aria-pressed="${f.type === x.t}">${esc(x.t)}<span class="n">${x.n}</span></button>`,
        )
        .join("")}
    </div>
    <div class="facets">
      ${sel("person", people, f.person)}
      ${sel("team", teams, f.team)}
      ${sel("tag", tags, f.tag)}
      <label class="facet-date">since <input type="date" data-facet="since" value="${esc(f.since)}" /></label>
      <label class="facet-date">until <input type="date" data-facet="until" value="${esc(f.until)}" /></label>
    </div>
    <div class="result-meta" id="result-meta"></div>
    <div id="results"></div>
  `;

  const input = /** @type {HTMLInputElement} */ ($("#q"));
  input.addEventListener("input", () => {
    state.q = input.value;
    state.mode = "instant";
    state.hits = null;
    state.notice = "";
    renderResults();
  });
  const deepBtn = /** @type {HTMLButtonElement} */ ($("#deep-toggle"));
  deepBtn.addEventListener("click", () => {
    state.deep = !state.deep;
    deepBtn.setAttribute("aria-pressed", String(state.deep));
    if (state.mode === "semantic") runSemantic();
  });
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") runSemantic();
    if (ev.key === "Escape") {
      input.value = "";
      state.q = "";
      state.mode = "instant";
      state.hits = null;
      state.notice = "";
      renderResults();
    }
  });
  for (const el of document.querySelectorAll("[data-facet]")) {
    el.addEventListener("change", () => {
      const key = /** @type {keyof Facets} */ (el.getAttribute("data-facet"));
      state.facets[key] = /** @type {HTMLSelectElement|HTMLInputElement} */ (el).value;
      if (state.mode === "semantic") runSemantic();
      else renderResults();
    });
  }
  renderResults();
  if (route().view === "entries") input.focus({ preventScroll: true });
  if (state.semanticOnArrive) {
    state.semanticOnArrive = false;
    runSemantic();
  }
}

// ---------- entry detail ----------

/** @param {string} id */
function renderEntry(id) {
  const e = state.entries.find((x) => x.id === id);
  if (!e) {
    $("#main").innerHTML = `<div class="empty">no entry with id <code>${esc(id)}</code></div>`;
    return;
  }
  const byId = new Set(state.entries.map((x) => x.id));
  /** @param {string} label @param {string} html */
  const section = (label, html) => `<section><div class="k">${esc(label)}</div>${html}</section>`;
  /** @param {string[]} xs @param {string} fk */
  const chipList = (xs, fk) =>
    xs.length ? `<div class="chips">${xs.map((x) => chip(fk, x)).join("")}</div>` : `<span class="none">—</span>`;

  $("#main").innerHTML = `
    <a class="back" href="#/entries">← entries</a>
    <div class="detail">
      <h1>${esc(e.title)}</h1>
      <div class="byline">
        <span>${esc(e.date)}</span>
        <span class="badge">${esc(e.type)}</span>
        ${e.updated ? `<span>updated ${esc(e.updated)}</span>` : ""}
        <span>id: <code>${esc(e.id)}</code></span>
      </div>
      <div class="detail-grid">
        <article class="prose">${renderMarkdown(e.body)}</article>
        <aside class="fm">
          ${section("path", `<div class="pathbox">${pathWithCopy(e.path)}</div>`)}
          ${section("people", chipList(e.people, "person"))}
          ${section("teams", chipList(e.teams, "team"))}
          ${section("tags", chipList(e.tags, "tag"))}
          ${
            e.source_ids?.length
              ? section("source ids", e.source_ids.map((s) => `<span class="source-id">${esc(s)}</span>`).join(""))
              : ""
          }
          ${
            e.sources?.length
              ? section(
                  "sources",
                  e.sources
                    .map((s) =>
                      byId.has(s)
                        ? `<a class="entry-link" href="#/entry/${encodeURIComponent(s)}">${esc(s)}</a>`
                        : `<span class="source-id">${esc(s)}</span>`,
                    )
                    .join(""),
                )
              : ""
          }
        </aside>
      </div>
    </div>
  `;
}

// ---------- modal ----------

/**
 * Open a modal on the native <dialog> element (focus trap, Esc and backdrop
 * handling for free). `build` receives the content root and a close();
 * the dialog removes itself from the DOM when closed.
 * @param {string} title
 * @param {(body: HTMLElement, close: () => void) => void} build
 */
function openModal(title, build) {
  const dlg = document.createElement("dialog");
  dlg.className = "modal";
  dlg.innerHTML = `
    <div class="modal-head">
      <h2>${esc(title)}</h2>
      <button class="modal-x" aria-label="close">✕</button>
    </div>
    <div class="modal-body"></div>
  `;
  document.body.append(dlg);
  const close = () => dlg.close();
  dlg.addEventListener("close", () => dlg.remove());
  dlg.addEventListener("click", (ev) => {
    if (ev.target === dlg) close(); // outside the padded content = backdrop
  });
  /** @type {HTMLElement} */ (dlg.querySelector(".modal-x")).addEventListener("click", close);
  build(/** @type {HTMLElement} */ (dlg.querySelector(".modal-body")), close);
  dlg.showModal();
}

// ---------- connectors ----------

const CONNECTOR_TEMPLATE = (/** @type {string} */ name) => `---
name: ${name}
enabled: true
source_id_scheme: "${name}:<id>"
# fetch:            # omit entirely for push-only connectors
#   lookback_days: 7
---

# What is memory-worthy in ${name}

Capture: …
Ignore: …
Writing the entry: …
`;

/** Where a connector resolves from: committed default template vs private override. */
const originBadge = (/** @type {Connector} */ c) =>
  c.origin === "override"
    ? `<span class="badge origin-custom" title="private override in memory/connectors/ — never committed to the main repo">custom</span>`
    : c.origin === "template"
      ? `<span class="badge" title="committed default template in connectors/ — edits via this UI are saved as a private override">default</span>`
      : `<span class="badge" title="not saved yet — saving creates a private override">unsaved</span>`;

/** Resolved file path from repo root; predicts the override path for unsaved drafts. */
const connectorPath = (/** @type {Connector} */ c) =>
  c.path ?? `memory/connectors/${c.name}.md`;

async function loadConnectorList() {
  const res = await fetch("/api/connectors");
  if (!res.ok) throw new Error(`failed to load /api/connectors (${res.status})`);
  state.connectors = /** @type {{connectors: Connector[]}} */ (await res.json()).connectors;
}

function renderConnectors() {
  const main = $("#main");
  if (state.connectors === null) {
    main.innerHTML = `<div class="loading">loading…</div>`;
    loadConnectorList().then(render, (err) => {
      main.innerHTML = `<div class="error-banner">${esc(err instanceof Error ? err.message : String(err))}</div>`;
    });
    return;
  }
  const cs = state.connectors;
  const rows = cs
    .map((c) => {
      const dot = c.error ? "warn" : c.enabled ? "ok" : "off";
      const meta = c.error
        ? `<span class="cerr">${esc(c.error.split("\n")[0])}</span>`
        : `<code class="cscheme">${esc(c.source_id_scheme ?? "")}</code>`;
      return `
        <a class="crow" href="#/connector/${encodeURIComponent(c.name)}">
          <span class="cdot ${dot}"></span>
          <span class="cmain">
            <span class="ctop">
              <span class="cname">${esc(c.name)}</span>
              ${c.fetch ? `<span class="badge">pull</span>` : `<span class="badge">push</span>`}
              ${originBadge(c)}
              ${meta}
              <span class="cpulled">${c.last_pulled ? `pulled ${esc(c.last_pulled.slice(0, 16).replace("T", " "))}` : c.fetch ? "never pulled" : ""}</span>
            </span>
          </span>
        </a>`;
    })
    .join("");
  main.innerHTML = `
    <div class="colophon">per-source ingestion config — frontmatter = fetch settings, body = the extraction prompt agents apply when capturing from that source<span class="sep">·</span>defaults live in <code>connectors/</code>, custom versions in <code>memory/connectors/</code> (private, never committed)</div>
    <div class="ledger l-top">${rows || `<div class="empty">no connector files yet</div>`}</div>
    <div class="see-all"><button class="chip" id="new-connector">+ new connector</button></div>
  `;
  $("#new-connector").addEventListener("click", () => {
    openModal("new connector", (body, close) => {
      body.innerHTML = `
        <form class="modal-form" id="nc-form">
          <label class="modal-label" for="nc-name">name</label>
          <input class="modal-input" id="nc-name" type="text" placeholder="e.g. gcal or linear"
                 autocomplete="off" spellcheck="false" />
          <div class="modal-hint">lower-kebab slug — saved as a private override at
            <code id="nc-path">memory/connectors/&lt;name&gt;.md</code>, never committed</div>
          <div class="modal-err" id="nc-err" hidden></div>
          <div class="modal-actions">
            <button type="button" class="chip" id="nc-cancel">cancel</button>
            <button type="submit" class="chip chip-primary">create</button>
          </div>
        </form>
      `;
      const input = /** @type {HTMLInputElement} */ ($("#nc-name"));
      const err = $("#nc-err");
      const path = $("#nc-path");
      input.addEventListener("input", () => {
        err.hidden = true;
        path.textContent = `memory/connectors/${input.value.trim() || "<name>"}.md`;
      });
      $("#nc-cancel").addEventListener("click", close);
      $("#nc-form").addEventListener("submit", (ev) => {
        ev.preventDefault();
        const name = input.value.trim();
        const fail = (/** @type {string} */ msg) => {
          err.textContent = msg;
          err.hidden = false;
          input.focus();
        };
        if (!name) return fail("name is required");
        if (!/^[a-z0-9][a-z0-9-]*$/.test(name))
          return fail("must be a lower-kebab slug, e.g. gcal or linear");
        if (!cs.some((c) => c.name === name)) {
          state.connectors = [...cs, { name, enabled: true, raw: CONNECTOR_TEMPLATE(name) }];
        }
        close();
        location.hash = `#/connector/${encodeURIComponent(name)}`; // existing name → just open it
      });
      input.focus();
    });
  });
}

/** @param {string} name */
function renderConnector(name) {
  const main = $("#main");
  if (state.connectors === null) {
    main.innerHTML = `<div class="loading">loading…</div>`;
    loadConnectorList().then(render, (err) => {
      main.innerHTML = `<div class="error-banner">${esc(err instanceof Error ? err.message : String(err))}</div>`;
    });
    return;
  }
  const c = state.connectors.find((x) => x.name === name);
  if (!c) {
    main.innerHTML = `<div class="empty">no connector named <code>${esc(name)}</code> — <a href="#/connectors">back to connectors</a></div>`;
    return;
  }
  main.innerHTML = `
    <a class="back" href="#/connectors">← connectors</a>
    <div class="detail">
      <h1>${esc(c.name)}</h1>
      <div class="byline">
        <span id="corigin">${originBadge(c)}</span>
        <span id="cpath"><code>${esc(connectorPath(c))}</code></span>
        ${c.last_pulled ? `<span>last pulled ${esc(c.last_pulled)}</span>` : ""}
      </div>
      <div class="connector-editor">
        <div class="editor-modes" role="group" aria-label="editor mode">
          <button class="chip" id="cmode-preview" aria-pressed="true">preview</button>
          <button class="chip" id="cmode-edit" aria-pressed="false">edit</button>
        </div>
        <textarea id="ceditor" spellcheck="false" aria-label="connector file" hidden>${esc(c.raw)}</textarea>
        <div class="connector-preview" id="cpreview"></div>
        <div class="save-row">
          <button class="chip" id="csave">save</button>
          <span class="save-note" id="cnote">${c.error ? `<span class="cerr">${esc(c.error.split("\n")[0])}</span>` : ""}</span>
        </div>
      </div>
    </div>
  `;
  const editor = /** @type {HTMLTextAreaElement} */ ($("#ceditor"));
  const note = $("#cnote");
  const preview = $("#cpreview");
  const previewBtn = $("#cmode-preview");
  const editBtn = $("#cmode-edit");
  /** @param {"edit" | "preview"} next */
  function setMode(next) {
    previewBtn.setAttribute("aria-pressed", String(next === "preview"));
    editBtn.setAttribute("aria-pressed", String(next === "edit"));
    if (next === "preview") {
      const { fm, body } = splitFrontmatter(editor.value);
      preview.innerHTML =
        (fm !== null ? `<pre class="preview-fm"><code>${esc(fm)}</code></pre>` : "") +
        (body.trim()
          ? `<article class="prose">${renderMarkdown(body)}</article>`
          : `<div class="preview-empty">(no body)</div>`);
    }
    editor.hidden = next === "preview";
    preview.hidden = next === "edit";
    if (next === "edit") editor.focus();
  }
  previewBtn.addEventListener("click", () => setMode("preview"));
  editBtn.addEventListener("click", () => setMode("edit"));
  setMode("preview");
  $("#csave").addEventListener("click", async () => {
    note.innerHTML = "saving…";
    try {
      const res = await fetch(`/api/connectors/${encodeURIComponent(c.name)}`, {
        method: "PUT",
        headers: { "Content-Type": "text/markdown; charset=utf-8" },
        body: editor.value,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `save failed (${res.status})`);
      state.connectors = null; // refetch on next view — the file on disk is now authoritative
      // Saves always land in the private override layer — reflect the new state.
      const saved = { ...c, origin: /** @type {const} */ ("override"), path: `memory/connectors/${c.name}.md` };
      $("#corigin").innerHTML = originBadge(saved);
      $("#cpath").innerHTML = `<code>${esc(saved.path)}</code>`;
      const at = new Date().toTimeString().slice(0, 8);
      note.innerHTML = `<span class="csaved">saved ${at}</span>`;
    } catch (err) {
      note.innerHTML = `<span class="cerr">${esc(err instanceof Error ? err.message : String(err))}</span>`;
    }
  });
}

// ---------- top-level render + events ----------

function render() {
  renderHeader();
  if (state.error) {
    $("#main").innerHTML = `<div class="error-banner">${esc(state.error)}</div>`;
    return;
  }
  if (!state.loaded) {
    $("#main").innerHTML = `<div class="loading">loading…</div>`;
    return;
  }
  const r = route();
  document.body.classList.toggle("view-graph", r.view === "graph");
  if (r.view === "overview") renderOverview();
  else if (r.view === "entries") renderEntries();
  else if (r.view === "graph") renderGraphView($("#main"), state.entries);
  else if (r.view === "connectors") renderConnectors();
  else if (r.view === "connector") renderConnector(r.name);
  else renderEntry(r.id);
  window.scrollTo(0, 0);
}

// chips → jump to entries pre-filtered; copy buttons; tooltip — via delegation
document.addEventListener("click", (ev) => {
  const t = /** @type {HTMLElement} */ (ev.target);
  const typeEl = t.closest("[data-ftype]");
  if (typeEl instanceof HTMLElement) {
    ev.preventDefault();
    state.facets.type = typeEl.dataset.ftype ?? "";
    render();
    if (state.mode === "semantic") runSemantic();
    return;
  }
  const chipEl = t.closest("[data-fk]");
  if (chipEl instanceof HTMLElement) {
    ev.preventDefault();
    ev.stopPropagation();
    const key = /** @type {keyof Facets} */ (chipEl.dataset.fk);
    state.facets = { type: "", person: "", team: "", tag: "", since: "", until: "" };
    state.facets[key] = chipEl.dataset.fv ?? "";
    state.q = "";
    state.mode = "instant";
    state.hits = null;
    if (route().view === "entries") render();
    else location.hash = "#/entries";
    return;
  }
  const clearEl = t.closest("[data-clear-filters]");
  if (clearEl) {
    ev.preventDefault();
    state.q = "";
    state.mode = "instant";
    state.hits = null;
    state.notice = "";
    state.facets = { type: "", person: "", team: "", tag: "", since: "", until: "" };
    render();
    return;
  }
  const copyEl = t.closest("[data-copy]");
  if (copyEl instanceof HTMLElement) {
    ev.preventDefault();
    ev.stopPropagation();
    navigator.clipboard.writeText(copyEl.dataset.copy ?? "").then(() => {
      copyEl.classList.add("done");
      copyEl.textContent = "copied";
      setTimeout(() => {
        copyEl.classList.remove("done");
        copyEl.textContent = "copy";
      }, 1200);
    });
  }
});

// "/" focuses search from anywhere (unless already typing in a field)
document.addEventListener("keydown", (ev) => {
  if (ev.key !== "/" || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const t = /** @type {HTMLElement} */ (ev.target);
  if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) return;
  ev.preventDefault();
  if (route().view === "entries") $("#q").focus();
  else location.hash = "#/entries"; // renderEntries focuses the input
});

const tooltip = document.getElementById("tooltip");

/** @param {HTMLElement} tipEl @param {number} cx @param {number} cy */
function showTooltip(tipEl, cx, cy) {
  if (!tooltip) return;
  tooltip.hidden = false;
  tooltip.textContent = tipEl.dataset.tip ?? "";
  const x = Math.min(cx + 12, window.innerWidth - tooltip.offsetWidth - 8);
  const y = Math.max(8, cy - tooltip.offsetHeight - 10);
  tooltip.style.left = `${x}px`;
  tooltip.style.top = `${y}px`;
}

document.addEventListener("pointermove", (ev) => {
  if (!tooltip) return;
  const t = /** @type {Element} */ (ev.target);
  const tipEl = t instanceof Element ? t.closest("[data-tip]") : null;
  // Element, not HTMLElement — chart marks are SVG
  if (tipEl instanceof Element) showTooltip(/** @type {HTMLElement} */ (tipEl), ev.clientX, ev.clientY);
  else tooltip.hidden = true;
});

// keyboard parity: focused chart elements get the same tooltip
document.addEventListener("focusin", (ev) => {
  const t = /** @type {Element} */ (ev.target);
  if (t instanceof Element && t.getAttribute("data-tip")) {
    const r = t.getBoundingClientRect();
    showTooltip(/** @type {HTMLElement} */ (t), r.left + r.width / 2, r.top);
  }
});
document.addEventListener("focusout", () => {
  if (tooltip) tooltip.hidden = true;
});

window.addEventListener("hashchange", render);

// ---------- boot ----------

async function boot() {
  render();
  try {
    const res = await fetch("/api/data");
    if (!res.ok) throw new Error(`failed to load /api/data (${res.status})`);
    const data = await res.json();
    state.entries = data.entries;
    state.index = data.index;
    state.loaded = true;
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
  }
  render();
}

boot();
