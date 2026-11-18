# Yasir Pro v2

A clean, self-contained extraction of the two user-facing applications from `yasir_pro`:

- **`interactive_beta`** — the static interactive reader (hover emphasis, collapsible vertical sections, grouped underlines).
- **`interactive_edit`** — **Yasir Studio**, the local visual annotation editor that writes into the reader.

Rendering and behaviour are identical to `yasir_pro`: 412 shipped files are byte-for-byte
the originals; everything else is the small set of workspace and packaging edits listed
under *Changes from the original*. Every screenshot the comparison suite takes matches pixel for
pixel, and every one of the 117 catalogued pages produces an identical DOM fingerprint,
geometry and resolved style set. Nothing in `app/` or `scripts/` reads outside this
project.

## Requirements

- Node.js 20 or newer (developed and verified on Node 24.22.0).
- Google Chrome/Chromium only for the test suites (`npm run setup` installs it).

```sh
npm run setup
```

That installs the root test dependency (Playwright 1.64.1, pinned), the editor's runtime
dependencies (parse5 8.0.1, postcss 8.5.32, postcss-selector-parser 7.1.7, lucide 0.468.0,
all pinned by `app/interactive_edit/package-lock.json`), and the Chromium build the
suites use.

## Launch

**Reader** — serves `app/` statically and prints its URL:

```sh
npm run start:reader
# Interactive reader: http://127.0.0.1:4173/interactive_beta/
```

The reader is plain HTML/CSS/JS, so `app/interactive_beta/index.html` also opens straight
from disk with no server. `PORT=… npm run start:reader` picks another port; if 4173 is
taken the server moves to the next free one.

**Editor (Yasir Studio)** — a loopback-only Node server:

```sh
npm run start:editor
# Visual editor: http://127.0.0.1:4180/ (interactive_beta)
```

Or double-click `app/interactive_edit/Start.command` on macOS. Keep the terminal open while
editing. `PORT=…` overrides 4180; an occupied port moves up by one.

The editor writes into `app/interactive_beta/` (page HTML, `styles/editor-pages/`,
`data/pages/`, `data/catalog.json`, `data/editor-edits.json`, and backups under
`data/editor-history/`). It only binds to `127.0.0.1` and rejects any other `Host` header.

## Layout

```
yasir_pro_v2/
  package.json              root tooling: setup, start and test scripts
  app/                      the web root both servers share
    fonts.css               @font-face declarations (original paths preserved)
    fonts/                  the six .ttf files those declarations load
    styles/                 index.css, explanation.css, inline.css, underlines.css
    Surah/Style_CSS/        114 surah entry points + 41 shared cascade partials
    interactive_beta/       READER  (name = editor workspace id and URL prefix)
      index.html            surah navigation list
      explanation.html
      Surah/*.html          114 pages, plus Surah/Farsi/061_Saff_farsi.html
      assets/               interactions.{css,js} and beta-annotations.css
      styles/editor-pages/  page-local CSS authored by the editor
      data/                 catalog.json, pages/ (annotations), curated-groups.json,
                            editor-edits.json
    interactive_edit/       EDITOR  (Yasir Studio)
      index.html app.css app.js catalog.mjs storage.mjs server.mjs
      package.json package-lock.json Start.command
  scripts/serve-reader.mjs  static server for the reader
  tests/
    lib/                    server launcher, PNG decoder/encoder/diff
    functional/             parity, interaction, self-containment and editor suites
    visual/                 screenshot capture and pixel comparison
    .output/                generated artifacts (gitignored)
```

`app/` is the shared presentation layer *and* the two applications' common root, because
the reader pages address it with `../../fonts.css`, `../../styles/inline.css` and
`../../Surah/Style_CSS/NNN_CSS.css`. Those relative depths are load-bearing: they are
what the reader's `<link>` elements, the editor's `<base>` rewriting and the editor's
site-root route mapping all resolve against. Moving the shared layer into `app/shared/`
would change every one of those paths.

## Changes from the original

Only these differences exist, and none of them touches rendered output:

| File | Change | Why |
| --- | --- | --- |
| `app/interactive_edit/server.mjs` | default workspace `interactive` → `interactive_beta`; built-in workspace map reduced to `interactive_beta` | the second reader is not part of this project |
| `app/interactive_edit/app.js` | fallback workspace `interactive` → `interactive_beta` | as above |
| `app/interactive_edit/index.html` | removed the stale `interactive` `<option>` and one guide sentence naming it | pre-hydration markup only; the list is rebuilt from `/api/catalog` |
| `app/interactive_edit/package.json` | renamed; `playwright` dev-dependency and test scripts removed | tests now live in `tests/` and use the root dependency |
| `scripts/serve-reader.mjs` | web root is `app/`, prints `/interactive_beta/`, and `/` redirects there | the old script lived one level deeper and printed `/interactive/`, which does not exist here |

