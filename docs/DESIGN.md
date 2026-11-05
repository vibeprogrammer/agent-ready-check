# Design

The web UI and the HTML report (landing page, reports, `/docs`, `/checks`, `/privacy`, `/terms` and the error pages) share one stylesheet, `/assets/app.css`, written in `src/report/assets.mjs`. This file records where the colours come from, the tokens, the fonts, the contrast checks and the rules the layout follows. Design version: v0.2.0.

## Direction

A pixel theme on a light page. Everything sits on an 8 px grid with square 2 px borders, hard offset shadows (no blur) on the two panels that matter, and pixel-art glyphs drawn as tiny SVGs. There are no rounded corners, gradients, card grids, emoji or stock images.

**One scheme, light.** The source page, the GitHub Universe recap, is light-first: a white page, near-black text, and dark pixel tiles in its hero canvas. We follow it. The page is `--paper`, and dark `--ink` slabs carry the two things you look at first: the score console on a report, and the CLI panel and level scale on the landing page. There is no dark-mode switch. One deliberate scheme is easier to keep contrast-safe than two (`<meta name="color-scheme" content="light">`).

## Palette

Read on **5 November 2026** from <https://github.com/events/universe/recap/> in Chromium 156 (Playwright, 1440×900 viewport), from computed CSS (`getComputedStyle`) and from the pixels of the hero `<canvas>` (the colours that canvas draws, counted in a screenshot of it).

| Token | Hex | Where it came from on the recap page |
| --- | --- | --- |
| `--paper` | #f2f5f3 | Computed `background-color` of the footer, the footer bar and the Share buttons; also the hero canvas background |
| `--panel` | #ffffff | Computed `background-color` of `body` and `main` |
| `--text` | #1f2328 | Computed `color` of `body` |
| `--ink` | #1e162b | Hero canvas: the dark pixel tiles |
| `--ink-deep` | #180e27 | Hero canvas: the darkest tiles |
| `--muted` | #58635b | Computed `color` of the lead paragraph (`p`, "Catch up on the key announcements…") |
| `--rule` | #b6bfb8 | Computed `border-color` of the Search button and `kbd` |
| `--rule-soft` | #e4ebe6 | The most common computed `border-top-color` on the page (dividers) |
| `--green` | #08872b | Computed `background-color` of every primary button ("Read the docs", "Get notified"…), the Platform tab marker (`::after`) and the footer visual |
| `--green-deep` | #0d6731 | Computed `border-top-color` of `footer` and `background-color` of the footer heading dot |
| `--mint` | #5fed83 | Hero canvas: the bright green tiles |
| `--violet` | #583af7 | Hero canvas: the violet tiles |
| `--lavender` | #ae85ff | Hero canvas: the lavender tiles |
| `--pink` | #f73678 | Computed `background-color` of the Copilot tab marker (`a[class*=AnchorNav-link]::after`) and the Copilot section icon |
| `--blue` | #168ffb | Computed `background-color` of the Security tab marker and section icon |
| `--olive` | #bba00a | Computed `background-color` of the Octoverse tab marker and section icon |
| `--orange` | #c05200 | Hero canvas: the burnt-orange tiles |
| `--cream` | #f5f0eb | Hero canvas: the cream tiles |
| `--plum` | #3d274f | Hero canvas: the plum tiles |

The page's own custom properties on `:root` are GitHub's general Primer tokens (diff, data-viz and control colours), not this page's look, so they were not used.

### Derived colours (contrast fixes)

Three source colours fail as text on the light page. Each was kept as a fill and given a text variant: the same hue and saturation, with HSL lightness lowered in 0.5 % steps until the colour reaches at least 4.5:1 on `--paper` (the darker of the two light surfaces).

| Token | Hex | From | As text on white, before → after |
| --- | --- | --- | --- |
| `--pink-text` | #da0950 | `--pink` #f73678 | 3.65:1 → 5.08:1 |
| `--olive-text` | #7e6c07 | `--olive` #bba00a | 2.58:1 → 5.20:1 |
| `--blue-text` | #046ece | `--blue` #168ffb | 3.30:1 → 5.09:1 |

