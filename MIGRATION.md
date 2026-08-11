# Migration Guide

Breaking changes for `documonster` will be documented here as they occur.

## Unreleased

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
