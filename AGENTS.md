# AGENTS.md

## Project Overview

**documonster** — zero-dependency TypeScript toolkit. Nine modules: Excel, Word, Formula, PDF, CSV, Markdown, XML, Archive, Stream.

- Zero runtime dependencies — never add packages to `dependencies`
- Cross-platform: Node.js 22+ and modern browsers
- ESM-first with CommonJS compatibility

## Hard Rules

1. **No runtime dependencies.** All functionality must be self-contained.
2. **Prefer native APIs.** If a browser or Node.js built-in can do the job, use it instead of writing a custom implementation. Only roll your own when the native API is missing, insufficient, or unavailable on a target platform.
3. **No circular imports.** Enforced by `import/no-cycle`.
4. **Named exports only.** No default exports.
5. **Respect module dependency direction.** See layer diagram below. Never introduce upward dependencies.
6. **Run `pnpm check` then `pnpm format` before committing.**

## Bug Fixing & Code Changes

- **Fix root causes, not symptoms.** Trace every bug to its origin. Never patch over a problem — fix the underlying logic.
- **Read before writing.** Before modifying any file, read the surrounding code to understand context, patterns, and invariants. Do not assume — verify.
- **Match existing patterns.** Follow the conventions already present in the file and module. When unsure, search for similar code in the codebase first.
- **No speculative code.** If you are uncertain about an API, type, or behavior, look it up in the source. Do not guess.
- **Fix it properly.** If the correct fix requires changing multiple files, refactoring a helper, or adjusting an interface — do it. Do not take shortcuts to minimize the diff. The goal is the best solution, not the smallest patch.
- **Do not be afraid of large changes.** If the best solution means rewriting a function, restructuring a module, or breaking an existing API — do it. Correctness and quality come first. Tests exist to catch regressions; use them.
- **Do not touch unrelated files.** Only modify files directly relevant to the task. Never make drive-by changes to code you were not asked to work on.
- **Verify your fix.** After making changes, run the relevant tests or `pnpm check` to confirm the fix works. Never claim a problem is resolved without evidence.
- **No over-engineering.** Solve the actual problem, not a hypothetical general case. If unsure whether a design is over-engineered, summarize the tradeoffs and ask before proceeding.

## Commands

```bash
pnpm i                  # Install (use pnpm, not npm/yarn)
pnpm check                # Type check + lint + format check — run before commit (do not run lint separately)
pnpm format               # Prettier format — run before commit
pnpm test                 # All tests
pnpm build                # Production build

# Workspace satellites (packages/*) — need `pnpm build:esm` first, see below
pnpm verify:packages      # satellites must use the public API only
pnpm type:packages
pnpm test:packages
pnpm build:packages

# Single test file
pnpm exec vitest run src/modules/excel/core/__tests__/cell.test.ts
# Pattern match
pnpm exec vitest run -t "should handle empty cells"
```

## Project Structure

```
src/
├── modules/
│   ├── excel/          # core/ (Workbook, Worksheet, Cell, …) surface/ stream/ xlsx/
│   ├── word/           # DocxDocument, DocumentBuilder, readDocx, packageDocx
│   ├── formula/        # Tokenizer, parser, evaluator, 433 functions, spill engine
│   ├── pdf/            # core/ builder/ font/ render/ reader/ + excel-bridge.ts + word-bridge.ts + word-chart-bridge.ts + word-layout-to-pdf.ts
│   ├── csv/            # Parsing/formatting + streaming
│   ├── markdown/       # GFM table parsing/formatting
│   ├── xml/            # SAX/DOM parser, query engine, writer
│   ├── archive/        # ZIP/TAR compression; core/ shared primitives
│   ├── draw/           # Shared drawing engine: display-list IR, one walker, SVG surface
│   └── stream/         # Cross-platform streaming primitives; core/ shared primitives
├── utils/              # Shared: errors, datetime, fs, binary, crypto
└── test/               # Test utilities and fixtures

packages/               # Workspace satellites — MAY have runtime dependencies
└── mcp/                # @documonster/mcp — Model Context Protocol server (node-only)
```

## Workspace Layout

This is a pnpm workspace. The repository **root is the `documonster` package**
itself; `packages/*` holds satellites.

