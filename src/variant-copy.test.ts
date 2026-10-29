import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GOLDEN_ENTRIES, REPO, runInStore, seedStore } from "./test-store.js";

/**
 * Publishing a redacted copy into a shared graph. The private home keeps the
 * raw wording; the shared copy carries the approved summary and declares what
 * it diverged from. These cover the ways that could silently go wrong — a
 * later edit overwriting the redaction with private text being the worst.
 */

const MEMBERSHIP = JSON.stringify(join(REPO, "src", "membership.ts"));
const INGEST = JSON.stringify(join(REPO, "src", "ingest.ts"));
const ID = "2026-01-03-otter-hiring";
const SUMMARY = "Hiring loop ran; the panel reached a decision.";

function cli(cwd: string, args: string[]): string {
  return execFileSync(
    process.execPath,
    ["--import", join(REPO, "node_modules", "tsx", "dist", "loader.mjs"), join(REPO, "src", "cli.ts"), ...args],
    { cwd, env: { ...process.env, MEMORY_EMBEDDINGS: "fake", MEMORY_QUIET: "1" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

/** Same, but `graphs sync` exits 2 when it found an unresolved issue — which
 *  a stale variant is, so the output still has to be readable. */
function cliOutput(cwd: string, args: string[]): string {
  try {
    return cli(cwd, args);
  } catch (err) {
    return String((err as { stdout?: string }).stdout ?? "");
  }
}

function withStore(fn: (root: string) => void): void {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pm-variant-")));
  try {
    seedStore(root);
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const homePath = (root: string) => join(root, "memory", "entries", "2026", "01", `${ID}.md`);
const sharedPath = (root: string) =>
  join(root, "memory-graphs", "team-x", "entries", "2026", "01", `${ID}.md`);

/** The markdown body of an entry file, without its frontmatter block. */
function body(file: string): string {
  return file.replace(/^---[\s\S]*?\n---\n/, "").trim();
}

/** Publish `ID` into team-x as a declared variant carrying SUMMARY. */
function publishVariant(root: string): Record<string, unknown> {
  return runInStore(
    root,
    `const m = await import(${MEMBERSHIP});
     const r = await m.copyEntry({ id: ${JSON.stringify(ID)}, to: "team-x", variantBody: ${JSON.stringify(SUMMARY)} });
     console.log(JSON.stringify(r));`,
  ) as Record<string, unknown>;
}

test("copyEntry publishes a redacted copy and leaves the private home untouched", { timeout: 300_000 }, () => {
  withStore((root) => {
    const before = readFileSync(homePath(root), "utf8");
    const res = publishVariant(root);
    assert.equal(res.changed, true);
    assert.match(String(res.variantOf), /^[0-9a-f]{16}$/, "the copy records what it diverged from");

    const shared = readFileSync(sharedPath(root), "utf8");
    assert.match(shared, /Hiring loop ran/, "the shared copy carries the approved summary");
    assert.doesNotMatch(shared, /interviews and offers/, "and not the private wording");
    assert.match(shared, new RegExp(`variant_of_hash: ${res.variantOf}`));
    assert.match(shared, new RegExp(`id: ${ID}`), "same id — it is the same memory");

    assert.equal(readFileSync(homePath(root), "utf8"), before, "the private home is byte-unchanged");
  });
});

test("a published variant does not read as drift, and the entry still loads", { timeout: 300_000 }, () => {
  withStore((root) => {
    publishVariant(root);
    const out = cli(root, ["list", "--graph", "team-x"]);
    assert.match(out, new RegExp(ID), "the store loads and the copy is a member");

    const report = runInStore(
      root,
      `const m = await import(${MEMBERSHIP});
       console.log(JSON.stringify(await m.syncGraphs({ dryRun: true })));`,
    ) as { drift: unknown[]; staleVariants: unknown[]; variantViolations: unknown[] };
    assert.deepEqual(report.drift, [], "a declared variant is not drift");
    assert.deepEqual(report.staleVariants, [], "and it is current");
    assert.deepEqual(report.variantViolations, []);
  });
});

test("editing the private entry leaves the published summary alone and marks it stale", { timeout: 300_000 }, () => {
  withStore((root) => {
    publishVariant(root);
    const published = readFileSync(sharedPath(root), "utf8");

    cli(root, ["add", "--update", ID, "--title", "Otter hiring loop", "--type", "hiring", "--body", "Totally new private wording about the candidate's compensation."]);

    const after = readFileSync(sharedPath(root), "utf8");
    assert.match(after, /Hiring loop ran/, "the approved summary survived the update");
    assert.doesNotMatch(after, /compensation/, "the new private wording did not leak into the shared store");
    // Frontmatter resyncs (that is the point); the body must not.
    assert.equal(body(after), body(published), "the published words are exactly as approved");
    assert.match(after, /variant_of_hash:/, "and it still declares what it diverged from");

    const report = runInStore(
      root,
      `const m = await import(${MEMBERSHIP});
       console.log(JSON.stringify(await m.syncGraphs({ dryRun: true })));`,
    ) as { drift: unknown[]; staleVariants: { id: string; graph: string }[] };
    assert.deepEqual(report.drift, [], "still not drift");
    assert.equal(report.staleVariants.length, 1, "but now flagged for re-review");
    assert.equal(report.staleVariants[0]!.graph, "team-x");

    assert.match(cliOutput(root, ["graphs", "sync", "--dry-run"]), /published summary predates/);
  });
});

test("a frontmatter-only change syncs into the variant without touching its body", { timeout: 300_000 }, () => {
  withStore((root) => {
    publishVariant(root);
    // A chain link rewrites `follows` across every copy. The target is already
    // a team-x member, so containment is satisfied.
    runInStore(
      root,
      `const g = await import(${JSON.stringify(join(REPO, "src", "graph-maintenance.ts"))});
       console.log(JSON.stringify(await g.applyChainLink({ laterId: ${JSON.stringify(ID)}, follows: ["2026-01-01-zebra-migration"], refreshAudit: false })));`,
    );
    const after = readFileSync(sharedPath(root), "utf8");
    assert.match(after, /follows:/, "the frontmatter change propagated");
    assert.match(after, /Hiring loop ran/, "the approved body did not");
    assert.doesNotMatch(after, /interviews and offers/);
  });
});

test("a slug merge rewrites a variant's frontmatter without republishing the private body", { timeout: 300_000 }, () => {
  withStore((root) => {
    publishVariant(root);
    // A person/tag merge touches every copy of every affected entry. It is
    // reachable from the CLI, the maintenance screen's Merge button, and
    // /compact-tags — and it used to write the home's bytes over the variant,
    // silently dropping variant_of_hash so `graphs sync` saw nothing wrong.
    runInStore(
      root,
      `const g = await import(${JSON.stringify(join(REPO, "src", "graph-maintenance.ts"))});
       console.log(JSON.stringify(await g.mergeSlugs({ kind: "person", from: "chen-mizrahi", to: "ana-levi", confirm: true })));`,
    );
    const after = readFileSync(sharedPath(root), "utf8");
    assert.match(after, /ana-levi/, "the slug change propagated");
    assert.match(after, /Hiring loop ran/, "the approved wording survived");
    assert.doesNotMatch(after, /interviews and offers/, "the private body did NOT get republished");
    assert.match(after, /variant_of_hash:/, "and the copy still announces itself as a variant");

    // The silent part: without the marker, sync would have called this clean.
    const report = runInStore(
      root,
      `const m = await import(${MEMBERSHIP});
       console.log(JSON.stringify(await m.syncGraphs({ dryRun: true })));`,
    ) as { drift: unknown[]; staleVariants: unknown[] };
    assert.deepEqual(report.drift, []);
    assert.deepEqual(report.staleVariants, [], "frontmatter-only change leaves it current");
  });
});

test("moving an entry that has a published variant is refused", { timeout: 300_000 }, () => {
  withStore((root) => {
    publishVariant(root);
    const res = runInStore(
      root,
      `const m = await import(${MEMBERSHIP});
       try {
         await m.moveEntry({ id: ${JSON.stringify(ID)}, to: "team-x" });
         console.log(JSON.stringify({ threw: false }));
       } catch (e) {
         console.log(JSON.stringify({ threw: true, message: e.message }));
       }`,
    ) as { threw: boolean; message?: string };
    assert.equal(res.threw, true, "a move would delete the home the variant diverges from");
    assert.match(String(res.message), /needs its private home/);
    // The home is still there, which is the thing the guard protects.
    assert.match(readFileSync(homePath(root), "utf8"), /interviews and offers/);
  });
});

test("hashBody ignores a frontmatter bump, so only a body edit goes stale", { timeout: 300_000 }, () => {
  withStore((root) => {
    const hashes = runInStore(
      root,
      `const i = await import(${INGEST});
       console.log(JSON.stringify({ same: i.hashBody("  one two  ") === i.hashBody("one two"), diff: i.hashBody("one two") !== i.hashBody("one three") }));`,
    ) as { same: boolean; diff: boolean };
    assert.equal(hashes.same, true);
    assert.equal(hashes.diff, true);
  });
});

test("setting or clearing a due date keeps a variant's approved body and hash", { timeout: 300_000 }, () => {
  const todoId = "2026-01-08-otter-followup";
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pm-variant-")));
  try {
    seedStore(root, [
      ...GOLDEN_ENTRIES,
      { id: todoId, date: "2026-01-08", type: "todo", title: "Otter follow-up", people: ["chen-mizrahi"], body: "Send the private offer numbers to the panel. ".repeat(10).trim() },
    ]);
    const shared = join(root, "memory-graphs", "team-x", "entries", "2026", "01", `${todoId}.md`);
    const approved = "Follow-up is open; details withheld.";
    runInStore(
      root,
      `const m = await import(${MEMBERSHIP});
       console.log(JSON.stringify(await m.copyEntry({ id: ${JSON.stringify(todoId)}, to: "team-x", variantBody: ${JSON.stringify(approved)} })));`,
    );
    const hash = /variant_of_hash:\s*\S+/.exec(readFileSync(shared, "utf8"))?.[0];
    assert.ok(hash, "the published copy declares variant_of_hash");

    cli(root, ["due", todoId, "2026-03-01"]);
    const dated = readFileSync(shared, "utf8");
    assert.match(dated, /due: ['"]?2026-03-01/, "the shared copy's frontmatter got the due date");
    assert.equal(body(dated), approved, "the approved body survived");
    assert.doesNotMatch(dated, /private offer numbers/);
    assert.ok(dated.includes(hash), "variant_of_hash is still declared");
    const sync1 = cliOutput(root, ["graphs", "sync", "--dry-run"]);
    assert.match(sync1, /✓ all graphs consistent/, sync1);

    cli(root, ["due", todoId, "none"]);
    const cleared = readFileSync(shared, "utf8");
    assert.doesNotMatch(cleared, /^due:/m, "the due date was cleared on the shared copy");
    assert.equal(body(cleared), approved, "the approved body survived clearing");
    assert.doesNotMatch(cleared, /private offer numbers/);
    assert.ok(cleared.includes(hash), "variant_of_hash survives clearing");
    const sync2 = cliOutput(root, ["graphs", "sync", "--dry-run"]);
    assert.match(sync2, /✓ all graphs consistent/, sync2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
