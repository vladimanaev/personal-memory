import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
