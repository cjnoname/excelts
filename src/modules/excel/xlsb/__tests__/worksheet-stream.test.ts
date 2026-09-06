/**
 * The streamed sheet part must be the buffered one minus `BrtWsDim`, and nothing else.
 *
 * That is the entire contract, and it is asserted by comparison rather than against constants on purpose. This
 * module's most frequent defect — seven times over — is two pieces of code sharing one wrong belief and
 * agreeing with each other while disagreeing with Excel. A streamed sheet checked against hand-written expected
 * bytes would be a test of my transcription; checked against the buffered writer, it is a test of the property
 * the streaming path actually rests on.
 */
import { Cell, Workbook, Worksheet } from "@excel";
import type { PartWriter } from "@excel/utils/package-sink";
import { iterateInterpretableRecords } from "@excel/xlsb/binary";
import { recordSpec } from "@excel/xlsb/spec/records";
import { CellFormatTable } from "@excel/xlsb/styles";
import { SharedStringTable } from "@excel/xlsb/write/shared-strings";
import type { SheetRow } from "@excel/xlsb/write/types";
import { sortedRows, writeWorksheetPart } from "@excel/xlsb/write/worksheet";
import type { WriteWorksheetPartOptions } from "@excel/xlsb/write/worksheet";
import { beginWorksheetPart } from "@excel/xlsb/write/worksheet-stream";
import { describe, expect, it } from "vitest";

/** A `PartWriter` that keeps what it is given, so a test can look at it. */
function collector(): { writer: PartWriter; bytes: () => Uint8Array; ended: () => boolean } {
  const chunks: Uint8Array[] = [];
  let ended = false;
  return {
    writer: {
      write(chunk: Uint8Array | string): void {
        chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
      },
      end(): void {
        ended = true;
      }
    },
    bytes(): Uint8Array {
      const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const out = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
      }
      return out;
    },
    ended(): boolean {
      return ended;
    }
  };
}

/** Record names and payloads, which is what "the same part" means for a BIFF stream. */
function records(bytes: Uint8Array): string[] {
  return [...iterateInterpretableRecords(bytes, "s")].map(
    entry => `${recordSpec(entry.id)?.name ?? `#${entry.id}`}:${[...entry.payload].join(",")}`
  );
}

/** The buffered part, and the streamed part, for one set of options. */
function bothWays(rows: readonly SheetRow[], rest: Partial<WriteWorksheetPartOptions> = {}) {
  const buffered = writeWorksheetPart({
    rows,
    strings: new SharedStringTable(),
    formats: new CellFormatTable(),
    ...rest
  } as WriteWorksheetPartOptions);
  const sink = collector();
  const stream = beginWorksheetPart(
    sink.writer,
    () =>
      ({
        strings: new SharedStringTable(),
        formats: new CellFormatTable(),
        ...rest
      }) as never
  );
  for (const row of sortedRows(rows)) {
    stream.row(row);
  }
  stream.end();
  return {
    buffered: records(buffered.bytes).filter(entry => !entry.startsWith("BrtWsDim:")),
    streamed: records(sink.bytes()),
    bufferedLosses: buffered.unsupported,
    streamedLosses: stream.unsupported,
    ended: sink.ended()
  };
}

const CASES: readonly {
  readonly name: string;
  readonly rows: readonly SheetRow[];
  readonly rest?: Partial<WriteWorksheetPartOptions>;
}[] = [
  {
    name: "a mix of value kinds",
    rows: [
      {
        row: 0,
        cells: [
          { row: 0, column: 0, value: "text" },
          { row: 0, column: 1, value: 12.5 }
        ]
      },
      { row: 1, cells: [{ row: 1, column: 0, value: true }] }
    ]
  },
  { name: "no rows at all", rows: [] },
  {
    name: "a sparse row with column widths",
    rows: [{ row: 5, cells: [{ row: 5, column: 2, value: null }] }],
    rest: { columns: [{ min: 0, max: 3, width: 12 }] as never }
  },
  {
    name: "merges and page setup in the epilogue",
    rows: [{ row: 0, cells: [{ row: 0, column: 0, value: 1 }] }],
    rest: {
      merges: [{ start: { row: 0, column: 0 }, end: { row: 0, column: 2 } }],
      pageSetup: { orientation: "landscape" }
    } as never
  },
  {
    name: "many rows",
    rows: Array.from({ length: 200 }, (_unused, index) => ({
      row: index,
      cells: [{ row: index, column: 0, value: index }]
    }))
  }
];

/**
 * The epilogue reads the sheet's metadata **when the part is closed**, not when its first row arrived.
 *
 * That is what the code has always claimed — "a caller may still be filling them in while rows arrive" — and until
 * `beginWorksheetPart` took a provider it was false: the options were resolved once, at the first row, and the epilogue
 * re-used that snapshot. So everything the epilogue describes (merges, conditional formats, validations, breaks, page
 * setup, header/footer, hyperlinks, table references) was frozen before a caller had finished setting it.
 *
 * Asserted by *timing* rather than by presence: the same merge is added on either side of the first `row()`, and both
 * must reach the records. Checking only that a merge appears would pass on the broken version.
 */
