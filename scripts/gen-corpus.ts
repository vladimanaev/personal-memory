/**
 * Deterministic synthetic-corpus generator for retrieval verification.
 * Run from a SCRATCH directory (the CLI roots everything at process.cwd()):
 *
 *   cd /path/to/scratch && npx tsx /path/to/repo/scripts/gen-corpus.ts
 *
 * Writes ~4,000 entries over 3 years (~100 people, 12 teams, 60 tags) plus
 * 20 "needle" entries — unique facts attached to rare people — and a
 * `needles.json` manifest for the verification script. Never run it inside
 * the real repo.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
if (existsSync(join(ROOT, ".git")) || existsSync(join(ROOT, "package.json"))) {
  throw new Error("refusing to generate a synthetic corpus inside a repo/package — run from an empty scratch dir");
}

// mulberry32 — tiny seeded PRNG, deterministic across runs
function rng(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(42);
const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
const pickN = <T>(xs: T[], n: number): T[] => {
  const out = new Set<T>();
  while (out.size < Math.min(n, xs.length)) out.add(pick(xs));
  return [...out];
};

const FIRST = ["ana", "boris", "chen", "dana", "eli", "fara", "gil", "hila", "ido", "jon", "karin", "lior", "maya", "noam", "orly", "pini", "rina", "shay", "tomer", "uri"];
const LAST = ["levi", "cohen", "mizrahi", "peretz", "biton", "dahan", "avraham", "friedman", "katz", "shapiro"];
const PEOPLE = FIRST.flatMap((f) => LAST.slice(0, 5).map((l) => `${f}-${l}`)); // 100
const TEAMS = ["demand-core", "ai-rnd", "supply", "platform", "data-eng", "infra", "growth", "mobile", "web", "sre", "bi", "creative"];
const TOPICS = ["latency", "budget", "roadmap", "hiring", "attrition", "migration", "incident", "rollout", "experiment", "pricing", "quota", "onboarding", "review", "promotion", "outage", "capacity", "vendor", "audit", "training", "offsite", "reorg", "okr", "forecast", "churn", "retention", "pipeline", "model", "dataset", "inference", "serving", "cache", "queue", "sharding", "kafka", "spark", "airflow", "dashboard", "alerting", "oncall", "runbook", "postmortem", "sla", "slo", "compliance", "gdpr", "security", "penetration", "backlog", "sprint", "velocity", "debt", "refactor", "monolith", "microservice", "gateway", "auth", "billing", "invoice", "payout", "revenue"]; // 60 tags
const TYPES = ["event", "decision", "1on1", "hiring", "incident", "achievement", "feedback", "meeting", "note"];
const VERBS = ["discussed", "shipped", "escalated", "postponed", "approved", "measured", "reviewed", "blocked", "unblocked", "planned"];
const OBJECTS = ["the quarterly plan", "a staged rollout", "the error budget", "capacity limits", "vendor pricing", "team staffing", "the on-call rotation", "an A/B test", "the data retention policy", "cross-team dependencies"];

function dateAt(i: number, total: number): string {
  // spread evenly over 2023-07-01 .. 2026-06-30, with jitter
  const start = Date.UTC(2023, 6, 1);
  const end = Date.UTC(2026, 5, 30);
  const t = start + ((end - start) * i) / total + rand() * 86400e3 * 3;
  return new Date(Math.min(t, end)).toISOString().slice(0, 10);
}

function fmYaml(fm: Record<string, unknown>): string {
  const lines = ["---"];
  for (const [k, v] of Object.entries(fm)) {
    if (Array.isArray(v)) lines.push(`${k}:\n${v.map((x) => `  - ${x}`).join("\n")}`);
    else lines.push(`${k}: ${JSON.stringify(v)}`);
  }
  lines.push("---");
  return lines.join("\n");
}

async function writeMd(id: string, date: string, fm: Record<string, unknown>, body: string) {
  const [y, m] = date.split("-");
  const dir = join(ROOT, "memory", "entries", y!, m!);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${id}.md`), `${fmYaml(fm)}\n\n${body}\n`, "utf8");
}

async function main() {
  const TOTAL = 4000;
  for (let i = 0; i < TOTAL; i++) {
    const date = dateAt(i, TOTAL);
    const tags = pickN(TOPICS, 1 + Math.floor(rand() * 3));
    const people = pickN(PEOPLE, 1 + Math.floor(rand() * 3));
    const team = pick(TEAMS);
    const type = pick(TYPES);
    const title = `${tags[0]} ${pick(VERBS)} with ${people[0]} #${String(i).padStart(4, "0")}`;
    const id = `${date}-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60)}`;
    const body = [
      `${people.join(", ")} ${pick(VERBS)} ${pick(OBJECTS)} for ${team} — focus on ${tags.join(", ")}.`,
      `Context: ${pick(OBJECTS)} was ${pick(VERBS)} last cycle; ${pick(TOPICS)} and ${pick(TOPICS)} remain open.`,
      rand() > 0.5 ? `Next step: revisit ${pick(TOPICS)} with ${pick(PEOPLE)} before end of quarter.` : `No follow-up needed.`,
    ].join("\n\n");
    await writeMd(id, date, { id, date, type, title, people, teams: [team], tags }, body);
  }

  // Needles: unique fact + a rare person who appears nowhere else.
  const needles: { id: string; person: string; fact: string; date: string }[] = [];
  for (let n = 0; n < 20; n++) {
    const person = `needle-person-${String(n).padStart(2, "0")}`;
    const fact = `codeword-${n}-zephyr-quokka`;
    const date = dateAt(n * 190 + 50, TOTAL);
    const title = `Rare decision involving ${person} (${fact})`;
    const id = `${date}-needle-${String(n).padStart(2, "0")}`;
    const body = `${person} made a rare call: adopt ${fact} as the internal protocol name.\n\nThis is the only entry mentioning ${fact}; it must always be retrievable.`;
    await writeMd(id, date, { id, date, type: "decision", title, people: [person], teams: [pick(TEAMS)], tags: ["needle-check"] }, body);
    needles.push({ id, person, fact, date });
  }

  await writeFile(join(ROOT, "needles.json"), JSON.stringify(needles, null, 2), "utf8");
  console.log(`✓ generated ${TOTAL} entries + ${needles.length} needles under ${ROOT}/memory`);
}

main();
