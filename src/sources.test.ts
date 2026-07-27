import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildLookupCommand,
  loadSources,
  lookupDirectory,
  parseSource,
  reconcileSuggestions,
  slugQuery,
  type DirectoryMatch,
  type LookupRunner,
  type SourceFile,
} from "./sources.js";

const VALID = `---
name: people-directory
kind: person
enabled: true
lookup:
  command: "dir-lookup {query}"
---

# Guidance

Consult before minting.
`;

function makeLayers(): { templates: string; overrides: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "sources-test-"));
  const templates = join(root, "sources");
  const overrides = join(root, "memory", "sources");
  mkdirSync(templates, { recursive: true });
  mkdirSync(overrides, { recursive: true });
  return { templates, overrides, root };
}

// ---------------- parsing & schema ----------------

test("parseSource accepts a valid file and trims the body", () => {
  const { fm, body } = parseSource(VALID, "people-directory");
  assert.equal(fm.name, "people-directory");
  assert.equal(fm.kind, "person");
  assert.equal(fm.enabled, true);
  assert.equal(fm.lookup.command, "dir-lookup {query}");
  assert.ok(body.startsWith("# Guidance"));
});

test("parseSource rejects an unknown kind", () => {
  const raw = VALID.replace("kind: person", "kind: org");
  assert.throws(() => parseSource(raw, "people-directory"), /invalid source frontmatter/);
});

test("parseSource rejects a lookup command without {query}", () => {
  const raw = VALID.replace("dir-lookup {query}", "dir-lookup");
  assert.throws(() => parseSource(raw, "people-directory"), /\{query\} placeholder/);
});

test("parseSource rejects a missing lookup block and unknown keys", () => {
  const noLookup = `---\nname: x\nkind: person\n---\nbody`;
  assert.throws(() => parseSource(noLookup, "x"), /invalid source frontmatter/);
  const extraKey = VALID.replace("enabled: true", "enabled: true\nfetch: {}");
  assert.throws(() => parseSource(extraKey, "people-directory"), /invalid source frontmatter/);
});

test("parseSource rejects a name that doesn't match the filename stem", () => {
  assert.throws(() => parseSource(VALID, "other"), /must equal the filename stem/);
});

// ---------------- loading & override precedence ----------------

test("loadSources reads templates and collects per-file errors", async (t) => {
  const { templates, overrides, root } = makeLayers();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(templates, "people-directory.md"), VALID);
  writeFileSync(join(templates, "broken.md"), `---\nname: broken\n---\nbody`);

  const sources = await loadSources(templates, overrides);
  assert.deepEqual(
    sources.map((s) => [s.name, s.origin, Boolean(s.error)]),
    [["broken", "template", true], ["people-directory", "template", false]],
  );
  assert.match(sources[0]!.error!, /invalid source frontmatter/);
});

test("loadSources: an override fully replaces the template of the same name", async (t) => {
  const { templates, overrides, root } = makeLayers();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(templates, "people-directory.md"), VALID);
  writeFileSync(
    join(overrides, "people-directory.md"),
    VALID.replace("dir-lookup {query}", "real-lookup {query}"),
  );

  const sources = await loadSources(templates, overrides);
  assert.equal(sources.length, 1);
  assert.equal(sources[0]!.origin, "override");
  assert.equal(sources[0]!.fm!.lookup.command, "real-lookup {query}");
});

// ---------------- lookup mechanics ----------------

test("slugQuery turns a slug into a name query", () => {
  assert.equal(slugQuery("jane-doe"), "jane doe");
});

test("buildLookupCommand substitutes {query} shell-quoted, escaping quotes", () => {
  assert.equal(buildLookupCommand("dir-lookup {query}", "jane doe"), "dir-lookup 'jane doe'");
  assert.equal(buildLookupCommand("x {query} y {query}", "a'b"), `x 'a'\\''b' y 'a'\\''b'`);
});

const SOURCE = parseSource(VALID, "people-directory").fm;

test("lookupDirectory parses a JSON array of matches", async () => {
  const run: LookupRunner = async () => `[{"name": "Jane Doe", "id": "jdoe"}]`;
  assert.deepEqual(await lookupDirectory(SOURCE, "jane doe", run), [
    { name: "Jane Doe", id: "jdoe" },
  ]);
});

test("lookupDirectory degrades to null on failure, non-JSON, or bad shapes", async () => {
  const cases: LookupRunner[] = [
    async () => {
      throw new Error("command not found");
    },
    async () => "not json",
    async () => `{"name": "Jane"}`, // object, not array
    async () => `[{"id": "no-name"}]`, // element missing required name
  ];
  for (const run of cases) {
    assert.equal(await lookupDirectory(SOURCE, "jane doe", run), null);
  }
});

// ---------------- suggestion reconciliation ----------------

function sourceFile(over: Partial<SourceFile> = {}): SourceFile {
  return {
    name: "people-directory",
    path: "/sources/people-directory.md",
    raw: VALID,
    origin: "template",
    fm: SOURCE,
    body: "",
    ...over,
  };
}

function suggestion(from: string, to: string, kind = "person") {
  return { kind, from, to, confidence: 0.72, reasons: ["edit similarity 0.90"] };
}

