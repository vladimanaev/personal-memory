import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import { RoutingSchema, type Routing } from "./schema.js";
import { ROOT, MEMORY_DIR } from "./ingest.js";

/**
 * The graph-routing prompt — ONE fixed-name file resolved from two layers,
 * exactly like connectors:
 *
 * - `routing/graph-routing.md` — generic, git-tracked default TEMPLATE.
 * - `memory/routing/graph-routing.md` — private OVERRIDE inside the gitignored
 *   memory/ dir; when present it fully replaces the template.
 *
 * Frontmatter = the machine-readable envelope (`enabled`, `default_graph`);
 * body = the natural-language classification prompt an agent applies to every
 * new capture. Edits (by hand or the web UI's PUT) go to the override layer.
 */
export const ROUTING_NAME = "graph-routing";
export const ROUTING_DIR = join(ROOT, "routing");
export const PRIVATE_ROUTING_DIR = join(MEMORY_DIR, "routing");
const TEMPLATE_PATH = join(ROUTING_DIR, `${ROUTING_NAME}.md`);
const OVERRIDE_PATH = join(PRIVATE_ROUTING_DIR, `${ROUTING_NAME}.md`);

export interface RoutingFile {
  name: string;
  path: string;
  raw: string;
  /** Which layer the file was resolved from. */
  origin: "template" | "override";
  /** Parsed frontmatter + body — absent when `error` is set. */
  fm?: Routing;
  body?: string;
  error?: string;
}

/** Parse + validate the routing file's text. Throws readable errors. */
export function parseRouting(raw: string): { fm: Routing; body: string } {
  const { data, content } = matter(raw);
  const parsed = RoutingSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(
      `invalid routing frontmatter:\n` +
        parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n"),
    );
  }
  if (parsed.data.name !== ROUTING_NAME) {
    throw new Error(`frontmatter name '${parsed.data.name}' must be '${ROUTING_NAME}'`);
  }
  return { fm: parsed.data, body: content.trim() };
}

/**
 * Load the routing prompt: the private override wins over the template.
 * Parse errors are captured (not thrown) so the CLI report / UI editor can
 * still open a broken file to fix it. Returns null when neither layer exists.
 */
export async function loadRouting(): Promise<RoutingFile | null> {
  const layer = existsSync(OVERRIDE_PATH)
    ? { path: OVERRIDE_PATH, origin: "override" as const }
    : existsSync(TEMPLATE_PATH)
      ? { path: TEMPLATE_PATH, origin: "template" as const }
      : null;
  if (!layer) return null;
  const raw = await readFile(layer.path, "utf8");
  try {
    const { fm, body } = parseRouting(raw);
    return { name: ROUTING_NAME, path: layer.path, raw, origin: layer.origin, fm, body };
  } catch (err) {
    return {
      name: ROUTING_NAME,
      path: layer.path,
      raw,
      origin: layer.origin,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Validate + atomically write the routing prompt. Always writes the PRIVATE
 * override layer (`memory/routing/`) — the template stays pristine, and the
 * personalized prompt never reaches the pushable repo. The path is fixed; no
 * caller-supplied path ever reaches the filesystem.
 */
export async function writeRouting(raw: string): Promise<string> {
  parseRouting(raw); // throws on invalid content — nothing is written
  await mkdir(PRIVATE_ROUTING_DIR, { recursive: true });
  const tmp = `${OVERRIDE_PATH}.tmp`;
  await writeFile(tmp, raw, "utf8");
  await rename(tmp, OVERRIDE_PATH);
  return OVERRIDE_PATH;
}
