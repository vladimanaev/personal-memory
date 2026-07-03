import { readFile, readdir, mkdir, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import matter from "gray-matter";
import { ConnectorSchema, type Connector } from "./schema.js";
import { ROOT, INDEX_DIR, MEMORY_DIR } from "./ingest.js";

/**
 * Connector files — one per connected source, resolved from two layers:
 *
 * - `connectors/<name>.md` — generic, git-tracked TEMPLATES. No personal
 *   config (queries, channels, names) belongs here.
 * - `memory/connectors/<name>.md` — private OVERRIDES, living inside the
 *   gitignored memory/ dir (versioned only in its local nested repo). When an
 *   override exists for a name it fully replaces the template.
 *
 * Edits (by hand or via the web UI's PUT endpoint) go to the override layer,
 * so personalization never reaches the pushable repo.
 */
export const CONNECTORS_DIR = join(ROOT, "connectors");
export const PRIVATE_CONNECTORS_DIR = join(MEMORY_DIR, "connectors");

/** Mutable machine state (last_pulled per connector) — disposable derivative. */
export const CONNECTOR_STATE_PATH = join(INDEX_DIR, "connector-state.json");

export interface ConnectorFile {
  /** Filename stem; present even when the file failed validation. */
  name: string;
  path: string;
  raw: string;
  /** Which layer the file was resolved from. */
  origin: "template" | "override";
  /** Parsed frontmatter + body — absent when `error` is set. */
  fm?: Connector;
  body?: string;
  error?: string;
}

export type ConnectorState = Record<string, { last_pulled?: string }>;

/**
 * Parse + validate one connector file's text. Throws with a readable message
 * on YAML/schema errors or a frontmatter `name` that doesn't match the file.
 */
export function parseConnector(
  raw: string,
  expectedName: string,
): { fm: Connector; body: string } {
  const { data, content } = matter(raw);
  const parsed = ConnectorSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(
      `invalid connector frontmatter:\n` +
        parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n"),
    );
  }
  if (parsed.data.name !== expectedName) {
    throw new Error(
      `frontmatter name '${parsed.data.name}' must equal the filename stem '${expectedName}'`,
    );
  }
  return { fm: parsed.data, body: content.trim() };
}

const listMd = async (dir: string): Promise<string[]> =>
  existsSync(dir) ? (await readdir(dir)).filter((f) => f.endsWith(".md")) : [];

/**
 * Load every connector, merging the two layers: a private override in
 * `memory/connectors/` wins over the template of the same name in
 * `connectors/`. Per-file errors are collected, not thrown, so callers
 * (CLI report, UI editor) can still open a broken file to fix it.
 */
export async function loadConnectors(): Promise<ConnectorFile[]> {
  const [templates, overrides] = await Promise.all([
    listMd(CONNECTORS_DIR),
    listMd(PRIVATE_CONNECTORS_DIR),
  ]);
  const overrideSet = new Set(overrides);
  const files = [
    ...templates
      .filter((f) => !overrideSet.has(f))
      .map((f) => ({ file: f, dir: CONNECTORS_DIR, origin: "template" as const })),
    ...overrides.map((f) => ({ file: f, dir: PRIVATE_CONNECTORS_DIR, origin: "override" as const })),
  ].sort((a, b) => a.file.localeCompare(b.file));
  return Promise.all(
    files.map(async ({ file, dir, origin }) => {
      const name = file.slice(0, -3);
      const path = join(dir, file);
      const raw = await readFile(path, "utf8");
      try {
        const { fm, body } = parseConnector(raw, name);
        return { name, path, raw, origin, fm, body };
      } catch (err) {
        return {
          name,
          path,
          raw,
          origin,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
}

/**
 * Validate + atomically write a connector file (tmp + rename in the same dir).
 * Always writes to the PRIVATE override layer (`memory/connectors/`) so edits
 * — typically personalization — never land in the git-tracked templates. The
 * path is built from `name` only — no caller-supplied path ever reaches the
 * filesystem. Returns the path written.
 */
export async function writeConnector(name: string, raw: string): Promise<string> {
  parseConnector(raw, name); // throws on invalid content — nothing is written
  await mkdir(PRIVATE_CONNECTORS_DIR, { recursive: true });
  const path = join(PRIVATE_CONNECTORS_DIR, `${name}.md`);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, raw, "utf8");
  await rename(tmp, path);
  return path;
}

/** Read `.index/connector-state.json`; `{}` when missing or corrupt. */
export async function loadConnectorState(): Promise<ConnectorState> {
  try {
    return JSON.parse(await readFile(CONNECTOR_STATE_PATH, "utf8")) as ConnectorState;
  } catch {
    return {};
  }
}

export const relConnector = (p: string) => relative(ROOT, p);