**Why satellites exist.** The core must have zero runtime dependencies (rule 1),
but some things genuinely need them — the MCP server needs the MCP SDK. A
satellite package keeps that dependency out of `documonster` entirely while the
code still lives in this repo, so a core API change and its MCP counterpart land
in one PR instead of drifting across two repositories.

**Satellite rules — machine-enforced by `scripts/verify-package-imports.ts`
(`pnpm verify:packages`, part of `pnpm check`):**

1. A satellite imports `documonster` **only through its published `exports` map**
   (`documonster/excel`, `documonster/csv`, …). Internal aliases (`@excel/*`,
   `@utils/*`) and relative reaches into `../../src` are build failures. This
   makes every satellite an honest consumer of the public API — and a real check
   on whether that API is sufficient.
2. A satellite is node-only and ESM-only. It does not participate in the core's
   CJS / browser / IIFE build matrix.
3. Satellites are excluded from the root `tsconfig.json` and the root
   `vitest.config.ts`; each carries its own.

**Consequence for the dev loop:** because satellites resolve the core through
`exports`, `dist/esm` + `dist/types` must exist before they will type-check.
Run `pnpm build:esm` once (not the full `pnpm build`), then iterate.

```bash
pnpm build:esm          # prerequisite: produces dist/esm + dist/types
pnpm verify:packages    # no internal imports (no build needed)
pnpm type:packages
pnpm test:packages
pnpm build:packages
```

**Watch out:** root `pnpm check` builds ESM/types first because type-aware lint
resolves `packages/*` through the public exports map; root tsc itself still
excludes satellites, whose dedicated type check runs under `pnpm test` and CI.
Root `pnpm test` (and its `test:all` alias) runs
everything in the required order (core node tests →
`build:esm` → package tests → browser tests; the browser step wipes `dist/`, so
package tests must precede it). `pnpm check` includes `verify:packages` because
that is a pure source scan; `type:packages` is left out because it needs a build,
and the pre-commit hook therefore runs it only when `dist/types` already exists.

**Releases — one version for the whole repository.** `@documonster/mcp` always
carries the same version as `documonster`. release-please tracks a single
package (`.`) and writes the new version into `packages/mcp/package.json` through
`extra-files`, so the two stay identical by construction — there is no second
manifest entry, no `mcp-v*` tag and no separate MCP changelog. MCP changes appear
in the root `CHANGELOG.md` like any other change, and a commit that only touches
`packages/mcp` still bumps the shared version.

That coupling is deliberate. `@documonster/mcp` depends on
`documonster: workspace:*`, which `pnpm publish` rewrites to an **exact** version
— so an MCP release that skipped a core release would leave MCP users pinned to
an old core forever. Releasing both together keeps that pin fresh. It also means
the core must reach npm first, which is why `publish-mcp` needs `publish` in
`.github/workflows/release.yml`.

Canaries follow the same rule. Both manifests receive the deterministic version
`<current>-canary.sha.<commit>`, then core publishes before MCP. The version must
not contain a timestamp: a retry after only one package published must reproduce
the same version so the idempotent checks can skip it and finish the pair.

**A scoped package needs `--access public` on the command line.** pnpm does not
apply `publishConfig.access`, and npm defaults a scoped package to restricted, so
`pnpm publish` prints `✅ Published` while the package stays invisible to
everyone but the owner — `documonster` is unscoped and never showed this. The
publish steps therefore pass `--access public`, and every verify step reads the
registry **unauthenticated**, because an authenticated read succeeds for a
restricted package and would hide the problem.

Do not try to give the satellite its own version line with the `linked-versions`
plugin: it skips any package whose component resolves to empty, and the core's
component is empty by design (`include-component-in-tag: false`, which is what
keeps the `v0.9.0` tag format instead of `documonster-v0.9.0`).

## Module Dependency Layers

```
Layer 5:  pdf      → excel (only excel-bridge.ts + word-chart-bridge.ts), word (only word-bridge.ts + word-chart-bridge.ts + word-layout-to-pdf.ts), draw, archive, utils
Layer 4:  excel, word → formula, draw, archive, xml, csv, markdown, stream, utils
Layer 3:  formula  → utils    (independent calc engine; no excel imports)
Layer 2:  csv, archive → stream, utils
Layer 1:  xml, markdown, stream, draw → utils
Layer 0:  utils    (no module dependencies)
```

