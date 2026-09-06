/**
 * `PackageSink` — the seam that lets one writer serve a buffer and a stream.
 *
 * There are four writing paths in this module: XLSX and XLSB, each buffered and streamed. Three existed and
 * each had its own vocabulary for "put a part in the package and remember that you did" — `addPart` pushing to
 * a `partPaths` array, `zip.append`, `this._addFile`. Three spellings of one idea is why the fourth path did
 * not exist: adding it meant picking one and porting a thousand lines to it.
 *
 * These tests pin the two properties the seam has to have for that to work:
 *
 * 1. **A writer cannot tell which sink it got.** Asserted by running `writeXlsbPackage` both ways and comparing
 *    every part, which is the check that made the refactor safe rather than plausible.
 * 2. **`paths` is the derived-part input.** `[Content_Types].xml` is built from it, and the two defects that
 *    cost the most — six `chartsheetDrawing*.xml` typed as `application/xml`, and a missing theme part — were
 *    both a hand-kept list drifting from the package. A path must therefore be recorded when the part is
 *    *begun*, not when it is finished, or a derived part assembled while another is open sees the wrong set.
 */
import { extractAll } from "@archive/unzip/extract";
import { ZipArchive } from "@archive/zip";
import { Cell, Workbook } from "@excel";
import { ArchiveSink, StreamingSink } from "@excel/utils/package-sink-adapters";
import { writeXlsbPackage } from "@excel/xlsb/write/package";
import { describe, expect, it } from "vitest";

/** A workbook with enough in it that the package has more than a handful of parts. */
function workbook(): Workbook.Handle {
  const handle = Workbook.create();
  const sheet = Workbook.addWorksheet(handle, "S");
  Cell.setValue(sheet, "A1", "text");
  Cell.setValue(sheet, "A2", 1);
  Cell.setValue(sheet, "A3", { formula: "A2+1", result: 2 } as never);
  return handle;
}

/**
 * A part's bytes, with the two things that legitimately differ between two writes removed.
 *
 * `docProps/core.xml` carries a save timestamp, and a drawing's `a16:creationId` is a freshly generated GUID —
 * both by design. This is the same normalisation the oracle script applies, and finding that the *existing*
 * writer is non-deterministic without it was the first result of this comparison.
 */
function normalise(path: string, data: Uint8Array | undefined): string {
  if (data === undefined) {
    return "(absent)";
  }
  if (path === "docProps/core.xml") {
    return "(timestamped)";
  }
  return new TextDecoder("utf-8", { fatal: false })
    .decode(data)
    .replace(/\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}/gi, "{GUID}");
}

describe("the same writer through either sink", () => {
  it("produces the same parts", async () => {
    const handle = workbook();
    const model = Workbook.getModel(handle);

    const implicit = await extractAll((await writeXlsbPackage(model as never)).bytes);
    const explicit = new ArchiveSink();
    await writeXlsbPackage(model as never, { sink: explicit });
    const supplied = await extractAll(await explicit.bytes());

    expect([...supplied.keys()].sort()).toEqual([...implicit.keys()].sort());
    for (const path of implicit.keys()) {
      expect(normalise(path, supplied.get(path)?.data), path).toBe(
        normalise(path, implicit.get(path)?.data)
      );
    }
  });

  it("reports the same losses", async () => {
    // The report is the writer's other output and must not depend on where the bytes went.
    const handle = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(handle, "S"), "A1", { error: "#SPILL!" } as never);
    const model = Workbook.getModel(handle);

    const implicit = await writeXlsbPackage(model as never);
    const sink = new ArchiveSink();
    const explicit = await writeXlsbPackage(model as never, { sink });
    expect(explicit.unsupported).toEqual(implicit.unsupported);
    expect(explicit.unsupported.length).toBeGreaterThan(0);
  });
});

