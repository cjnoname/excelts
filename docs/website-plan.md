# Documentation Website — Design Plan

**Status:** proposal, not implemented. Every factual claim below was verified against the
tree at the time of writing; the two places where a claim could not be settled without
building something are marked **SPIKE**.

**Thesis.** The repository already contains the website's content — nine module guides in
two languages, ~160 runnable examples, a 21-entry public exports map, and the emitted
`.d.ts` surface. A documentation site should therefore be a **derivation** of the tree,
never a second copy of it. Everything below follows from that: the site is generated from
sources that the test suite already exercises, and a check fails the build when a
derivation goes stale.

---

## 1. Where the site lives

**Decision: in this repository, at a new top-level `website/`.**

This is not a preference. The published npm tarball does not contain the content:

```
$ npm pack --dry-run --json          # 3877 entries
dist/**  LICENSE  README.md  README_zh.md  THIRD_PARTY_NOTICES.md  package.json
```

`.npmignore` excludes `src/` on its first line. So:

| Content the site needs          | In the npm tarball? |
| ------------------------------- | ------------------- |
| `src/modules/*/README{,_zh}.md` | no                  |
| `src/modules/*/examples/*.ts`   | no                  |
| `MIGRATION*.md`                 | no                  |
| Root `README{,_zh}.md`          | yes                 |
| `dist/types/**`                 | yes                 |

A separate repository could not obtain its primary content from the registry. It would
have to check out this repository at some ref — which keeps every bit of the coupling (an
API change still means edits in two places) while losing the one thing a split buys you
(independence), and adds a new failure mode: a stale pin silently serves old documentation,
which is precisely what this plan exists to prevent.

The repository has already decided this question once, for `packages/mcp`, and the recorded
rationale in `AGENTS.md` applies verbatim — a core API change and its documentation land in
one PR instead of drifting across two repositories. The argument is stronger here, because
the MCP satellite depends only on the public API whereas the site depends on concrete file
paths under `src/`.

### Not `packages/*`, not `docs/`

`packages/*` is reserved for **published** npm satellites and is the exact directory
`scripts/verify-package-imports.ts` scans; putting a private site there would muddle a
machine-enforced boundary. `docs/` is already named by `package.json`'s
`directories.doc`. Hence `website/`.

### Accepted cost

VitePress plus TypeDoc adds roughly 150–250 packages to a lockfile that currently holds 352
resolutions (`node_modules` is already 254 MB, dominated by Playwright, rspack native
bindings and the TypeScript native preview). Package **count** roughly doubles; installed
**size** does not move much. The real costs are (a) install time on the 12-cell Node matrix
plus 3-cell Bun and 3-cell packages matrices, which do not need the site, and (b) added
dependency-advisory noise in a repository that runs CodeQL. (a) is mitigated by scoping
those jobs with `pnpm i --filter documonster...`. (b) is accepted.

Consumers are unaffected: `files` is `["dist", …]`, so no devDependency reaches the tarball.
The zero-runtime-dependency rule is untouched.

---

## 2. Content inventory

| Site section           | Derived from                                          | Notes                                      |
| ---------------------- | ----------------------------------------------------- | ------------------------------------------ |
| Landing page           | root `README.md` / `README_zh.md`                     | hand-authored hero, generated feature list |
| Module guides (× 9)    | `src/modules/*/README.md` + `README_zh.md`            | publishable nearly as-is — see §4          |
| Code samples           | `src/modules/*/examples/*.ts`                         | transcluded, with rewrite — see §6         |
| API reference          | `dist/types/**/*.d.ts` via the 21-entry `exports` map | generated — see §5                         |
| Formula function index | `src/modules/formula/runtime/function-registry.ts`    | generated — see §7                         |
| Mermaid gallery        | `src/modules/mermaid/examples/gallery.ts`             | generated, rendered by documonster — §7    |
| Migration guides       | `MIGRATION.md`, `MIGRATION_EXCELTS_TO_DOCUMONSTER.md` | as-is                                      |
| Version, module list   | `package.json` (`version`, `exports`)                 | read at build time                         |