### The `draw` module

`draw` is the shared drawing engine. It owns a structured display list
(`DrawList`), the single walker that consumes it (`renderDrawList`), the abstract
backend interface (`DrawSurface`), an SVG serialiser and a rasteriser. A producer
that emits a `DrawList` therefore gets markup and pixels from `documonster/draw`
alone, and a PDF page from `documonster/pdf` — the claim below is testable from
outside the repository, not only inside it.

**Why it exists.** The renderers used to pass an _SVG string_ between themselves:
the chart engine serialised SVG, then the Node PNG fallback re-parsed it with a
regex scanner and the PDF importer parsed it again with a second, differently
capable parser. Each backend therefore had its own reading of every attribute,
and the same picture came out differently depending on which one you asked —
dashes disappeared, opacity was dropped, rotations mirrored, 8-digit colours were
read with the wrong byte order. A display list removes the round trip.

**The rule: one walker, many surfaces.** `renderDrawList` owns transform
composition, stroke/dash scaling and text rotation, and hands surfaces
**absolute, already-transformed** coordinates in a Y-down space. A surface never
implements a transform stack, so a new backend is a few dozen lines instead of a
parallel renderer. Adding a _producer_ (a chart type, a diagram engine) gets every
existing backend for free; adding a _backend_ serves every producer.

A surface lives with the engine when it needs nothing but the IR, and next to its
target when it draws onto something the engine cannot know about:

| Surface    | Location                     | Output                                                   |
| ---------- | ---------------------------- | -------------------------------------------------------- |
| SVG        | `draw/svg.ts`                | Markup in the subset the rest of the library understands |
| Raster     | `draw/raster/surface.ts`     | RGBA pixels via `BasicRasterCanvas`                      |
| PDF vector | `pdf/render/draw-surface.ts` | Page operators; owns the Y flip                          |

The rasteriser used to live in `excel/chart/render/`, which was an accident of where
charts were written rather than a statement about what it does: it paints a display
list and knows nothing about a workbook. It sits in `draw/` now, alongside the glyph
rasteriser and the stroke font it needs, and `documonster/draw` exports it.

**It yields pixels, not a PNG.** Encoding one needs DEFLATE, which lives at Layer 2 in
`archive/`, and dragging that down into Layer 1 to return a file format would make
every consumer of the drawing engine pay for a compression library. The seam is
therefore at the image: `rasterizeToRgba` is the backend, and
`excel/chart/render/draw-raster-png.ts` is the ten-line adapter that pairs it with the
library's own encoder. A caller with a different encoder pairs it with that instead.

`createPdfDrawSurface` takes a `PdfDrawPage` — a structural interface naming the six
marks it puts down — rather than a `PdfPageBuilder`. The concrete builder also carries
annotations, form fields and a content stream, and naming it in a public signature
would publish all of them.

Because the Y flip lives in exactly one adapter, so does the fact that a
reflection reverses a rotation's sense — a bug each per-backend renderer
previously had to discover for itself.

**Clipping** is axis-aligned rectangles only (`DrawNode.group.clip`), authored in
the group's own space so it moves with `transform`. Every backend expresses that
exactly — SVG `clipPath`, PDF `q … W n … Q`, a scissor test in `setPixel` — and an
arbitrary clip path in a scanline rasteriser is a different order of problem. A
surface may omit `pushClip`/`popClip`, in which case the walker draws unclipped
rather than dropping the content.

**Primitives** are rect, ellipse, **sector**, line, polyline, path (move/line/cubic)
and text. A sector is first-class rather than lowered to a path because the three
backends do it three genuinely different ways and lowering upstream would make two
of them worse: SVG has arcs natively, PDF needs cubics, and the rasteriser tests
radius-and-angle per pixel for an exact edge. The old pipeline smuggled the
parameters past the SVG string in a `data-sector` attribute so the rasteriser
could recover them; modelling them removes that channel.