describe("ArchiveSink", () => {
  it("records a path when the part is begun, not when it is closed", async () => {
    // A derived part is assembled while another may still be open, and it reads `paths` to decide what to
    // declare. Recording late is how a part would go undeclared.
    const sink = new ArchiveSink();
    const entry = sink.open("xl/worksheets/sheet1.bin");
    expect(sink.paths).toContain("xl/worksheets/sheet1.bin");
    entry.write(Uint8Array.of(1, 2));
    entry.end();
    expect(sink.paths).toEqual(["xl/worksheets/sheet1.bin"]);
  });

  it("joins the chunks of an incremental part in order", async () => {
    const sink = new ArchiveSink();
    const entry = sink.open("a.bin");
    entry.write(Uint8Array.of(1, 2));
    entry.write(Uint8Array.of(3));
    entry.write(Uint8Array.of(4, 5));
    entry.end();
    const parts = await extractAll(await sink.bytes());
    expect([...parts.get("a.bin")!.data]).toEqual([1, 2, 3, 4, 5]);
  });

  it("refuses a write after the part is closed", () => {
    const sink = new ArchiveSink();
    const entry = sink.open("a.bin");
    entry.end();
    expect(() => entry.write("x")).toThrow(/already closed/);
  });

  it("carries bytes above 0x7F through unchanged", async () => {
    // The reason `createEntry` had to accept `Uint8Array`: encoding these as text would turn each into two.
    // Every `BrtCellReal` contains such bytes, so getting this wrong corrupts almost every sheet.
    const sink = new ArchiveSink();
    const entry = sink.open("a.bin");
    entry.write(Uint8Array.of(0x00, 0x7f, 0x80, 0xff));
    entry.end();
    const parts = await extractAll(await sink.bytes());
    expect([...parts.get("a.bin")!.data]).toEqual([0x00, 0x7f, 0x80, 0xff]);
  });

  it("accepts a caller's own archive", async () => {
    const archive = new ZipArchive();
    archive.add("kept.txt", new TextEncoder().encode("mine"));
    const sink = new ArchiveSink(archive);
    sink.part("added.txt", "theirs");
    const parts = await extractAll(await sink.bytes());
    expect([...parts.keys()].sort()).toEqual(["added.txt", "kept.txt"]);
    // `paths` is what *this sink* added, which is what a derived part must declare — not what the archive
    // happened to contain already.
    expect(sink.paths).toEqual(["added.txt"]);
  });
});

describe("StreamingSink", () => {
  /** A zip that records what it was given, standing in for the streaming writer. */
  function recorder(): {
    readonly zip: {
      append(data: string | Uint8Array, options: { name: string }): void;
      createEntry(name: string): { write(chunk: Uint8Array | string): void; end(): void };
      waitForDrain(): Promise<void>;
    };
    readonly written: Map<string, (Uint8Array | string)[]>;
    drains: number;
  } {
    const written = new Map<string, (Uint8Array | string)[]>();
    const state = {
      written,
      drains: 0,
      zip: {
        append(data: string | Uint8Array, options: { name: string }): void {
          written.set(options.name, [data]);
        },
        createEntry(name: string) {
          const chunks: (Uint8Array | string)[] = [];
          written.set(name, chunks);
          return {
            write(chunk: Uint8Array | string): void {
              chunks.push(chunk);
            },
            end(): void {}
          };
        },
        async waitForDrain(): Promise<void> {
          state.drains += 1;
        }
      }
    };
    return state;
  }

  it("passes bytes to the entry without encoding them", () => {
    const state = recorder();
    const sink = new StreamingSink(state.zip);
    const entry = sink.open("xl/worksheets/sheet1.bin");
    const bytes = Uint8Array.of(0x80, 0xff);
    entry.write(bytes);
    entry.end();
    // The same object, not a re-encoded copy: this is the property the widened signature exists for.
    expect(state.written.get("xl/worksheets/sheet1.bin")).toEqual([bytes]);
  });

  it("records paths for both kinds of part", () => {
    const sink = new StreamingSink(recorder().zip);
    sink.part("[Content_Types].xml", "<Types/>");
    sink.open("xl/worksheets/sheet1.bin").end();
    expect(sink.paths).toEqual(["[Content_Types].xml", "xl/worksheets/sheet1.bin"]);
  });

  it("forwards drain to the zip", async () => {
    const state = recorder();
    await new StreamingSink(state.zip).drain();
    expect(state.drains).toBe(1);
  });
});
