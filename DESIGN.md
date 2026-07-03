---
name: Personal Memory
description: Calm, editorial read-only UI for a private personal memory record
colors:
  paper: "#f9f9f7"
  surface: "#fcfcfb"
  surface-2: "#f0f0ed"
  ink: "#0b0b0b"
  ink-secondary: "#52514e"
  muted: "#6e6d66"
  grid: "#e1e0d9"
  baseline: "#c3c2b7"
  working-blue: "#2a78d6"
  working-blue-text: "#1c60b4"
  working-blue-soft: "#cde2fb"
  confirm-green: "#006300"
  caution-amber: "#8a5a00"
typography:
  display:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "26px"
    fontWeight: 650
    letterSpacing: "-0.015em"
  headline:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "15px"
    fontWeight: 600
    letterSpacing: "-0.015em"
  title:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "15px"
    fontWeight: 600
  body:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "11px"
    fontWeight: 600
    letterSpacing: "0.04em"
  mono:
    fontFamily: "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "11.5px"
rounded:
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "10px"
  pill: "999px"
spacing:
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "24px"
  xl: "40px"
components:
  entry-row:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "13px 16px"
  chip:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink-secondary}"
    rounded: "{rounded.pill}"
    padding: "3px 11px"
  badge:
    textColor: "{colors.ink-secondary}"
    rounded: "{rounded.sm}"
    padding: "1px 6px"
  search-input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "10px 14px"
  tile:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "14px 16px 12px"
  tooltip:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.md}"
    padding: "6px 10px"
---

# Design System: Personal Memory

## 1. Overview

**Creative North Star: "The Quiet Ledger"**

This is a private book of record. One person opens it mid-workday to find what
he knows about a colleague, a decision, a month — reads the entry, and closes
it. The interface behaves like a well-kept ledger: dated rows in a single
prose-width column (880px wrap, 62ch reading measure), tabular numerals for
every date and count, hairline rules instead of boxes, and one ink color that
isn't black. Chrome recedes; the record carries the page.

The system is deliberately unspectacular. Typography does the hierarchy work —
weight and size, never color blocks or decoration. Surfaces separate from the
page by a single tone step and a 1px border; nothing floats, glows, or
animates. It explicitly rejects the two failure modes named in PRODUCT.md:
**SaaS dashboard clichés** (KPI hero cards, gradient accents, icon-tile grids)
and **dev-tool terminal cosplay** (all-monospace, neon-on-black). Monospace
appears only as an accent — ids, file paths, keyboard hints — never as the
voice.

**Key Characteristics:**
- Single centered column (max 880px), prose capped at 62ch
- Warm-neutral paper with one accent: Working Blue, ≤10% of any screen
- Flat construction: 1px borders and tone steps, zero shadows
- Entries render as **hairline ledger rows** — a fixed 92px date column, then
  the record — grouped by month; cards are reserved for charts
