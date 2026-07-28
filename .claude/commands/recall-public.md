---
description: Recall ONLY one shared graph's memories (default public; never touches other graphs)
argument-hint: [graph name — default public] <question, or the shareable content to prepare>
---

Use the `recall-public` skill (`skills/recall-public/SKILL.md`) to answer the
following from ONE shared memory graph only (default `public`; if I name a
different graph, use that). Every retrieval command must carry
`--graph <name>`; if that graph is silent, say so — never widen the scope to
other graphs or fill gaps from chat history, and never surface a non-member
entry's content, id, title, or path. Cite the `memory-graphs/<name>/…`
entries you used.

Question / topic:

$ARGUMENTS