describe("when the epilogue reads its options", () => {
  /** A part whose merge is set before or after the first row, and the `BrtMergeCell` records it produced. */
  function mergeRecords(when: "before" | "after"): number {
    const sink = collector();
    let merges: readonly string[] = [];
    const stream = beginWorksheetPart(
      sink.writer,
      () =>
        ({
          strings: new SharedStringTable(),
          formats: new CellFormatTable(),
          merges
        }) as never
    );
    if (when === "before") {
      merges = ["A1:B1"];
    }
    stream.row({ row: 0, cells: [{ row: 0, column: 0, value: "x" }] } as never);
    if (when === "after") {
      merges = ["A1:B1"];
    }
    stream.end();
    return records(sink.bytes()).filter(entry => entry.startsWith("BrtMergeCell:")).length;
  }

  it("takes a merge set before the first row", () => {
    expect(mergeRecords("before")).toBe(1);
  });

  it("takes a merge set after the first row", () => {
    // The case that was silently lost.
    expect(mergeRecords("after")).toBe(1);
  });
});

describe("a streamed sheet part", () => {
  for (const testCase of CASES) {
    it(`matches the buffered part for ${testCase.name}`, () => {
      const result = bothWays(testCase.rows, testCase.rest);
      // Record for record, payload for payload. Not a length check and not a hash: a mismatch should say which
      // record moved.
      expect(result.streamed).toEqual(result.buffered);
    });
  }

  it("reports the same losses the buffered writer does", () => {
    const rows: readonly SheetRow[] = [
      { row: 0, cells: [{ row: 0, column: 0, value: { unsupported: true } as never }] }
    ];
    const result = bothWays(rows);
    expect(result.streamedLosses).toEqual(result.bufferedLosses);
  });

  it("ends the underlying writer exactly once", () => {
    // A part left open produces a truncated ZIP entry, and a second `end()` on a real sink throws. Both are
    // silent until Excel opens the file.
    const sink = collector();
    const stream = beginWorksheetPart(
      sink.writer,
      () =>
        ({
          strings: new SharedStringTable(),
          formats: new CellFormatTable()
        }) as never
    );
    stream.end();
    expect(sink.ended()).toBe(true);
    expect(() => stream.end()).not.toThrow();
  });

  it("refuses a row after the part is ended", () => {
    // The epilogue is already written, so a row here would land after `BrtEndSheetData` — a corrupt sheet
    // rather than a misplaced row. Throwing is the only honest response a forward writer can give.
    const sink = collector();
    const stream = beginWorksheetPart(
      sink.writer,
      () =>
        ({
          strings: new SharedStringTable(),
          formats: new CellFormatTable()
        }) as never
    );
    stream.end();
    expect(() => stream.row({ row: 0, cells: [] })).toThrow(/after the sheet part was ended/);
  });

  it("omits the dimension and nothing else", () => {
    // Stated as its own assertion because it is the one deliberate difference. If a future change caused a
    // second record to go missing, the comparisons above would fail without saying why.
    const rows: readonly SheetRow[] = [{ row: 0, cells: [{ row: 0, column: 0, value: 1 }] }];
    const buffered = records(
      writeWorksheetPart({
        rows,
        strings: new SharedStringTable(),
        formats: new CellFormatTable()
      }).bytes
    );
    const result = bothWays(rows);
    expect(buffered.filter(entry => entry.startsWith("BrtWsDim:"))).toHaveLength(1);
    expect(result.streamed.filter(entry => entry.startsWith("BrtWsDim:"))).toEqual([]);
    expect(result.streamed).toHaveLength(buffered.length - 1);
  });
});

describe("interning is shared, not duplicated", () => {
  it("puts a repeated string in the table once", () => {
    // The streamed path holds the same `SharedStringTable` the buffered one does, and that table is the reason
    // "streaming" here is bounded by distinct values rather than by cells. A second table per sheet would be a
    // correctness bug as well as a memory one: `BrtCellIsst` indices are workbook-wide.
    const strings = new SharedStringTable();
    const sink = collector();
    const stream = beginWorksheetPart(
      sink.writer,
      () =>
        ({
          strings,
          formats: new CellFormatTable()
        }) as never
    );
    stream.row({ row: 0, cells: [{ row: 0, column: 0, value: "same" }] });
    stream.row({ row: 1, cells: [{ row: 1, column: 0, value: "same" }] });
    stream.end();
    const indices = records(sink.bytes())
      .filter(entry => entry.startsWith("BrtCellIsst:"))
      .map(entry => entry.split(":")[1]);
    expect(indices).toHaveLength(2);
    expect(indices[0]).toBe(indices[1]);
  });
});

describe("a sheet built through the public API", () => {
  it("still carries its dimension, because a buffered write has the extent for free", async () => {
    const handle = Workbook.create();
    const sheet = Workbook.addWorksheet(handle, "S");
    Worksheet.addAoa(sheet, [
      ["a", "b"],
      [1, 2]
    ]);
    Cell.setValue(sheet, "A3", 3);
    const { extractAll } = await import("@archive/unzip/extract");
    const parts = await extractAll(await Workbook.toBuffer(handle, { format: "xlsb" }));
    const names = records(parts.get("xl/worksheets/sheet1.bin")!.data).map(
      entry => entry.split(":")[0]
    );
    expect(names).toContain("BrtWsDim");
    // Immediately after the properties, in every one of the 208 sheet parts the examples produce — which is
    // what makes omitting it a single-record deletion rather than a re-ordering.
    expect(names[names.indexOf("BrtWsDim") - 1]).toBe("BrtWsProp");
  });
});
