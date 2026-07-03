import { z } from "zod";

/**
 * Memory entry frontmatter — the typed contract for every Markdown memory file.
 * Raw entries are the immutable source of truth; `summary` entries are an
 * additive compaction layer that back-link to their sources.
 */
export const MEMORY_TYPES = [
  "event",
  "decision",
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

/** A fully-parsed memory: validated frontmatter + Markdown body + file path. */
export interface MemoryEntry extends Frontmatter {
  body: string;
  path: string;
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