`draw` and `mermaid` had no README until this plan prompted one; both now have an English and
a Chinese guide, and both are linked from the root README, which had no section for either.
§9 R3 turns the next such gap into a build failure rather than a thing someone notices.

---

## 3. Pipeline

Four stages, in order. Each is a separate script so each can fail loudly on its own.

```
 build:esm ──► dist/types/**            (prerequisite; see §5)
     │
     ├─► scripts/docs/collect-guides.ts   READMEs        ──► website/.generated/guides/**
     ├─► scripts/docs/rewrite-examples.ts examples       ──► website/.generated/examples/**
     ├─► scripts/docs/generate-api.ts     TypeDoc        ──► website/.generated/api/**
     └─► scripts/docs/generate-tables.ts  registries     ──► website/.generated/data/*.json
                                                              │
                                              vitepress build ▼
                                                          website/.vitepress/dist
```

`website/.generated/` is gitignored. Nothing generated is ever committed — a committed
artifact is a copy, and a copy is the thing this plan is designed to avoid. The cost is that
`docs:dev` must run the generators first; `predev`/`prebuild` hooks handle it.

Generators live in `scripts/docs/` rather than inside `website/` so they run under the root
toolchain (Node 22+, no bundler, the same style as `scripts/verify-*.ts`) and so
`verify:docs` can call them without installing the site's dependency tree.

---

## 4. Framework: VitePress

Chosen because the content is already Markdown in two languages, which is the shape
VitePress consumes natively:

- **`srcDir` + `rewrites`** map `website/.generated/guides/excel/README.md` to `/excel/`.
- **`locales`** gives `/` (en) and `/zh/` from the existing `README.md` / `README_zh.md`
  pair, matching a convention the repository already follows in 9 modules.
- **`<<< path{#region}`** transcludes source files, optionally by `// #region` marker.
- Markdown-only pages, no framework component required for the common case; Vue is
  available for the live playground if that is ever wanted.
- devDependency only.

Two mechanical fixes are needed when collecting guides (both verified present):

1. **`README_zh.md` cross-links.** Every module README links to its translation with
   `](README_zh.md)`, which must become the locale-switch URL rather than a page link.
2. **Repo-relative links.** `src/modules/excel/README.md` links to `examples/charts.ts`,
   `examples/images-external.ts`, `examples/`, `../formula/README.md` and
   `../../../docs/enterprise-corpus-manifest.example.json`. On a site these 404. They must
   be rewritten to either a site route (module guide, transcluded example page) or a
   permalink into GitHub at the current commit. Anything unresolvable fails the build (§9 R1)
   rather than shipping a dead link.

Code fences need no work: the READMEs contain 233 `typescript` fences and their imports
already use public specifiers (`documonster/excel` × 74, `documonster/stream` × 72,
`documonster/pdf` × 58, …). **The READMEs are directly publishable.** Only the example
files are not — which is §6.

---

## 5. API reference — and the TypeScript 7 constraint

This section revises an earlier recommendation. TypeDoc is still the right tool, but it
**cannot run against the repository's pinned TypeScript**, and the workaround changes the
input.

### What was measured

```
$ node -p "require('typescript/package.json').version"    → 7.0.2
$ node -e 'import ts from "typescript"; console.log(Object.keys(ts))'
    → [ "version", "versionMajorMinor" ]                  # two keys. that is the whole API.
$ npm view typedoc peerDependencies
    → typescript: 5.0.x … 6.0.x
```

`typescript@7.0.2` exposes **no compiler API at all** — no `createProgram`, no
`createSourceFile`, no `SyntaxKind`. Two consequences:

