# Design system

Live reference: run the app and open [`#/styleguide`](http://localhost:5173/#/styleguide). It renders
the real tokens and the real component classes, so it cannot drift from the app.

## Layers

Imported in this order from `src/index.css` — the order is load-bearing.

| File          | Contains                                                                        |
| ------------- | ------------------------------------------------------------------------------- |
| `fonts.css`   | `@font-face` for the display face (Phenomena 400/700). See `public/fonts/README.md`. |
| `tokens.css`  | Colour, type, space, radius, elevation, motion. Light + dark.                     |
| `grain.css`   | The noise textures, the fixed page backdrop, and the `.u-*` gradient utilities.    |
| `base.css`    | Element defaults, then the primitives: `.btn` `.panel` `.pill` `.banner` `.field`. |
| `../App.css`  | Feature layout only. Composes the above; contains no literal colours.              |

## Rules

**Component CSS may only reference semantic tokens** (`--text-secondary`, `--accent`, `--border`) —
never primitives (`--warm-500`, `--indigo-600`). If a component reaches for a primitive, the role it
needs is missing; add it to `tokens.css` instead. This is why dark mode is one block of overrides
rather than a parallel stylesheet.

**Two type faces.** `--font-display` (Phenomena, by Radomir Tinkov & Plamen Motev / Fontfabric)
carries `h1`, `h2`, the wordmark and button labels; `--font-sans` carries everything else, including
`h3` at 15px and all sustained reading. Phenomena is a narrow geometric sans — fine large, but at
13px the tight counters cost more legibility than the character buys, which is why it is not the
body face. To use it everywhere, point `--font-sans` at it too.

Three weights are installed, of the seven the family ships, and each has exactly one job:

| Weight               | Used on                | Note                                              |
| -------------------- | ---------------------- | ------------------------------------------------- |
| 400 `--weight-normal`| `h2`                   | `h2` asks for 500 and resolves *down* to this      |
| 700 `--weight-bold`  | the wordmark           | the logo is type, so it needs the extra presence   |
| 900 `--weight-black` | `h1`, `.btn` labels    | weight buys presence without buying width          |

`body` sets `font-synthesis: none`, so an uninstalled weight is never faked — it resolves to the
nearest installed one per the CSS font-matching rules. That is why `h2` at `--weight-medium` renders
Regular rather than a smeared fake 500, and it is deliberate. A missing font *file* falls back to the
sans stack silently rather than failing the build. See `public/fonts/README.md`, which covers adding
a weight and **an unresolved licence question that needs answering before this ships**.

**Buttons are the one place the display face runs at body size**, which is why `.btn` is the only
rule that opens tracking to `--tracking-wide`. Black closes Phenomena's narrow counters, and at 12px
(`.btn--sm`) the lowercase e/a/o start to fill in without that air. If you re-point `--font-display`
to a wider face, that tracking should come back down.

**The wordmark is the logo.** There is no mark, glyph or lockup image — the header is one line of
type in the display face at `--weight-bold`, which is the only place in the app that uses 700. If
you shrink it, shrink it toward `--text-base`; below that it stops reading as a brand and starts
reading as a stray header label.

**Grain goes on ambient and emphatic surfaces only** — the page backdrop, the primary action, status
banners. Never behind sustained reading (panel bodies, transcripts, the event log),
because luminance noise under small text costs legibility. The grain tile is a fixed pixel size and
never scales with its host; that constant size is what reads as texture rather than as a blurry image.

Strength is two tokens: `--grain-opacity` (page backdrop, per scheme) and `--grain-surface-opacity`
(discrete surfaces — buttons, banners). The current setting is deliberately subtle: fine
specks, no contrast stretch, so it reads as paper tooth. **Opacity is the wrong dial if you want it
to bite harder** — raising it alone just lays down a flat grey veil. The two that actually change the
character are `baseFrequency` in `grain.css` (lower = chunkier specks; ~0.55 is coarse) and adding an
`feComponentTransfer` with a linear slope around 2, which pushes grains toward near-black and
near-white instead of clustering at mid-grey.

**Text tiers are contrast-budgeted.** All four steps clear WCAG AA (4.5:1) against the worst-case
background in their scheme, including `--text-faint`, which carries the intake panel's field labels.
Measured ratios are noted inline in `tokens.css`. Re-check them if you re-point a surface.

**One focus treatment**, defined once in `base.css`. There is no bare `outline: none` in this
codebase; anything that removes the ring owes a replacement.

**The brand tricolour exists at two strengths, and which one you use is decided by one question:
does anything sit on top of it?**

| Token           | Stops                              | Used on                                 |
| --------------- | ---------------------------------- | --------------------------------------- |
| `--mesh-brand`  | `blue-600 → white → red-600`       | **Nothing.** Reference only — see below. |
| `--mesh-accent` | `blue-200 → white → red-200`       | Anything carrying a label (the button)   |

`--mesh-brand` cannot host text at all: its blue and red ends need a light label and its white
midpoint needs a dark one, so no single colour survives the sweep. That is the whole reason the
lightened tier exists. Keep the two in sync if you re-angle or re-stop either.

Since the logo mark was removed, **nothing in the app renders `--mesh-brand`** — the wordmark carries
the brand now. It is kept as the canonical statement of the ramp (the styleguide renders it, and
`--mesh-accent` is the same sweep lightened). Do not press it back into service as a surface without
re-reading the paragraph above.

**A gradient through white has no fill contrast — the border is load-bearing.** In light mode the
button's white midpoint sits at **1.04:1** against `--bg`, so the fill alone does not define the
button's edge at all. `.btn--primary` carries an explicit border for this reason; removing it makes
it dissolve into a light page. (In dark mode the same pale fill is
14–20:1 against the page and pops on its own.)

**Red is a brand colour now; danger must still win.** Two things keep an emergency unmistakable:

1. Every accent *surface* — `--accent-soft`, `--accent-border`, focus, links, the active pill — is
   **blue only**. Red appears solely inside the brand gradients and `--mesh-ambient`.
2. `--mesh-danger` is deliberately **not a sweep**. It is a flat, fully saturated red field. That
   flatness, against a brand ramp that visibly travels blue → white → red, is the distinguishing
   signal — and the brand ramp on labelled surfaces is pale, where danger is saturated.

If you re-point the accent, re-check both — dropping either makes the emergency banner read as
decoration.

**Gradient stops are contrast-budgeted across the whole sweep, not just at the stops.** Near-black
sits on `--mesh-accent` (button labels); worst point across the ramp is 13.7:1, at the red end.
Sample the interpolation rather than the endpoints if you move a stop, and re-check the direction of
the budget if you ever re-saturate the fill — a darker fill flips the label back to light, and then
the white midpoint becomes the failure point instead of the ends.

## Adding a variant

Prefer a new hook over a new rule. `.pill` carries its colour on `--pill-color` and `.stage` on
`--stage-accent`, so a variant is one declaration:

```css
.pill--success {
  --pill-color: var(--success-text);
  border-color: var(--success-border);
  background-color: var(--success-soft);
}
```

## Reduced motion / transparency

`prefers-reduced-motion` collapses all animation and transition to near-zero in `base.css`.
`prefers-reduced-transparency` drops both backdrop layers and the grain overlays in `grain.css`.
