# Claude Usage widget — feature & visual redesign

Status: approved, implementing.

## Context

The Windows panel (`windows/panel/`) was built functionally-first across
several sessions. Before publishing it publicly, revisit both what it
tracks and how it looks, rather than shipping the first-draft version.

## Feature change

- **Drop Cowork tracking.** The user doesn't use Claude Cowork; the row
  always reads "not used this week" for them and most people won't have
  used it either. Not worth a permanent row.
- **Add usage credits instead.** The `/api/oauth/usage` response includes
  a `spend` object (`used`/`limit`/`percent`, minor-unit currency amounts)
  that's more universally relevant than Cowork — every paid plan can hit
  it. Mirrors the "$X spent / Y% used" block already shown on claude.ai's
  own Settings → Usage page.
- Net effect: the panel still shows exactly 3 rows, just Session / Weekly
  / Credits instead of Session / Weekly / Cowork.

## Visual direction: "Refined minimal"

Chosen over a denser "compact stat strip" alternative (single-line-per-row
layout) — the user picked the evolutionary option that keeps the current
stacked-row layout but treats color and type with more intention, rather
than a bigger structural departure.

**Color system** (replaces literal traffic-light red/yellow/green):
- Low usage: muted sage `#8FBC94`
- Mid usage: warm amber `#E8A94B`
- High/critical usage: Anthropic coral `#D97757` — same hue as the tray
  icon, so the "at your limit" state visually ties back to the app's own
  identity instead of a generic alarm red.
- Panel background: warm near-black (`#18161A`-ish) instead of neutral
  gray, in both dark and light themes' dark variant.
- Thresholds unchanged: <50% low, 50-79% mid, >=80% high.

**Typography**: row labels (SESSION / WEEKLY / CREDITS) become small
(~10-11px) uppercase, letter-spaced, dimmed — secondary/metadata role.
Percentage values become the visual focus: larger, semibold,
`font-variant-numeric: tabular-nums` so digits don't shift width as the
live value updates. Still system font (Segoe UI/-apple-system) — no
bundling cost, stays native.

**Bars**: 10px tall (was 8px), fully pill-rounded, subtle inset shadow on
the track for depth, faint top-to-bottom gradient on the fill instead of
flat color.

**Container**: hairline 1px border added (stays legible over any desktop
background since the panel sits on top of arbitrary content), corner
radius up from 16px to ~18-20px, more generous padding and inter-row
spacing.

**Explicitly out of scope**: no true OS-level blur-behind (still not
implemented, per earlier build notes), no layout restructuring beyond the
row-content swap, no new rows/metrics beyond the Cowork→Credits swap —
this is a visual refinement pass, not a feature expansion, consistent with
"stay minimal."

## Implementation touch points

- `windows/panel/poller.js` — replace `seven_day_cowork` parsing with a
  `credits` field derived from `resp.spend` (percent + used/limit dollar
  amounts); null when the account doesn't have spend/credits enabled.
- `windows/panel/renderer.js` — new row markup (uppercase label span +
  value span), new `colorFor` palette, Credits row replacing Cowork row,
  new empty-state copy for credits-not-enabled.
- `windows/panel/styles.css` — full visual pass per above.
- No changes needed to `main.js`, `preload.js`, or `index.html` structure
  beyond what renderer.js already emits into `#accounts`.

## Testing plan

Verify against the live API (real account, already confirmed `spend` is
populated) rather than assuming the shape is right. Capture the panel's
own rendered window (not the desktop) to visually confirm colors/spacing
match the design, per the established pattern in this project of avoiding
full-desktop screenshots.