- TypeDoc is doubly incompatible: peer range excludes 7.x, and there is no API to drive.
- A hand-rolled generator using the compiler API is impossible under the root toolchain.
  This also explains a fact that otherwise looks like a stylistic choice: the 816 lines of
  regular expressions in `scripts/verify-public-types.ts` are not a preference, they are
  forced.
- Note in passing that `scripts/codemod-namespace-to-flat.ts` calls `ts.createSourceFile`
  and therefore **cannot currently run**. It is a spent one-off migration script, so nothing
  is broken, but it is misleading evidence about what the toolchain supports.

### Decision

**Run TypeDoc from `website/`, with its own pinned `typescript@~5.9`, over
`dist/types/**` — not over `src/`.**

pnpm workspace isolation makes the second TypeScript clean: `website/node_modules/typescript`
resolves to 5.9 while the root stays at 7.0.2, with no override and no interaction.

Taking `dist/types` as the input, rather than `src/`, is the part that makes this robust, and
it was verified: after `pnpm build:esm`, `dist/types` is **fully self-contained** — 0 of 773
`.d.ts` files retain a path alias, and every relative specifier carries an explicit
extension.

```
$ pnpm build:esm && rg --no-ignore -l '"@[a-z]+/' dist/types | wc -l   → 0
$ head -12 dist/types/modules/excel/index.d.ts
    export * from "./index.base.js";
```

(Before that build the same count was 629 — the alias rewrite is `scripts/fix-esm-imports.ts`,
so a **stale `dist/` will silently produce a broken API reference**. The docs job must build,
not reuse.)

Consequences of the `dist/types` input, all of them favourable:

- No path-alias resolution, no root `tsconfig`, no need for TS 5.9 to parse TS 7-era source.
  The `.d.ts` files are plain declaration syntax.
- The reference then describes **the surface consumers actually receive**, not the source.
  This is the more correct thing to document.
- TSDoc survives declaration emit (verified: `dist/types/modules/excel/core/cell.d.ts`
  retains its comments), so prose is preserved.
- Entry points come from the `exports` map, which already has a machine-readable inventory in
  `scripts/verify-types-versions.ts`. No hand-maintained list of 21 entries.

Entry `.d.ts` files are pure barrels (`export * from "./index.base.js"`), so the generator
must follow re-export chains — which is exactly what TypeDoc's checker does and what a
regex-based generator would get subtly wrong forever. That asymmetry is the whole reason for
accepting a second TypeScript.

### Expectation to set: TSDoc coverage is low

Sampled: `dist/types/modules/excel/core/cell.d.ts` declares 65 symbols and 5 carry a TSDoc
comment (~8%). The generated reference will therefore be **mostly bare signatures** at
first. That is still worth shipping — a searchable, always-correct signature index is more
than exists today — but the plan should not pretend it produces prose. §9 R4 proposes a
ratchet so coverage can only improve.

### SPIKE 1

Confirm TypeDoc 0.28 + `typedoc-plugin-markdown` 4.12 on TS 5.9 resolves all 21 entries from
`dist/types` (including the browser-variant entries) and emits usable Markdown. Time-box:
half a day. If it fails, the fallback is a signature index generated by regex from
`dist/types` in the style of `verify-public-types.ts` — cheaper than it sounds, because a
signature index needs no type resolution, only the declaration lines — plus a link out to
the source on GitHub for detail.

---

## 6. Example transclusion — the rewrite is not a prefix swap

The 160 example files are the best content in the tree: they are real, and `pnpm example`
runs them. But **every one of them imports through internal aliases**, so transcluding them
verbatim would publish code that no reader can run. Measured import specifiers:
`@excel/index` × 81, `@excel/core/worksheet` × 21, `@excel/core/cell` × 15,
`@excel/bridge/formula` × 15, and so on.

