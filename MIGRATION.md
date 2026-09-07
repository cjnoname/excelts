# Migration Guide

Breaking changes for `documonster` will be documented here as they occur.

## Unreleased

### Dates: `Temporal` accepted, the `date1904` epoch honored where it was dropped

Most of this is additive. Three items change existing behavior, and all three
are cases where the previous behavior produced a wrong file or a wrong read.

**New, non-breaking.** `Cell.setValue` now accepts `Temporal.PlainDate`,
`Temporal.PlainTime` and `Temporal.PlainDateTime`, and there are four new
readers/writers: `Cell.getDateParts`, `Cell.setDateParts`, `Cell.getDateKind`
and `Cell.getTemporal`. Only `CellValueInput` grew — `CellValue`, the type a
read returns, is unchanged, so no exhaustive `switch` over a cell value breaks
and `Cell.getValue` still returns a `Date`. The exported `PlainDate` /
`PlainTime` / `PlainDateTime` types are derived structurally from `globalThis`,
so a consumer whose `lib` predates `esnext.temporal` gets `never` rather than an
error in a declaration file they did not write. No polyfill is added; `Temporal`
needs Node 26+, Chrome 144+, Firefox 139+, Bun 1.4+ or Deno 2.7+, and
`Cell.getDateParts` / `Cell.setDateParts` are the runtime-independent
equivalent.

#### 1. The streaming XLSX writer now honors `date1904` (bug fix, output changes)

`Stream.WorkbookWriter`'s `date1904` option reached the BIFF12 row encoder but
neither the XLSX row encoder nor `xl/workbook.xml` — which was built from a
literal `properties: {}`. Both halves were missing, so the package was a
self-consistent **1900** workbook that round-tripped perfectly and was simply
not the workbook that had been asked for. `date1904: true` now writes 1904
serials and `<workbookPr date1904="1">`, so a cell's serial changes by 1,462.

Only affects code that passed `date1904: true` (or assigned
`writer.properties.date1904`) to a **streaming XLSX** writer. If you were
compensating for this by shifting your dates, remove the compensation.

#### 2. Date bounds in data validations now use the workbook's epoch (bug fix)

`DataValidation` rules of `type: "date"` had their bounds converted against a
hard-coded 1900 epoch on both read and write. In a 1904 workbook the bounds
therefore sat 1,462 days from the cells they constrained — a rule reading "on or
after 2020-01-15" rejected that very date. The read side had the mirror-image
omission, so a round trip through this library agreed with itself and hid it.

#### 3. Strict-format `t="d"` date cells are no longer parsed as local time (bug fix)

A strict-OpenXML date cell stores an ISO string with no timezone
(`2020-01-15T00:00:00`), and this was read with `new Date(...)`, which every JS
engine interprets as _local_. The cell therefore read a day early anywhere east
of UTC, and disagreed with every other read path in the library. It now goes
through `parseOoxmlDate`, like the rest.

#### 4. `Stream.WorkbookWriter.xlsbDate1904()` is renamed to `date1904Flag()`

The accessor is consulted by the XLSX writer as well now, and the old name said
otherwise — which is part of why the XLSX branch went unfixed. `date1904` is not
an XLSB concept. Rename the call if you were using it; the workbook-level
`date1904` option and `properties.date1904` are unchanged and are the supported
way to set it.

#### 5. Date-validation bounds in XLSB, and an ISO `Z` in CSV (bug fixes)

Two more of the same shape, both found while checking the above:

- **XLSB** wrote `type: "date"` validation bounds against the 1900 epoch too, so a
  1904 workbook's bounds sat 1,462 days from its cells. Now threaded, like XLSX.
- **`2020-01-15T00:00:00.000Z` was parsed a day early** anywhere east of UTC. The
  fixed-width ISO parsers in `@utils/datetime` were written to be selected by
  length and so checked only their separators — `parseISO` looked for dashes at
  positions 4 and 7 and nothing else. Any caller reaching them another way got a
  silent prefix match, and both `createIsoDateParser` and `createDateParser` do,
  so the 24-character string was consumed by the 10- and 19-character parsers and
  built with `new Date(y, m - 1, d, …)` — local time. Each parser now checks its
  own width. Consequently a malformed or unexpected-width value that previously
  parsed by prefix now returns `null` and stays a string, which is the intended
  behaviour of `castDate`.
