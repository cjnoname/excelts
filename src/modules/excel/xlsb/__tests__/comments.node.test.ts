import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { extractAll } from "@archive/unzip/extract";
/**
 * Cell comments.
 *
 * **These are the only assertions in this module checked against Excel's own bytes.** Two corpus
 * workbooks carry comments, fourteen between them, so the layout claims here are verified rather than
 * inferred — and the corpus cases are asserted directly, not only through a round trip, because a round
 * trip through this library cannot tell a correct reading from two matching mistakes.
 *
 * The corpus tests carry `.node` in the file name because they read the cache off disk; the browser
 * config excludes that suffix by glob.
 */
import { Cell, Workbook } from "@excel";
import { iterateInterpretableRecords } from "@excel/xlsb/binary";
import { encodeCommentsPart, readCommentsPart } from "@excel/xlsb/comments";
import { XLSB_CORPUS_CACHE } from "@excel/xlsb/corpus/paths";
import { recordSpec } from "@excel/xlsb/spec/records";
import { describe, expect, it } from "vitest";

/** Read a part back through the module's own iterator, as the package reader does. */
function readPart(bytes: Uint8Array) {
  return readCommentsPart(bytes, "test", iterateInterpretableRecords, id => recordSpec(id)?.name);
}

/** Comments a workbook came back with, keyed by address. */
async function roundTrip(build: (workbook: ReturnType<typeof Workbook.create>) => void) {
  const workbook = Workbook.create();
  build(workbook);
  const bytes = await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" });
  const reopened = Workbook.create();
  await Workbook.read(reopened, bytes);
  const sheet = Workbook.getModel(reopened).worksheets[0] as unknown as {
    rows?: {
      cells?: { address?: string; comment?: { note?: { texts?: { text: string }[] } } }[];
    }[];
  };
  const found = new Map<string, string[]>();
  for (const row of sheet.rows ?? []) {
    for (const cell of row.cells ?? []) {
      if (cell.comment !== undefined && cell.address !== undefined) {
        found.set(
          cell.address,
          (cell.comment.note?.texts ?? []).map(run => run.text)
        );
      }
    }
  }
  return { found, bytes };
}