Most of it maps cleanly onto a public entry (each mapping below was verified against the
module's `index.ts`):

| Internal alias                                                                            | Public specifier             |
| ----------------------------------------------------------------------------------------- | ---------------------------- |
| `@excel/index`, `@excel/core/{cell,row,worksheet,workbook,workbook-core}`, `@excel/types` | `documonster/excel`          |
| `@excel/chart`, `@excel/chart/index`, `@excel/chart/render/chart{,-ex}-renderer`          | `documonster/chart`          |
| `@excel/bridge/formula`                                                                   | `documonster/excel/formula`  |
| `@excel/bridge/markdown-bridge{,.node}`                                                   | `documonster/excel/markdown` |
| `@pdf/index`, `@pdf/builder/document-builder`, `@pdf/render/draw-surface`                 | `documonster/pdf`            |
| `@draw/index`, `@draw/svg`                                                                | `documonster/draw`           |
| `@mermaid/index`                                                                          | `documonster/mermaid`        |
| `@word/index`                                                                             | `documonster/word`           |
| `@stream`                                                                                 | `documonster/stream`         |

But five specifiers have **no public counterpart**, and they are not all the same kind of
problem:

| Specifier                                        | Files | Verdict                                                                                                                                      |
| ------------------------------------------------ | ----- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `@excel/examples/utils/hr-stopwatch`             | 23    | Private timing helper for console output. Strip it and its call sites from the published snippet — it is scaffolding, not teaching material. |
| `@excel/utils/png`                               | 2     | Not exported anywhere public. Either export it or rewrite the example.                                                                       |
| `@excel/chart/render/draw-raster-png`            | 1     | Not in `chart/index.ts`. Same choice.                                                                                                        |
| `@utils/event-emitter`                           | 1     | Layer 0; `utils/` is deliberately never exported. Rewrite the example.                                                                       |
| `@pdf/excel-bridge` → `excelToPdf`, `chartToPdf` | 5     | Public as `Pdf.fromExcel` / `Pdf.fromChart`, reached through a lazy `await import()`. Rewrite to the namespace form — see below.             |

So the rewriter is a mapping table plus a gate, not a regex. The gate: after rewriting,
type-check the snippets against the built public types (the same trick that keeps
`packages/*` honest). A snippet that does not compile against `documonster/*` does not ship.
This will initially fail for the files above, so §11 phases it per-module rather than
switching it on everywhere at once.

### The `excelToPdf` case, and what it was really about

**An earlier draft of this document claimed `excelToPdf` was not publicly reachable. That was
wrong**, and the correction is more useful than the original claim.

`src/modules/pdf/index.ts:51` does re-export only the option types:

```ts
export type { ChartToPdfOptions, ExcelToPdfOptions } from "@pdf/excel-bridge";
```

But the functions are published on the `Pdf` namespace, which loads the bridge on demand:

```ts
// src/modules/pdf/surface/pdf.ts
export async function fromExcel(workbook: Workbook, options?: ExcelToPdfOptions) {
  const { excelToPdf } = await import("@pdf/excel-bridge");
  return excelToPdf(workbook, options);
}
```

That dynamic import is the design: it keeps the whole Excel module and chart engine out of the
entry chunk of anyone who imports `documonster/pdf` for something else, which is a property
`verify:treeshake` asserts. Re-exporting `excelToPdf` statically from `pdf/index.ts` — the
"fix" the earlier draft implied — would have broken it.

The real defect was narrower and entirely documentary: **seventeen `@example` blocks named
functions the exports map does not publish.** `excel-bridge.ts:14` told readers to write
`import { excelToPdf } from "documonster/pdf"`; the correct form is `Pdf.fromExcel`. The same
drift hit `pdf()`→`Pdf.create`, `readPdf`→`Pdf.read`, `PdfDocumentBuilder`→`Pdf.Builder`,
`PdfEditor`→`Pdf.Editor`, `docxToPdf`→`Pdf.fromDocx`,
`createWordChartPdfRenderer`→`await Pdf.wordChartRenderer()`, `readDocx`→`Io.read`,
`toBuffer`→`Io.toBuffer`, `diffDocuments`→`Diff.documents` and
`searchByFormat`→`Query.searchByFormat`. One comment in `pdf/index.ts` disagreed with itself:
its second example already used `Pdf.fromExcel` while its first and third did not.

`verify:public-types` could not see any of it, because its subject is whether a type reachable
from a public signature can be named — not whether a documented function exists. All seventeen
are fixed, and `scripts/verify-doc-examples.ts` (wired into `pnpm check`) now compiles every
doc-comment import against the built public surface, so the class of bug cannot recur silently.

That gate has one known blind spot, and it found its own first instance: it reads `import`
statements, not prose. `draw/index.ts` pointed readers at `rasterizeDrawList` in a sentence —
a function that is **not** exported from `documonster/chart`. Which surfaces a genuine API gap
rather than only a wording problem: a `documonster/draw` consumer can obtain RGBA pixels but
has no published way to encode a PNG, even though the library contains an encoder. The wording
now states the truth; whether to publish the ten-line adapter is an open decision.

The lesson for the plan is not "the API had a hole" but something narrower and more durable:
documentation is the one artefact in this repository that no tool read, so it was the one
artefact that drifted. R5 in §9 exists for the snippet form of the same problem.

---

## 7. Generated pages

Three pages should be produced from registries rather than written, so that adding a feature
updates the documentation by construction.

**Formula function index.** `function-registry.ts` contains 448 `defineEager`/`defineLazy`
calls (448 distinct names). Enumeration is available: `listFunctionNames()` was added beside
`lookupFunction` and respects the lazy-init contract documented above it — the table is
deliberately not a module-level side effect, so the enumerator calls
`ensureRegistryInitialized()` itself and stays out of any bundle that does not use it. It is
currently internal; publishing it from `documonster/formula` is the decision to make when the
generator is written (the MCP server plausibly wants the same function).

The page should carry arity from `FunctionDescriptor` (`minArity`/`maxArity`/`volatile`),
which no hand-written list would ever keep accurate.

The count itself has been corrected: it appeared sixteen times across ten files, all saying 433. The twelve user-facing claims now say 448 and are pinned by
`src/modules/formula/__tests__/function-count.node.test.ts`, which fails if any of them drifts
again; the other four were internal comments and were reworded to drop the number. That test
is a curated list of claim sites, which is a stopgap — it cannot cover a _new_ claim written
somewhere it does not know about. Generating the number is still the fix.

**Mermaid gallery.** `src/modules/mermaid/examples/gallery.ts` covers the 21 diagram types.
Render each to SVG at build time with `documonster/mermaid` itself. This is dogfooding with
teeth: if a rendering regression lands, the site build produces visibly wrong pictures, so the
gallery doubles as a live check on the `draw` backends.

**Chart type matrix.** Enumerate from `documonster/chart`'s builders, same rationale.

---

## 8. Freshness and CI

Because every source of content is in the tree, freshness needs nothing exotic: build the
site from `main` and it is current by construction.

```yaml
# .github/workflows/docs.yml (sketch)
on:
  push: { branches: [main] }
  pull_request: { branches: ["**"] } # build only, no deploy — a broken site fails the PR
permissions: { contents: read, pages: write, id-token: write }
jobs:
  docs:
    steps:
      - pnpm i --frozen-lockfile
      - pnpm build:esm # REQUIRED: TypeDoc reads dist/types (§5)
      - pnpm docs:build # runs the four generators, then vitepress build
      - pnpm verify:docs
      - actions/upload-pages-artifact + actions/deploy-pages # main only
```

Notes:

- Deploy from an Actions artifact, not a `gh-pages` branch. A monorepo does not need a
  branch-shaped deploy, and a committed build output would be another copy.
- The `should-run` gate in `ci.yml` skips release-please merge commits. The docs job should
  **not** copy that gate: a release commit changes `version`, which the site displays.
- **No cron.** A scheduled rebuild only helps for content that lives outside the repository.
  If npm download counts or GitHub stars are ever wanted, fetch them client-side or add a
  nightly job then — do not add one speculatively.
- Deployment is one site, `latest` only, bilingual. No version snapshots: VitePress has no
  built-in versioning, and per-release snapshots mean maintaining copies of old content — the
  opposite of this plan's premise. Users needing old documentation have the git tag.

---

## 9. `verify:docs` — the anti-rot gate

Without this, "always current" is an aspiration. With it, staleness is a build failure. The
repository's existing checks (`verify:layers`, `verify:public-types`, `verify:packages`,
`verify:types-versions`) establish both the pattern and the expectation.

