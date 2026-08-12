# Design system — "Clinical Calm"

Live reference: run the app and open [`#/styleguide`](http://localhost:5173/#/styleguide). It renders
the real tokens and the real component classes, so it cannot drift from the app.

## The idea in one line

Cool slate neutrals, one accent hue, flat surfaces — so that **anything coloured on screen means
something clinical**. There is no brand colour competing with a status colour, because there is no
brand colour.

## Layers

Imported in this order from `src/index.css` — the order is load-bearing.

| File         | Contains                                                                          |
| ------------ | --------------------------------------------------------------------------------- |
| `tokens.css` | Colour, type, space, radius, elevation, motion. Light + dark.                      |
| `base.css`   | Element defaults, then the primitives: `.btn` `.panel` `.pill` `.banner` `.field`. |
| `../App.css` | Feature layout only. Composes the above; contains no literal colours.              |

## Rules

**Component CSS may only reference semantic tokens** (`--text-secondary`, `--accent`, `--border`) —
never primitives (`--slate-500`, `--sky-700`). If a component reaches for a primitive, the role it
needs is missing; add it to `tokens.css` instead. This is why dark mode is one block of overrides
rather than a parallel stylesheet.

**One typeface, and no webfont.** `--font-sans` leads with Inter and falls through to the platform
UI face (SF Pro, Segoe, Roboto) — all humanist grotesks, all metrically close. Nothing is fetched,
so there is no FOUT to design around and no third-party request from a page handling patient
answers. `--font-display` still exists but is an **alias** of `--font-sans`: it is kept so that
"heading" remains a nameable role, and re-pointing that single token restores a separate display
face without editing a rule.

> If you want Inter guaranteed rather than opportunistic, **self-host** it and add an `@font-face`.
> Do not add a Google Fonts `<link>` — it leaks a request per page view to a third party, which is
> a bad trade on a clinical intake screen and an awkward line in the ISO 27001 assessment.

**Weight, not face, marks hierarchy.** With one family doing every job, the heavy end had to come
down: headings are `--weight-semibold` (600), and `--weight-bold` (700) appears exactly once, on the
wordmark. There is no 900 any more. That weight existed to give a narrow condensed face presence at
display size; a grotesk does not need it, and a very heavy h1 on an intake screen reads as urgency
the copy has not earned — which is precisely the signal an emergency banner needs to own.

**The wordmark is the logo.** There is no mark, glyph or lockup image — the header is one line of
type at `--weight-bold`. If you shrink it, shrink it toward `--text-base`; below that it stops
reading as a brand and starts reading as a stray header label.

**Surfaces are flat.** No mesh, no gradient, no grain, anywhere. A card separates from the page by
being lighter (`#ffffff` on `#f8fafc`), by a hairline, and by a shadow — that is the entire depth
model. The previous system's page-level gradient and film-grain layers are gone, along with
`grain.css` and the `.u-grain` / `.u-gradient-*` / `.u-mesh-panel` utilities.

**Text tiers are contrast-budgeted**, and the budget is measured against the *worst-case* surface in
each scheme — `--surface-sunken` in light, `--surface-raised` in dark, not `--bg` in either. All four
steps clear WCAG AA (4.5:1), including `--text-faint`, which carries the intake panel's field labels
and is content rather than decoration. Ratios are noted inline in `tokens.css`. Re-measure if you
re-point a surface.

**One focus treatment**, defined once in `base.css`. There is no bare `outline: none` in this
codebase; anything that removes the ring owes a replacement.

## Tint vs. field — the load-bearing distinction

Two ways a colour can be applied, and they are not interchangeable:

| Fill      | What it is                                    | Carries        | Used by                          |
| --------- | --------------------------------------------- | -------------- | -------------------------------- |
| **Tint**  | status colour at ~10% over the surface        | dark same-hue text | pills, patient turns, banners |
| **Field** | the colour at full saturation                 | a white label  | the primary action, an emergency |

Only two things in the app are ever a field: `.btn--primary` and `.banner--danger` / `.btn--danger`.
That is a difference in **kind**, not degree, and it is what makes an escalation unmistakable next
to an ordinary warning — you do not have to read the copy to know which is which. If a third
component starts filling with a saturated colour, this signal is gone.

## `--danger-fill` is the one token dark mode does not re-point

`--danger` lightens to `red-500` in dark mode for dots, borders and text, where the deeper red goes
muddy. But **white on `red-500` is 3.76:1** — below AA. So the emergency *fill* reads from a separate
token, `--danger-fill`, which stays `red-600` in both schemes (4.83:1 with white).

The surface that says "call 911" does not get to fail contrast because it looked better on a dark
page. `.btn--danger` and `.banner--danger` both read from `--danger-fill`, not `--danger`.

## Four values that are not the obvious pick

Each of these was chosen *because* the natural choice measured short. Do not "tidy" them back.

| Token           | Obvious pick        | Measured           | Actually used              |
| --------------- | ------------------- | ------------------ | -------------------------- |
| `--accent`      | `sky-600 #0284c7`   | **4.10:1** w/ white | `sky-700 #0369a1` → 5.93:1 |
| `--text-faint`  | `slate-500 #64748b` | **4.34:1** on sunken | `slate-550 #5b6a7d` → 5.04:1 |
| `--warning`     | `amber-500 #f59e0b` | **2.15:1** as a dot | `amber-600 #d97706` → 3.19:1 |
| `--success-text`| `green-700 #15803d` | **4.49:1** on tint  | `green-800 #166534` → 6.38:1 |

`--accent` is the one worth internalising: `sky-500`/`sky-600` are the steps that *look* like the
brand colour, and both fail AA under a white button label. The accent is a fill that carries text,
so it is budgeted as text.

## Why sky and not teal

Teal is the more fashionable "clinical" accent and it was the first candidate. It lost because teal
sits next to `--success` on the wheel, and in a triage UI *"the interactive colour"* and *"the
everything-is-fine colour"* must not be confusable. Sky is far enough from green, red and amber to
stay unambiguous against all three.

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

## Reduced motion

`prefers-reduced-motion` collapses all animation and transition to near-zero in `base.css`. There is
no longer a `prefers-reduced-transparency` block — it existed to drop the backdrop and grain layers,
and there are none.
