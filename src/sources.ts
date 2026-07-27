import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import matter from "gray-matter";
import { SourceSchema, type Source } from "./schema.js";
import { ROOT, MEMORY_DIR } from "./ingest.js";

/**
 * Reference-source files — one per authoritative directory the store may
 * consult, resolved from the same two layers as connectors:
 *
 * - `sources/<name>.md` — generic, git-tracked TEMPLATES. No personal
 *   config (real commands, org names) belongs here.
 * - `memory/sources/<name>.md` — private OVERRIDES, living inside the
 *   gitignored memory/ dir. When an override exists for a name it fully
 *   replaces the template.
 *
 * Sources never gate a write: they only make suggestions and repairs smarter
 * (maintenance slug hygiene, verify-then-mint slug creation). Every consumer
 * must degrade to today's behavior when a source is disabled, missing, or its
 * lookup fails.
 */
export const SOURCES_DIR = join(ROOT, "sources");
export const PRIVATE_SOURCES_DIR = join(MEMORY_DIR, "sources");

export interface SourceFile {
  /** Filename stem; present even when the file failed validation. */
  name: string;
  path: string;
  raw: string;
  /** Which layer the file was resolved from. */
  origin: "template" | "override";
  /** Parsed frontmatter + body — absent when `error` is set. */
  fm?: Source;
  body?: string;
  error?: string;
}

/**
 * Parse + validate one source file's text. Throws with a readable message
 * on YAML/schema errors or a frontmatter `name` that doesn't match the file.
 */