- **R1 — No dead links.** Every repo-relative link collected from a README resolves to a site
  route or an explicit GitHub permalink. Motivated by the five such links already in
  `src/modules/excel/README.md`.
- **R2 — No dangling transclusions.** Every `<<<` target and every `#region` marker exists.
  Renaming an example file must fail here, not silently blank a code block.
- **R3 — Every public entry has a page.** Each of the 21 `exports` keys maps to at least one
  guide or reference page. `draw` and `mermaid` are what motivated it: two published entry
  points with no documentation anywhere, including the root README.
- **R4 — TSDoc coverage ratchets.** Record current coverage per entry; fail if it drops. Do
  not demand a threshold today (≈8% sampled) — demand that it cannot get worse.
- **R5 — Snippets compile against the public API.** §6's gate. The strongest rule here, and
  the one that would have caught `excelToPdf`.
- **R6 — No hardcoded counts.** Reject a doc page asserting a function/module count that
  disagrees with the registry. Motivated by 433-vs-448.

R1–R4 and R6 are pure source scans and belong in `pnpm check`. R5 needs `dist/types`, so it
belongs with `type:packages` in `pnpm test` and CI — the same reasoning `AGENTS.md` records
for why `verify:packages` is in `check` but `type:packages` is not.

---

## 10. Configuration changes required

