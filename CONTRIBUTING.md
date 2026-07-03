# Contributing

Thanks for improving Personal Memory. Bug reports, documentation fixes, UI
polish, retrieval improvements, connector templates, and agent-workflow
improvements are welcome.

## Ground Rules

- Preserve the local-first default. Do not make a hosted database, hosted vector
  store, or remote embedding provider required for normal use.
- Do not commit personal memory data. Keep `memory/`, `.index/`, model caches,
  connector overrides, tokens, and account-specific configuration out of source.
- Use the CLI for memory entries. Do not hand-create or edit files under
  `memory/entries/`; see [MEMORY-GUARDRAILS.md](MEMORY-GUARDRAILS.md).
- Keep PRs focused. One behavior change or documentation topic per PR is easier
  to review.
- Be respectful and follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Before You Start

Open an issue for large behavior changes, retrieval changes, schema changes, or
new connector patterns. Small typo fixes and broken-link fixes can go straight
to a pull request.

Good issues describe:

- what problem you hit
- what you expected to happen
- what happened instead
- the command or workflow involved
- whether private data was removed from examples

## Development Workflow

```bash
git clone https://github.com/vladimanaev/personal-memory.git
cd personal-memory
npm install
npm run typecheck
```

Useful commands:

```bash
npm run memory -- help
npm run memory -- connectors
npm run index
npm start
```

For UI changes, run `npm start` and check the app locally at
`http://127.0.0.1:4664`.

## Pull Request Checklist

- [ ] The change is focused and explained.
- [ ] `npm run typecheck` passes.
- [ ] README or docs are updated for user-facing changes.
- [ ] No personal memory data, private connector overrides, `.index/`, model
      caches, credentials, or screenshots with private data are included.
- [ ] Changes to capture or recall behavior preserve CLI-based memory access.
- [ ] New connector templates avoid personal queries, channels, names, or IDs.

## Privacy Review

Before opening a PR, run:

```bash
git status --short
git diff --cached --stat
```

Make sure the staged files are source, docs, or sanitized assets only.
