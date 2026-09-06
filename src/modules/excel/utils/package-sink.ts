/**
 * `PackageSink` — the one thing every writer here hands its parts to.
 *
 * ## Why this exists
 *
 * There are four writing paths in this module — XLSX and XLSB, each buffered and streamed — and three of them
 * exist. Every one of them ends up doing the same two things: put a finished part into a package, and remember
 * that it did so, because `[Content_Types].xml` and the relationship parts are *derived* from what is there.
 * Each spelled it differently:
 *
 * | Path              | Whole part                            | Incremental part      | Path list            |
 * | ----------------- | ------------------------------------- | --------------------- | -------------------- |
 * | XLSB buffered     | `addPart(path, data)` → `archive.add` | —                     | `partPaths` array    |
 * | XLSX buffered     | `zip.append(data, { name })`          | `zip.createEntry(p)`  | inside the xform     |
 * | XLSX streamed     | `this._addFile(data, name)`           | `_addFile` per sheet  | `_worksheets` list   |
 *
 * Three vocabularies for one idea is why the fourth path did not exist: adding it meant picking one of them and porting
 * a thousand lines to it. With a single sink the choice disappears — a serialiser writes parts and does not know whether
 * the destination is a buffer being assembled or a socket being drained.
 *
 * **The fourth path exists now, and the three vocabularies are still there.** XLSB streamed is written through
 * `StreamingSink`; the three XLSX paths still say `zip.append` and `_addFile`. That is worth stating plainly rather than
 * leaving the table above to imply a finished migration.
 *
 * **What porting XLSX would buy was measured, and it is less than the table suggests.** The argument for it is below:
 * XLSB derives `[Content_Types].xml` from `sink.paths` while XLSX *predicts* it from the model, and prediction is what
 * left six `chartsheetDrawing*.xml` parts typed `application/xml` and the theme undeclared. Those were XLSB defects, and
 * the prediction on the XLSX side does not currently reproduce them: on a workbook carrying a table, a note, a jpeg, an
 * external hyperlink and a chartsheet — 21 parts — every part is covered by an `Override` or a `Default`, no `Override`
 * dangles, and none falls back to the generic `application/xml`. So the case for the port is structural rather than a
 * defect anyone can point at, and it costs a rewrite of 27 `addXxx` methods plus a second streaming-zip adapter that
 * does not satisfy `StreamingZipLike`. It is not being done on that basis.
 *
 * ## What it deliberately does not abstract
 *
 * **Not the serialisers.** An XML part and a BIFF12 part have nothing in common below the byte level, and a
 * "unified part writer" that took either would be a tagged union pretending to be an abstraction. The sink
 * takes bytes; producing them stays with the code that knows the format.
 *
 * **Not ordering.** ZIP has no entry-order requirement, and both containers already rely on that: the
 * streaming XLSX writer emits `[Content_Types].xml` from `commit()`, and the buffered XLSB writer emits it
 * after every other part. A comment in `xlsb/write/package.ts` used to claim content types were "added to the
 * archive before the sheet parts" — that described a version that no longer exists, and it is the belief that
 * made the derived parts look like they needed a first pass.
 *
 * ## The one genuine forward-pass problem
 *
 * `BrtWsDim` sits *inside* a sheet part, before its rows, and states the used range — so a single forward pass
 * over rows cannot fill it in. The XLSX side does not have this problem because it omits `<dimension>`
 * entirely (there is a comment in `stream/worksheet-writer.ts` saying Excel cannot handle it at the end of the
 * file). Whether `BrtWsDim` may likewise be omitted is unobserved: Excel writes it in all 67 worksheet parts
 * across the corpus and the oracle references.
 *
 * That question is deliberately **not** answered by this interface. `open()` returns a writer that a serialiser
 * may fill incrementally, and a serialiser that needs a value it does not yet have is free to buffer its own
 * records and call `part()` instead. The choice belongs to the format, not to the plumbing.
 */

/** An incremental part: bytes appended, then closed. */
export interface PartWriter {
  /** Append bytes. Text is encoded as UTF-8, matching every XML part in both containers. */
  write(chunk: Uint8Array | string): void;
  /** Close the part. Nothing may be written after this. */
  end(): void;
}

/** Where a writer puts its finished parts. */
export interface PackageSink {
  /**
   * Add a whole part.
   *
   * Returns nothing rather than a promise even for a streamed destination: backpressure is observed through
   * {@link drain}, which is a separate concern from whether the bytes have been handed over. Making this
   * `async` would put an `await` on every part in every writer for the benefit of one destination.
   */
  part(path: string, data: Uint8Array | string): void;

  /**
   * Begin a part whose bytes are produced incrementally.
   *
   * The path is recorded as soon as this is called, not when the writer is closed, because a derived part may
   * be built while another is still open.
   */
  open(path: string): PartWriter;

  /**
   * Every path handed over so far, in the order it was added.
   *
   * This is what `[Content_Types].xml` is derived from, and deriving it rather than maintaining a parallel list
   * is not a stylistic preference — a hand-kept list is how six `chartsheetDrawing*.xml` parts went out typed
   * as `application/xml`, and how the theme part went out missing entirely.
   */
  readonly paths: readonly string[];

  /**
   * Wait for a streamed destination to accept what it has been given.
   *
   * Resolves immediately for a buffered one. A writer that produces many large parts should await this between
   * them; one that produces a handful need not.
   */
  drain(): Promise<void>;
}
