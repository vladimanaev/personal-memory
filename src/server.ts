import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { loadAllEntries, ROOT } from "./ingest.js";
import { search, indexStatus, type SearchFilters } from "./store.js";
import { loadConnectors, loadConnectorState, writeConnector, relConnector } from "./connectors.js";

const UI_DIR = fileURLToPath(new URL("./ui/", import.meta.url));

// Explicit whitelist — no generic static handler, no traversal surface.
const STATIC: Record<string, { file: string; mime: string }> = {
  "/": { file: "index.html", mime: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", mime: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", mime: "text/javascript; charset=utf-8" },
  "/graph.js": { file: "graph.js", mime: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", mime: "text/css; charset=utf-8" },
};

type LogValue = string | number | boolean | undefined;

const DEFAULT_SLOW_MS = 1000;

function slowRequestMs(): number {
  const raw = process.env.MEMORY_UI_SLOW_MS;
  if (!raw?.trim()) return DEFAULT_SLOW_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_SLOW_MS;
}

function formatLogValue(value: Exclude<LogValue, undefined>): string {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return /^[A-Za-z0-9._~:/-]+$/.test(value) ? value : JSON.stringify(value);
}

function log(level: "info" | "warn" | "error", message: string, fields: Record<string, LogValue> = {}): void {
  const suffix = Object.entries(fields)
    .filter((entry): entry is [string, Exclude<LogValue, undefined>] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${formatLogValue(value)}`)
    .join(" ");
  const line = `${new Date().toISOString()} ${level} ${message}${suffix ? ` ${suffix}` : ""}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

function logError(message: string, err: unknown, fields: Record<string, LogValue> = {}): void {
  const error = err instanceof Error ? err.message : String(err);
  log("error", message, { ...fields, error });
  if (err instanceof Error && err.stack) console.error(err.stack);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

async function apiData(res: ServerResponse): Promise<void> {
  const [index, entries] = await Promise.all([indexStatus(), loadAllEntries()]);
  const payload = entries
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((e) => ({ ...e, path: relative(ROOT, e.path) }));
  sendJson(res, 200, { generatedAt: new Date().toISOString(), index, entries: payload });
}

async function apiSearch(res: ServerResponse, params: URLSearchParams): Promise<void> {
  // Repeatable: /api/search?q=phrasing+one&q=phrasing+two — all fused.
  const queries = params.getAll("q").map((q) => q.trim()).filter(Boolean);
  if (queries.length === 0) {
    sendJson(res, 400, { error: "missing q" });
    return;
  }
  const filters: SearchFilters = {
    person: params.get("person") || undefined,
    type: params.get("type") || undefined,
    team: params.get("team") || undefined,
    tag: params.get("tag") || undefined,
    since: params.get("since") || undefined,
    until: params.get("until") || undefined,
  };
  const deep = params.get("deep") === "1" || params.get("deep") === "true";
  const k = Number(params.get("k")) || (deep ? 40 : 8);
  const hits = await search(queries, filters, k, { deep });
  sendJson(res, 200, {
    query: queries.join(" | "),
    hits: hits.map((h) => ({ id: h.entry.id, score: h.score, bestChunk: h.bestChunk })),
  });
}

async function apiConnectors(res: ServerResponse): Promise<void> {
  const [files, state] = await Promise.all([loadConnectors(), loadConnectorState()]);
  const connectors = files.map((c) => ({
    name: c.name,
    origin: c.origin,
    path: relConnector(c.path),
    enabled: c.fm?.enabled ?? false,
    source_id_scheme: c.fm?.source_id_scheme,
    fetch: c.fm?.fetch,
    last_pulled: state[c.name]?.last_pulled,
    body: c.body,
    raw: c.raw,
    ...(c.error ? { error: c.error } : {}),
  }));
  sendJson(res, 200, { connectors });
}

async function readBody(req: IncomingMessage, maxBytes = 256 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > maxBytes) throw Object.assign(new Error("body too large"), { status: 413 });
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// Names are validated against this shape and the path is built from the name
// alone — no request-supplied path ever reaches the filesystem.
const CONNECTOR_NAME = /^[a-z0-9][a-z0-9-]*$/;

async function apiPutConnector(
  req: IncomingMessage,
  res: ServerResponse,
  name: string,
): Promise<void> {
  let raw: string;
  try {
    raw = await readBody(req);
  } catch (err) {
    sendJson(res, (err as { status?: number }).status ?? 500, {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  if (!raw.trim()) {
    sendJson(res, 400, { error: "empty body — send the full connector file text" });
    return;
  }
  try {
    await writeConnector(name, raw);
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    return;
  }
  sendJson(res, 200, { ok: true, name });
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(cmd, [url], { detached: true, stdio: "ignore", shell: process.platform === "win32" }).unref();
}

export function startServer(opts: { port: number; open: boolean }): Promise<never> {
  const server = createServer(async (req, res) => {
    const start = performance.now();
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    res.on("finish", () => {
      const durationMs = Math.round(performance.now() - start);
      const thresholdMs = slowRequestMs();
      if (res.statusCode >= 500) {
        log("error", "request", {
          method: req.method,
          path: url.pathname,
          status: res.statusCode,
          duration_ms: durationMs,
        });
      } else if (res.statusCode >= 400 || durationMs >= thresholdMs) {
        log("warn", "request", {
          method: req.method,
          path: url.pathname,
          status: res.statusCode,
          duration_ms: durationMs,
        });
      }
    });
    try {
      const asset = STATIC[url.pathname];
      if (asset) {
        const body = await readFile(join(UI_DIR, asset.file));
        res.writeHead(200, { "Content-Type": asset.mime, "Cache-Control": "no-store" });
        res.end(body);
      } else if (url.pathname === "/api/data") {
        await apiData(res);
      } else if (url.pathname === "/api/search") {
        await apiSearch(res, url.searchParams);
      } else if (url.pathname === "/api/connectors") {
        if (req.method === "GET") await apiConnectors(res);
        else sendJson(res, 405, { error: "method not allowed" });
      } else if (url.pathname.startsWith("/api/connectors/")) {
        const name = url.pathname.slice("/api/connectors/".length);
        if (!CONNECTOR_NAME.test(name)) sendJson(res, 404, { error: "not found" });
        else if (req.method === "PUT") await apiPutConnector(req, res, name);
        else sendJson(res, 405, { error: "method not allowed" });
      } else {
        sendJson(res, 404, { error: "not found" });
      }
    } catch (err) {
      logError("request failed", err, { method: req.method, path: url.pathname });
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  return new Promise<never>((_, reject) => {
    server.on("error", (err: NodeJS.ErrnoException) => {
      log("error", "server error", {
        port: opts.port,
        code: err.code,
        error: err.message,
      });
      if (err.code === "EADDRINUSE") {
        reject(new Error(`port ${opts.port} is already in use — try \`memory ui --port <N>\``));
      } else {
        reject(err);
      }
    });
    server.listen(opts.port, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${opts.port}`;
      log("info", "server started", { url });
      // Pre-load the embedder so the first real semantic query is instant.
      indexStatus()
        .then((s) => (s.chunkRows > 0 ? search(["warmup"], {}, 1) : undefined))
        .catch((err) =>
          log("warn", "warmup failed", { error: err instanceof Error ? err.message : String(err) }),
        );
      if (opts.open) openBrowser(url);
    });
  });
}
