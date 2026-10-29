import { z } from "zod";

/**
 * Memory entry frontmatter — the typed contract for every Markdown memory file.
 * Raw entries are the immutable source of truth; `summary` entries are an
 * additive compaction layer that back-link to their sources.
 */
export const MEMORY_TYPES = [
  "event",
  "decision",
  "todo",
  "pending-decision",
  "1on1",
  "hiring",
  "incident",
  "achievement",
  "feedback",
  "meeting",
  "note",
  "summary",
] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];

/** The type enum on its own, so derived stores can validate a `type` column. */
export const MemoryTypeSchema = z.enum(MEMORY_TYPES);

const isoDate = z.preprocess(
  // YAML auto-parses unquoted dates into JS Date objects; normalize to ISO string.
  (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v),
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be ISO YYYY-MM-DD"),
);

const slug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, "must be a lower-kebab slug");

export const FrontmatterSchema = z
  .object({
    id: slug.describe("stable, date-prefixed slug, e.g. 2026-06-28-acme-kickoff"),
    date: isoDate,
    type: MemoryTypeSchema,
    title: z.string().min(1),
    people: z.array(slug).default([]),
    teams: z.array(slug).default([]),
    tags: z.array(slug).default([]),
    /** Only on `type: summary` entries — ids of the raw entries compacted. */
    sources: z.array(slug).optional(),
    /**
     * Canonical EXTERNAL identifiers this entry was captured from, e.g.
     * `slack:<channel-id>:<ts>`, `gmail:<thread-id>`. Unlike `sources` (slugs of
     * other entries), these are raw `scheme:rest` strings and are the dedup
     * anchor: a re-capture carrying the same source id updates this entry in
     * place instead of creating a duplicate.
     */
    source_ids: z.array(z.string().min(1)).optional(),
    /**
     * Ids of EARLIER entries this entry is a later development of (note →
     * pending-decision → decision). Set on the later entry; the reverse map is
     * derived at read time. Multi-parent allowed (one decision can resolve
     * several pending items).
     */
    follows: z.array(slug).optional(),
    /**
     * Last-refresh date (ISO). `date` stays immutable (first-seen / event date);
     * `updated` records when a same-source re-capture last changed this entry.
     */
    updated: isoDate.optional(),
    /**
     * Present ONLY on a shared-graph copy whose BODY was deliberately replaced
     * by a user-approved redaction or condensation, via the review queue.
     * Holds the home entry's BODY hash at approval time.
     *
     * This is what makes the divergence *declared* rather than drift: without
     * it, any byte difference between copies is a bug that `graphs sync`
     * repairs from the home. With it, `graphs sync` can tell an approved
     * variant from drift, and a current variant from one whose home has since
     * moved on. Never present on the default-graph (home) copy — the home is
     * not a variant of anything.
     *
     * Body-only on purpose: a variant's frontmatter stays synced with its home,
     * so tag merges and chain links still propagate. Hashing the whole entry
     * would mark every variant in the store stale on any frontmatter change.
     * The corollary is that a sensitive *title* cannot be redacted — such an
     * entry is declined, not summarized.
     */
    variant_of_hash: z
      .string()
      .regex(/^[0-9a-f]{16}$/, "must be a 16-hex body hash")
      .optional(),
    /**
     * When an open `todo` / `pending-decision` is due (ISO), inferred at
     * capture from the entry and its context ("by Thursday", a meeting date).
     * Lets readers flag overdue items; it never settles one by itself.
     */
    due: isoDate
      .refine((s) => {
        const t = new Date(`${s}T00:00:00Z`); // Invalid Date (month 13…) throws on toISOString
        return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === s;
      }, "due must be a real calendar date")
      .optional(),
  })
  .strict();

export type Frontmatter = z.infer<typeof FrontmatterSchema>;

/**
 * Connector file frontmatter — `connectors/<name>.md`. Each connected source
 * (gmail, slack, raw-capture, …) gets one file: frontmatter = mechanical fetch
 * config, body = the natural-language extraction prompt an agent applies when
 * capturing from that source. The envelope is strict; `fetch` is freeform
 * because its keys are connector-specific and consumed by an LLM, not by code.
 */