| File                  | Change                                                                    |
| --------------------- | ------------------------------------------------------------------------- |
| `pnpm-workspace.yaml` | add `website` (currently `packages/*` only)                               |
| `tsconfig.json`       | add `website` to `exclude` (beside `benchmark`, `tmp`, `scripts/**`)      |
| `.oxlintrc.json`      | add `website` and `website/.generated` to `ignorePatterns`                |
| `vitest.config.ts`    | exclude `website`                                                         |
| `.gitignore`          | add `website/.generated`, `website/.vitepress/{dist,cache}`               |
| `package.json`        | add `docs:dev`, `docs:build`, `verify:docs`; add `verify:docs` to `check` |
| `.github/workflows/`  | new `docs.yml`                                                            |
| `AGENTS.md`           | document `website/` and the `verify:docs` rules                           |

`scripts/verify-package-imports.ts` needs no change — it scans `packages/` specifically, and
`website` is not a satellite. Worth stating explicitly so nobody "fixes" it later.

---

## 11. Phasing

1. **Skeleton.** `website/` + VitePress + guide collection with link rewriting + one module
   (excel) end to end. Deliverable: `pnpm docs:dev` renders the excel guide with working
   links, bilingual.
2. **Guides.** Remaining 8 modules, landing page, migration guides. Write the missing `draw`
   and `mermaid` READMEs (source files, not site-only pages — they belong to the modules).
3. **Examples.** Rewriter + mapping table + R5 gate, module by module. Fix or exclude the
   files listed in §6.
4. **API reference.** SPIKE 1, then TypeDoc wiring and R3/R4.
5. **Generated pages.** Formula index (with `listFunctionNames`), mermaid gallery, chart
   matrix. Retire the hardcoded 433.
6. **CI and deploy.** `docs.yml`, Pages, `verify:docs` into `check`.

