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
    assert.match(r1.stdout, new RegExp(`↳ ${DEC} is a decision; not overwriting — created ${NOTE} \\(note\\)$`, "m"));
    assert.ok(!r1.stdout.includes("↻ matches existing"));
    let f = files(root);
    assert.equal(Object.keys(f).length, 2);
    assert.equal(f[DEC], before, "the decision is untouched byte-for-byte");
    const note = matter(f[NOTE]!);
    assert.equal(note.data.type, "note");
    assert.equal(note.data.sources, undefined, "the shared source id is the link; `sources` is not used");
    assert.deepEqual(note.data.source_ids, [SID]);

    // Re-running the same capture refreshes the note, not the decision, and adds no third entry.
    const r2 = add(root, "note", "Updated thread summary: alpha pilot proceeds next month.");
    assert.equal(r2.status, 0, r2.stderr);
    assert.match(r2.stdout, new RegExp(`↻ matches existing ${NOTE} via ${SID}`));
    assert.ok(!r2.stdout.includes("↳"));
    f = files(root);
    assert.equal(Object.keys(f).length, 2);
    assert.equal(f[DEC], before);
    const refreshed = matter(f[NOTE]!);
    assert.match(refreshed.content, /alpha pilot proceeds/);
    assert.equal(refreshed.data.sources, undefined);

  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("add: an explicit --sources passes through a type split unchanged", { timeout: 300_000 }, () => {
  const other: SeedEntry = { id: "2026-03-02-other", date: "2026-03-02", type: "note", title: "Other", body: "Something unrelated entirely." };
  const root = fixture([...ENTRIES, other]);
  try {
    const r = add(root, "note", "Thread recap of the vendor discussion.", ["--sources", "2026-03-02-other"]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(matter(files(root)[`${DEC}-note`]!).data.sources, ["2026-03-02-other"]);
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

const EV = "2026-03-02-vendor-kickoff";
const SIBLINGS: SeedEntry[] = [
  ...ENTRIES,
  { id: EV, date: "2026-03-02", type: "event", title: "Vendor kickoff", body: "Kickoff held for the alpha pilot.", source_ids: [SID] },
];

test("add: a split sits beside every match; the target never depends on row order", { timeout: 300_000 }, () => {
  const root = fixture(SIBLINGS);
  try {
    const f0 = files(root);
    const r1 = add(root, "note", "Thread recap for the pilot.");
    assert.equal(r1.status, 0, r1.stderr);
    assert.deepEqual(matter(files(root)[`${DEC}-note`]!).data.sources, undefined);
    assert.match(r1.stdout, new RegExp(`↳ ${DEC} is a decision, ${EV} is an event; not overwriting — created ${DEC}-note \\(note\\)`));
    assert.equal(files(root)[DEC], f0[DEC]);
    assert.equal(files(root)[EV], f0[EV]);

    // Two same-type matches: each update moves the target's row to the end of the scan,
    // yet the (date, id)-first one is picked every time and its sibling is never touched.
    const twin = "2026-03-03-vendor-choice-twin";
    runInStore(root, `const fs = await import("node:fs"); const p = ${JSON.stringify(join(root, "memory", "entries", "2026", "03", `${twin}.md`))};
      fs.writeFileSync(p, fs.readFileSync(${JSON.stringify(join(root, "memory", "entries", "2026", "03", `${DEC}.md`))}, "utf8").replace(${JSON.stringify(DEC)}, ${JSON.stringify(twin)}).replace("2026-03-01", "2026-03-03"));
      const s = await import(${STORE_MOD}); await s.syncIndex(); console.log("{}");`);
    const twinBefore = files(root)[twin]!;
    for (const body of ["First revision of the decision.", "Second revision of the decision.", "Third revision of the decision."]) {
      const r = add(root, "decision", body);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, new RegExp(`↻ matches existing ${DEC} via ${SID}`));
      assert.match(matter(files(root)[DEC]!).content, new RegExp(body));
      assert.equal(files(root)[twin], twinBefore, "the other same-type match is untouched");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("add: the split line names every match, capped with +N more", { timeout: 300_000 }, () => {
  const many: SeedEntry[] = Array.from({ length: 7 }, (_, i) => ({
    id: `2026-03-0${i + 1}-vendor-step-${i + 1}`, date: `2026-03-0${i + 1}`, type: "decision",
    title: `Vendor step ${i + 1}`, body: `Decision number ${i + 1} on the pilot.`, source_ids: [SID],
  }));
  const root = fixture(many);
  try {
    const before = files(root);
    const r = add(root, "note", "Recap of the whole thread.");
    assert.equal(r.status, 0, r.stderr);
    const line = r.stdout.split("\n").find((l) => l.startsWith("↳"))!;
    for (const m of many.slice(0, 5)) assert.ok(line.includes(`${m.id} is a decision`), line);
    for (const m of many.slice(5)) assert.ok(!line.includes(m.id), "beyond the cap is summarised");
    assert.match(line, /, \+2 more; not overwriting — created /);
    const after = files(root);
    assert.equal(Object.keys(after).length, 8);
    for (const m of many) assert.equal(after[m.id], before[m.id], "every match is untouched");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("add: an incident and an achievement read with 'an'", { timeout: 300_000 }, () => {
  const pair: SeedEntry[] = [
    { id: "2026-03-01-vendor-outage", date: "2026-03-01", type: "incident", title: "Vendor outage", body: "The vendor API was down.", source_ids: [SID] },
    { id: "2026-03-02-vendor-launch", date: "2026-03-02", type: "achievement", title: "Vendor launch", body: "The pilot launched.", source_ids: [SID] },
  ];
  const root = fixture(pair);
  try {
    const bad = run(root, ["add", "--title", "Vendor wrap", "--date", "2026-03-03", "--source-ids", SID, "--body", "Wrap-up."]);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /vendor-outage is an incident; 2026-03-02-vendor-launch is an achievement/);
    const r = add(root, "note", "Recap of the incident thread.");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /↳ 2026-03-01-vendor-outage is an incident, 2026-03-02-vendor-launch is an achievement; not overwriting/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("add: mixed-type matches without --type error and change nothing", { timeout: 300_000 }, () => {
  const root = fixture(SIBLINGS);
  try {
    const before = files(root);
    const r = run(root, ["add", "--title", "Vendor choice", "--date", "2026-03-01", "--source-ids", SID, "--body", "Another pass."]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, new RegExp(`${DEC} is a decision`));
    assert.match(r.stderr, new RegExp(`${EV} is an event`));
    assert.match(r.stderr, /--type .*--update <id>/);
    assert.deepEqual(files(root), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("add: a plain note is retyped in place", { timeout: 300_000 }, () => {
  const note: SeedEntry = { id: "2026-03-01-vendor-note", date: "2026-03-01", type: "note", title: "Vendor note", body: "Early notes on vendors.", source_ids: [SID] };
  const root = fixture([note]);
  try {
    const r = add(root, "decision", "We chose vendor alpha.");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /↻ matches existing 2026-03-01-vendor-note/);
    const f = files(root);
    assert.deepEqual(Object.keys(f), ["2026-03-01-vendor-note"]);
    assert.equal(matter(f["2026-03-01-vendor-note"]!).data.type, "decision");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("add: an open match that is not first still raises the open-item error", { timeout: 300_000 }, () => {
  const todo: SeedEntry = { id: "2026-03-05-send-quote", date: "2026-03-05", type: "todo", title: "Send quote", body: "Send the quote to the vendor.", source_ids: [SID] };
  const root = fixture([...ENTRIES, todo]);
  try {
    const before = files(root);
    const r = add(root, "note", "Recap of the thread.");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /already anchors the open todo 2026-03-05-send-quote — log the outcome as a new entry with --follows 2026-03-05-send-quote/);
    assert.deepEqual(files(root), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("add: a taken derived id gets -<type>, then -<type>-N", { timeout: 300_000 }, () => {
  const taken: SeedEntry = { id: `${DEC}-note`, date: "2026-03-01", type: "event", title: "Unrelated", body: "Holds the first suffixed id.", source_ids: ["slack:CTEST:1700000900.1"] };
  const root = fixture([...ENTRIES, taken]);
  try {
    const r = add(root, "note", "Thread recap.");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`created ${DEC}-note-2 \\(note\\)`));
    assert.deepEqual(matter(files(root)[`${DEC}-note-2`]!).data.sources, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("add: --follows combines with a split; a failed check prints no split line", { timeout: 300_000 }, () => {
  const earlier: SeedEntry = { id: "2026-02-20-earlier-thread", date: "2026-02-20", type: "note", title: "Earlier thread", body: "Background thread before the vendor choice." };
  const root = fixture([...ENTRIES, earlier]);
  try {
    const bad = add(root, "note", "Thread recap.", ["--follows", "2026-02-01-does-not-exist"]);
    assert.notEqual(bad.status, 0);
    assert.ok(!bad.stdout.includes("↳"), "no split line when the capture fails");
    assert.equal(Object.keys(files(root)).length, 2);

    const r = add(root, "note", "Thread recap.", ["--follows", "2026-02-20-earlier-thread"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /↳ .* created /);
    const created = matter(files(root)[`${DEC}-note`]!).data;
    assert.deepEqual(created.follows, ["2026-02-20-earlier-thread"]);
    assert.equal(created.sources, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("add: a note beside a decision is protected from retyping; a third type gets its own entry", { timeout: 300_000 }, () => {
  const root = fixture();
  try {
    assert.equal(add(root, "note", "Thread recap for the pilot.").status, 0);
    const before = files(root);
    const NOTE = `${DEC}-note`;
    assert.equal(Object.keys(before).length, 2);

    const r = add(root, "event", "Calendar entry for the pilot kickoff.");
    assert.equal(r.status, 0, r.stderr);
    const f = files(root);
    assert.equal(Object.keys(f).length, 3);
    assert.equal(f[DEC], before[DEC]);
    assert.equal(f[NOTE], before[NOTE], "the split-off note is not retyped");
    assert.equal(matter(f[`${DEC}-event`]!).data.type, "event");
    assert.match(r.stdout, /created .*-event \(event\)$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("add: --update bypasses the selection, even with mixed-type matches", { timeout: 300_000 }, () => {
  const root = fixture(SIBLINGS);
  try {
    const before = files(root);
    const r = run(root, ["add", "--title", "Vendor kickoff", "--date", "2026-03-02", "--source-ids", SID,
      "--update", EV, "--body", "Kickoff notes, revised."]);
    assert.equal(r.status, 0, r.stderr);
    const f = files(root);
    assert.equal(Object.keys(f).length, 2);
    assert.equal(f[DEC], before[DEC]);
    assert.match(matter(f[EV]!).content, /revised/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("add: a resolved todo among the matches splits instead of erroring", { timeout: 300_000 }, () => {
  const todo: SeedEntry = { id: "2026-03-01-send-quote", date: "2026-03-01", type: "todo", title: "Send quote", body: "Send the quote to the vendor.", source_ids: [SID] };
  const outcome: SeedEntry = { id: "2026-03-04-quote-sent", date: "2026-03-04", type: "note", title: "Quote sent", body: "The quote went out.", follows: [todo.id], source_ids: ["slack:CTEST:1700000800.1"] };
  const root = fixture([todo, outcome]);
  try {
    const before = files(root);
    const r = add(root, "note", "Recap of the quote thread.");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /↳ 2026-03-01-send-quote is a todo; not overwriting — created /);
    const f = files(root);
    assert.equal(Object.keys(f).length, 3);
    assert.equal(f[todo.id], before[todo.id]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("add: --id with a split is used as given; a colliding --id errors", { timeout: 300_000 }, () => {
  const root = fixture();
  try {
    const before = files(root);
    const bad = add(root, "note", "Thread recap.", ["--id", DEC]);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /already exists/);
    assert.ok(!bad.stdout.includes("↳"));
    assert.deepEqual(files(root), before);

    const r = add(root, "note", "Thread recap.", ["--id", "2026-03-01-custom-recap"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /created 2026-03-01-custom-recap \(note\)$/m);
    assert.equal(Object.keys(files(root)).length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("add: untyped capture with several same-type matches updates the earliest by (date, id)", { timeout: 300_000 }, () => {
  const twin: SeedEntry = { id: "2026-03-03-vendor-twin", date: "2026-03-03", type: "decision", title: "Vendor twin", body: "A second decision.", source_ids: [SID] };
  const root = fixture([twin, ...ENTRIES]);
  try {
    const before = files(root);
    for (const body of ["First untyped revision.", "Second untyped revision."]) {
      const r = add(root, undefined, body);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, new RegExp(`↻ matches existing ${DEC} via`));
      assert.match(matter(files(root)[DEC]!).content, new RegExp(body));
      assert.equal(files(root)[twin.id], before[twin.id]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("add: a match living in a shared graph is left byte-identical in every store", { timeout: 300_000 }, () => {
  const shared: SeedEntry = { ...ENTRIES[0]!, graphs: ["default", "team-x"] };
  const root = fixture([shared]);
  try {
    const copy = join(root, "memory-graphs", "team-x", "entries", "2026", "03", `${DEC}.md`);
    const before = readFileSync(copy, "utf8");
    const r = add(root, "note", "Thread recap.");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(copy, "utf8"), before);
    assert.equal(files(root)[DEC], before);
    assert.match(r.stdout, /created /);
    // The new entry homes in the default graph only.
    assert.equal(Object.keys(files(root)).length, 2);
    assert.equal(readdirSync(join(root, "memory-graphs", "team-x", "entries", "2026", "03")).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