`storage.mjs`, `catalog.mjs`, `interactions.js`, `interactions.css`, `beta-annotations.css`
and all HTML/CSS/data are identical. Verify with:

```sh
bash scripts/verify-provenance.sh
```

## Excluded on purpose

Everything not reachable from the two applications:

- `interactive/`, `interactive_farsi/`, `Surah/*.html` (the non-interactive originals),
  root `index.html`, `explanation.html`, `README.md` — other applications.
- `inetractive_edit/README.md`, `interactive_beta/README.md`, `BETA.md` — prose about the
  reference project's layout.
- `interactive_beta/tools/` except `serve.mjs`: the annotation **build/verify pipeline**
  (`build.mjs`, `verify.mjs`, `beta-*.mjs`, grouping and quotation scripts). `build.mjs` and
  `verify.mjs` read `yasir_pro/Surah/*.html` and `yasir_pro/tools/source-manifest.json`, so
  they cannot run without the original corpus, which is outside this project's scope.
- `interactive_beta/data/beta/` (17 MB of annotation-pipeline intermediates),
  `data/grouping-audit.json`, `data/source-manifest.json`, `data/beta-source-manifest.json`,
  `data/verification-*.json` — generator inputs and reports, never read at runtime.
- `interactive_beta/data/editor-history/` (85 backup runs) — created on demand by the editor.
- `annotation-review.html`, `annotation-review-fa.html` (6.4 MB) and
  `assets/beta-review*.{css,js}` — generated review reports with no link from either app.
- `interactive/`-only editor pages, `tools/`, `styles/explanation.css` stays because
  `interactive_beta/explanation.html` loads it.
- `fonts/Webdings.ttf` — no `@font-face` anywhere points at it, so it cannot affect
  rendering; `font-family: "Webdings"` in `styles/inline.css` has never loaded that file.
- `*.bak`, `.DS_Store`, `.idea/`, `.git/`, all `node_modules/` and `tools/.artifacts/`.

Regenerating the annotation data (`data/pages/`, `data/catalog.json`) from
`data/curated-groups.json` still requires the reference project's build pipeline. That file
is kept so the relationship definitions are not lost; the editor writes memberships directly
and does not need the builder.

## Tests

```sh
npm run test:functional   # parity, interactions, self-containment, editor suites
npm run test:visual       # zero-tolerance screenshot comparison against ../yasir_pro
npm test                  # both
```

`test:visual` and the parity suites start both projects themselves and compare them; they
expect the reference project at `../yasir_pro`, overridable with
`YASIR_REFERENCE_ROOT=/path node tests/visual/compare.mjs`. They are the only files that
may reference it, and they never write there. See `tests/README.md` for what each suite
covers and how to read the pixel report. Generated screenshots appear in
`tests/.output/` only when something mismatches.

## Verification results

`npm test`, macOS arm64, Node 24.22.0, Chromium through Playwright 1.64.1, compared
against the sibling `yasir_pro`:

- **functional — 27/27 assertions pass**: rendered fingerprints of all 117 catalogued
  pages (text, classes, geometry to 3 decimals, resolved styles, underline IDs and
  memberships, section and line IDs, embedded group index, stylesheet rule counts, font
  state), console and network parity, real-pointer hover, collapse/expand and reload
  behaviour, keyboard toggling, index navigation and history, editor catalog, document and
  preview routes for every page, route and `Host`-guard parity, and byte-identical save
  output. Plus the ported editor suites: 10/10 storage tests and the full browser workflow
  ("exact canvas, annotation workflow, saved HTML/CSS/JSON, backup, reload, and mobile
  layout"). Self-containment: no `yasir_pro` reference anywhere in the shipped tree, every
  local reference resolves, the reader runs from disk over `file://`, and a fresh copy
  boots both applications with no reference project present.
- **visual — 278 of 278 screenshots byte-identical, 0 differing pixels, 349.6 megapixels
  compared**, across 51 page/state and editor combinations (10 reader pages × up to 11
  states, 3 editor pages). Zero tolerance: no threshold, blur, mask or resize.
  `tests/.output/visual/report.json` holds one row per screenshot.

Browser nondeterminism, measured rather than assumed: comparing `yasir_pro` **with
itself**, one cold browser per side and no retries, gave 228 differing pixels in 4 of 14
segments on one run, 282 in 4 of 14 on another and 0 on a third, out of 18.1 million
pixels — small boxes about 10×10 px in the right-hand gutter where diacritic marks and
line-cap ornaments fall on a subpixel boundary. Captures therefore come from fresh
browsers and a segment passes when *some* reference render equals *some* project render
(180 of 278 matched on the first capture, 98 needed a second or later render). A real
rendering difference has no shared render and would fail all four attempts.

## Known inherited quirk

`app/interactive_beta/Surah/Farsi/061_Saff_farsi.html` links `../../../Surah/fonts.css`,
which does not exist in `yasir_pro` either, so the page logs one 404 in both projects.
Left as-is: creating the file would add stylesheets and change rendering.
