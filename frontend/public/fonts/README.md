# Fonts

## Phenomena

Radomir Tinkov & Plamen Motev, published by [Fontfabric](https://www.fontfabric.com/fonts/phenomena/).
The display face for `h1`, `h2` and the wordmark (`--font-display` in `src/styles/tokens.css`).

**Installed and working.** Three files are in this directory:

```
Phenomena-Regular.woff2   32 KB   weight 400 — h2
Phenomena-Bold.woff2      35 KB   weight 700 — the wordmark
Phenomena-Black.woff2     33 KB   weight 900 — h1, button labels
```

All three were converted from the vendor `.otf` release (see below). `src/styles/fonts.css`
declares them; nothing else is needed. Each is fetched lazily, only when something on the page
actually asks for that weight.

### Licence — still open, resolve before shipping

The vendor archive shipped **no EULA file**, and the OTFs carry **no embedded licence string**
(name ID 13 is absent), so there is nothing in the files themselves that states what is permitted.
Fontfabric distributes Phenomena from its own site under its own terms. Confirm what your download
actually permits — specifically **webfont embedding** and **commercial use** — before this goes
anywhere but localhost, and keep a copy of those terms somewhere durable.

This also decides whether the three `.woff2` files belong in git. They are currently untracked and
*not* gitignored, so a `git add` would commit them. Committing redistributes them; that is the
call the licence check is for.

### Only three of seven weights are wired up

The family ships Thin, ExtraLight, Light, Regular, Bold, ExtraBold and Black. Regular, Bold and
Black are converted and declared because those are the only three the app asks for. To add another,
convert it (below), drop the `.woff2` here, and add an `@font-face` block in `src/styles/fonts.css`
alongside the existing three — the file name and the `font-weight` are the only things that change.

`body` sets `font-synthesis: none`, so nothing is ever faked. A weight you have not installed does
not render as a smeared fake bold; it resolves to the nearest weight you *have* installed, per the
CSS font-matching rules. That is deliberate — `h2` requests 500 and gets Regular.

### The vendor files use per-weight family names

`Phenomena-Bold.otf` reports its family as **"Phenomena Bold"** and its subfamily as "Regular" —
the old convention, where each weight is its own one-member family rather than a 700 within a
shared family. This does not affect us, because `@font-face` assigns both the family name and the
weight itself. It *would* break a `local()` source or a bare `font-family: Phenomena` resolving
against a system-installed copy. Keep the weight mapping in `fonts.css` rather than trusting the
files' own metadata.

### Converting the remaining weights

woff2 is roughly 40% smaller than otf and is the format every current browser prefers:

```sh
# one-off, no install — works on the vendor .otf directly
npx ttf2woff2 < Phenomena-Light.otf > Phenomena-Light.woff2
```

Verify the result is really woff2 before trusting it — the first four bytes must be `wOF2`:

```sh
xxd -l 4 -p Phenomena-Light.woff2   # -> 774f4632
```

### Check it loaded

In the browser console:

```js
document.fonts.check("16px Phenomena"); // 400 — h2
document.fonts.check("bold 16px Phenomena"); // 700 — the wordmark
document.fonts.check("900 16px Phenomena"); // 900 — h1 and buttons
```

All three should be `true`. If one is `false`, the Network tab will show which `/fonts/*.woff2`
404'd. Note that `[...document.fonts].map(f => f.status)` reports a weight as `unloaded` until the
page actually renders something in it — that is lazy loading, not a failure.

### A note on scope

Phenomena is a narrow geometric sans — tall, tightly set, and noticeably condensed against
`--font-sans`. It is scoped to large type on purpose: at 13px the narrow counters cost more
legibility than the character buys, and clinical values like "7 out of 10" are read carefully rather
than skimmed. To use it everywhere anyway, point `--font-sans` at it too in `tokens.css` — nothing
else needs to change.
