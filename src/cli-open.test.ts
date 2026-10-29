import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO, STORE_MOD, runInStore, seedStore, type SeedEntry } from "./test-store.js";

function run(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, ["--import", join(REPO, "node_modules", "tsx", "dist", "loader.mjs"), join(REPO, "src", "cli.ts"), ...args], {
      cwd,
      env: { ...process.env, MEMORY_EMBEDDINGS: "fake", MEMORY_QUIET: "1" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { status: e.status, stdout: e.stdout, stderr: e.stderr };
  }
}

function cli(cwd: string, args: string[]): string {
  const r = run(cwd, args);
  assert.equal(r.status, 0, `${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

type Item = { id: string; graphs: string[]; confidence: string;
  evidence: { source?: { id: string; scope: string }; query?: { rank: number; terms: string[] } } };

function open(cwd: string, args: string[]): { total: number; shown: number; items: Item[] } {
  return JSON.parse(cli(cwd, ["open", ...args, "--format", "json"]));
}

const EXPENSE = "2026-01-06-expense-ex-1-approval";
const READOUT = "2026-01-06-readout-to-boris";
const VENDOR = "2026-01-06-vendor-decision";
const THREAD = "2026-01-06-thread-ask";

const ENTRIES: SeedEntry[] = [
  { id: EXPENSE, date: "2026-01-06", type: "todo", title: "Follow up on expense EX-1 approval", people: ["boris-cohen"],
    body: "Waiting for Boris to approve expense EX-1 for the keyboard.", source_ids: ["slack:D9:1700000000.1"] },
  { id: READOUT, date: "2026-01-06", type: "todo", title: "Send onboarding readout to Boris", people: ["boris-cohen"],
    body: "Write the onboarding readout and share it.", source_ids: ["slack:D9:1700000100.1"] },
  { id: VENDOR, date: "2026-01-06", type: "pending-decision", title: "Decide on the vendor contract", people: ["ana-levi"],
    body: "Pick between the two vendor offers.", source_ids: ["slack:C7:1700000200.1"], graphs: ["default", "team-x"] },
  { id: THREAD, date: "2026-01-06", type: "todo", title: "Answer the staging question", people: ["ana-levi"],
    body: "Reply in the thread about staging.", source_ids: ["slack:C8:1700000300.1"] },
  { id: "2026-01-06-thread-ask-a", date: "2026-01-06", type: "todo", title: "Send the deploy checklist", people: ["ana-de-souza"],
    body: "Share the deploy checklist in the thread.", source_ids: ["slack:C5:1700000500.1:1700000501.1"] },
  { id: "2026-01-06-thread-ask-b", date: "2026-01-06", type: "todo", title: "Book the retro room", people: ["ana-de-souza"],
    body: "Book a room for the retro.", source_ids: ["slack:C5:1700000500.1:1700000502.1"] },
  { id: "2026-01-06-marketing-signoff", date: "2026-01-06", type: "todo", title: "Marketing budget sign-off", people: ["mark-levi"],
    body: "Get the marketing budget signed off.", source_ids: ["slack:D4:1700000600.1"] },
  { id: "2026-01-06-level-review", date: "2026-01-06", type: "todo", title: "Plan the offsite", people: ["mark-levi"],
    body: "Plan the offsite agenda.", source_ids: ["slack:D4:1700000700.1"] },
  // Resolved todos about the expense must not crowd the open one out either.
  ...Array.from({ length: 50 }, (_, i): SeedEntry => ({
    id: `2026-01-01-expense-todo-${i}`, date: "2026-01-01", type: "todo", title: `Expense EX-1 approval todo ${i}`,
    body: `Expense EX-1 approval keyboard ${i}.` })),
  ...Array.from({ length: 50 }, (_, i): SeedEntry => ({
    id: `2026-01-02-expense-todo-done-${i}`, date: "2026-01-02", type: "note", title: `Expense todo ${i} done`,
    body: "Done.", follows: [`2026-01-01-expense-todo-${i}`] })),
  // Non-open entries that share the expense vocabulary must not crowd the todo out of a query.
  ...Array.from({ length: 100 }, (_, i): SeedEntry => ({
    id: `2026-01-0${(i % 3) + 1}-expense-note-${i}`, date: `2026-01-0${(i % 3) + 1}`, type: "note",
    title: `Expense EX-1 approval note ${i}`, body: `Expense EX-1 approval keyboard discussion ${i}.` })),
];

test("open: evidence, confidence, prefix rules, graphs, crowding, and settle guards", { timeout: 300_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "pm-cli-open-"));
  try {
    seedStore(root, ENTRIES);
    runInStore(root, `const s = await import(${STORE_MOD}); console.log(JSON.stringify(await s.syncIndex()));`);

    // No flags: every open item of both open types, with graph membership.
    const all = open(root, []);
    const MINE = [EXPENSE, READOUT, THREAD, VENDOR, "2026-01-06-thread-ask-a", "2026-01-06-thread-ask-b",
      "2026-01-06-marketing-signoff", "2026-01-06-level-review"];
    assert.deepEqual(all.items.map((r) => r.id).sort(), [...MINE].sort());
    assert.deepEqual(all.items.find((r) => r.id === VENDOR)?.graphs, ["default", "team-x"]);

    // A conversation-level prefix matches every open item in the DM — as candidates only.
    const dm = open(root, ["--source", "slack:D9"]);
    assert.deepEqual(dm.items.map((r) => r.id).sort(), [EXPENSE, READOUT].sort());
    assert.ok(dm.items.every((r) => r.confidence === "candidate" && r.evidence.source?.scope === "conversation"));

    // Adding a phrasing singles out the item it describes; the other DM item stays a candidate.
    const settled = open(root, ["expense EX-1 approved", "--source", "slack:D9"]);
    assert.equal(settled.items[0]?.id, EXPENSE);
    assert.equal(settled.items[0]?.confidence, "high");
    assert.ok(settled.items[0]?.evidence.query?.terms.length);
    assert.equal(settled.items.find((r) => r.id === READOUT)?.confidence, "candidate");
    // With --source, the phrasing never pulls in items from other conversations.
    assert.ok(settled.items.every((r) => r.evidence.source));

    // Topic words that merely start like a name part ("market"/"mark") still count as topical.
    const mkt = open(root, ["marketing budget approved", "--source", "slack:D4"]);
    assert.deepEqual([mkt.items[0]?.id, mkt.items[0]?.confidence], ["2026-01-06-marketing-signoff", "high"]);

    // A person's name alone is not topical evidence: no item becomes high.
    assert.ok(open(root, ["Boris", "--source", "slack:D9"]).items.every((r) => r.confidence === "candidate"));

    // A query alone finds the todo despite 100 non-open entries ranking above it.
    assert.equal(open(root, ["expense EX-1 approval keyboard"]).items[0]?.id, EXPENSE);

    // A thread prefix is exact.
    const thread = open(root, ["--source", "slack:C8:1700000300.1"]);
    assert.deepEqual(thread.items.map((r) => [r.id, r.confidence, r.evidence.source?.scope]), [[THREAD, "high", "exact"]]);

    // A thread holding two open asks is not an exact match for either.
    assert.ok(open(root, ["--source", "slack:C5:1700000500.1"]).items.every((r) => r.confidence === "candidate"));
    // A short name part ("de") doesn't disqualify topical words ("deploy").
    const deploy = open(root, ["deploy checklist", "--source", "slack:C5"]);
    assert.deepEqual([deploy.items[0]?.id, deploy.items[0]?.confidence], ["2026-01-06-thread-ask-a", "high"]);

    // Prefix normalization: scheme case, trailing colon, ':' boundaries, bare scheme rejected.
    assert.equal(open(root, ["--source", "Slack:D9:"]).items.length, 2);
    assert.equal(open(root, ["--source", "slack:D"]).items.length, 0);
    assert.notEqual(run(root, ["open", "--source", "slack"]).status, 0);

    // Graph scope and truncation reporting.
    assert.deepEqual(open(root, ["--graph", "team-x"]).items.map((r) => r.id), [VENDOR]);
    const limited = open(root, ["--limit", "1"]);
    assert.deepEqual([limited.shown, limited.total], [1, 8]);
    assert.match(cli(root, ["open", "--limit", "1"]), /1 of 8 open items/);

    // Settling by rewrite is refused: same anchor + retype, or following itself through the anchor.
    const retype = run(root, ["add", "--type", "note", "--title", "Staging answered", "--people", "ana-levi",
      "--body", "Answered.", "--source-ids", "slack:C8:1700000300.1"]);
    assert.notEqual(retype.status, 0);
    assert.match(retype.stderr, /already anchors the open todo .*distinct source id/);
    const self = run(root, ["add", "--type", "note", "--title", "Staging answered", "--people", "ana-levi",
      "--body", "Answered.", "--source-ids", "slack:C8:1700000300.1", "--follows", THREAD]);
    assert.notEqual(self.status, 0);
    assert.match(self.stderr, /already anchors the open todo/);

    // --update can't retype an open item either; a resolved one still can be.
    const upd = run(root, ["add", "--update", THREAD, "--type", "note", "--title", "Staging answered", "--body", "Answered."]);
    assert.notEqual(upd.status, 0);
    assert.match(upd.stderr, /--update targets the open todo/);
    cli(root, ["add", "--update", "2026-01-01-expense-todo-0", "--type", "note", "--title", "Expense EX-1 note", "--body", "Retyped."]);

    // The sanctioned path: a distinct reply anchor + --follows resolves it (a pending-decision too).
    cli(root, ["add", "--type", "note", "--title", "Staging answered in thread", "--people", "ana-levi", "--date", "2026-01-07",
      "--body", "Answered the staging question.", "--source-ids", "slack:C8:1700000300.1:1700000400.1", "--follows", THREAD]);
    cli(root, ["add", "--type", "decision", "--title", "Vendor A chosen", "--people", "ana-levi", "--date", "2026-01-07",
      "--body", "Chose vendor A.", "--follows", VENDOR, "--force-new"]);
    assert.deepEqual(open(root, []).items.map((r) => r.id).sort(),
      [EXPENSE, READOUT, "2026-01-06-thread-ask-a", "2026-01-06-thread-ask-b",
        "2026-01-06-marketing-signoff", "2026-01-06-level-review"].sort());
    assert.match(cli(root, ["open", "--graph", "team-x"]), /no matching open items/);

    // A wrong link is undone with unlink: the item is open again; unknown links are rejected.
    cli(root, ["add", "--type", "decision", "--title", "Unrelated decision", "--people", "boris-cohen", "--date", "2026-01-08",
      "--body", "Something else entirely.", "--follows", EXPENSE, "--force-new"]);
    assert.ok(!open(root, []).items.some((r) => r.id === EXPENSE));
    cli(root, ["unlink", "2026-01-08-unrelated-decision", "--follows", EXPENSE]);
    assert.ok(open(root, []).items.some((r) => r.id === EXPENSE));
    assert.notEqual(run(root, ["unlink", "2026-01-08-unrelated-decision", "--follows", EXPENSE]).status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A filter narrows which open items are LISTED; it must not change what the
// evidence means. Judging thread-uniqueness over the filtered set would let
// `--person` hide a thread's other open ask and promote an ambiguous prefix
// to `exact` — which the skills settle unattended.
const SHARED_THREAD = "slack:C6:1700000800.1";
const AMBIGUOUS: SeedEntry[] = [
  { id: "2026-01-06-shared-ask-x", date: "2026-01-06", type: "todo", title: "Send the deploy checklist",
    people: ["ana-levi"], body: "Share the deploy checklist in the thread.", source_ids: [`${SHARED_THREAD}:1700000801.1`] },
  { id: "2026-01-06-shared-ask-y", date: "2026-01-06", type: "todo", title: "Book the retro room",
    people: ["boris-cohen"], body: "Book a room for the retro.", source_ids: [`${SHARED_THREAD}:1700000802.1`] },
];

test("open: a filter never promotes an ambiguous thread to exact", { timeout: 300_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "pm-cli-open-filter-"));
  try {
    seedStore(root, AMBIGUOUS);
    runInStore(root, `const s = await import(${STORE_MOD}); console.log(JSON.stringify(await s.syncIndex()));`);

    // Unfiltered, the thread holds two open asks: neither is exact.
    const both = open(root, ["--source", SHARED_THREAD]);
    assert.equal(both.items.length, 2);
    assert.ok(both.items.every((r) => r.confidence === "candidate" && r.evidence.source?.scope === "conversation"));

    // Filtering to one of them must not change that: the thread is still ambiguous.
    const filtered = open(root, ["--source", SHARED_THREAD, "--person", "ana-levi"]);
    assert.deepEqual(filtered.items.map((r) => r.id), ["2026-01-06-shared-ask-x"]);
    assert.deepEqual([filtered.items[0]?.confidence, filtered.items[0]?.evidence.source?.scope],
      ["candidate", "conversation"]);

    // A prefix that IS the anchor still identifies one message exactly, filter or not.
    const anchored = open(root, ["--source", `${SHARED_THREAD}:1700000801.1`, "--person", "ana-levi"]);
    assert.deepEqual([anchored.items[0]?.confidence, anchored.items[0]?.evidence.source?.scope], ["high", "exact"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("due dates: set at capture or later, shown and filtered by open, rejected on non-open types", { timeout: 300_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "pm-cli-due-"));
  try {
    seedStore(root, ENTRIES.slice(0, 4));
    runInStore(root, `const s = await import(${STORE_MOD}); console.log(JSON.stringify(await s.syncIndex()));`);

    // Capture-time due date; a past one is flagged overdue and sorts first in a plain listing.
    cli(root, ["add", "--type", "todo", "--title", "Renew the parking permit", "--people", "ana-levi",
      "--date", "2026-01-06", "--due", "2026-01-09", "--body", "Renew it by Friday.", "--force-new"]);
    const permit = "2026-01-06-renew-the-parking-permit";
    cli(root, ["due", READOUT, "2999-01-01"]);
    cli(root, ["add", "--type", "todo", "--title", "Newer undated ask", "--people", "ana-levi",
      "--date", "2026-01-07", "--body", "Nothing due.", "--force-new"]);
    const newer = "2026-01-07-newer-undated-ask";
    const rows = open(root, []).items as (Item & { due?: string; overdue?: boolean })[];
    // Only the overdue row is pulled ahead; a far-future due does not outrank a newer undated item.
    assert.deepEqual([rows[0]!.id, rows[0]!.due, rows[0]!.overdue], [permit, "2026-01-09", true]);
    const at = (id: string) => rows.findIndex((r) => r.id === id);
    assert.ok(at(newer) < at(READOUT), "newer undated item stays ahead of a far-future due");
    assert.deepEqual(rows.find((r) => r.id === READOUT)!.overdue, false);
    assert.match(cli(root, ["open"]), /⚠ overdue 2026-01-09/);

    assert.deepEqual(open(root, ["--overdue"]).items.map((r) => r.id), [permit]);
    assert.deepEqual(open(root, ["--no-due"]).items.map((r) => r.id).sort(), [EXPENSE, THREAD, VENDOR, newer].sort());

    // A shared-graph item gets the due date in every copy; clearing works; re-setting is idempotent.
    cli(root, ["due", VENDOR, "2026-02-01"]);
    assert.equal((open(root, ["--graph", "team-x"]).items[0] as { due?: string }).due, "2026-02-01");
    assert.match(cli(root, ["due", VENDOR, "2026-02-01"]), /unchanged/);
    cli(root, ["due", VENDOR, "none"]);
    assert.ok(open(root, ["--no-due"]).items.some((r) => r.id === VENDOR));

    // Only open types take a due date; bad dates are rejected.
    const note = run(root, ["add", "--type", "note", "--title", "A plain note", "--body", "Nothing due.", "--due", "2026-01-09", "--force-new"]);
    assert.notEqual(note.status, 0);
    assert.match(note.stderr, /only to todo/);
    assert.notEqual(run(root, ["due", READOUT, "next friday"]).status, 0);

    // Impossible calendar dates, empty --due, and retyping a settled todo that has a due.
    assert.notEqual(run(root, ["due", READOUT, "2026-02-30"]).status, 0);
    assert.match(run(root, ["add", "--type", "todo", "--title", "Bad date", "--body", "x", "--due", "2026-13-45", "--force-new"]).stderr, /real YYYY-MM-DD/);
    const empty = run(root, ["add", "--update", permit, "--title", "Renew the parking permit", "--body", "Renew it.", "--due", ""]);
    assert.notEqual(empty.status, 0);
    assert.match(empty.stderr, /memory due <id> none/);
    cli(root, ["add", "--type", "event", "--title", "Renewed the parking permit", "--people", "ana-levi",
      "--date", "2026-01-10", "--follows", permit, "--body", "Done.", "--force-new"]);
    assert.ok(!open(root, []).items.some((r) => r.id === permit));
    cli(root, ["add", "--update", permit, "--type", "event", "--title", "Renew the parking permit (done)", "--body", "Renewed."]);
    // Setting a date on a non-open type is refused, clearing is not.
    assert.notEqual(run(root, ["due", permit, "2026-01-09"]).status, 0);
    assert.match(cli(root, ["due", permit, "none"]), /unchanged/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("open: --overdue / --no-due never promote an ambiguous thread to exact", { timeout: 300_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "pm-cli-open-due-"));
  try {
    seedStore(root, AMBIGUOUS);
    runInStore(root, `const s = await import(${STORE_MOD}); console.log(JSON.stringify(await s.syncIndex()));`);
    cli(root, ["due", "2026-01-06-shared-ask-x", "2026-01-09"]);

    const overdue = open(root, ["--source", SHARED_THREAD, "--overdue"]);
    assert.deepEqual(overdue.items.map((r) => r.id), ["2026-01-06-shared-ask-x"]);
    assert.deepEqual([overdue.items[0]?.confidence, overdue.items[0]?.evidence.source?.scope], ["candidate", "conversation"]);
    const undated = open(root, ["--source", SHARED_THREAD, "--no-due"]);
    assert.deepEqual(undated.items.map((r) => [r.id, r.confidence]), [["2026-01-06-shared-ask-y", "candidate"]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