Phases 1–2 are useful on their own; if the project stops after 2 it still has a real site.
Phase 3 is where the enforcement value appears.

---

## 12. Risks

| Risk                                               | Severity | Handling                                                                             |
| -------------------------------------------------- | -------- | ------------------------------------------------------------------------------------ |
| TypeDoc/TS 5.9 cannot consume `dist/types` cleanly | medium   | SPIKE 1 before committing to phase 4; regex signature index as fallback              |
| Two TypeScript versions confuse contributors       | low      | scoped to `website/`; document in `AGENTS.md` with the reason                        |
| Stale `dist/` yields a wrong API reference         | medium   | docs job always runs `build:esm`; never reuse a cached `dist`                        |
| Install time on the 21-cell CI matrix              | low      | `pnpm i --filter documonster...` in jobs that do not need the site                   |
| Snippet gate (R5) too strict to adopt at once      | medium   | per-module opt-in during phase 3                                                     |
| `src/` adopts TS 7-only syntax later               | low      | input is `dist/types`, which is plain declaration syntax — insulated by construction |

---

## Appendix — defects found while planning, and their disposition

All of these existed before this plan and were worth fixing regardless of whether the site is
built. They are recorded because they are the evidence for §9: every one of them lived in an
artefact no tool read.

**Fixed.**

1. **Seventeen `@example` blocks named functions the exports map does not publish** — the PDF
   and Word modules moved to namespace surfaces and their examples did not follow (§6). All
   seventeen corrected. Note the correction recorded in §6: the earlier claim that
   `excelToPdf` was unreachable was wrong — it is public as `Pdf.fromExcel`.
2. **Eleven more of the same, in the READMEs** — found once the gate below was extended past
   TypeScript comments into Markdown, which is where five sixths of the documented imports
   live. Three defects: `import type { WorkbookData }` from `documonster/excel` (handles are
   published only as `Worksheet.Handle` / `Workbook.Handle`, deliberately — and the same
   README already said so correctly forty lines further down, so it contradicted itself
   exactly as `pdf/index.ts` did); three binary helpers imported from `documonster/archive`
   that live in the never-exported `utils/` layer, under a note that had half-noticed the
   problem and named the wrong module; and one `WorksheetData` in the migration guide's
   _recommended_ code. The binary helpers are now shown as the `TextEncoder` / `TextDecoder`
   calls they wrap, per the repository's own "prefer native APIs" rule.
3. **Five more, invisible to an import-only check.** Extending the gate to `Namespace.member`
   references found `Document.addBodyContent` (the member is `addContent`) in a comment that
   had just been hand-edited for defect 1 — reading carefully is not a substitute for
   compiling — and four members named on `StyleMap`, which `documonster/word` really does
   export, but as the mapping _type_; the namespace is published as `Styles`. The import
   resolved to a different thing of the same name, so only a member probe could see it.
4. **The gate itself.** `scripts/verify-doc-examples.ts` resolves every documented import
   (542), every `Namespace.member` reference (896, 262 distinct), and the syntax of every
   TypeScript Markdown fence against the built public surface, and runs in `pnpm check`.
   Two corpora: comment lines in `.ts`,
   fenced blocks in `.md` — both select text that claims to be runnable code, which is why a
   document discussing a broken import (this one) needs no exception; it quotes it in prose.
   Member references are scoped to the region that imported the namespace, which is what keeps
   false positives near zero — `image.format` never matches because `image` was not imported.
   Across nearly 900 references exactly one needed suppressing, `Workbook.calculate`, named by a
   comment explaining why it deliberately does not exist. Twenty-eight cases in
   `src/test/__tests__/verify-doc-examples.test.ts` drive the gate against a fixture tree.
