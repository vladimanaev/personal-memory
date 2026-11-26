import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
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
const OLD_TITLE = "Alpha shared decision";
const ENTRIES: SeedEntry[] = [
  { id: SHARED, date: "2026-02-01", type: "decision", title: OLD_TITLE, people: ["jane-doe"], teams: ["platform"],
    tags: ["alpha", "beta"], source_ids: ["slack:C1:1.0"], body: "Body text with **markdown**.\n\n- keep me", graphs: ["default", "team-x"] },
  { id: PLAIN, date: "2026-02-02", type: "note", title: "Alpha plain note", tags: ["alpha"], body: "Plain body." },
];

const files = (root: string, id: string, date = id.slice(0, 7).split("-")) =>
  ({ home: join(root, "memory", "entries", date[0]!, date[1]!, `${id}.md`), shared: join(root, "memory-graphs", "team-x", "entries", date[0]!, date[1]!, `${id}.md`) });

const HOME_STORE = (root: string) => join(root, "memory");
const SHARED_STORE = (root: string) => join(root, "memory-graphs", "team-x");

function setup(): string {
  const root = mkdtempSync(join(tmpdir(), "pm-cli-retitle-"));
  seedStore(root, ENTRIES);
  for (const dir of [HOME_STORE(root), SHARED_STORE(root)]) {
    git(dir, "init", "-q");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "seed");
  }
  runInStore(root, `const s = await import(${JSON.stringify(join(REPO, "src", "store.ts"))}); console.log(JSON.stringify(await s.syncIndex()));`);
  return root;
}

const read = (file: string) => matter(readFileSync(file, "utf8"));
const titleOf = (file: string): string => read(file).data.title as string;
const bodyOf = (file: string): string => read(file).content;
const restOf = (file: string) => { const { title: _t, updated: _u, ...rest } = read(file).data; return rest; };
const commits = (dir: string) => Number(git(dir, "rev-list", "--count", "HEAD"));
/** Every entry file name under a store, so a retitle can be shown not to add or rename one. */
const fileNames = (store: string, dir = join(store, "entries")): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? fileNames(store, join(dir, d.name)) : [d.name])).sort();