**Text measurement belongs here too.** A producer sizes its boxes around the text they
contain, so it has to measure before it can build a display list at all. `draw/text.ts`
expresses `@utils/text-measure` (Layer 0 — the glyph-advance tables, moved down from
`@excel/utils` where nothing below Layer 4 could reach them) in terms of `DrawTextStyle`,
and adds `wrapText`. Before that, measurement was reachable only through
`@excel/chart/shared/chart-utils`, which is Layer 4: anything sitting beside `draw` could
draw text but not measure it, and therefore could not lay anything out. That was the one
thing stopping a non-chart producer from being written against this engine.

Note the unit: `measureTextWidthPx` returns CSS pixels for a point size, while a display
list draws text at `style.size` units. `measureText` applies `POINTS_PER_PIXEL`; skipping
it over-reports every label by 4/3, which is how legends came out too wide and centred
titles sat left of centre.

**Deliberately absent**: element-level opacity, gradients and patterns. Opacity is
expressed as an alpha on each paint instead. That is _not_ identical to the SVG
`opacity` attribute, and it is worth being precise about the difference rather than
claiming an equivalence: element opacity composites the finished shape once, so a
stroke that overlaps its own fill is flattened first and then faded, whereas
per-paint alpha fades the fill and then blends the stroke over the result. The two
agree everywhere except the band where a translucent stroke covers its own fill.
For the region map's circles — a 1.5-unit white ring at `0.92` over a near-white
panel — that band is under a pixel wide and the channels differ by at most
15/255; the fill is bit-identical. Closing that gap properly means offscreen
compositing in every backend (a transparency group and a Form XObject in PDF, a
second buffer in the rasteriser), which is a large amount of machinery for a
sub-pixel seam, so the alpha is where it stays. Note that
`describeSvgGeometry` folds element opacity into both paints, so it cannot see this
difference — do not read a matching geometry hash as proof that compositing agrees.
Nothing produces gradients or patterns —
the chart engine already degrades gradient fills to a representative colour before
it reaches any renderer — so adding them would grow the IR and every surface
without changing a single output. Filters are the one exception, and they are
named for the single backend that can express them (`DrawList.svgDefs` +
`group.svgFilterId`): a DrawingML shadow has no counterpart in a content stream or
a scanline rasteriser, so the field says SVG in its name rather than pretending to
be portable. That mirrors what the per-backend renderers already did.

**Metadata that only one backend can carry does not enter the IR.** The region map
reports which path drew it — real TopoJSON, the built-in centroid preview, or the
hex-tile fallback — and that is the only way a caller learns whether their topology
actually matched their categories. It is a fact about a decision, not about geometry
or paint, so the SVG renderer attaches it as a `data-region-map-mode` attribute on a
wrapping `<g>` when it serialises, and the PDF path simply draws the nodes. Nothing
was added to `DrawNode` for it. Prefer that shape for any future SVG-only
annotation: decide it in the producer, attach it at the serialisation boundary.

Cross-backend agreement is enforced by
`src/modules/pdf/__tests__/draw-backend-parity.test.ts`: the same display list is
rendered to markup, pixels and PDF operators, and the geometry is asserted to
match modulo each backend's coordinate convention.

- Modules may only import from **lower** layers — never sideways or upward.
- **Sole exceptions**:
  - `pdf/excel-bridge.ts` may import from `@excel/`. No other file in `pdf/` may import `@excel/` except `pdf/word-chart-bridge.ts` (Word charts rendered by the Excel chart engine).
  - `pdf/word-bridge.ts`, `pdf/word-chart-bridge.ts`, and `pdf/word-layout-to-pdf.ts` may import from `@word/` (the Word→PDF bridge family). No other file in `pdf/` may.
  - `word/bridge/excel-bridge.ts` may import from `@excel/`. No other file in `word/` may.
  - `formula/` consumes immutable snapshots and emits writeback plans; `excel/` owns the host adapter. `formula/` never imports concrete types from `@excel/*`.
- `utils/` must never import from any module.

These rules are **machine-enforced** by `scripts/verify-layers.ts` (run via `pnpm verify:layers`, included in `pnpm check`). It scans every production `.ts` import and fails on any forbidden cross-module import. A new bridge file that legitimately needs a cross-module import must be registered in that script's `EXCEPTIONS` map and documented above.