export const ConnectorSchema = z
  .object({
    /** Must equal the filename stem (`connectors/<name>.md`). */
    name: slug,
    enabled: z.boolean().default(true),
    /** Canonical source-id pattern for dedup, e.g. `gmail:<thread-id>`. */
    source_id_scheme: z.string().min(1),
    /**
     * Pull config read by the pull-memories skill (gmail: queries; slack:
     * channels). Omitted entirely for push-only connectors like raw-capture.
     * `lookback_days` is the one shared key: the default window when no
     * last-pull state exists.
     */
    fetch: z
      .object({ lookback_days: z.number().int().positive().optional() })
      .catchall(z.unknown())
      .optional(),
  })
  .strict();

export type Connector = z.infer<typeof ConnectorSchema>;

/**
 * A graph name. `default` is the built-in home graph at `memory/` — secret,
 * local-only, where every capture lands; every other graph is a user-created
 * shareable store under `memory-graphs/<slug>/`. Membership is derived from
 * where an entry's file(s) sit on disk — never stored in frontmatter, so
 * location and metadata can't drift.
 */
export type GraphId = string;
export const DEFAULT_GRAPH = "default";

/** Canonical membership order: the default graph first, then lexicographic. */
export function sortGraphs(gs: Iterable<string>): string[] {
  return [...new Set(gs)].sort((a, b) =>
    a === DEFAULT_GRAPH ? -1 : b === DEFAULT_GRAPH ? 1 : a.localeCompare(b),
  );
}

/**
 * Per-graph manifest — `memory-graphs/<slug>/GRAPH.md`. Frontmatter is the
 * machine-readable envelope; the body is the graph's description +
 * eligibility notes agents consult before copying/moving anything there.
 * Travels with the store when shared.
 */
export const GraphManifestSchema = z
  .object({
    /** Must equal the directory slug (`memory-graphs/<name>/`). */
    name: slug,
    display_name: z.string().min(1).optional(),
    enabled: z.boolean().default(true),
    created: isoDate.optional(),
  })
  .strict();

export type GraphManifest = z.infer<typeof GraphManifestSchema>;

/**
 * Reference-source file frontmatter — `sources/<name>.md`. A source is an
 * authoritative directory (company directory, LDAP export, contacts CLI) the
 * store may CONSULT — never a capture path. Frontmatter = the lookup contract;
 * body = agent guidance (when to consult it, how to act on matches), exactly
 * like connector bodies are extraction prompts. Lookups are user-supplied
 * local commands; the store never ships credentials or fetches anything itself.
 */