- The Excel CSV bridge's default read formats also did not include
  `YYYY-MM-DD[T]HH:mm:ss.SSSZ` — the form its own writer emits. Added.

`CsvOptions.dateUTC` keeps its existing default (local). Making it UTC would give
a file that is identical on every machine, which is worth having, but it is only
safe when the output says what zone it is in: a named `dateFormat` such as
`"DD/MM/YYYY HH:mm:ss"` carries no marker and is read back as local, so UTC
output through one would lose a day rather than merely display one. Pass
`dateUTC: true` when you control both ends.

#### 6. Dates before 1900-03-01 now match Excel (behaviour change)

The serial converter placed serial 0 at 1899-12-30 and ran linearly, which is
correct from 1900-03-01 onward and one day out below it — because Excel spends
serial 60 on the fictitious 1900-02-29 and the linear model had no room for it.

| Expression        | Before | Now  | Excel |
| ----------------- | ------ | ---- | ----- |
| `DATE(1900,1,1)`  | 2      | 1    | 1     |
| `DATE(1900,2,28)` | 60     | 59   | 59    |
| `DATE(1900,2,29)` | 60     | 60   | 60    |
| `MONTH(60)`       | 3      | 2    | 2     |
| `DAY(60)`         | 28     | 29   | 29    |
| `YEAR(TRUE)`      | 1899   | 1900 | 1900  |

Serials from 61 onward — every date a real workbook holds — are bit-for-bit
unchanged, as is the whole 1904 system, which has no phantom day. Only dates in
January and February 1900 move.

`Cell.setDateParts` **refuses** 1900-02-29: a cell's value is stored as a `Date`
and no `Date` names that day, so accepting it would silently store March 1.
`Cell.getDateParts` on a cell read from a file whose serial is 60 likewise
reports 1900-03-01. The formula engine, which works on serials and never routes
a date through a `Date`, is exact.

#### 7. `Cell.getDateKind` gained `"duration"` and `"unknown"`

It previously answered `"dateTime"` for an unformatted cell, a `General` cell, a
plain number format _and_ an elapsed-time format such as `[h]:mm:ss` — dressing
"I cannot tell" and "this is a length of time" up as a calendar kind.
`Cell.getTemporal` now refuses a duration cell instead of manufacturing a
`PlainDateTime` in 1899 for it; pass an explicit kind to override.

Format detection was fixed alongside: `[hh]:mm` (and `[mm]`, `[ss]`) are
recognised as elapsed time, only the first `;` section is consulted, and `\d0`
is read as an escaped literal rather than a day code.

#### 8. `Cell.setDateParts` validates its input

`{}`, `{ month: 13 }`, `{ day: 0 }`, `{ year: 2024, month: 2, day: 31 }`,
`{ hour: 99 }` and `NaN` now throw. They previously carried the way `Date.UTC`
does — 2024-02-31 became March 2 in silence, and `NaN` wrote a workbook Excel
cannot open from a call that reported success. Internal month arithmetic
(`EDATE`, coupon stepping) still relies on carrying and is unaffected.

#### 6. Dates before 1900-03-01 now match Excel (behaviour change)

The serial converter placed serial 0 at 1899-12-30 and ran linearly, which is
correct from 1900-03-01 onward and one day out below it — because Excel spends
serial 60 on the fictitious 1900-02-29 and the linear model had no room for it.

| Expression        | Before | Now  | Excel |
| ----------------- | ------ | ---- | ----- |
| `DATE(1900,1,1)`  | 2      | 1    | 1     |
| `DATE(1900,2,28)` | 60     | 59   | 59    |
| `DATE(1900,2,29)` | 60     | 60   | 60    |
| `MONTH(60)`       | 3      | 2    | 2     |
| `DAY(60)`         | 28     | 29   | 29    |
| `YEAR(TRUE)`      | 1899   | 1900 | 1900  |

Serials from 61 onward — every date a real workbook holds — are bit-for-bit
unchanged, as is the whole 1904 system, which has no phantom day. Only dates in
January and February 1900 move.

`Cell.setDateParts` **refuses** 1900-02-29: a cell's value is stored as a `Date`
and no `Date` names that day, so accepting it would silently store March 1. A
cell read from a file whose serial is 60 likewise reports 1900-03-01. The formula
engine, which works on serials and never routes a date through a `Date`, is exact.