describe("comments part structure", () => {
  it("deduplicates authors and references them by index", () => {
    // `poi-comments.xlsb` carries two authors for four comments, with `iauthor` 0 and 1. Writing one
    // author record per comment would still read back correctly here and produce a part Excel bloats.
    const bytes = encodeCommentsPart([
      { ref: "A1", author: "Ann", texts: [{ text: "one" }] },
      { ref: "A2", author: "Bob", texts: [{ text: "two" }] },
      { ref: "A3", author: "Ann", texts: [{ text: "three" }] }
    ]);
    let authors = 0;
    const headers: number[] = [];
    for (const record of iterateInterpretableRecords(bytes, "test")) {
      const name = recordSpec(record.id)?.name;
      if (name === "BrtCommentAuthor") {
        authors++;
      }
      if (name === "BrtBeginComment") {
        expect(record.payload).toHaveLength(36);
        headers.push(
          new DataView(record.payload.buffer, record.payload.byteOffset).getInt32(0, true)
        );
      }
    }
    expect(authors).toBe(2);
    expect(headers).toEqual([0, 1, 0]);
  });

  it("nests the records the way Excel does", () => {
    const bytes = encodeCommentsPart([{ ref: "A1", author: "Ann", texts: [{ text: "x" }] }]);
    const names = [...iterateInterpretableRecords(bytes, "test")].map(
      record => recordSpec(record.id)?.name
    );
    // Exactly the sequence read out of `poi-comments.xlsb`.
    expect(names).toEqual([
      "BrtBeginComments",
      "BrtBeginCommentAuthors",
      "BrtCommentAuthor",
      "BrtEndCommentAuthors",
      "BrtBeginCommentList",
      "BrtBeginComment",
      "BrtCommentText",
      "BrtEndComment",
      "BrtEndCommentList",
      "BrtEndComments"
    ]);
  });

  it("writes the anchor as a one-cell range and a zero GUID", () => {
    const bytes = encodeCommentsPart([{ ref: "C5", author: "A", texts: [{ text: "x" }] }]);
    for (const record of iterateInterpretableRecords(bytes, "test")) {
      if (recordSpec(record.id)?.name !== "BrtBeginComment") {
        continue;
      }
      const view = new DataView(record.payload.buffer, record.payload.byteOffset);
      // Both corners equal, as in every corpus comment: a note is attached to one cell.
      expect([view.getUint32(4, true), view.getUint32(8, true)]).toEqual([4, 4]);
      expect([view.getUint32(12, true), view.getUint32(16, true)]).toEqual([2, 2]);
      // Zero in all fourteen corpus comments. The GUID identifies a *threaded* conversation, and a
      // classic note has none — generating one would invent an identity the note does not have.
      expect([...record.payload.slice(20, 36)]).toEqual(Array.from({ length: 16 }, () => 0));
    }
  });

  it("sets fRichStr, which the record requires", () => {
    const bytes = encodeCommentsPart([{ ref: "A1", author: "A", texts: [{ text: "x" }] }]);
    for (const record of iterateInterpretableRecords(bytes, "test")) {
      if (recordSpec(record.id)?.name === "BrtCommentText") {
        expect(record.payload[0] & 0x01).toBe(1);
      }
    }
  });

  it("round-trips run segmentation", () => {
    // The runs are where the author's byline ends and the body begins, which is what Excel puts in bold.
    // The fonts are not resolved — that would mean interning into a styles part written later — but
    // losing the *split* would merge the byline into the body.
    const comments = [
      { ref: "A1", author: "Ann", texts: [{ text: "Ann:" }, { text: "\nthe body" }] }
    ];
    const back = readPart(encodeCommentsPart(comments));
    expect(back).toHaveLength(1);
    expect(back[0].texts.map(run => run.text)).toEqual(["Ann:", "\nthe body"]);
  });

  it("substitutes Excel's placeholder for an unknown author index", () => {
    // A malformed `iauthor` costs the byline, not the comment. Dropping the comment over its author
    // would lose the text a person wrote to keep a name they did not.
    const bytes = encodeCommentsPart([{ ref: "A1", author: "", texts: [{ text: "x" }] }]);
    expect(readPart(bytes)[0].author).toBe("Author");
  });
});

describe("comments through a workbook", () => {
  it("round-trips a plain note", async () => {
    const { found } = await roundTrip(workbook => {
      const sheet = Workbook.addWorksheet(workbook, "S");
      Cell.setValue(sheet, "A1", 1);
      Cell.setNote(sheet, "A1", "hello note");
    });
    expect(found.get("A1")).toEqual(["hello note"]);
  });

  it("writes the VML the note box needs, not only the text", async () => {
    // A `comments{N}.bin` on its own opens in Excel with the comment data present and nothing on screen:
    // the box geometry lives in legacy VML, reached through `BrtLegacyDrawing`. Both corpus workbooks
    // that carry comments carry both parts.
    const { bytes } = await roundTrip(workbook => {
      const sheet = Workbook.addWorksheet(workbook, "S");
      Cell.setValue(sheet, "A1", 1);
      Cell.setNote(sheet, "A1", "note");
    });
    const paths = [...(await extractAll(bytes)).keys()];
    expect(paths).toContain("xl/comments1.bin");
    expect(paths).toContain("xl/drawings/vmlDrawing1.vml");
    // And the sheet must point at the VML, or none of it renders.
    const sheetPart = (await extractAll(bytes)).get("xl/worksheets/sheet1.bin")!.data;
    const names = [...iterateInterpretableRecords(sheetPart, "s")].map(
      record => recordSpec(record.id)?.name
    );
    expect(names).toContain("BrtLegacyDrawing");
  });

  it("declares both parts in the content types", async () => {
    // A `.bin` is covered by this writer's own `Default` — with the *workbook's* type. Without an
    // override the comments part is described as a second workbook, which Excel rejects.
    const { bytes } = await roundTrip(workbook => {
      const sheet = Workbook.addWorksheet(workbook, "S");
      Cell.setValue(sheet, "A1", 1);
      Cell.setNote(sheet, "A1", "note");
    });
    const declared = new TextDecoder().decode(
      (await extractAll(bytes)).get("[Content_Types].xml")!.data
    );
    expect(declared).toContain('PartName="/xl/comments1.bin"');
    expect(declared).toContain("application/vnd.ms-excel.comments");
    expect(declared).toContain('Extension="vml"');
  });

  it("round-trips notes on several cells", async () => {
    const { found } = await roundTrip(workbook => {
      const sheet = Workbook.addWorksheet(workbook, "S");
      for (const [address, text] of [
        ["A1", "first"],
        ["C3", "second"],
        ["E5", "third"]
      ] as const) {
        Cell.setValue(sheet, address, 1);
        Cell.setNote(sheet, address, text);
      }
    });
    expect([...found.keys()].sort()).toEqual(["A1", "C3", "E5"]);
    expect(found.get("C3")).toEqual(["second"]);
  });

  it("writes no comments part for a sheet with none", async () => {
    const { bytes } = await roundTrip(workbook => {
      Cell.setValue(Workbook.addWorksheet(workbook, "S"), "A1", 1);
    });
    const paths = [...(await extractAll(bytes)).keys()];
    // An unused `Default Extension="vml"` describes a part the package does not contain.
    expect(paths.some(path => path.includes("comments"))).toBe(false);
    const declared = new TextDecoder().decode(
      (await extractAll(bytes)).get("[Content_Types].xml")!.data
    );
    expect(declared).not.toContain('Extension="vml"');
  });
});

