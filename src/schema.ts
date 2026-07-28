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
    type: z.enum(MEMORY_TYPES),
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
 * Public-eligibility prompt frontmatter — `routing/graph-routing.md`
 * (git-tracked default template) or `memory/routing/graph-routing.md`
 * (private override that fully replaces it). The body is the
 * natural-language criteria for what may enter the PUBLIC graph — applied
 * during the user-confirmed promotion review (and the rare explicit
 * "log as public" capture); capture itself always lands private.
 */
export const RoutingSchema = z
  .object({
    /** Must equal the filename stem (`graph-routing`). */
    name: slug,
    /** false = skip routing entirely; every capture goes to `default_graph`. */
    enabled: z.boolean().default(true),
    /** Machine-readable fallback verdict — applied on any doubt. */
    default_graph: slug.default("private"),
  })
  .strict();

export type Routing = z.infer<typeof RoutingSchema>;

/**
 * A graph name. `private` is the local-only `memory/` repo; every other graph
 * is a user-created shareable store under `memory-graphs/<slug>/`. Membership
 * is derived from where an entry's file(s) sit on disk — never stored in
 * frontmatter, so location and metadata can't drift.
 */
export type GraphId = string;
export const PRIVATE_GRAPH = "private";

/** Canonical membership order: private first, then lexicographic. */
export function sortGraphs(gs: Iterable<string>): string[] {
  return [...new Set(gs)].sort((a, b) =>
    a === PRIVATE_GRAPH ? -1 : b === PRIVATE_GRAPH ? 1 : a.localeCompare(b),
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
}

/** Memberships other than private (the labels shown in listings). */
export function sharedGraphs(e: Pick<MemoryEntry, "graphs">): string[] {
  return e.graphs.filter((g) => g !== PRIVATE_GRAPH);
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