- Tabular numerals on every date, count, and score
- **Dark-first**: dark is the designed-primary theme (default; sun/moon header
  toggle persisted in localStorage), light inherits every decision through the
  same token names. Dark ink is off-white (#ececea) — never pure #fff on near-black
- Motion is feedback-only: 150ms color/border transitions on interactive elements and a quiet skeleton pulse while search is in flight — nothing enters, slides, or choreographs, and `prefers-reduced-motion` flattens all of it

## 2. Colors

A warm-neutral monochrome ramp with a single working accent; color is
information, never decoration.

### Primary
- **Working Blue** (#2a78d6 light / #3987e5 dark): the one ink that isn't
  black. Carries the focused search border, focus-visible rings, and every
  data mark (all chart bars).
- **Working Blue Text** (#1c60b4 light / #5f9ceb dark): the same voice
  deepened for *text* — links, relevance scores, entry cross-links — so accent
  type holds ≥4.5:1 at small sizes. Also the hover state of chart bars
  (emphasis darkens; it never washes out).
- **Working Blue Soft** (#cde2fb / #184f95): text `::selection` and instant-
  filter match highlights (`<mark>`) only.

### Neutral
- **Paper** (#f9f9f7 / #0f0f0e): the page itself — warm off-white, near-black in dark.
- **Surface** (#fcfcfb / #191918): cards and hover tints — one tone step off the page.
- **Surface-2** (#f0f0ed / #232322): the control layer — chips, selects, inputs,
  buttons all sit here, one step above Surface, so controls read as furniture.
- **Ink** (#0b0b0b / #ececea): primary text and the inverted tooltip background.
  Dark ink is off-white, never pure #fff — glare is not contrast.
- **Ink Secondary** (#52514e / #c3c2b7): supporting text, labels, chart value columns.
- **Muted** (#6e6d66 light / #898781 dark): dates, hints, empty states,
  metadata. Held at ≥4.5:1 on both Paper and Surface — small ledger annotations
  are still meant to be read.
- **Grid** (#e1e0d9 / #2c2c2a): hairline rules, badge borders, code borders.
- **Baseline** (#c3c2b7 / #383835): chart baselines, blockquote rules, hover borders.
- **Border** (rgba ink at 10%): the default 1px stroke on every surface.

### Semantic (rare, text-first)
- **Confirm Green** (#006300 text on rgba(12,163,12,0.1)): "index fresh" pill, copy-done state.
- **Caution Amber** (#8a5a00 text on rgba(250,178,25,0.14)): "index stale" pill, error banner text.

### Named Rules
**The One Ink Rule.** Working Blue is the only accent on any screen and covers
≤10% of it. Navigation state, links, scores, and data marks all share it. A
second accent hue is prohibited.

**The Ink-on-Its-Own-Paper Rule.** Semantic states (good/warn) are dark text
on a faint tint of the same hue — never white-on-saturated badges.

## 3. Typography

**Display Font:** system-ui (with -apple-system, "Segoe UI", sans-serif)
**Body Font:** system-ui — same family, one voice
**Label/Mono Font:** ui-monospace ("SF Mono", Menlo, Consolas)

**Character:** One native family in multiple weights — quiet, immediate, and
invisible in the best sense. Hierarchy comes from weight (400 → 600 → 650) and
size, with a slight negative tracking (-0.015em) on headings. Monospace is a
marginal annotation voice for ids, paths, and kbd hints.

### Hierarchy
- **Display** (650, 26px): entry-detail titles only. The largest type in the system.
- **Headline** (600, 15px, Ink Secondary): section headings ("By type", "Recent"). Deliberately body-sized; position and weight do the work.
- **Title** (600, 15px): entry titles inside rows.
- **Body** (400, 15px/1.55): entry prose, capped at 62ch.
- **Label** (600, 11px, +0.04em, uppercase): type badges and sidebar keys — the only uppercase in the system.
- **Mono** (11.5–12.5px): file paths, source ids, inline code, kbd.

### Named Rules
**The Tabular Numerals Rule.** Every date, count, and score renders with
`font-variant-numeric: tabular-nums`. A ledger's numbers align.

**The Label Heading Rule.** Section headings are Label voice — 12px uppercase,
+0.06em tracking, Muted — set apart by case, never by size. Only an entry's own
title (Display, 26px) may be larger than body. The record outranks the chrome.

## 4. Elevation

The system is flat — a book, not a stack. There are no box-shadows anywhere.
Depth is conveyed by exactly two devices: a one-tone step from Paper to
Surface, and a 1px border (`rgba(ink, 0.1)`). Hover raises nothing; it darkens
the border to Baseline or deepens text toward Ink. The single "highest"
element, the chart tooltip, inverts to solid Ink-on-Paper instead of casting a
shadow. The z-index scale has one working value (tooltip: 10).

### Named Rules
**The Flat Book Rule.** No box-shadows, no blurs, no glassmorphism. If an
element must read as "above", invert its colors (like the tooltip) — don't
lift it.

## 5. Components

All controls share one vocabulary — **the control furniture spec**: 28px
height, Surface-2 fill (never a ghost outline), 1px Border stroke, 8px radius
(999px for chips), 13px type. Hover deepens text to Ink and border to
Baseline; active presses back to Surface; focus-visible gets the 2px Working
Blue ring. Selects are `appearance: none` with a custom muted chevron so they
match; date inputs and the header search follow the same recipe. Nothing is
raised or glowing.

### Navigation
- **Style:** text links in the baseline-aligned header, 14px, Ink Secondary.
- **Hover:** color deepens to Ink; no underline, no background.
- **Active page:** 600 weight, Surface background, inset 1px ring (`box-shadow: inset 0 0 0 1px` — the only box-shadow property in the system, used as a border, radius 6px).
- **Header search:** on non-entries views the header carries a compact 200px search input (control furniture spec); Enter routes to the entries view and runs the semantic search.
- **Index status:** a 7px colored dot (Confirm Green / Caution Amber) + Muted 12.5px text — never a filled pill; passive status must not outshout content.
- **Theme toggle:** a 28px icon button (control furniture spec) showing the theme you'd switch *to*; persisted in localStorage, dark is the default.

### Type Chips (entries filter)
- **Style:** the standard chip row, one per entry type with its count, plus "all".
- **Selected:** Working Blue border + Working Blue Text label (`aria-pressed`), background unchanged — selection is stated in ink, not paint.

### Ledger Rows (signature component)
- **Shape:** borderless hairline rows — a two-column grid (`92px` date column +
  content), separated by 1px Grid rules. No card, no radius, no background at rest.
- **Anatomy:** date column in Muted tabular numerals (dates align down the page);
  content column holds the uppercase type badge → 600-weight title → Working Blue
  Text score pushed right, then snippet in Ink Secondary, then a metadata line of
  mini-chips and mono path.
- **Grouping:** in browse mode, rows sit under month heads ("July 2026 · n") —
  13px/600 Ink Secondary with a hairline underneath. Semantic results skip
  grouping (relevance order) and open with a plain hairline top rule.
- **Hover:** the row tints to Surface. Nothing else moves.

### Colophon (overview summary)
- **Style:** a single inline line of record facts ("**26** entries · **45**
  people · **81** tags · **2026-06-28 → 2026-07-01**") — values at 650 Ink,
  labels Ink Secondary, separators Baseline. Replaces stat tiles; a ledger
  states its totals, it doesn't dashboard them.

### People Table (overview)
- **Style:** hairline rows (`person | entries | last seen`), 13.5px, uppercase
  Label column heads, counts and dates in Muted tabular numerals right-aligned.
  Top 12 by mentions; the rest collapse behind a quiet `<details>` disclosure.
  Person names are text buttons that deepen to Working Blue Text on hover.

### Chips
- **Style:** full-pill (999px), Surface background, 1px border, 12.5px Ink Secondary; counts in Muted tabular numerals.
- **State:** hover deepens text to Ink and border to Baseline. `mini` variant (11.5px, `1px 8px`) for row metadata.

### Badges
- **Style:** the entry-type mark — **unboxed**: 10.5px uppercase, +0.08em
  tracking, Muted. No border, no background — a mark repeated on every row
  must whisper. (The old boxed badge is retired; a box on a passive label is
  control cosplay.)

### Inputs / Fields
- **Search:** full-width, Surface, 1px border, 10px radius, `10px 14px`, inherited font.
- **Focus:** border becomes Working Blue. No glow, no ring.
- **Facet selects / date inputs:** same recipe at 13px with 8px radius.

### Cards
- **Corner Style:** 10px.
- **Background:** Surface with 1px border; internal padding `18px 20px`.
- **Shadow Strategy:** none (see Elevation).
- **Use:** charts only. Entry lists are ledger rows, and overview stats are the
  colophon line — a card wrapping either is drift.

### Charts (hand-rolled SVG, single hue)
- **Marks:** ≤20px thick, solid Working Blue, 4px rounded cap at the data end
  only — square at the baseline (**The Square Baseline Rule**). Hover and
  keyboard focus deepen to Working Blue Text; each mark's hit target is its
  full band, and every mark carries an `aria-label`.
- **Values:** bars carry their value at the tip, columns on the cap (≤12
  columns; beyond that the tooltip + ticks carry it) — always in text tokens,
  never the series color.
- **Axes & grid:** hairline Grid gridlines at clean tick steps (1/2/5×10ᵏ), a
  single Baseline axis rule, 11px Muted tabular tick labels thinned to ≤12 on
  long ranges. Single series — no legend, the section heading names it.

### Tooltip
- **Style:** inverted — solid Ink background, Paper text, 8px radius, 12.5px; value at 650 weight, label at 75% opacity. Fixed-position, pointer-events none. Shown on hover *and* keyboard focus.

### Skeleton Rows
- **Style:** while semantic search is in flight, three entry-row-shaped Surface blocks with Grid bars and a 1.4s opacity pulse — never a spinner in the content area. Flattened under `prefers-reduced-motion`.

## 6. Do's and Don'ts

### Do:
- **Do** keep Working Blue at ≤10% of any screen; it must always mean something (link, focus, score, data).
- **Do** use `font-variant-numeric: tabular-nums` on every date, count, and score.
- **Do** separate surfaces with a 1px `rgba(ink, 0.1)` border and a single tone step — that is the entire elevation vocabulary.
- **Do** show provenance plainly: mono file paths, source ids, and dates on every entry, in Muted or Ink Secondary.
- **Do** define every color once per theme as a CSS custom property; dark mode remaps tokens, never restyles components.
- **Do** hold body text at AA contrast (≥4.5:1) in both themes — long reading sessions are the norm.
- **Do** give every interactive element a visible `:focus-visible` ring (2px Working Blue, 2px offset) — keyboard is a first-class input; `/` focuses search from anywhere.
- **Do** use Working Blue Text (never base Working Blue) whenever the accent is read as type.

### Don't:
- **Don't** ship SaaS dashboard clichés (PRODUCT.md, verbatim): no KPI hero cards, gradient accents, icon-tile grids, stat deltas, or "analytics product" styling.
- **Don't** ship dev-tool terminal cosplay (PRODUCT.md, verbatim): no scanlines, all-monospace layouts, or neon-on-black. Monospace is an accent voice only.
- **Don't** add box-shadows, blurs, or glassmorphism anywhere. The Flat Book Rule has no exceptions.
- **Don't** introduce a second accent hue, fill the type badges, or color entry titles.
- **Don't** use `border-left` stripes as category markers — entry types are marked by the outline badge.
- **Don't** add entrance animations, staggered reveals, or skeleton shimmer. If motion is ever added, it must explain a state change and respect `prefers-reduced-motion`.