Other pairs that failed and how they were fixed:

- White on `--pink` (3.65:1), on `--olive` (2.58:1) and on `--blue` (3.30:1): the status chips use `--ink` text on these fills instead (4.78, 6.76 and 5.28:1).
- `--muted` on `--ink` (2.78:1): small text on dark panels uses `--lavender` instead (6.31:1).
- `--green` text on `--paper` (4.24:1): pass text uses `--green-deep` (6.37:1). `--green` stays as the button fill (white label 4.66:1) and as meter blocks on white panels (4.66:1).
- `--mint` (1.51:1) and `--lavender` (2.76:1) on white: used only as fills under `--ink` text, or as text on `--ink`.

## Contrast table

Every foreground/background pair the stylesheet uses, with the WCAG 2.x contrast ratio computed from relative luminance. Text needs 4.5:1, large text (the 96 px score) 3:1, UI components and focus indicators 3:1.

| Foreground | Background | Used for | Ratio | Needs | Result |
| --- | --- | --- | --- | --- | --- |
| `--text` #1f2328 | `--paper` #f2f5f3 | body text | 14.39:1 | 4.5:1 | pass |
| `--text` #1f2328 | `--panel` #ffffff | body text in panels and tables | 15.80:1 | 4.5:1 | pass |
| `--ink` #1e162b | `--paper` #f2f5f3 | headings, borders | 15.88:1 | 4.5:1 | pass |
| `--ink` #1e162b | `--panel` #ffffff | headings in panels, quiet buttons | 17.43:1 | 4.5:1 | pass |
| `--ink` #1e162b | `--cream` #f5f0eb | fix block text | 15.39:1 | 4.5:1 | pass |
| `--ink` #1e162b | `--rule-soft` #e4ebe6 | inline code | 14.38:1 | 4.5:1 | pass |
| `--muted` #58635b | `--paper` #f2f5f3 | small text, captions | 5.71:1 | 4.5:1 | pass |
| `--muted` #58635b | `--panel` #ffffff | small text in panels, finding messages | 6.27:1 | 4.5:1 | pass |
| `--violet` #583af7 | `--paper` #f2f5f3 | links | 5.69:1 | 4.5:1 | pass |
| `--violet` #583af7 | `--panel` #ffffff | links in panels | 6.24:1 | 4.5:1 | pass |
| `--violet` #583af7 | `--cream` #f5f0eb | links in fix blocks | 5.51:1 | 4.5:1 | pass |
| `--white` #ffffff | `--green` #08872b | primary button label | 4.66:1 | 4.5:1 | pass |
| `--white` #ffffff | `--green-deep` #0d6731 | primary button hover | 7.00:1 | 4.5:1 | pass |
| `--ink` #1e162b | `--mint` #5fed83 | Pass chip, current level | 11.56:1 | 4.5:1 | pass |
| `--ink` #1e162b | `--pink` #f73678 | Fail chip | 4.78:1 | 4.5:1 | pass |
| `--ink` #1e162b | `--olive` #bba00a | Warning chip, Draft badge | 6.76:1 | 4.5:1 | pass |
| `--ink` #1e162b | `--blue` #168ffb | Info chip | 5.28:1 | 4.5:1 | pass |
| `--white` #ffffff | `--orange` #c05200 | Error chip | 4.72:1 | 4.5:1 | pass |
| `--ink` #1e162b | `--lavender` #ae85ff | reached level, Guidance badge | 6.31:1 | 4.5:1 | pass |
| `--pink-text` #da0950 | `--panel` #ffffff | error page status line | 5.08:1 | 4.5:1 | pass |
| `--pink-text` #da0950 | `--paper` #f2f5f3 | fail text on the page | 4.63:1 | 4.5:1 | pass |
| `--green-deep` #0d6731 | `--paper` #f2f5f3 | pass text token | 6.37:1 | 4.5:1 | pass |
| `--olive-text` #7e6c07 | `--paper` #f2f5f3 | warn text token | 4.74:1 | 4.5:1 | pass |
| `--blue-text` #046ece | `--paper` #f2f5f3 | info text token | 4.64:1 | 4.5:1 | pass |
| `--paper` #f2f5f3 | `--ink` #1e162b | headings on dark panels | 15.88:1 | 4.5:1 | pass |
| `--cream` #f5f0eb | `--ink` #1e162b | text on dark panels, code blocks | 15.39:1 | 4.5:1 | pass |
| `--cream` #f5f0eb | `--ink-deep` #180e27 | code in the CI panel | 16.40:1 | 4.5:1 | pass |
| `--mint` #5fed83 | `--ink` #1e162b | links, score (good), prompts on dark | 11.56:1 | 4.5:1 | pass |
| `--lavender` #ae85ff | `--ink` #1e162b | small text and next levels on dark | 6.31:1 | 4.5:1 | pass |
| `--olive` #bba00a | `--ink` #1e162b | score 40-69 (96px) | 6.76:1 | 3:1 | pass |
| `--pink` #f73678 | `--ink` #1e162b | score under 40 (96px) | 4.78:1 | 3:1 | pass |
| `--paper` #f2f5f3 | `--plum` #3d274f | inline code on dark | 11.95:1 | 4.5:1 | pass |
| `--ink` #1e162b | `--paper` #f2f5f3 | UI: borders of fields, buttons, chips | 15.88:1 | 3:1 | pass |
| `--violet` #583af7 | `--paper` #f2f5f3 | UI: focus outline | 5.69:1 | 3:1 | pass |
| `--mint` #5fed83 | `--ink` #1e162b | UI: focus outline on dark | 11.56:1 | 3:1 | pass |
| `--green` #08872b | `--panel` #ffffff | UI: layer meter blocks (70+) | 4.66:1 | 3:1 | pass |
| `--olive-text` #7e6c07 | `--panel` #ffffff | UI: layer meter blocks (40-69) | 5.20:1 | 3:1 | pass |
| `--pink-text` #da0950 | `--panel` #ffffff | UI: layer meter blocks (<40) | 5.08:1 | 3:1 | pass |

