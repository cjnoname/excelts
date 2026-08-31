# Migration Guide

Breaking changes for `documonster` will be documented here as they occur.

## Unreleased

### XLSB reads can opt out of materializing styled blank cells

`XlsbReadOptions` and the canonical `WorkbookReadOptions` now accept
`blankCells: "skip"`. It skips value-less BIFF12 cells and otherwise-default
rows, substantially reducing memory for workbooks with formatted blank tails.
The option is additive and defaults to `"keep"`, so existing reads are
unchanged. An unchanged loaded XLSB still writes byte-for-byte; after an edit,
strict writing reports the skipped count unless `unsupported: "ignore"` opts
into dropping the blank-cell formatting.

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