#### 7. `Cell.getDateKind` gained `"duration"` and `"unknown"`

It previously answered `"dateTime"` for an unformatted cell, a `General` cell, a
plain number format _and_ an elapsed-time format such as `[h]:mm:ss` — dressing
"I cannot tell" and "this is a length of time" up as a calendar kind.
`Cell.getTemporal` now refuses a duration cell instead of manufacturing a
`PlainDateTime` in 1899 for it; pass an explicit kind to override.

Format detection was fixed alongside: `[hh]:mm` (and `[mm]`, `[ss]`) are
recognised as elapsed time, only the first `;` section is consulted, and `\d0` is
read as an escaped literal rather than a day code.

#### 8. `Cell.setDateParts` validates its input

`{}`, `{ month: 13 }`, `{ day: 0 }`, `{ year: 2024, month: 2, day: 31 }`,
`{ hour: 99 }` and `NaN` now throw. They previously carried the way `Date.UTC`
does — 2024-02-31 became March 2 in silence, and `NaN` wrote a workbook Excel
cannot open from a call that reported success. Internal month arithmetic
(`EDATE`, coupon stepping) still relies on carrying and is unaffected.

#### A note on `new Date(y, m, d)`

Not a change, but the reason for the above. A spreadsheet date is a _calendar_
value and a `Date` is an _instant_, so this library reads a `Date`'s **UTC**
fields as the cell's value. `new Date(2024, 0, 15)` therefore stores a different
serial in every timezone — in UTC+8 it becomes 2024-01-14 16:00. Pass
`new Date(Date.UTC(2024, 0, 15))`, or better, a value that says what it is:

```ts
Cell.setDateParts(ws, "A1", { year: 2024, month: 1, day: 15 });
Cell.setValue(ws, "A1", Temporal.PlainDate.from("2024-01-15"));
```

### `Pdf.fromExcel` now honors the worksheet's print settings (behavior change)

The PDF bridge forwarded only a handful of `pageSetup` fields, so most of Excel's
Page Setup dialog had no effect on the output — and in three places the exporter
did something Excel does not. Everything below is now wired end to end, with an
explicit export option that overrides the sheet, resolved **per sheet** so sheets
in one workbook can differ.

Four changes alter the default output of existing code:

| Setting             | Before                                                 | Now                                                                  |
| ------------------- | ------------------------------------------------------ | -------------------------------------------------------------------- |
| Center on page      | Narrow sheets were **always** centered horizontally    | Starts at the left margin; opt in with `horizontalCentered`          |
| Page order          | Effectively `overThenDown`                             | `downThenOver`, Excel's default; override with `pageOrder`           |
| `pageSetup.scale`   | Silently dropped whenever `fitToPage` was on (default) | Honored when the sheet is in "Adjust to N %" mode                    |
| `repeatRows: false` | Could not suppress `printTitlesRow`                    | An explicit `false` now suppresses it (`undefined` still falls back) |

To keep the previous appearance:

```ts
await Pdf.fromExcel(workbook, {
  horizontalCentered: true,
  pageOrder: "overThenDown",
  scale: 1 // ignore the sheet's own percentage
});
```

Newly honored settings (previously ignored entirely, so nothing regresses — the
output only changes for sheets that had already set them):

- `verticalCentered` — center on page, vertical axis
- `fitToPage` + `fitToWidth` / `fitToHeight` — "Fit to N pages wide by M tall".
  Like Excel, these only ever shrink; a grid that already fits is not enlarged.
  Both are solved against the real paginator, and exact for wrapped cells too
  (the wrap calculation scales width, padding and font size together).
- `printTitlesColumn` — "Columns to repeat at left", the counterpart of
  `printTitlesRow`. Both are now treated as **absolute** bands independent of the
  print area, so a sheet printing `E1:T3` still repeats `A:B` at the left of every
  page. Previously they were read as "the first N rows/columns of the printed
  range", which repeated the wrong tracks whenever a print area was set, and
  `printTitlesRow: "3:5"` was misread as "repeat the first five rows". A band
  inside the printed range still repeats, but is not hoisted to the leading edge,
  since that would reorder the first page's grid.