## Path Aliases

`@excel/*`, `@word/*`, `@formula/*`, `@pdf/*`, `@csv/*`, `@markdown/*`, `@xml/*`, `@archive/*`, `@stream/*`, `@draw/*` → `./src/modules/<name>/*`
`@utils/*` → `./src/utils/*` | `@test/*` → `./src/test/*`

Use aliases for **all** module imports — both cross-module (`@archive/...` from excel) and same-module (`@excel/cell` from within excel). This matches the IDE auto-import setting (`importModuleSpecifier: "non-relative"`) and keeps imports stable when files move. The only exception is `src/utils/` (Layer 0), whose internal files use relative paths (`./errors`, `./glob`).

## Code Style

- **Type-only imports**: `import type { Foo } from "..."`
- **Error handling**: Extend `BaseError` from `@utils/errors`, use `{ cause }` for chaining.
- **Files**: kebab-case. **Browser variants**: `*.browser.ts`.
- **Formatting**: Handled entirely by Prettier — just run `pnpm format`.
- **Tests**: Vitest, in `__tests__/*.test.ts`. Timeout: 30s.
  - **Co-locate tests next to the code they cover.** A test lives in the `__tests__/` directory of the module subfolder it exercises — e.g. `core/__tests__/`, `surface/__tests__/`, `stream/__tests__/`, `chart/__tests__/`, `bridge/__tests__/`, `utils/__tests__/`, `xlsx/__tests__/`. The `xlsx/__tests__/` tree mirrors the `xlsx/xform/` source layout. Do not pile module tests into a single top-level `__tests__/`.
  - **Shared fixtures stay centralized.** Cross-cutting test assets — `data/` (binary `.xlsx`/`.png`/`.csv` fixtures), `helpers/` (e.g. `expect-valid-xlsx`, `zip-text`, `external-oracle`), and `shared/` (reusable sheet builders) — live in `src/modules/excel/__tests__/` and are imported via the `@excel/__tests__/...` alias from any co-located test. A test that is private to one subfolder may keep a private helper beside it (e.g. `chart/__tests__/chart-builder.helpers.ts`).
  - **Browser tests** stay under a `__tests__/browser/` directory (matched by `vitest.browser.config.ts`); keep their `__screenshots__/` baselines alongside them.

## Functions, Arrow Functions & Classes

Choose the form by purpose, not by preference. Do **not** make everything an arrow function — each form exists for a reason.

- **Top-level named functions → `function` declarations.** Use `function foo() {}` for module-level functions. They are hoisted (free ordering, no top-of-file dependency dance), carry a real name in stack traces, and support recursion cleanly.
- **Callbacks & inline functions → arrow functions.** Use arrows for `map`/`filter`/`forEach`, promise chains, event handlers, and anywhere lexical `this` is wanted. Keep bodies expression-form when possible (`x => x * 2`, not `x => { return x * 2; }`).
- **Overloads & generators → must be `function`.** Multiple call signatures (TS overloads) and `function*` generators cannot be expressed as arrows.
- **Class members → method syntax, never arrow fields.** Write `load() {}`, not `load = () => {}`. Methods live on the prototype and are shared across instances; arrow fields allocate a fresh function per instance (measured ~5× memory on hot value types like `Cell`/`Token`/XML nodes) and add per-`new` construction cost. Only use an arrow field when a method is detached and passed as a callback that genuinely needs bound `this`.
- **Avoid named function expressions** (`const foo = function bar() {}`); prefer a `function` declaration or an arrow.

### Prefer plain functions over classes

- **Don't reach for `class` by default.** If a unit of behavior is just data + a few transforms, prefer plain functions operating on plain objects/interfaces over a class. Modules with named exports already give you encapsulation and namespacing.
- **Use a `class` only when you genuinely need** instance identity with mutable state, inheritance/polymorphism, lifecycle (`implements`/`extends`), or a public API where `new`/methods read more naturally than free functions.
- **Avoid classes that are just namespaces** — a class with only static members (or a single method) should be plain exported functions instead.

## Example Output

All runnable examples write output to `tmp/` under the project root. This directory is gitignored.