test("retitle: both copies change, everything else stays, one commit per store, index follows, dry-run writes nothing", { timeout: 300_000 }, () => {
  const root = setup();
  try {
    const f = files(root, SHARED);
    const beforeHome = readFileSync(f.home, "utf8");
    const beforeBody = bodyOf(f.home);
    const beforeRest = restOf(f.home);
    const names = { home: fileNames(HOME_STORE(root)), shared: fileNames(SHARED_STORE(root)) };

    // dry-run prints old -> new and the copies, writes nothing, commits nothing
    const dry = cli(root, ["retitle", SHARED, "--title", "Alpha decision, renamed", "--dry-run"]);
    assert.match(dry, new RegExp(`would retitle ${SHARED}: "${OLD_TITLE}" → "Alpha decision, renamed"`));
    assert.match(dry, /copies: default, team-x/);
    assert.match(dry, /would publish the title, unreviewed, to shared graph: team-x/);
    assert.equal(readFileSync(f.home, "utf8"), beforeHome);
    assert.equal(commits(HOME_STORE(root)), 1);
    assert.equal(commits(SHARED_STORE(root)), 1);

    const out = cli(root, ["retitle", SHARED, "--title", "  Alpha decision, renamed  "]);
    assert.match(out, new RegExp(`✓ retitled ${SHARED}: "${OLD_TITLE}" → "Alpha decision, renamed"`));
    assert.match(out, /indexed \(\+\d+ changed, \d+ unchanged\)/);
    // a real run prints the copies and the shared graphs too, not only --dry-run
    assert.match(out, /copies: default, team-x/);
    assert.match(out, /published the title, unreviewed, to shared graph: team-x/);

    // both copies carry the (trimmed) title; nothing else but `updated` moved
    for (const file of [f.home, f.shared]) {
      assert.equal(titleOf(file), "Alpha decision, renamed");
      assert.equal(bodyOf(file), beforeBody);
      assert.deepEqual(restOf(file), beforeRest);
    }
    assert.ok(read(f.home).data.updated);

    // same file names: no new file, no rename
    assert.deepEqual(fileNames(HOME_STORE(root)), names.home);
    assert.deepEqual(fileNames(SHARED_STORE(root)), names.shared);

    // each member store got one commit, the title is not in its subject, worktree clean
    for (const store of [HOME_STORE(root), SHARED_STORE(root)]) {
      assert.equal(commits(store), 2);
      assert.equal(git(store, "log", "-1", "--format=%s"), `Retitle memory: ${SHARED}`);
      assert.equal(git(store, "status", "--porcelain"), "");
    }

    // the index follows, and the copies are consistent
    const listed = cli(root, ["list"]);
    assert.match(listed, /Alpha decision, renamed/);
    assert.doesNotMatch(listed, new RegExp(OLD_TITLE));
    assert.match(cli(root, ["graphs", "sync", "--dry-run"]), /✓ all graphs consistent/);

    // an unshared entry only touches the home store
    const plain = cli(root, ["retitle", PLAIN, "--title", "Plain note, renamed"]);
    assert.match(plain, /copies: default\n/);
    assert.doesNotMatch(plain, /shared graph/);
    assert.equal(titleOf(files(root, PLAIN).home), "Plain note, renamed");
    assert.equal(commits(SHARED_STORE(root)), 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retitle: YAML-special and long titles round-trip exactly", { timeout: 300_000 }, () => {
  const root = setup();
  try {
    const f = files(root, SHARED);
    const long = `Quarterly planning ${"notes on the onboarding flow, ".repeat(10)}wrap-up`;
    assert.ok(long.length > 300);
    const titles = [`Fix: the "onboarding" doc #2`, `- leading dash it's 'quoted'`, long];
    for (const title of titles) {
      // `--title=…` is how a value that starts with a dash is passed (node's parseArgs).
      cli(root, ["retitle", SHARED, `--title=${title}`]);
      for (const file of [f.home, f.shared]) assert.strictEqual(titleOf(file), title);
    }
    assert.equal(git(HOME_STORE(root), "status", "--porcelain"), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retitle: bad input exits non-zero, the same title is a no-op, neither changes anything", { timeout: 300_000 }, () => {
  const root = setup();
  try {
    const f = files(root, SHARED);
    const beforeHome = readFileSync(f.home, "utf8");
    const beforeShared = readFileSync(f.shared, "utf8");
    const head = () => [HOME_STORE(root), SHARED_STORE(root)].map((s) => git(s, "rev-parse", "HEAD"));
    const heads = head();
    const fails = (args: string[], message: RegExp) => {
      const r = run(root, args);
      assert.notEqual(r.status, 0, `${args.join(" ")} should fail`);
      assert.match(r.stderr, message);
    };

    fails(["retitle", "2026-01-01-nope", "--title", "Anything"], /no entry with id '2026-01-01-nope'/);
    fails(["retitle", SHARED, "--title", ""], /title must not be empty/);
    fails(["retitle", SHARED, "--title", "   "], /title must not be empty/);
    fails(["retitle", SHARED, "--title", "First line\nSecond line"], /single line/);
    // every control character (NUL cannot be passed in argv) and line separator, not only \r and \n
    for (const bad of ["a\rb", "a\u2028b", "a\u2029b", "a\u0085b", "a\tb", "a\u001bb", "a\u007fb", "a\u009fb", "a\u000bb", "a\u000cb"]) {
      fails(["retitle", SHARED, `--title=${bad}`], /single line without control or invisible formatting characters/);
    }
    fails(["retitle", SHARED], /usage: memory retitle/);
    fails(["retitle", SHARED, PLAIN, "--title", "Anything"], /usage: memory retitle/);

    // bidi embeddings/overrides/isolates, zero-width space and BOM are rejected too,
    // inside the title and (for BOM, which trim() would drop) at its ends
    const invisible = ["\u202A", "\u202B", "\u202C", "\u202D", "\u202E", "\u2066", "\u2067", "\u2068", "\u2069", "\u200B", "\uFEFF"];
    for (const ch of invisible) {
      fails(["retitle", SHARED, `--title=a${ch}b`], /single line without control or invisible formatting characters/);
    }
    fails(["retitle", SHARED, "--title=\uFEFFLeading BOM"], /invisible formatting/);
    fails(["retitle", SHARED, "--title=Trailing BOM\uFEFF"], /invisible formatting/);

    // The exact same title (surrounding whitespace is trimmed) is a no-op that exits 0,
    // dry-run or not, so a retried call never fails.
    for (const args of [["--title", OLD_TITLE], ["--title", `  ${OLD_TITLE} `], ["--title", OLD_TITLE, "--dry-run"]]) {
      const out = cli(root, ["retitle", SHARED, ...args]);
      assert.equal(out.trim(), `✓ unchanged ${SHARED}: "${OLD_TITLE}"`);
    }

    assert.equal(readFileSync(f.home, "utf8"), beforeHome);
    assert.equal(readFileSync(f.shared, "utf8"), beforeShared);
    assert.deepEqual(head(), heads);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retitle: a whitespace-only change applies, and repeating it is then a no-op", { timeout: 300_000 }, () => {
  const root = setup();
  try {
    const f = files(root, SHARED);
    const messy = "Alpha   shared  decision";
    cli(root, ["retitle", SHARED, "--title", messy]);
    for (const file of [f.home, f.shared]) assert.strictEqual(titleOf(file), messy);

    // cleaning the doubled spaces up is a real change, in every copy
    const out = cli(root, ["retitle", SHARED, "--title", OLD_TITLE]);
    assert.match(out, /✓ retitled /);
    for (const file of [f.home, f.shared]) assert.strictEqual(titleOf(file), OLD_TITLE);
    assert.equal(commits(HOME_STORE(root)), 3);

    // and the retry changes nothing
    assert.equal(cli(root, ["retitle", SHARED, "--title", OLD_TITLE]).trim(), `✓ unchanged ${SHARED}: "${OLD_TITLE}"`);
    assert.equal(commits(HOME_STORE(root)), 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retitle: LRM, RLM, ZWJ, ZWNJ and the soft hyphen stay allowed", { timeout: 300_000 }, () => {
  const root = setup();
  try {
    const f = files(root, SHARED);
    const titles = ["Review \u200Fsummary\u200E (v2)", "Team \u{1F469}\u200D\u{1F4BB} sync", "mi\u200Cx ed", "co\u00ADoperate plan"];
    for (const title of titles) {
      cli(root, ["retitle", SHARED, `--title=${title}`]);
      for (const file of [f.home, f.shared]) assert.strictEqual(titleOf(file), title);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