- `showRowColHeaders` — print row numbers and column letters
- `blackAndWhite` — grayscale both vector and raster content. Vector colors
  (cell text, fills, borders, gridlines, heading bands, chart vectors,
  `&K`-colored header/footer runs, text watermarks) are converted up-front, with
  opacity preserved. Raster payloads are converted per pixel when the image
  XObject is written: PNG samples collapse to one `/DeviceGray` component, JPEG
  keeps its `DCTDecode` data and gains a `/DeviceN` luma color space. Transparent
  PNG regions stay transparent — no blend overlay is painted.
- `draft` — omit images and charts. A chartsheet still emits its page, blank,
  so page numbering is unaffected.
- `errors` — print error cells as `"displayed"` / `"blank"` / `"dash"` / `"NA"`

**Type change (internal surface).** `ResolvedPdfOptions.repeatRows` /
`repeatCols` are now `PdfRepeatBand | false` (`{ first, last }`, absolute
1-based) instead of `number | false`. `ResolvedPdfOptions` is _not_ exported from
`documonster/pdf`, so this only affects code that reaches into
`@pdf/render/layout-engine` to call `layoutSheet` with a hand-built options
object. The public `PdfExportOptions` inputs are unchanged and still take a count.

`PdfPageOrder` and `PdfCellErrorMode` are now exported from `documonster/pdf`, so
the new `pageOrder` / `errors` options can be named in user code.

**On `fitToPage`.** `PdfExportOptions.fitToPage` (default `true`) collided by
name with `pageSetup.fitToPage` but means something different: it is
documonster's own "shrink to one page wide" fallback. It now applies only when
neither the caller nor the sheet expresses a scaling intent, so a sheet asking
for 80% is no longer shrunk twice. Explicitly passing `fitToPage` still wins.

- `cellComments` — print cell comments and notes, in either of Excel's modes.
  `"atEnd"` appends a list of every comment (classic notes and threaded comments
  alike) after the sheet's pages; `"asDisplayed"` draws each one as a box where it
  sits on the sheet, decoding the note's VML anchor, plus the red corner marker on
  the commented cell.

**Not implemented.** `horizontalDpi` / `verticalDpi` are meaningless for vector
output.

### Charts with an EMU extent are no longer 4/3 too large (behavior change)

A chart anchored with an explicit `ext` (`cx`/`cy`, which Excel stores in EMU)
was converted EMU→**pixels** (÷9525) and the result used directly as PDF points.
Every such chart rendered 33% oversized — a 4in × 2in chart came out
384pt × 192pt instead of 288pt × 144pt — which also overflowed the content area
and distorted the aspect ratio against surrounding cells. The conversion is now
EMU→points (÷12700).

Charts sized from a `br` anchor (the common case when Excel writes a
two-cell anchor) were always correct and are unaffected.

**Also fixed:** `fitToPage` (default `true`) promises "shrink to one page wide",
but the ratio ignored `scale`, so `{ scale: 2 }` overflowed to two pages while
`{ scale: 0.8 }` compounded the two factors and under-filled the page. It now
behaves as `min(scale, contentWidth / tableWidth)`, matching `fitToWidth: 1`.

**Also fixed:** a chart fill and stroke with _different_ opacities collapsed to a
single value, because the alpha `ExtGState` sets `/ca` and `/CA` together and
`fillAndStroke()` paints both under one graphics state. Such paints are now split
into two passes, each with its own state.

### `createCsvReadStream` is now a byte stream (breaking)

`createCsvReadStream(workbook, options?)` from `documonster/excel/csv` used to
return an **object-mode** stream that emitted `string` chunks. It now returns a
normal **byte** stream: `objectMode` is off on the readable side and every chunk
is a `Uint8Array` (a `Buffer` on Node).

The declared return type changed from `IReadable<Uint8Array | string>` to
`IReadable<Uint8Array>`. On the Node entry it is narrowed further, to
`IReadable<Uint8Array> & Readable`, so the value is a nominal `stream.Readable`:

```ts
// Node — no adapter, no cast
await pipeline(createCsvReadStream(wb), createWriteStream("out.csv"));
const web = Readable.toWeb(createCsvReadStream(wb));
```

The writable half of the underlying `Transform` is deliberately **not** exposed.
The stream is already attached to a producer, so `write()` would inject rows into
the CSV; `write()` / `end()` therefore do not typecheck on the returned value.

**Why.** The old shape leaked the CSV _formatter's_ internals into a public API.
It also made the stream indistinguishable by type from `Workbook.toStream()`
while behaving completely differently, so anything that consumes bytes silently
misbehaved instead of failing to compile:

```ts
// Before: threw `list[0] argument must be an instance of Buffer or Uint8Array`
Buffer.concat(chunks);

// Before: produced a ReadableStream of *strings*, which an SDK then rejected
// or uploaded as "[object Object]"-shaped garbage.
Readable.toWeb(createCsvReadStream(wb));
```

Both now work. The CSV content is byte-for-byte identical to before — only the
chunk type changed.

**If you relied on string chunks**, decode explicitly, or use the string API:

```ts
// A chunk boundary can fall inside a multi-byte character, so decode with a
// streaming decoder rather than per chunk.
const decoder = new TextDecoder();
let csv = "";
for await (const chunk of createCsvReadStream(wb)) {
  csv += decoder.decode(chunk, { stream: true });
}
csv += decoder.decode();

// …or skip streaming entirely when the whole document fits in memory:
const csv = writeCsv(wb);
```

Building a string by `+=`-ing chunks is the one pattern that breaks **silently**
— `"" + new Uint8Array([97])` yields `"97"`, not `"a"`. Search for that shape.

`CsvFormatterStream` from `documonster/csv` is **unchanged** and still emits
strings by default. It gained a `readableObjectMode` option to opt into bytes:

```ts
new CsvFormatterStream({ readableObjectMode: false }); // rows in, bytes out
```

### Node IO declarations now match the runtime (non-breaking)

Two Node-entry signatures were narrowed to the types Node already returned.
Both are strict narrowings, so existing code keeps compiling — but the wrappers
and casts it needed can be deleted.

**`Workbook.toBuffer` returns `Promise<Buffer>`** on `documonster/excel` (the
browser entry still returns `Promise<Uint8Array>`). The runtime already produced
a `Buffer`; the `Uint8Array` declaration is what pushed callers into a defensive
`Buffer.from(bytes)`, which copies the entire package.

```ts
// Before
const bytes = await Workbook.toBuffer(wb);
await upload(Buffer.from(bytes)); // full copy, purely to satisfy the type

// Now
await upload(await Workbook.toBuffer(wb));
```

**`Workbook.toStream` returns a nominal `stream.Readable` on Node.** The shared
`XlsxReadable` type is unchanged and **identical in both builds** — it is still
`IReadable<Uint8Array>`, so cross-platform code written against that name keeps
compiling as-is. Node's `toStream` refines only its _return type_ to
`XlsxReadable & Readable`, which is assignable to `XlsxReadable`:

```ts
// Before: an adapter, or a bet on an implementation detail
const body = Readable.from(Workbook.toStream(wb));
const body = Workbook.toStream(wb) as unknown as Readable;

// Now
const body = Workbook.toStream(wb);
const web = Readable.toWeb(Workbook.toStream(wb));

// Still valid, and still means the same type on both platforms
const portable: Workbook.XlsxReadable = Workbook.toStream(wb);
```

`for await` continues to yield `Uint8Array`.

### Note: leaving `for await` early (no change, previously undocumented)

Not a change in `documonster`, but it was never written down and it bites the
common "read the first N chunks" shape.

On **Node**, breaking out of a `for await` loop lets Node's own async iterator
destroy the stream with an `AbortError`, so `stream.errored` is set and any
attached `'error'` listener receives `The operation was aborted`. Calling
`destroy()` yourself destroys it with no error. Nothing crashes either way — the
iterator handles the event — but code that treats an `'error'` or a non-null
`errored` as a serialization failure will report a false one.

```ts
// Sets errored to AbortError
for await (const chunk of Workbook.toStream(wb)) break;

// Silent: destroy first, then break
const stream = Workbook.toStream(wb);
for await (const chunk of stream) {
  stream.destroy();
  break;
}

// Silent: opt out of the iterator's teardown — but then you must destroy it,
// or the serializer stays parked
const stream = Workbook.toStream(wb);
try {
  for await (const chunk of stream.iterator({ destroyOnReturn: false })) break;
} finally {
  stream.destroy();
}
```

The **browser** build destroys silently on early exit, so `errored` is not a
portable way to distinguish "the consumer stopped" from "serialization failed".
Track that yourself if the same code runs on both platforms.

The same applies to `createCsvReadStream` on Node, which is also a
`stream.Readable`.
