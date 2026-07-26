# Formula Module

[中文](README_zh.md)

Standalone Excel-compatible formula engine — tokenizer, parser, compiler, evaluator, dependency graph, dynamic-array spill materialiser, and 433 built-in functions. Zero runtime dependencies.

## Two usage modes

Which entry you call depends on what holds your data. You never pay for
the engine unless you import it.

| Mode                        | How                                                          | Use when                                                                                            |
| --------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| **Paired with `Workbook`**  | `calculateFormulas(wb)` from `documonster/excel/formula`     | You use the excel module's `Workbook` and want to recompute its formulas (and PDF export recalc).   |
| **Standalone / functional** | `Formula.calculate(workbookLike)` from `documonster/formula` | You operate on a `WorkbookLike` object (custom host, server-side recalc, tests) — no excel runtime. |

Both run the same engine. The split exists because an excel workbook
handle is a plain-data record (`WorkbookData`) while the engine consumes
the structural `WorkbookLike` contract — `documonster/excel/formula`
holds the adapter between them. There is **no install or registration
step** in either mode. See [Why separate subpaths?](#why-separate-subpaths)
for the tree-shake numbers.

## Features

- **Full expression pipeline** — tokenizer → AST → binder → compiled form → evaluator → writeback plan
- **Dependency graph** — topological evaluation, circular-ref detection, iterative calculation
- **Dynamic arrays with spill** — `FILTER`, `SORT`, `UNIQUE`, `SEQUENCE`, spill-error detection, ghost-cell cleanup
- **Higher-order functions** — `LAMBDA`, `LET`, `MAP`, `REDUCE`, `SCAN`, `BYROW`, `BYCOL`
- **Array semantics** — implicit intersection, broadcasting, CSE array formulas
- **Structured references** — Tables, `[#This Row]`, `[@Column]`, `[#Totals]`
- **Shared formulas** — read, translate, recalculate
- **Defined names** — scoped, formula-based, range unions
- **Cross-sheet references** — `Sheet2!A1`, 3D ranges `Sheet1:Sheet3!A1`
- **R1C1 addressing** — both A1 and R1C1 modes via `INDIRECT`
- **433 built-in Excel functions** across 11 categories
- **Zero runtime dependencies** — no npm deps, no polyfills

## Function Coverage

| Category      | Count | Highlights                                                                              |
| ------------- | ----- | --------------------------------------------------------------------------------------- |
| Math & Trig   | ~70   | `SUM`, `PRODUCT`, `ROUND`, `CEILING`, `POWER`, `MMULT`, `MDETERM`, `SIN`, `ATAN2`       |
| Text          | ~55   | `CONCAT`, `TEXTJOIN`, `TEXT`, `LEFT`, `MID`, `SUBSTITUTE`, `REGEXTEST`, `REGEXEXTRACT`  |
| Logical       | ~15   | `IF`, `IFS`, `AND`, `OR`, `SWITCH`, `IFERROR`, `XOR`                                    |
| Date & Time   | ~30   | `TODAY`, `DATEDIF`, `EDATE`, `NETWORKDAYS`, `WEEKNUM`, `ISOWEEKNUM`, `WORKDAY.INTL`     |
| Lookup & Ref  | ~25   | `VLOOKUP`, `XLOOKUP`, `XMATCH`, `INDEX`, `OFFSET`, `INDIRECT`, `ADDRESS`, `CHOOSE`      |
| Statistical   | ~90   | `AVERAGE`, `STDEV`, `NORM.DIST`, `T.TEST`, `PERCENTILE`, `QUARTILE`, `CORREL`, `LINEST` |
| Financial     | ~50   | `PMT`, `IRR`, `NPV`, `XIRR`, `RATE`, `PRICE`, `DURATION`, `COUPNUM`, `ACCRINT`          |
| Dynamic Array | ~25   | `FILTER`, `SORT`, `UNIQUE`, `SEQUENCE`, `TAKE`, `DROP`, `VSTACK`, `TEXTSPLIT`, `LAMBDA` |
| Database      | ~12   | `DSUM`, `DCOUNT`, `DAVERAGE`, `DMAX`, `DMIN`, `DSTDEV`, `DPRODUCT`                      |
| Engineering   | ~45   | `DEC2BIN`, `BITAND`, `COMPLEX`, `IMSUM`, `ERF`, `BESSELJ`                               |
| Information   | ~20   | `ISNUMBER`, `ISBLANK`, `ISREF`, `N`, `TYPE`, `CELL`, `FORMULA`                          |

See `functions/` for the full list; `runtime/function-registry.ts` is the registration site.

## Quick Start

### Paired with `Workbook` (most common)

```typescript
import { Workbook, Cell } from "documonster/excel";
import { calculateFormulas } from "documonster/excel/formula";

const wb = Workbook.create();
const ws = Workbook.addWorksheet(wb, "Sheet1");
Cell.setValue(ws, "A1", 10);
Cell.setValue(ws, "A2", 20);
Cell.setValue(ws, "A3", 30);
Cell.setValue(ws, "A4", { formula: "SUM(A1:A3)" });

calculateFormulas(wb);
console.log(Cell.getResult(ws, "A4")); // 60
```

### Standalone / functional

The engine runs on any object shaped like `WorkbookLike` — you do **not**
have to use the excel module at all. A bundle that imports only
`Formula.calculate` pulls zero excel runtime code.

```typescript
import { Formula, type WorkbookLike } from "documonster/formula";

// Your own data — any object implementing WorkbookLike works.
// No Workbook required.
const wb: WorkbookLike = buildMyWorkbookLike();

Formula.calculate(wb); // pure function, zero global side effects
```

This mode is ideal for:

- Server-side recalculation of cached XLSX files
- Custom spreadsheet hosts that already have their own data model
- Tests and benchmarks that want deterministic, per-instance behaviour
- Concurrent evaluation of multiple workbooks without touching process globals

`Formula.calculate` does **not** accept an excel workbook handle: a
`Workbook.Handle` (`WorkbookData`) is a plain-data record with no
`worksheets` array and no `getWorksheet()` method, so passing one is a
compile error (and would throw at runtime). Use
`documonster/excel/formula` for those.

### Recalculating a loaded workbook

Load an XLSX with the excel module, then recalculate its formulas
functionally. There is no install or registration step.

```typescript
import { Workbook } from "documonster/excel";
import { calculateFormulas } from "documonster/excel/formula";

const wb = Workbook.create();
await Workbook.read(wb, buffer);
calculateFormulas(wb); // defined names classified and formulas recalculated
```

### Tokenise / parse without evaluating

```typescript
import { Formula } from "documonster/formula";

const tokens = Formula.tokenize("SUM(A1:B10) + VLOOKUP(key, table, 2, FALSE)");
const ast = Formula.parse(tokens); // throws on syntax errors
```

## Why separate subpaths?

The formula engine is ~200 KB minified. Most callers of `documonster`
only read and write XLSX files and let Excel recalculate on open — pulling
the engine into those bundles unconditionally would be a large, invisible
cost.

The subpaths give you these tree-shaking outcomes:

| Imports                                   | Excel module | Formula engine |
| ----------------------------------------- | ------------ | -------------- |
| `Workbook` from `/excel` only             | ✓            | ✗              |
| `Formula.calculate` from `/formula`       | ✗            | ✓              |
| `calculateFormulas` from `/excel/formula` | ✓            | ✓              |

The functional `Formula.calculate` API operates on the structural
`WorkbookLike` interface and pulls **no** excel runtime code — you can
hand it any object shaped like a workbook. Recalculating a workbook the
excel module loaded goes through `/excel/formula`, which is the only
entry that links both.

Keeping recalculation on its own subpath — rather than as a member of the
`Workbook` namespace — is what makes "no engine unless you ask for it"
hold in **every** output format, not just the ones with member-level
dead-code elimination. Measured: hanging it off `Workbook` added approximately
200 KB to the script-tag excel IIFE for every CDN consumer, because an IIFE
must keep all of an entry's exports.
`scripts/verify-treeshake` asserts the current split on rolldown and
rspack.

> **IIFE note:** The script-tag IIFE bundles
> (`dist/iife/documonster.excel.iife.min.js` and friends) intentionally
> exclude the formula engine so they stay lean —
> `dist/iife/documonster.formula.iife.min.js` ships it separately. Script-tag
> users who need to recalculate an excel workbook should switch to ESM and
> import `calculateFormulas` from `documonster/excel/formula`.

## Examples

Runnable examples live in `src/modules/formula/examples/`:

| File                         | What it demonstrates                                           |
| ---------------------------- | -------------------------------------------------------------- |
| `formula-math.ts`            | Arithmetic, rounding, trig, matrix, power & log                |
| `formula-text.ts`            | Slicing, search/replace, concat, formatting, regex             |
| `formula-logical.ts`         | `IF`/`IFS`, boolean ops, `IFERROR`, `SWITCH`, `CHOOSE`         |
| `formula-date.ts`            | Date construction, extract, duration, business days, format    |
| `formula-lookup.ts`          | `VLOOKUP`, `XLOOKUP`, `INDEX/MATCH`, `OFFSET`, `INDIRECT`      |
| `formula-statistical.ts`     | Descriptive stats, conditional aggregates, regression, dists   |
| `formula-financial.ts`       | Loans, TVM, NPV/IRR, depreciation                              |
| `formula-dynamic-array.ts`   | `FILTER`/`SORT`/`UNIQUE`, spill, `SEQUENCE`, `LAMBDA`/`REDUCE` |
| `formula-database.ts`        | `DSUM`/`DCOUNT`/`DAVERAGE` with criteria ranges                |
| `formula-engineering.ts`     | Base conversions, bitwise, complex numbers, ERF/BESSELJ        |
| `formula-standalone.ts`      | Functional API + `tokenize`/`parse` without evaluation         |
| `formula-pdf-integration.ts` | Automatic recalc during `Pdf.fromExcel()`                      |

Run any example:

```bash
npx tsx src/modules/formula/examples/formula-math.ts
npx tsx src/modules/formula/examples/formula-dynamic-array.ts
npx tsx src/modules/formula/examples/formula-pdf-integration.ts
# Output: tmp/formula-examples/formula-pdf-integration.pdf
```

## Architecture

The engine is a six-layer pipeline (see `AGENTS.md` Layer 3 for where
it sits in the overall module graph):

```
┌─ syntax/        tokenizer → parser → AST
├─ compile/       binder, dependency analysis, compiled form
├─ runtime/       evaluator, function registry, RuntimeValue
├─ functions/     433 function implementations (11 category files)
├─ materialize/   spill engine, ghost-cell tracking, writeback plan
└─ integration/   workbook adapter, snapshot, calculate-formulas entry
```

All layers depend on structural interfaces from `materialize/types.ts`
(`WorkbookLike`, `WorksheetLike`, `CellLike`, …) — not on the concrete
`Workbook`/`Worksheet`/`Cell` classes in the excel module. Any host
that implements those interfaces can drive the engine.

## API Surface

### `Formula.calculate(workbook: WorkbookLike): void`

The functional entry point for evaluation. Walks every formula cell
in `workbook`, evaluates it with full dependency resolution, writes
results back onto each cell's `result` property, and materialises
dynamic-array spills onto ghost cells. Mutates the workbook in place.
Zero global side effects; safe for concurrent calls on different
workbooks. There is **no install or registration step** and **no
`Workbook.calculateFormulas()` method**.

It takes a `WorkbookLike` — a host that exposes a `worksheets` array, a
`getWorksheet()` method, and live worksheet/cell views. An excel
`Workbook.Handle` is a plain-data record and does **not** satisfy that
contract; pass those to `calculateFormulas` below instead.

### `calculateFormulas(workbook: Workbook.Handle): void`

From `documonster/excel/formula`. Adapts an excel workbook handle to
`WorkbookLike` and runs the engine on it, writing results back into the
real cells. This is the entry to use whenever the workbook came from
`documonster/excel` — including workbooks loaded from XLSX.

### PDF export recalculation

`Pdf.fromExcel` does not depend on the formula engine. To recompute
formulas before rendering, inject `calculateFormulas` via the
`recalculate` option — only opt-in callers pull the ~200 KB engine into
their bundle. Without it, the cached XLSX results are used (the safe
default for files written by Excel itself).

```typescript
import { Pdf } from "documonster/pdf";
import { calculateFormulas } from "documonster/excel/formula";

const bytes = await Pdf.fromExcel(wb, { recalculate: calculateFormulas });
```

### Defined-name syntax classification

When the excel module loads an XLSX, it classifies defined names using a
built-in syntax probe that reuses this engine's `tokenize` + `parse`.
This is automatic — no setup required, and a `Workbook` that never loads
XLSX never pulls the tokenizer/parser in. To override classification per
instance (e.g. for a custom host), pass your own probe — a
`(text: string) => boolean` — to `Workbook.create({ formulaSyntaxProbe })`.
You can build one from this module's primitives:

```typescript
import { Workbook } from "documonster/excel";
import { Formula } from "documonster/formula";

const probe = (text: string): boolean => {
  try {
    Formula.parse(Formula.tokenize(text));
    return true;
  } catch {
    return false;
  }
};

const wb = Workbook.create({ formulaSyntaxProbe: probe });
```

### `Formula.tokenize(source: string): Token[]`

Pure lexer — accepts a formula string (with or without leading `=`) and
returns a flat token stream. Throws on invalid characters.

### `Formula.parse(tokens: Token[]): AstNode`

Pratt parser — builds a typed AST from a token stream. Throws on
structural errors.

### Errors

`FormulaError` (base), `FormulaParseError` (carries an optional 0-based
`position`), and the `isFormulaError` type guard.

### Structural types

`WorkbookLike`, `WorksheetLike`, `CellLike`, `RowLike`, `CellErrorValueLike`,
`FormulaResultLike`, `DefinedNameEntry`, `DefinedNamesLike`,
`DimensionsLike`, `SpillRegion`.

## Compatibility Notes

- **Date system** — honours the workbook's 1900 / 1904 setting, including
  the 1900 leap-year bug.
- **Error propagation** — matches Excel's precedence (`#N/A > #VALUE! > ...`).
- **Implicit intersection** — applied at non-dynamic-array sites, exactly
  where Excel 365 applies it.
- **Iterative calc** — disabled by default; enable via
  `workbook.calcProperties = { iterate: true, iterateCount: 100, iterateDelta: 0.001 }`.
- **External references** — `[book.xlsx]Sheet!A1` is parsed as `#REF!`;
  cached values are not followed.