5. **The function count was wrong in sixteen places across ten files** — READMEs,
   `AGENTS.md` and a public TSDoc block said 433 while the registry held 448. The twelve
   user-facing claims were corrected and are pinned by
   `src/modules/formula/__tests__/function-count.node.test.ts`; the four internal comments (two in
   `function-registry.ts`, two in `scripts/treeshake-verify.ts`) were reworded to drop the
   number, because a count in a comment about tree-shaking costs maintenance and tells its
   reader nothing. `listFunctionNames()` was added so the number can be derived at all.
6. **`draw` and `mermaid` had no README** — both written, in English and Chinese, and both
   modules added to the root README, which had no section for either despite both being
   published entry points.
7. **`scripts/codemod-namespace-to-flat.ts` could not run** — it imported the TypeScript
   compiler API, which `typescript@7.0.2` does not provide. Deleted.
8. **A malformed `@example` in `mermaid/index.ts`** — four lines of English prose sat inside a
   ` ```ts ` fence, so the block a reader copies was not valid TypeScript. Prose moved above
   the fence.
9. **A comment in `pdf/__tests__/excel-bridge-workbook-shape.typecheck.ts`** told readers to
   `import { Workbook } from "documonster"`. There is no `.` entry in the exports map, so the
   bare specifier resolves to nothing. Corrected to `documonster/excel`. Found by the new gate.

10. **A `documonster/draw` consumer could not encode a PNG.** `rasterizeToRgba` returns pixels
    by design, and the encoder that completes the job sat in `excel/utils/png.ts` — exported
    from nowhere. So a chart consumer could obtain a PNG while a Mermaid or own-producer
    consumer could not, and `draw/index.ts` pointed at the internal adapter in prose as though
    it were reachable.

Resolved by moving the encoder to `archive/png.ts` and publishing `encodePng` from
`documonster/archive`. The reasoning, and why the two obvious alternatives lose:

- The file had **zero dependencies on `excel`** — only `@archive/compression/*` and
  `@utils/binary`. Its location was an accident of which module needed it first, exactly
  like the rasteriser that used to live in `excel/chart/render/` before moving to `draw/`.
  Its own header even recorded the contingency: _"if a second module ever needs it, move it
  down rather than copying it a third time."_ What fired that contingency was not a second
  internal caller but a public entry.
- **Exporting `rasterizeDrawList` from `documonster/chart`** would have been two lines, but
  publishes a generic display-list function from an entry named after charts, and leaves the
  encoder misplaced. A symptom patch.
- **A `documonster/draw/png` subpath is illegal**: `draw` is Layer 1 and DEFLATE is Layer 2,
  so the implementation cannot live under `draw/`. `verify:layers` would reject it.
- **A new `image` module** is the only option that answers "where does PNG live" for both
  halves, but costs a module, a layer-table entry, an exports subpath, `typesVersions`,
  rolldown config, two `build:verify` lists and two READMEs — for a 242-line encoder whose
  decoder nobody has asked to publish.

`archive` is not "where PNG belongs because PNG is an archive" — it is where DEFLATE and
CRC-32 live and are _already published_ as `zlibSync` and `crc32`, which is the whole of
what a PNG is beyond chunk framing. The treeshake allowlist for the `Chart` namespace was
widened by exactly one precise entry (`modules/archive/png.`), so the ZIP/TAR containers
stay asserted absent.

**Open, and needing a decision rather than a fix.**

10. **PNG decoding is in the same situation, unresolved.**
    `pdf/render/png-decoder.ts` (359 lines) also has zero dependencies on its host module —
    only `@archive/compression/compress` and `@utils/binary` — so by the reasoning above it
    belongs beside the encoder in `archive/`. It was left alone because nothing forces it:
    no consumer has asked for a public decoder, and moving code with no requirement behind it
    is tidiness, not a fix. The asymmetry is deliberate and recorded here rather than silently
    tolerated.
11. **Eight further spent codemods remain in `scripts/`** — same migration, same two commits of
    2026-07-01, no references anywhere. They still run; they are simply useless. Removing them
    is a cleanup decision, not a defect fix, so they were left alone.
