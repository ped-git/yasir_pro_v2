# Regression suites

Two groups. Both launch the projects they compare, capture everything in one browser
engine (Chromium through Playwright 1.64.1, headless), and write generated artifacts only
under `tests/.output/`, which is gitignored.

The parity suites read the reference project at `../yasir_pro`
(override: `YASIR_REFERENCE_ROOT`). That is a *test* dependency: the applications
themselves never look outside this project, and `self-containment.test.mjs` proves it.

## functional/

| File | Covers |
| --- | --- |
| `page-parity.test.mjs` | All 117 catalogued pages in both projects. Per page compares title, direction, language, whitespace-normalised text, every element's class list, geometry and resolved style of annotated/verse elements (rect to 3 decimals, font family/size, line height, colour, bottom-border pattern/width/colour, right border, padding, background image), underline IDs and group memberships, section and line IDs, embedded `reader-group-data`, scroll height, injected controls, `document.fonts` state and each stylesheet's rule count. Console errors and failed requests must match on both sides; one 404 is allow-listed as inherited. |
| `interaction-parity.test.mjs` | Real-pointer hover on a painted vertical line and on a leaf underline (hit-tested, not `dispatchEvent`), Escape clearing emphasis, double-click collapse/expand including nested-section retention, exact markup restoration after expansion and after reload, keyboard Enter/Space toggling and focus outline, index link set and history navigation, editor URL/storage/reload state, and byte-identity of every page HTML and annotation JSON against the reference project. |
| `editor-parity.test.mjs` | `/api/catalog` (117 pages, the full generated style catalogue), `/api/document` and `/document` for every page byte-for-byte, script suppression, route and content-type parity for all static and API paths, the loopback `Host` guard, an identical save (page HTML, annotation JSON, `editor-edits.json`, `catalog.json`, page CSS, backup layout) and the stale-hash rejection. Saves run against disposable copies. |
| `self-containment.test.mjs` | No `yasir_pro` or absolute machine path in any shipped file; every local `href`/`src`/`url()`/`@import` resolves inside `app/`; page references never climb above `app/`; the reader opens from disk over `file://` with no failed request or page error; and a fresh copy boots both apps with no reference project present. |
| `editor-storage.test.mjs` | Ported from the reference editor: path traversal, chunked UTF-8 request decoding, text-and-whitespace preservation on save, quotation-pair styles, stale-save rejection, script-free preview, review-status retention, repeated-save whitespace. Uses disposable fixtures under `tests/.output/storage/`. |
| `editor-browser.mjs` | Ported from the reference editor (run separately: `npm run test:editor-ui`). Exact canvas pixels versus the reader at the same viewport, first-open guide, right-click annotation, nested underlines and sections, quote-pair colours and removal, group selection and membership, effects, undo/redo, save/reopen, backups, conflict handling, mobile layout. Two disposable fixture workspaces: `interactive_beta` and `interactive_beta_alt`. |

## visual/

`compare.mjs` captures both projects through the *same* code path
(`capture.mjs`) with viewport 1440×900 (editor 1720×1082), `deviceScaleFactor` 1,
locale `en-US`, timezone `UTC`, fixed Chromium flags, `document.fonts.ready` awaited,
a two-frame plus 250 ms settle after every state change, and scroll positions stepped at
900 px. Pointers move through `page.mouse` so the browser hit-tests them.

Cases in `cases.mjs` are chosen for layout breadth: Al-Fatiha (short, underlines only),
Al-Baqarah (longest, 879 underlines, 35 collapsible sections), Ale Imran and Al-Hashr (the
two pages carrying editor-authored CSS), Ar-Rahman (repeated refrain groups), Al-Mulk
(gradient underlines), Al-Ikhlas (shortest page with a section), the Farsi page (deeper
relative paths), the index and explanation pages. States: idle, hover-underline, hover-line,
collapsed, expanded, nested-collapse, simple-layout, underlines-hidden, keyboard-focus,
print media and a 390 px mobile viewport.

Comparison is zero tolerance. PNG buffers are compared byte-first; on any difference they
are decoded and every pixel and channel is measured, reporting differing pixel count,
percentage and maximum channel difference, and writing `.reference.png`, `.project.png`
and `.diff.png` into `tests/.output/visual/`. No masking, blurring, tolerance or resizing
is applied. `report.json` records one row per screenshot with its attempt count.

**Chromium is not bit-stable for these pages.** Repeated cold runs of the *same* project
produce more than one distinct render for some segments. Measured on Ale-Imran: 98 of the
278 screenshot pairs in a full run needed a second or later captured render to match, up
to three distinct renders appear per side, and comparing the reference project with
itself mismatches in 4 of 14 segments on two of three runs — always a few tens of pixels
inside boxes about 9×10 px near the right-hand gutter, where Arabic diacritic marks and
line-cap ornaments land on a subpixel boundary.

`compare.mjs` therefore launches a fresh Chromium for each captured render — so neither
side inherits glyph or rasterisation cache state produced by the other — and matches
*across* the renders each side produced: a segment passes only when one reference render is
byte-identical to one project render, up to four attempts (`--attempts=N`). Byte-identity
is symmetric, so a pass states that one whole render of yasir_pro equals one whole render
of yasir_pro_v2. A genuine rendering difference produces no shared render and fails every
attempt. Nothing is masked, blurred, tolerated or resized.

`report.json` makes the exemption auditable: per segment it records `attempts`,
`distinctReferenceRenders` and `distinctProjectRenders`, and the run includes a
`noiseFloor` block that re-measures yasir_pro against itself (single pair, no retries) so
the browser's own variation is quantified rather than hidden.

Long pages are compared in viewport-height segments rather than one full-page image, which
keeps every capture inside Chromium's screenshot limits without resizing anything.