/** Fake directory keyed by the (unquoted) query embedded in the command. */
function fakeDirectory(byQuery: Record<string, DirectoryMatch[]>): LookupRunner {
  return async (command) => {
    const query = /'([^]*?)'/.exec(command)?.[1] ?? "";
    const matches = byQuery[query];
    if (!matches) throw new Error(`unexpected lookup: ${command}`);
    return JSON.stringify(matches);
  };
}

test("both slugs resolving to distinct identities dismisses the suggestion", async () => {
  const run = fakeDirectory({
    "dana m": [{ name: "Dana Magen", id: "dmagen" }],
    "dana n": [{ name: "Dana Nadler", id: "dnadler" }],
  });
  const { kept, dismissed } = await reconcileSuggestions([suggestion("dana-m", "dana-n")], [sourceFile()], run);
  assert.equal(kept.length, 0);
  assert.equal(dismissed.length, 1);
  assert.match(dismissed[0]!.reason, /Dana Magen \(dmagen\)/);
  assert.match(dismissed[0]!.reason, /distinct identities/);
});

test("both slugs resolving to the same identity boosts confidence with a reason", async () => {
  const jane = [{ name: "Jane Doe", id: "jdoe" }];
  const run = fakeDirectory({ "jane doe": jane, "jane d": jane });
  const { kept, dismissed } = await reconcileSuggestions([suggestion("jane-d", "jane-doe")], [sourceFile()], run);
  assert.equal(dismissed.length, 0);
  assert.equal(kept.length, 1);
  assert.equal(kept[0]!.confidence, 0.95);
  assert.match(kept[0]!.reasons.at(-1)!, /both resolve to Jane Doe \(jdoe\)/);
});

test("a boost never lowers an already-higher confidence", async () => {
  const jane = [{ name: "Jane Doe", id: "jdoe" }];
  const run = fakeDirectory({ "jane doe": jane, "jane d": jane });
  const high = { ...suggestion("jane-d", "jane-doe"), confidence: 0.98 };
  const { kept } = await reconcileSuggestions([high], [sourceFile()], run);
  assert.equal(kept[0]!.confidence, 0.98);
});

test("zero or multiple matches leave the suggestion untouched", async () => {
  const run = fakeDirectory({
    "dana m": [],
    "dana n": [
      { name: "Dana Nadler", id: "dnadler" },
      { name: "Dana Nachman", id: "dnachman" },
    ],
  });
  const input = [suggestion("dana-m", "dana-n")];
  const { kept, dismissed } = await reconcileSuggestions(input, [sourceFile()], run);
  assert.equal(dismissed.length, 0);
  assert.deepEqual(kept, input);
});

test("a failing lookup command leaves the suggestion untouched", async () => {
  const run: LookupRunner = async () => {
    throw new Error("directory down");
  };
  const input = [suggestion("dana-m", "dana-n")];
  const { kept, dismissed } = await reconcileSuggestions(input, [sourceFile()], run);
  assert.equal(dismissed.length, 0);
  assert.deepEqual(kept, input);
});

test("non-JSON lookup output leaves the suggestion untouched", async () => {
  const run: LookupRunner = async () => "ERROR: not logged in";
  const input = [suggestion("dana-m", "dana-n")];
  const { kept } = await reconcileSuggestions(input, [sourceFile()], run);
  assert.deepEqual(kept, input);
});

test("disabled, invalid, or kind-mismatched sources are never consulted", async () => {
  const run: LookupRunner = async () => {
    throw new Error("must not run");
  };
  const disabled = sourceFile({ fm: { ...SOURCE, enabled: false } });
  const invalid = sourceFile({ fm: undefined, error: "invalid source frontmatter" });
  const teamOnly = sourceFile({ fm: { ...SOURCE, kind: "team" } });
  for (const sources of [[], [disabled], [invalid], [teamOnly]]) {
    const input = [suggestion("dana-m", "dana-n")];
    const { kept, dismissed } = await reconcileSuggestions(input, sources, run);
    assert.equal(dismissed.length, 0);
    assert.deepEqual(kept, input);
  }
});

test("tag suggestions pass through untouched even with a person source", async () => {
  const run: LookupRunner = async () => {
    throw new Error("must not run");
  };
  const input = [suggestion("k8s", "kubernetes", "tag")];
  const { kept } = await reconcileSuggestions(input, [sourceFile()], run);
  assert.deepEqual(kept, input);
});

test("identity falls back to name when the directory has no ids", async () => {
  const run = fakeDirectory({
    "jane d": [{ name: "Jane Doe" }],
    "jane doe": [{ name: "Jane Doe" }],
  });
  const { kept, dismissed } = await reconcileSuggestions([suggestion("jane-d", "jane-doe")], [sourceFile()], run);
  assert.equal(dismissed.length, 0);
  assert.equal(kept[0]!.confidence, 0.95);
});

test("lookups are cached per slug across suggestions", async () => {
  let calls = 0;
  const jane = [{ name: "Jane Doe", id: "jdoe" }];
  const counting: LookupRunner = async (command) => {
    calls++;
    return fakeDirectory({ "jane doe": jane, "jane d": jane, "jane do": jane })(command);
  };
  await reconcileSuggestions(
    [suggestion("jane-d", "jane-doe"), suggestion("jane-do", "jane-doe")],
    [sourceFile()],
    counting,
  );
  assert.equal(calls, 3); // jane-doe looked up once, not twice
});