export const SourceSchema = z
  .object({
    /** Must equal the filename stem (`sources/<name>.md`). */
    name: slug,
    /** What this source resolves — checked against person/team slug kinds. */
    kind: z.enum(["person", "team"]),
    enabled: z.boolean().default(true),
    lookup: z
      .object({
        /**
         * Command printing a JSON array of matches for `{query}` (substituted
         * shell-quoted), e.g. `[{"name": "Jane Doe", "id": "jdoe", …}]`.
         * The placeholder must be an unquoted token: the CLI single-quotes the
         * value itself, and a template like `--name "{query}"` would neuter
         * that quoting and let query text reach the shell.
         */
        command: z
          .string()
          .min(1)
          .refine((c) => c.includes("{query}"), "must contain the {query} placeholder")
          .refine(
            (c) => !/["']\{query\}|\{query\}["']/.test(c),
            "{query} must be an unquoted token — the CLI shell-quotes it itself",
          ),
        /** Optional command that refreshes a local cache of the directory. */
        refresh: z.string().min(1).optional(),
        /** How stale that cache may get before `refresh` is worth running. */
        cache_ttl_days: z.number().int().positive().optional(),
      })
      .strict(),
  })
  .strict();

export type Source = z.infer<typeof SourceSchema>;

/** A fully-parsed memory: validated frontmatter + Markdown body + membership. */
export interface MemoryEntry extends Frontmatter {
  body: string;
  /** Home copy's path: the private copy when a member of private, else the sole copy. */
  path: string;
  /** Every materialization, graph → absolute file path. */
  paths: Record<string, string>;
  /**
   * Sorted membership (`sortGraphs`); never empty; length > 1 implies the
   * entry is a private member (copies originate from private). Derived from
   * file locations; excluded from the content hash.
   */
  graphs: string[];
  /**
   * Shared graphs whose copy is a declared variant: graph → the home BODY hash
   * that copy was approved against. Absent when no copy diverges. Derived from
   * the copies' own `variant_of_hash`, never from the home's frontmatter, and
   * excluded from the content hash — publishing a variant must not change the
   * logical entry's identity.
   *
   * A graph in here holds text the private home does not. Readers that quote
   * an entry into shared output must read that copy, not `body`.
   */
  variants?: Record<string, string>;
}

/** Whether this entry's copy in `graph` is a declared variant of the home. */
export function isVariantIn(e: Pick<MemoryEntry, "variants">, graph: string): boolean {
  return e.variants?.[graph] !== undefined;
}

/** Memberships other than private (the labels shown in listings). */
export function sharedGraphs(e: Pick<MemoryEntry, "graphs">): string[] {
  return e.graphs.filter((g) => g !== DEFAULT_GRAPH);
}

/**
 * A row stored in the vector index (one per chunk of an entry). Slug lists
 * (people/teams/tags) are stored as pipe-delimited strings — `"|jane|bob|"`,
 * `""` when empty — so metadata filters can prefilter the vector search via
 * SQL `LIKE` without LanceDB's Arrow list-type pitfalls (empty-array
 * inference, unverified list predicates). The JS filter over the Markdown
 * source of truth remains the final authority.
 */
export interface MemoryRecord {
  /** `${id}#${chunkIndex}` — unique per chunk. */
  rowId: string;
  id: string;
  chunkIndex: number;
  date: string;
  type: MemoryType;
  title: string;
  path: string;
  /** Pipe-delimited slugs, e.g. `"|jane|bob|"`; empty string when none. */
  people: string;
  teams: string;
  tags: string;
  /** Pipe-delimited sorted membership, e.g. `"|private|team-x|"` — enables SQL scope prefilters. */
  graphs: string;
  /** Content hash of the whole source entry — drives incremental indexing. */
  hash: string;
  /** The text that was embedded (title + chunk of body). */
  text: string;
  vector: number[];
}

/** Pack a slug array into its pipe-delimited index-column form. */
export function packSlugs(xs: string[]): string {
  return xs.length ? `|${xs.join("|")}|` : "";
}

/**
 * Pipe-delimited list column (same shape as `packSlugs`, for lists whose
 * members are not slugs — source ids, follows, sources). Members must never
 * contain `|`; `normalizeSourceId` enforces that for source ids.
 */
export function packList(xs: string[] | undefined): string {
  return xs?.length ? `|${xs.join("|")}|` : "";
}

export function unpackList(s: string): string[] {
  return s ? s.slice(1, -1).split("|") : [];
}

/** One row per logical entry in a new-format slot's `entries` table (Phase 3 catalog). */
export interface CatalogEntryRow {
  id: string;
  date: string;
  /** ISO date or "" when unset. */
  updated: string;
  type: string;
  title: string;
  people: string;
  teams: string;
  tags: string;
  graphs: string;
  follows: string;
  sources: string;
  source_ids: string;
  hash: string;
  /** Home copy's path, relative to the repo root. */
  home_path: string;
  /** JSON of graph → repo-relative path for every copy. */
  paths_json: string;
  /** Pre-tokenized `entrySearchText` (space-joined `tokenize` output) — the FTS column. */
  lex: string;
  /** Token count (BM25 document length). */
  len: number;
  /** Number of chunk rows this entry has in the `memory` table. */
  chunks: number;
}

/** One row per materialized file in a new-format slot's `files` table. */
export interface CatalogFileRow {
  relpath: string;
  graph: string;
  id: string;
  mtimeMs: number;
  size: number;
  hash: string;
}
