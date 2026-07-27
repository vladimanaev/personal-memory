import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRouting } from "./routing.js";

const valid = `---
name: graph-routing
enabled: true
default_graph: private
---

Route everything sensitive to private.
`;

test("parseRouting: valid file parses with body", () => {
  const { fm, body } = parseRouting(valid);
  assert.equal(fm.name, "graph-routing");
  assert.equal(fm.enabled, true);
  assert.equal(fm.default_graph, "private");
  assert.match(body, /sensitive/);
});

test("parseRouting: enabled and default_graph default to true/private", () => {
  const { fm } = parseRouting(`---\nname: graph-routing\n---\nbody`);
  assert.equal(fm.enabled, true);
  assert.equal(fm.default_graph, "private");
});

test("parseRouting: rejects a bad default_graph", () => {
  assert.throws(
    () => parseRouting(`---\nname: graph-routing\ndefault_graph: shared\n---\nbody`),
    /invalid routing frontmatter/,
  );
});

test("parseRouting: rejects unknown keys (strict envelope)", () => {
  assert.throws(
    () => parseRouting(`---\nname: graph-routing\nfetch: {}\n---\nbody`),
    /invalid routing frontmatter/,
  );
});

test("parseRouting: name must be the fixed stem", () => {
  assert.throws(
    () => parseRouting(`---\nname: other-routing\n---\nbody`),
    /must be 'graph-routing'/,
  );
});