export function parseSource(raw: string, expectedName: string): { fm: Source; body: string } {
  const { data, content } = matter(raw);
  const parsed = SourceSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(
      `invalid source frontmatter:\n` +
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
 * Load every source, merging the two layers: a private override in
 * `memory/sources/` wins over the template of the same name in `sources/`.
 * Per-file errors are collected, not thrown, so callers (CLI report) can
 * still open a broken file to fix it.
 */
export async function loadSources(
  templatesDir = SOURCES_DIR,
  overridesDir = PRIVATE_SOURCES_DIR,
): Promise<SourceFile[]> {
  const [templates, overrides] = await Promise.all([listMd(templatesDir), listMd(overridesDir)]);
  const overrideSet = new Set(overrides);
  const files = [
    ...templates
      .filter((f) => !overrideSet.has(f))
      .map((f) => ({ file: f, dir: templatesDir, origin: "template" as const })),
    ...overrides.map((f) => ({ file: f, dir: overridesDir, origin: "override" as const })),
  ].sort((a, b) => a.file.localeCompare(b.file));
  return Promise.all(
    files.map(async ({ file, dir, origin }) => {
      const name = file.slice(0, -3);
      const path = join(dir, file);
      const raw = await readFile(path, "utf8");
      try {
        const { fm, body } = parseSource(raw, name);
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

export const relSource = (p: string) => relative(ROOT, p);

// ---------------- lookups ----------------

/** One row of a lookup command's JSON-array output. */
export interface DirectoryMatch {
  name: string;
  id?: string;
  title?: string;
  team?: string;
}

/** Runs a prepared lookup command, returns stdout. Injectable for tests. */
export type LookupRunner = (command: string) => Promise<string>;

const LOOKUP_TIMEOUT_MS = 10_000;
const execAsync = promisify(exec);

const defaultRunner: LookupRunner = async (command) => {
  const { stdout } = await execAsync(command, { timeout: LOOKUP_TIMEOUT_MS });
  return stdout;
};

/** A slug is the query: `jane-doe` → `jane doe` (directories index names). */
export const slugQuery = (slug: string) => slug.replace(/-/g, " ");

/** Substitute `{query}` shell-quoted — the user's command runs in a shell. */
export function buildLookupCommand(template: string, query: string): string {
  return template.replaceAll("{query}", `'${query.replace(/'/g, `'\\''`)}'`);
}

const isMatch = (m: unknown): m is DirectoryMatch =>
  typeof m === "object" && m !== null && typeof (m as { name?: unknown }).name === "string";

/**
 * Run one lookup. Returns the parsed matches, or null when the source is
 * unusable (command failed/timed out, non-JSON, not an array of {name})
 * — degradation, never a throw. `[]` means the directory answered "nobody".
 */
export async function lookupDirectory(
  source: Source,
  query: string,
  run: LookupRunner = defaultRunner,
): Promise<DirectoryMatch[] | null> {
  try {
    const parsed: unknown = JSON.parse(await run(buildLookupCommand(source.lookup.command, query)));
    if (!Array.isArray(parsed) || !parsed.every(isMatch)) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ---------------- slug-suggestion reconciliation ----------------

/** The slice of a merge suggestion that reconciliation reads and adjusts. */
export interface MergeSuggestionLike {
  kind: string;
  from: string;
  to: string;
  confidence: number;
  reasons: string[];
}

/** Directory confirmation is strong evidence — near the engine's 0.98 cap. */
const DIRECTORY_CONFIRMED_CONFIDENCE = 0.95;

const matchLabel = (m: DirectoryMatch) => (m.id ? `${m.name} (${m.id})` : m.name);
const matchIdentity = (m: DirectoryMatch) => m.id ?? m.name;

/**
 * Check each person/team merge suggestion against the first enabled source of
 * its kind. A slug "resolves" only on exactly one match — zero or multiple
 * matches, a failed lookup, or no usable source all leave the suggestion
 * exactly as it was (hard requirement: sources degrade to today's behavior).
 *
 * - both slugs resolve to DISTINCT identities → the suggestion is dismissed
 *   (returned separately with the reason, for reporting)
 * - both resolve to the SAME identity → confidence is boosted and the reason
 *   is appended
 */
export async function reconcileSuggestions<T extends MergeSuggestionLike>(
  suggestions: T[],
  sources: SourceFile[],
  run: LookupRunner = defaultRunner,
): Promise<{ kept: T[]; dismissed: { suggestion: T; reason: string }[] }> {
  const usable = sources.filter((s) => !s.error && s.fm!.enabled);
  const sourceFor = (kind: string) => usable.find((s) => s.fm!.kind === kind);
  const kept: T[] = [];
  const dismissed: { suggestion: T; reason: string }[] = [];
  // One lookup per slug per source, however many suggestions mention it.
  const cache = new Map<string, Promise<DirectoryMatch[] | null>>();
  const lookup = (source: SourceFile, slug: string) => {
    const key = `${source.name}|${slug}`;
    let hit = cache.get(key);
    if (!hit) {
      hit = lookupDirectory(source.fm!, slugQuery(slug), run);
      cache.set(key, hit);
    }
    return hit;
  };

  for (const s of suggestions) {
    const source = sourceFor(s.kind);
    if (!source) {
      kept.push(s);
      continue;
    }
    const [from, to] = await Promise.all([lookup(source, s.from), lookup(source, s.to)]);
    if (!from || !to || from.length !== 1 || to.length !== 1) {
      kept.push(s); // unresolved — behave exactly as without sources
      continue;
    }
    const [mf] = from as [DirectoryMatch];
    const [mt] = to as [DirectoryMatch];
    if (matchIdentity(mf) === matchIdentity(mt)) {
      kept.push({
        ...s,
        confidence: Math.max(s.confidence, DIRECTORY_CONFIRMED_CONFIDENCE),
        reasons: [...s.reasons, `${source.name}: '${s.from}' and '${s.to}' both resolve to ${matchLabel(mf)}`],
      });
    } else {
      dismissed.push({
        suggestion: s,
        reason: `${source.name}: '${s.from}' → ${matchLabel(mf)}, '${s.to}' → ${matchLabel(mt)} — distinct identities`,
      });
    }
  }
  return { kept, dismissed };
}
