import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { REPO, runInStore, seedStore, type SeedEntry } from "./test-store.js";

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

function cli(cwd: string, args: string[]): string {
  const r = run(cwd, args);
  assert.equal(r.status, 0, `${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { env: ENV, encoding: "utf8" }).trim();

const SHARED = "2026-02-01-alpha-shared";
const PLAIN = "2026-02-02-alpha-plain";
const ENTRIES: SeedEntry[] = [
  { id: SHARED, date: "2026-02-01", type: "decision", title: "Alpha shared decision", people: ["jane-doe"], teams: ["platform"],
    tags: ["alpha", "beta"], source_ids: ["slack:C1:1.0"], body: "Body text with **markdown**.\n\n- keep me", graphs: ["default", "team-x"] },
  { id: PLAIN, date: "2026-02-02", type: "note", title: "Alpha plain note", tags: ["alpha"], body: "Plain body." },
];

const files = (root: string, id: string, date = id.slice(0, 7).split("-")) =>
  ({ home: join(root, "memory", "entries", date[0]!, date[1]!, `${id}.md`), shared: join(root, "memory-graphs", "team-x", "entries", date[0]!, date[1]!, `${id}.md`) });

function setup(): string {
  const root = mkdtempSync(join(tmpdir(), "pm-cli-tag-"));
  seedStore(root, ENTRIES);
  for (const dir of [join(root, "memory"), join(root, "memory-graphs", "team-x")]) {
    git(dir, "init", "-q");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "seed");
  }
  runInStore(root, `const s = await import(${JSON.stringify(join(REPO, "src", "store.ts"))}); console.log(JSON.stringify(await s.syncIndex()));`);
  return root;
}

const read = (file: string) => matter(readFileSync(file, "utf8"));
const tagsOf = (file: string): string[] => read(file).data.tags as string[];
const bodyOf = (file: string): string => read(file).content;
const restOf = (file: string) => { const { tags: _t, updated: _u, ...rest } = read(file).data; return rest; };

test("tag: add, remove, both, preserved fields, shared copy sync, no-op, errors, dry-run", { timeout: 300_000 }, () => {
  const root = setup();
  try {
    const f = files(root, SHARED);
    const beforeHome = readFileSync(f.home, "utf8");
    const beforeBody = bodyOf(f.home);
    const beforeRest = restOf(f.home);
    const commits = (dir: string) => Number(git(dir, "rev-list", "--count", "HEAD"));

    // dry-run writes nothing, commits nothing
    const dry = cli(root, ["tag", SHARED, "--add", "gamma", "--remove", "beta", "--dry-run"]);
    assert.match(dry, /would change .* tags: alpha, beta → alpha, gamma/);
    assert.match(dry, /copies: default, team-x/);
    assert.equal(readFileSync(f.home, "utf8"), beforeHome);
    assert.equal(commits(join(root, "memory")), 1);

    // add
    const addOut = cli(root, ["tag", SHARED, "--add", "gamma"]);
    assert.match(addOut, new RegExp(`✓ ${SHARED} tags: alpha, beta, gamma`));
    assert.match(addOut, /added: gamma/);
    assert.deepEqual(tagsOf(f.home), ["alpha", "beta", "gamma"]);

    // remove + add together; both copies in sync
    const both = cli(root, ["tag", SHARED, "--add", "delta", "--remove", "beta"]);
    assert.match(both, /tags: alpha, gamma, delta/);
    assert.match(both, /added: delta/);
    assert.match(both, /removed: beta/);
    assert.deepEqual(tagsOf(f.shared), ["alpha", "gamma", "delta"]);
    assert.deepEqual(tagsOf(f.home), ["alpha", "gamma", "delta"]);

    // everything else preserved in both copies
    for (const file of [f.home, f.shared]) {
      assert.equal(bodyOf(file), beforeBody);
      assert.deepEqual(restOf(file), beforeRest);
    }
    assert.ok(read(f.home).data.updated);

    // both stores committed once for each effective edit
    assert.equal(commits(join(root, "memory")), 3);
    assert.equal(commits(join(root, "memory-graphs", "team-x")), 3);

    // no-op: adding present / removing absent -> unchanged, no write, no commit
    const noop = cli(root, ["tag", SHARED, "--add", "alpha", "--remove", "beta"]);
    assert.match(noop, /✓ unchanged/);
    assert.equal(commits(join(root, "memory")), 3);
    assert.equal(git(join(root, "memory"), "status", "--porcelain"), "");

    // an unshared entry only touches the home store
    cli(root, ["tag", PLAIN, "--remove", "alpha"]);
    assert.deepEqual(tagsOf(files(root, PLAIN).home), []);
    assert.equal(commits(join(root, "memory-graphs", "team-x")), 3);

    // errors
    const unknown = run(root, ["tag", "2026-01-01-nope", "--add", "x"]);
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /no entry with id '2026-01-01-nope'/);
    const nothing = run(root, ["tag", SHARED]);
    assert.notEqual(nothing.status, 0);
    assert.match(nothing.stderr, /usage: memory tag/);
    const clash = run(root, ["tag", SHARED, "--add", "x,y", "--remove", "y"]);
    assert.notEqual(clash.status, 0);
    assert.match(clash.stderr, /both --add and --remove: y/);
    const bad = run(root, ["tag", SHARED, "--add", "Not A Slug"]);
    assert.notEqual(bad.status, 0);
    assert.equal(commits(join(root, "memory")), 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function shareRule(root: string, tag = "share"): void {
  mkdirSync(join(root, "memory", "graphs"), { recursive: true });
  writeFileSync(
    join(root, "memory", "graphs", "rules.json"),
    JSON.stringify({ version: 1, rules: [{ match: { tag }, graph: "team-x", mode: "copy" }] }, null, 2),
    "utf8",
  );
}

test("tag: standing rules judge only newly added tags; dry-run previews; removal reconciles", { timeout: 300_000 }, () => {
  const root = setup();
  try {
    shareRule(root);
    const queue = () => cli(root, ["queue", "list", "--graph", "team-x"]);

    // dry-run previews the rule against the NEW tags and queues nothing
    const dry = cli(root, ["tag", PLAIN, "--add", "share", "--dry-run"]);
    assert.match(dry, new RegExp(`would queue ${PLAIN} → team-x`));
    assert.doesNotMatch(queue(), new RegExp(PLAIN));

    // repeated --add keeps both; the rule queues once
    const add = cli(root, ["tag", PLAIN, "--add", "share", "--add", "extra"]);
    assert.deepEqual(tagsOf(files(root, PLAIN).home), ["alpha", "share", "extra"]);
    assert.match(add, new RegExp(`→ rule: queued ${PLAIN} → team-x`));
    assert.match(queue(), new RegExp(PLAIN));

    // dismiss, then an unrelated tag must NOT resurrect the declined candidate
    cli(root, ["queue", "dismiss", PLAIN, "--graph", "team-x"]);
    const other = cli(root, ["tag", PLAIN, "--add", "unrelated"]);
    assert.doesNotMatch(other, /rule:/);
    assert.doesNotMatch(queue(), new RegExp(PLAIN));

    // a pending rule row is dropped when the tag is removed (dry-run says so first)
    cli(root, ["tag", PLAIN, "--remove", "share"]);
    cli(root, ["tag", PLAIN, "--add", "share"]);
    assert.match(queue(), new RegExp(PLAIN));
    const dryRm = cli(root, ["tag", PLAIN, "--remove", "share", "--dry-run"]);
    assert.match(dryRm, new RegExp(`would drop pending rule candidate ${PLAIN} → team-x`));
    assert.match(queue(), new RegExp(PLAIN));
    const rm = cli(root, ["tag", PLAIN, "--remove", "share"]);
    assert.match(rm, new RegExp(`dropped pending rule candidate ${PLAIN} → team-x`));
    assert.doesNotMatch(queue(), new RegExp(PLAIN));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

type TestRule = { match: { tag?: string; type?: string }; graph: string; mode: "copy" | "move" };
function setRules(root: string, rules: TestRule[]): void {
  mkdirSync(join(root, "memory", "graphs"), { recursive: true });
  writeFileSync(join(root, "memory", "graphs", "rules.json"), JSON.stringify({ version: 1, rules }, null, 2), "utf8");
}
const toX = (match: TestRule["match"], mode: "copy" | "move" = "copy"): TestRule => ({ match, graph: "team-x", mode });

test("tag: type-only rules never fire; tag+type rule honours both; conflicts are reported not queued", { timeout: 300_000 }, () => {
  const root = setup();
  try {
    const queue = () => cli(root, ["queue", "list", "--graph", "team-x"]);

    setRules(root, [toX({ type: "note" })]);
    const typeOnly = cli(root, ["tag", PLAIN, "--add", "whatever"]);
    assert.doesNotMatch(typeOnly, /rule:/);
    assert.doesNotMatch(queue(), new RegExp(PLAIN));

    // tag + type: wrong type does not match, right type does
    setRules(root, [toX({ tag: "share", type: "decision" })]);
    assert.doesNotMatch(cli(root, ["tag", PLAIN, "--add", "share"]), /rule:/);
    cli(root, ["tag", PLAIN, "--remove", "share"]);
    setRules(root, [toX({ tag: "share", type: "note" })]);
    assert.match(cli(root, ["tag", PLAIN, "--add", "share"]), new RegExp(`→ rule: queued ${PLAIN} → team-x`));
    cli(root, ["queue", "dismiss", PLAIN, "--graph", "team-x"]);
    cli(root, ["tag", PLAIN, "--remove", "share"]);

    // move rule + another matching rule on the same entry: conflict, nothing queued
    setRules(root, [toX({ tag: "share" }, "move"), toX({ type: "note" })]);
    const dry = cli(root, ["tag", PLAIN, "--add", "share", "--dry-run"]);
    assert.match(dry, /rule skipped/);
    assert.doesNotMatch(dry, /would queue/);
    const real = cli(root, ["tag", PLAIN, "--add", "share"]);
    assert.match(real, /rule skipped/);
    assert.doesNotMatch(real, /queued/);
    assert.doesNotMatch(queue(), new RegExp(PLAIN));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tag: removal only reconciles rule rows whose rule lost its tag; dry-run is read-only", { timeout: 300_000 }, () => {
  const root = setup();
  try {
    const queue = () => cli(root, ["queue", "list", "--graph", "team-x"]);
    const queueFile = join(root, "memory", "graphs", "queue.json");

    // a sweep row and an explicit-graph row survive removal of any tag
    setRules(root, [toX({ tag: "share" })]);
    cli(root, ["tag", PLAIN, "--add", "share"]);
    cli(root, ["queue", "dismiss", PLAIN, "--graph", "team-x"]);
    cli(root, ["tag", PLAIN, "--remove", "share"]);
    for (const by of ["sweep", "add"]) {
      cli(root, ["queue", "add", PLAIN, "--to", "team-x", "--reason", `from ${by}`, "--proposed-by", by, "--force"]);
      cli(root, ["tag", PLAIN, "--add", "share"]);
      cli(root, ["tag", PLAIN, "--remove", "share"]);
      assert.match(queue(), new RegExp(`${by}: from ${by}`));
      cli(root, ["queue", "dismiss", PLAIN, "--graph", "team-x"]);
      // a dismissal is keyed on content: change it so the next proposal is visible
      cli(root, ["tag", PLAIN, "--add", `after-${by}`]);
    }

    // two rules into the same graph: swapping one matching tag for the other keeps the row
    cli(root, ["tag", PLAIN, "--remove", "share"]);
    setRules(root, [toX({ tag: "one" }), toX({ tag: "two" })]);
    cli(root, ["tag", PLAIN, "--add", "one"]);
    assert.match(queue(), new RegExp(PLAIN));
    const swap = cli(root, ["tag", PLAIN, "--remove", "one", "--add", "two"]);
    assert.doesNotMatch(swap, /dropped/);
    assert.match(queue(), new RegExp(PLAIN));

    // removing an unrelated tag does not touch the row; dry-run leaves queue.json byte-identical
    const bytes = readFileSync(queueFile, "utf8");
    cli(root, ["tag", PLAIN, "--remove", "alpha"]);
    assert.equal(readFileSync(queueFile, "utf8"), bytes);
    const dryRm = cli(root, ["tag", PLAIN, "--remove", "two", "--dry-run"]);
    assert.match(dryRm, /would drop pending rule candidate/);
    assert.equal(readFileSync(queueFile, "utf8"), bytes);

    // a pending row means dry-run does not claim it would queue again
    const dryAdd = cli(root, ["tag", PLAIN, "--add", "one", "--dry-run"]);
    assert.doesNotMatch(dryAdd, /would queue/);
    assert.equal(readFileSync(queueFile, "utf8"), bytes);

    // no rules configured: nothing is dropped
    rmSync(join(root, "memory", "graphs", "rules.json"));
    assert.doesNotMatch(cli(root, ["tag", PLAIN, "--remove", "two"]), /dropped/);
    assert.match(queue(), new RegExp(PLAIN));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tag / rules apply never overwrite a pending sweep row; no conflict noise without a triggering tag", { timeout: 300_000 }, () => {
  const root = setup();
  try {
    const queueFile = join(root, "memory", "graphs", "queue.json");
    const summaryFile = join(root, "redacted.txt");
    writeFileSync(summaryFile, "Redacted wording.", "utf8");
    cli(root, ["queue", "add", PLAIN, "--to", "team-x", "--reason", "sweep thinks so", "--proposed-by", "sweep", "--summary-file", summaryFile]);
    const bytes = readFileSync(queueFile, "utf8");
    assert.match(bytes, /Redacted wording/);

    setRules(root, [toX({ tag: "share" })]);
    const dry = cli(root, ["tag", PLAIN, "--add", "share", "--dry-run"]);
    assert.doesNotMatch(dry, /would queue/);
    const add = cli(root, ["tag", PLAIN, "--add", "share"]);
    assert.doesNotMatch(add, /rule: queued/);
    assert.equal(readFileSync(queueFile, "utf8"), bytes);

    // rules apply honours the same rule: the pending row is skipped, not replaced
    const apply = cli(root, ["rules", "apply"]);
    assert.doesNotMatch(apply, /queued PLAIN|✓ queued/);
    assert.equal(readFileSync(queueFile, "utf8"), bytes);

    cli(root, ["tag", PLAIN, "--remove", "share"]);
    assert.equal(readFileSync(queueFile, "utf8"), bytes);

    // an entry that conflicts on its existing tags: an unrelated --add stays quiet
    setRules(root, [toX({ tag: "alpha" }, "move"), toX({ type: "note" })]);
    const quiet = cli(root, ["tag", PLAIN, "--add", "unrelated"]);
    assert.doesNotMatch(quiet, /rule skipped|rule:/);
    const quietDry = cli(root, ["tag", PLAIN, "--add", "unrelated2", "--dry-run"]);
    assert.doesNotMatch(quietDry, /rule skipped|rule:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
