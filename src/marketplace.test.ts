import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import { ROOT } from "./ingest.js";

/**
 * Sanity checks for the plugin-marketplace manifests (.claude-plugin/), which
 * both Claude Code and Codex consume. Nothing here executes plugin tooling —
 * it guards the static contract: parseable JSON, names/versions that agree
 * with package.json, and a skills/ directory that actually matches what the
 * manifests advertise.
 */

const readJson = (p: string) => JSON.parse(readFileSync(join(ROOT, p), "utf8")) as Record<string, any>;

const marketplace = readJson(".claude-plugin/marketplace.json");
const plugin = readJson(".claude-plugin/plugin.json");
const pkg = readJson("package.json");

test("marketplace lists exactly one plugin, rooted at the repo", () => {
  assert.equal(marketplace.name, "personal-memory");
  assert.equal(marketplace.plugins.length, 1);
  const entry = marketplace.plugins[0];
  assert.equal(entry.name, plugin.name);
  assert.equal(entry.source, "./");
});

test("plugin manifest agrees with package.json", () => {
  assert.equal(plugin.name, pkg.name);
  assert.equal(plugin.version, pkg.version);
  assert.equal(marketplace.plugins[0].version, pkg.version);
  assert.equal(plugin.license, pkg.license);
});

const skillDirs = readdirSync(join(ROOT, "skills")).filter((d) =>
  statSync(join(ROOT, "skills", d)).isDirectory(),
);

test("every skill directory ships a SKILL.md whose frontmatter name matches", () => {
  assert.ok(skillDirs.length >= 7);
  for (const dir of skillDirs) {
    const path = join(ROOT, "skills", dir, "SKILL.md");
    assert.ok(existsSync(path), `missing ${dir}/SKILL.md`);
    const { data } = matter(readFileSync(path, "utf8"));
    assert.equal(data.name, dir, `frontmatter name must equal the directory name in ${dir}`);
    assert.ok(typeof data.description === "string" && data.description.length > 0, `${dir} needs a description`);
  }
});

test("every skill tells installed copies how to locate the store", () => {
  // Installed via the marketplace, skills run from foreign projects where the
  // CLI's cwd-relative store resolution breaks — each must carry the operative
  // MEMORY_HOME contract, not just mention the variable: cd into the store for
  // CLI commands, and point nested-git checks at its memory/ repo.
  for (const dir of skillDirs) {
    const body = readFileSync(join(ROOT, "skills", dir, "SKILL.md"), "utf8");
    for (const phrase of [`cd "$MEMORY_HOME" && npx tsx src/cli.ts`, `git -C "$MEMORY_HOME/memory"`]) {
      assert.ok(body.includes(phrase), `${dir}/SKILL.md lacks the store-location instruction: ${phrase}`);
    }
  }
});
