# Security Policy

## Reporting a Vulnerability

Please do not open a public GitHub issue with vulnerability details.

Use GitHub private vulnerability reporting if it is available for this
repository. If private reporting is not available, open a minimal public issue
asking for a secure contact path and do not include exploit details, secrets,
private memory content, or screenshots with private data.

Useful report details:

- affected commit, version, or branch
- reproduction steps
- expected and actual behavior
- whether the issue involves the CLI, local UI, connector loading, indexing, or
  agent workflow
- any relevant logs with private data removed

## Scope

In scope:

- the TypeScript CLI and local web UI
- local indexing and retrieval behavior
- connector template loading and validation
- agent instructions, guardrails, and slash commands shipped in this repo
- accidental disclosure risks in public assets or documentation

Out of scope:

- private memory content stored in a user's local `memory/` directory
- credentials, tokens, or account-specific connector overrides created by a user
- vulnerabilities in optional third-party embedding providers
- compromise of the user's local machine or shell environment

## Security Posture

Personal Memory is designed to run locally:

- the UI binds to `127.0.0.1`
- `memory/` and `.index/` are gitignored in the main repository
- default embeddings run on-device
- remote embedding backends are opt-in through `MEMORY_EMBEDDINGS`

Please include privacy impact in security reports when relevant.
