---
description: Recall ONLY shareable/public memories (never touches the private graph)
argument-hint: <question, or the shareable content to prepare>
---

Use the `recall-public` skill (`skills/recall-public/SKILL.md`) to answer the
following from the PUBLIC memory graph only. Every retrieval command must carry
`--graph public`; if the public graph is silent, say so — never widen the scope
to private memories or fill gaps from chat history, and never surface a private
entry's content, id, title, or path. Cite the `memory-public/…` entries you used.

Question / topic:

$ARGUMENTS
