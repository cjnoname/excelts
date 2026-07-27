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
│   └── stream/         # Cross-platform streaming primitives; core/ shared primitives
├── utils/              # Shared: errors, datetime, fs, binary, crypto
└── test/               # Test utilities and fixtures
```

## Module Dependency Layers

```
Layer 5:  pdf      → excel (only excel-bridge.ts + word-chart-bridge.ts), word (only word-bridge.ts + word-chart-bridge.ts + word-layout-to-pdf.ts), archive, utils
Layer 4:  excel, word → formula, archive, xml, csv, markdown, stream, utils
Layer 3:  formula  → utils    (independent calc engine; no excel imports)
Layer 2:  csv, archive → stream, utils
Layer 1:  xml, markdown, stream → utils
Layer 0:  utils    (no module dependencies)
```

- Modules may only import from **lower** layers — never sideways or upward.
- **Sole exceptions**:
  - `pdf/excel-bridge.ts` may import from `@excel/`. No other file in `pdf/` may import `@excel/` except `pdf/word-chart-bridge.ts` (Word charts rendered by the Excel chart engine).
  - `pdf/word-bridge.ts`, `pdf/word-chart-bridge.ts`, and `pdf/word-layout-to-pdf.ts` may import from `@word/` (the Word→PDF bridge family). No other file in `pdf/` may.
  - `word/bridge/excel-bridge.ts` may import from `@excel/`. No other file in `word/` may.
  - `formula/` consumes immutable snapshots and emits writeback plans; `excel/` owns the host adapter. `formula/` never imports concrete types from `@excel/*`.
- `utils/` must never import from any module.

These rules are **machine-enforced** by `scripts/verify-layers.ts` (run via `pnpm verify:layers`, included in `pnpm check`). It scans every production `.ts` import and fails on any forbidden cross-module import. A new bridge file that legitimately needs a cross-module import must be registered in that script's `EXCEPTIONS` map and documented above.

## Path Aliases

`@excel/*`, `@word/*`, `@formula/*`, `@pdf/*`, `@csv/*`, `@markdown/*`, `@xml/*`, `@archive/*`, `@stream/*` → `./src/modules/<name>/*`
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
