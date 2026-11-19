import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { REPO, STORE_MOD, runInStore, seedStore, type SeedEntry } from "./test-store.js";

const ENV = {
  ...process.env,
  MEMORY_EMBEDDINGS: "fake",
  MEMORY_QUIET: "1",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
};

function run(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, ["--import", join(REPO, "node_modules", "tsx", "dist", "loader.mjs"), join(REPO, "src", "cli.ts"), ...args], {
      cwd, env: ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { status: e.status, stdout: e.stdout, stderr: e.stderr };
  }
}

const DEC = "2026-03-01-vendor-choice";
const SID = "slack:CTEST:1700000000.1";
const DEC_BODY = "We chose vendor alpha for the pilot because of price.";
const ENTRIES: SeedEntry[] = [
  { id: DEC, date: "2026-03-01", type: "decision", title: "Vendor choice", people: ["ana-levi"], body: DEC_BODY, source_ids: [SID] },
];

/** All entry files under the default store, by id. */
function files(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (d.isDirectory()) walk(join(dir, d.name));
      else if (d.name.endsWith(".md")) out[d.name.slice(0, -3)] = readFileSync(join(dir, d.name), "utf8");
    }
  };
  walk(join(root, "memory", "entries"));
  return out;
}

function fixture(entries: SeedEntry[] = ENTRIES): string {
  const root = mkdtempSync(join(tmpdir(), "pm-add-split-"));
  seedStore(root, entries);
  runInStore(root, `const s = await import(${STORE_MOD}); console.log(JSON.stringify(await s.syncIndex()));`);
  return root;
}

const add = (root: string, type: string | undefined, body: string, extra: string[] = []) =>
  run(root, ["add", "--title", "Vendor choice", ...(type ? ["--type", type] : []), "--date", "2026-03-01",
    "--source-ids", SID, "--body", body, ...extra]);

test("add: a different --type never overwrites a settled entry; same-type re-run refreshes the new one", { timeout: 300_000 }, () => {
  const root = fixture();
  try {
    const before = files(root)[DEC]!;

    // The body is identical to the decision's: the near-duplicate guard must not block the split,
    // and the derived id (same date + title) collides, so it gets a type suffix.
    // A tiny --dup-threshold makes the guard fire on any hit, so only the exclusion lets this through
    // (the control below proves the guard fires for a capture without the source id).
    const control = run(root, ["add", "--title", "Vendor choice", "--type", "note", "--date", "2026-03-05",
      "--body", DEC_BODY, "--dup-threshold", "0.01"]);
    assert.equal(control.status, 2, "control: the semantic guard blocks an unanchored near-duplicate");
    const r1 = add(root, "note", DEC_BODY, ["--dup-threshold", "0.01"]);
    assert.equal(r1.status, 0, r1.stderr);
    const NOTE = `${DEC}-note`;
    assert.match(r1.stdout, new RegExp(`↳ ${DEC} is a decision; not overwriting — created ${NOTE} \\(note\\) linked via sources`));
    assert.ok(!r1.stdout.includes("↻ matches existing"));
    let f = files(root);
    assert.equal(Object.keys(f).length, 2);
    assert.equal(f[DEC], before, "the decision is untouched byte-for-byte");
    const note = matter(f[NOTE]!);
    assert.equal(note.data.type, "note");
    assert.deepEqual(note.data.sources, [DEC]);
    assert.deepEqual(note.data.source_ids, [SID]);

    // Re-running the same capture refreshes the note, not the decision, and adds no third entry.
    const r2 = add(root, "note", "Updated thread summary: alpha pilot proceeds next month.");
    assert.equal(r2.status, 0, r2.stderr);
    assert.match(r2.stdout, new RegExp(`↳ ${DEC} is a decision; not overwriting — updating ${NOTE} \\(note\\) linked via sources`));
    f = files(root);
    assert.equal(Object.keys(f).length, 2);
    assert.equal(f[DEC], before);
    const refreshed = matter(f[NOTE]!);
    assert.match(refreshed.content, /alpha pilot proceeds/);
    assert.deepEqual(refreshed.data.sources, [DEC]);

    // A third capture with yet another type gets its own id and links BOTH matched entries.
    const r3 = add(root, "event", "A calendar event for the pilot kickoff.");
    assert.equal(r3.status, 0, r3.stderr);
    f = files(root);
    assert.equal(Object.keys(f).length, 3);
    assert.equal(f[DEC], before);
    assert.deepEqual(matter(f[`${DEC}-event`]!).data.sources.sort(), [DEC, NOTE].sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("add: --sources passed with a type split are merged after the linked ids", { timeout: 300_000 }, () => {
  const other: SeedEntry = { id: "2026-03-02-other", date: "2026-03-02", type: "note", title: "Other", body: "Something unrelated entirely." };
  const root = fixture([...ENTRIES, other]);
  try {
    const r = add(root, "note", "Thread recap of the vendor discussion.", ["--sources", "2026-03-02-other"]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(matter(files(root)[`${DEC}-note`]!).data.sources, [DEC, "2026-03-02-other"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("add: same type updates in place; --type omitted is unchanged", { timeout: 300_000 }, () => {
  const root = fixture();
  try {
    const r1 = add(root, "decision", "Revised: we chose vendor beta after all.");
    assert.equal(r1.status, 0, r1.stderr);
    assert.match(r1.stdout, new RegExp(`↻ matches existing ${DEC} via ${SID}`));
    assert.ok(!r1.stdout.includes("↳"));
    let f = files(root);
    assert.equal(Object.keys(f).length, 1);
    assert.match(matter(f[DEC]!).content, /vendor beta/);

    const r2 = add(root, undefined, "Revised again: vendor gamma.");
    assert.equal(r2.status, 0, r2.stderr);
    assert.match(r2.stdout, new RegExp(`↻ matches existing ${DEC} via ${SID}`));
    assert.ok(!r2.stdout.includes("↳"));
    f = files(root);
    assert.equal(Object.keys(f).length, 1);
    const d = matter(f[DEC]!);
    assert.equal(d.data.type, "decision");
    assert.match(d.content, /vendor gamma/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("add: an open todo with a different --type still errors as before", { timeout: 300_000 }, () => {
  const todo: SeedEntry = { id: "2026-03-01-send-quote", date: "2026-03-01", type: "todo", title: "Send quote", body: "Send the quote to the vendor.", source_ids: ["slack:CTEST:1700000500.1"] };
  const root = fixture([todo]);
  try {
    const r = run(root, ["add", "--title", "Quote recap", "--type", "note", "--source-ids", "slack:CTEST:1700000500.1", "--body", "Recap of the quote thread."]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /already anchors the open todo 2026-03-01-send-quote — log the outcome as a new entry with --follows 2026-03-01-send-quote/);
    assert.equal(Object.keys(files(root)).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
