# Product

## Register

product

## Users

One user: the owner. He uses this
on his own machine, usually mid-workday between meetings, to recall what he knows
about people, teams, decisions, and past events — or to browse the record while
planning (1:1s, promos, reorgs, quarterly planning). The agent (Claude Code /
Codex) is the primary capture interface; the web UI is the human recall/browse
surface. Sessions are short and purposeful: find the relevant memory, read it,
get back to work.

## Product Purpose

A local, private RAG personal memory ("Personal Memory") for keeping the user's
working record over 6–12 month horizons. Markdown entries are the source
of truth; a LanceDB hybrid index powers semantic recall via the `memory` CLI; a
read-only web UI (port 4664) lets the user browse and search the record directly.
Success: any question about the people or history in the record is answerable in
seconds, with the answer grounded in dated, citable entries — and the record
stays trustworthy (immutable raw entries, deduped captures, additive summaries).

## Brand Personality

Calm, quiet, editorial. It should read like a well-typeset private notebook:
generous whitespace, restrained color, almost no motion. The interface recedes;
the record is the content. Emotional goal: quiet confidence — "it's all here,
nothing is lost" — never urgency, gamification, or productivity-tool cheer.

## Anti-references

- **SaaS dashboard clichés**: no KPI hero cards, gradient accents, icon-tile
  grids, stat tiles with big numbers, or "analytics product" styling. This is a
  record to read, not metrics to glance at.
- **Dev-tool terminal cosplay**: no fake-terminal aesthetics — scanlines,
  all-monospace layouts, neon-on-black. Monospace is an accent (ids, dates,
  commands), not the voice.

## Design Principles

1. **The record is the interface.** Entries, people, and dates carry the page;
   chrome stays minimal and monochrome, with the single accent reserved for
   navigation state and data marks.
2. **Recall speed over presentation.** Every screen optimizes time-to-found:
   search first, scannable dated lists, tight information scent. No screen
   should require reading to navigate.
3. **Trust through provenance.** Always show when something happened, when it
   was captured, and where it came from (source ids, file paths). Nothing in
   the UI should obscure the underlying Markdown truth.
4. **Editorial calm.** Typography does the hierarchy work — weight and size, not
   boxes and color. Whitespace over dividers; prose-width columns; motion only
   where it explains a state change.
5. **Local and private by posture.** The UI is read-only and single-user; it
   should feel like opening your own notebook, not logging into a product. No
   onboarding, no empty-state marketing, no calls to action.

## Accessibility & Inclusion

Sensible defaults, held consistently: WCAG AA contrast (≥4.5:1 body text,
including both light and dark themes), full keyboard navigability, visible
focus states, and `prefers-reduced-motion` respected for any animation. Single
local user, so no broader audience requirements — but AA is the floor, not a
nice-to-have, since long reading sessions in both themes are the norm.