Decorative only, with no information of their own: the empty blocks of the score meter (`--plum` on `--ink`, 1.33:1) and of the layer meters (`--rule-soft` with a `--rule` outline on white). Both meters are `aria-hidden`, and the number next to them carries the value. The colour bar under the header and above the footer is decoration.

Lighthouse accessibility, measured locally on 5 November 2026 (Lighthouse from npm, run against Chromium 156): 100 on the landing page, 100 on a report with 25 failing checks, 100 on a report of the service itself, and 100 on `/docs`.

## Fonts

| Use | Font | Licence | Source |
| --- | --- | --- | --- |
| Headings, labels, scores, buttons | **Silkscreen** 400 and 700 by Jason Kottke | SIL Open Font License 1.1 (full text in `src/report/fonts/OFL.txt`, from <https://github.com/google/fonts/blob/main/ofl/silkscreen/OFL.txt>) | Latin-subset woff2 files as served by Google Fonts for `css2?family=Silkscreen:wght@400;700` (v6), downloaded 5 November 2026. The font's upstream repository is <https://github.com/googlefonts/silkscreen>. |
| Body text | System UI stack (`system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", …`) at 17 px (16 px on phones), line height 1.6 | The visitor's own fonts | Not shipped |
| Code, URLs, check ids | System monospace stack (`ui-monospace, SFMono-Regular, "Cascadia Mono", …`) | The visitor's own fonts | Not shipped |

The fonts are self-hosted, like every other asset. They sit in the `ASSETS` map at `/assets/fonts/silkscreen-400.woff2` and `/assets/fonts/silkscreen-700.woff2`, base64-encoded with `encoding: 'base64'` (`src/report/fonts.mjs`), and the server decodes them to bytes. They are preloaded and use `font-display: block`, so headings don't shift when the font arrives (the e2e test holds CLS under 0.01).

## Tokens

All colours are CSS custom properties on `:root` in `src/report/assets.mjs`. Beyond the palette:

- Status tokens: `--pass-fill` (mint), `--fail-fill` (pink), `--warn-fill` (olive), `--info-fill` (blue), `--error-fill` (orange), and the matching `--*-text` variants for text on light surfaces.
- Type: `--font-pixel`, `--font-body`, `--font-mono`.
- Grid: `--u: 8px` (all spacing is a multiple of 4 or 8 px), `--b: 2px` (borders), `--wrap: 1120px` (content width).

## Status encoding

Each status shows three things at once: a colour, a pixel glyph with its own shape, and the word. None of them depends on the others, so the encoding works without colour (colour-blind or greyscale) and without the glyph (screen readers read the word; the glyph is `aria-hidden`).

| Status | Chip fill / text | Glyph (7×7 pixels) | Label |
| --- | --- | --- | --- |
| pass | mint / ink | check mark | Pass |
| fail | pink / ink | X (cross) | Fail |
| warn | olive / ink | exclamation mark | Warning |
| info | blue / ink | lower-case i | Info |
| error | orange / white | question mark | Error |
| neutral | soft grey / ink | horizontal bar | Not applicable |
| skipped | white, dashed border / ink | hollow square | Skipped |

The glyphs are drawn from pixel rows in `src/report/html.mjs` (`GLYPHS`, `pixelSvg`), with `shape-rendering: crispEdges`. In the findings list the chip fills a fixed-width status column, so a page of results reads as a column of colour and shape before any words.

Scores use bands: 70 and up mint (`--green` on white), 40–69 olive, under 40 pink. The band is always next to the number.

Standard maturity badges (Standard, Guidance, Draft, Proposal, Convention) are square tags: Standard on mint, Guidance on lavender, Draft on olive, and Proposal and Convention dashed and unfilled, so the weaker evidence also looks weaker.

## Layout and hierarchy

- **Landing page:** the scan box comes first: the heading, one sentence on what the tool reads, then the form, with the violet offset shadow as the page's one loud element. Beside it, a dark panel shows what you get back: a 0–100 score and the L0–L5 level scale drawn as pixel stairs. Below that come the 13 layers as a numbered, ruled list with check counts (not cards); a two-column block with what every finding contains and how standards are weighted; a dark terminal panel for agents and CI; and where the checks come from.
- **Report:** the compact rescan bar comes first, then the score console, a dark slab split in two. On the left: the host as the page's one `h1`, the scan facts, the score in 96 px Silkscreen, a 20-step block meter (5 points a block), the grade and the pass/warn/fail tally. On the right: the isitagentready-compatible level on the pixel stairs (reached levels in lavender, the current one in mint with a white outline, later ones dashed) and what the next level needs. Then the layer scores as a two-column ruled list with 10-step meters, the Lighthouse Agentic view and the role table, and the findings grouped by layer. The filter bar and "Copy all fix prompts" come first, and each finding is a disclosure row: status column, title, message. Opened, it shows the standard, why it matters, the fix (a cream block with snippet and fix prompt) and the evidence. The request log and share links come last.
- **Docs, checks, privacy, terms, errors:** one `h1` with a pink pixel marker, the lead paragraph ruled off below, and prose capped at 78 characters a line.
- **Phones (390 px):** single column. The level stairs turn sideways: the step widths grow instead of the heights. The status chip moves above the title, tables tighten, and nothing scrolls sideways (checked at 390 px on all four views).
- **Focus and motion:** every interactive element shows a 3 px violet focus outline (mint on dark panels) with a 2 px offset. The only animation is the blinking pixel next to "Scanning…" and the 4 px press of a button. Both are switched off under `prefers-reduced-motion: reduce`.
- **Constraints kept:** the CSP stays `'self'` (no inline styles, `style` attributes, inline scripts or external fonts). One `h1` per page. Landmarks, the skip link, the declarative WebMCP form attributes, the imperative tools in `app.js`, JSON-LD and the Markdown alternate links are unchanged.