/** Skipped when the corpus is absent, which is how every other corpus test behaves. */
const corpus = (name: string): Uint8Array | undefined => {
  const path = join(XLSB_CORPUS_CACHE, name);
  return existsSync(path) ? new Uint8Array(readFileSync(path)) : undefined;
};

describe.runIf(corpus("poi-comments.xlsb") !== undefined)("against Excel's own bytes", () => {
  it("reads all four comments from poi-comments.xlsb", async () => {
    const parts = await extractAll(corpus("poi-comments.xlsb")!);
    const comments = readPart(parts.get("xl/comments1.bin")!.data);
    expect(comments).toHaveLength(4);
    expect(comments.map(comment => comment.ref)).toEqual(["A1", "A2", "A3", "A4"]);
    // Two authors, and the second comment belongs to the second of them — which is what makes the
    // `iauthor` index worth reading rather than assuming one author per part.
    expect(comments[0].author).toBe("Sven Nissel");
    expect(comments[1].author).toBe("Allison, Timothy B.");
    // Excel's own run split: the byline, then the body.
    expect(comments[1].texts.map(run => run.text)).toEqual([
      "Allison, Timothy B.:",
      "\ncomment row2 (index1)"
    ]);
  });

  it("reads all ten comments from poi-testVarious.xlsb", async () => {
    const parts = await extractAll(corpus("poi-testVarious.xlsb")!);
    expect(readPart(parts.get("xl/comments1.bin")!.data)).toHaveLength(10);
  });

  it("keeps every comment through a read-modify-write", async () => {
    for (const name of ["poi-comments.xlsb", "poi-testVarious.xlsb"] as const) {
      const workbook = Workbook.create();
      await Workbook.read(workbook, corpus(name)!);
      const before = countComments(workbook);
      expect(before, name).toBeGreaterThan(0);
      const written = await Workbook.toBuffer(workbook, {
        format: "xlsb",
        unsupported: "ignore"
      });
      const reopened = Workbook.create();
      await Workbook.read(reopened, written);
      expect(countComments(reopened), name).toBe(before);
    }
  });
});

function countComments(workbook: ReturnType<typeof Workbook.create>): number {
  const model = Workbook.getModel(workbook) as unknown as {
    worksheets: { rows?: { cells?: { comment?: unknown }[] }[] }[];
  };
  return model.worksheets
    .flatMap(sheet => sheet.rows ?? [])
    .flatMap(row => row.cells ?? [])
    .filter(cell => cell.comment !== undefined).length;
}
