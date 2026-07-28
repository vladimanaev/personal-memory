---
description: Recall ONLY one shared graph's memories (never touches other graphs)
argument-hint: <graph name> <question, or the shareable content to prepare>
---

Use the `recall-graph` skill (`skills/recall-graph/SKILL.md`) to answer the
following from ONE shared memory graph only (the graph is named in the
request — ask me if it's ambiguous; `memory graphs list` shows the registry).
Every retrieval command must carry `--graph <name>`; if that graph is silent,
say so — never widen the scope to other graphs or fill gaps from chat
history, and never surface a non-member entry's content, id, title, or path.
Cite the `memory-graphs/<name>/…` entries you used.

Graph + question:

$ARGUMENTS
