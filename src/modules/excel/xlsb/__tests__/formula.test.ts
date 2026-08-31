/**
 * Formulas through XLSB.
 *
 * The interesting property is not that a formula survives — it is *where the work happens*.
 * BIFF12 stores a reverse-polish token stream, so text has to become a tree and back, and
 * this module owns only the token half. `@formula` owns the text half: `tokenize` + `parse`
 * one way, `printAst` the other.
 *
 * That split is what these tests are really asserting. Precedence, associativity and
 * parenthesisation are decided once, in the formula module, and verified there against its
 * own parser. If this file had to reimplement them — which is what building text while
 * walking the token stack requires — a mistake would not produce a syntax error. It would
 * produce a different formula that parses cleanly and computes something else: `=-2^2` is
 * `4` in Excel and `-4` almost everywhere.
 */

import { extractAll } from "@archive/unzip/extract";
import { Cell, DefinedNames, Workbook, Worksheet } from "@excel";
import { expectValidXlsb } from "@excel/__tests__/helpers/expect-valid-xlsb";
import { ExcelNotSupportedError, XlsbParseError } from "@excel/errors";
import { decodePtg, encodePtg, type PtgContext } from "@excel/xlsb/formula/ptg";
import { readSharedStrings, readWorkbookPart, readWorksheetPart } from "@excel/xlsb/read/parts";
import { writeXlsbPackage } from "@excel/xlsb/write/package";
import type { AstNode } from "@formula/syntax/ast";
import { parse } from "@formula/syntax/parser";
import { printAst } from "@formula/syntax/print";
import { tokenize } from "@formula/syntax/tokenizer";
import { describeBiffStream } from "@test/biff-dump";
import { createRng } from "@test/rng";
import { describe, expect, it } from "vitest";

const CONTEXT: PtgContext = {
  sheetNames: ["Sheet1", "Data"],
  definedNames: ["Rate", "Total"]
};

/** Encode a formula and decode it back, returning the text. */
function tokenRoundTrip(source: string, context: PtgContext = CONTEXT): string {
  const ast = parse(tokenize(source));
  const decoded = decodePtg(encodePtg(ast, context, "A1"), context, "A1");
  if ("sharedRow" in decoded) {
    throw new Error(`${source} decoded as a shared-formula reference`);
  }
  return printAst(decoded);
}

/** Assert the tree survives the token round trip, which is the real invariant. */
function expectTokenRoundTrip(source: string): string {
  const original = parse(tokenize(source));
  const text = tokenRoundTrip(source);
  expect(JSON.stringify(parse(tokenize(text))), `${source} → ${text}`).toBe(
    JSON.stringify(original)
  );
  return text;
}

describe("token round trip", () => {
  it("carries literals", () => {
    for (const source of ["1", "42", "3.5", "-7", "0", "TRUE", "FALSE", '"hi"', '""', "#DIV/0!"]) {
      expect(expectTokenRoundTrip(source), source).toBe(source);
    }
  });

  it("carries every absolute-reference combination", () => {
    // The two flag bits mean *relative* when set, an inversion that produces `$A$1` for `A1`
    // if read the obvious way round.
    for (const source of ["A1", "$A1", "A$1", "$A$1", "A1:B2", "$A$1:$B$2", "A1:$B2"]) {
      expect(expectTokenRoundTrip(source), source).toBe(source);
    }
  });

  it("carries sheet-qualified references", () => {
    expect(expectTokenRoundTrip("Sheet1!A1")).toBe("Sheet1!A1");
    expect(expectTokenRoundTrip("Data!A1:B2")).toBe("Data!A1:B2");
  });

  it("carries operators without changing what they mean", () => {
    for (const source of [
      "1+2",
      "A1*2",
      "A1+A2*A3",
      "(A1+A2)*3",
      "2^3^2",
      "-2^2",
      "A1%",
      'A1&"x"',
      "A1>=1",
      "A1<>2",
      "1-2-3",
      "1-(2-3)"
    ]) {
      expect(expectTokenRoundTrip(source), source).toBe(source);
    }
  });

  it("carries function calls, including an omitted argument", () => {
    for (const source of [
      "SUM(A1:A10)",
      "IF(A1>0,1,0)",
      "MAX(A1,A2,A3)",
      "ROUND(A1,2)",
      "TODAY()",
      "SUM(A1:A5)/COUNT(A1:A5)",
      "IF(A1,,0)"
    ]) {
      expect(expectTokenRoundTrip(source), source).toBe(source);
    }
  });

  it("carries defined names by index, so their order is load-bearing", () => {
    expect(expectTokenRoundTrip("Rate*Total")).toBe("Rate*Total");
    // `PtgName` stores a one-based position, so a context listing them differently resolves
    // to a different name — which is why the reader keeps declaration order.
    const swapped: PtgContext = { ...CONTEXT, definedNames: ["Total", "Rate"] };
    expect(tokenRoundTrip("Rate", swapped)).toBe("Rate");
    const encoded = encodePtg(parse(tokenize("Rate")), CONTEXT, "A1");
    const decoded = decodePtg(encoded, swapped, "A1");
    expect("sharedRow" in decoded ? "" : printAst(decoded)).toBe("Total");
  });

  it("carries reference unions and intersections", () => {
    expect(expectTokenRoundTrip("SUM((A1:B2,D4:E5))")).toBe("SUM((A1:B2,D4:E5))");
    expect(expectTokenRoundTrip("A1:B2 B1:C3")).toBe("A1:B2 B1:C3");
  });

  it("flattens a union of more than two areas", () => {
    // The parser builds one node with three members from this text, so the decoder has to
    // fold successive union operators into the same node. Nesting them instead produces a
    // tree that prints identically for two areas and differently for three — which is why
    // two areas cannot pin this.
    const source = "SUM((A1,B1,C1))";
    const ast = parse(tokenize(source)) as { args: { areas?: unknown[] }[] };
    expect(ast.args[0]!.areas).toHaveLength(3);
    expect(expectTokenRoundTrip(source)).toBe(source);
  });

  it("survives generated expressions", () => {
    // The invariant across many inputs. Fixed seeds so a failure names its input.
    const atoms = ["A1", "$B$2", "Sheet1!C3", "A1:B2", "1", "3.5", '"t"', "TRUE", "Rate"];
    const operators = ["+", "-", "*", "/", "^", "&", "=", "<", ">=", "<>"];
    const functions = ["SUM", "IF", "MAX", "ROUND"];

    for (const seed of [1, 7, 42, 1337]) {
      const rng = createRng(seed);
      const build = (depth: number): string => {
        if (depth <= 0 || rng.bool(0.35)) {
          return rng.pick(atoms);
        }
        switch (rng.int(0, 3)) {
          case 0:
            return `${build(depth - 1)}${rng.pick(operators)}${build(depth - 1)}`;
          case 1:
            return `-${build(depth - 1)}`;
          case 2:
            return `(${build(depth - 1)})`;
          default: {
            const args = Array.from({ length: rng.int(1, 3) }, () => build(depth - 1));
            return `${rng.pick(functions)}(${args.join(",")})`;
          }
        }
      };

      for (let iteration = 0; iteration < 80; iteration++) {
        const source = build(rng.int(1, 3));
        let ast;
        try {
          ast = parse(tokenize(source));
        } catch {
          continue;
        }
        let text: string;
        try {
          text = printAst(
            decodePtg(encodePtg(ast, CONTEXT, "A1"), CONTEXT, "A1") as Parameters<
              typeof printAst
            >[0]
          );
        } catch (error) {
          // An unsupported construct is a legitimate outcome; a wrong answer is not.
          expect(error, `seed ${seed}/${iteration}: ${source}`).toBeInstanceOf(
            ExcelNotSupportedError
          );
          continue;
        }
        expect(
          JSON.stringify(parse(tokenize(text))),
          `seed ${seed}, iteration ${iteration}: ${source} → ${text}`
        ).toBe(JSON.stringify(ast));
      }
    }
  });
});

describe("what the codec refuses", () => {
  it("names the construct it cannot encode", () => {
    // The list is the contract. A caller deciding whether XLSB is usable for their workbook
    // needs to know which of these applies to them, so each is named rather than lumped
    // together as "unsupported".
    const cases: readonly (readonly [string, RegExp])[] = [
      ["{1,2;3,4}", /array constant/],
      ["Table1[Col]", /structured reference/],
      ["A:B", /whole-row or whole-column/],
      ["1:3", /whole-row or whole-column/],
      ["NOTAFUNCTION(1)", /function NOTAFUNCTION/],
      ["Unknown", /name Unknown/]
    ];
    for (const [source, expected] of cases) {
      expect(() => encodePtg(parse(tokenize(source)), CONTEXT, "A1"), source).toThrow(expected);
    }
  });

  it("rejects a sheet the workbook does not have", () => {
    expect(() => encodePtg(parse(tokenize("Missing!A1")), CONTEXT, "A1")).toThrow(
      /sheet Missing is not in the workbook/
    );
  });

  it("reports a token stream that does not reduce to one expression", () => {
    // A stack left with two values means the stream is malformed. Returning the top of it
    // would produce a formula that is a fragment of the real one.
    expect(() => decodePtg(Uint8Array.of(0x1e, 1, 0, 0x1e, 2, 0), CONTEXT, "A1")).toThrow(
      XlsbParseError
    );
  });

  it("reports an operator with nothing to operate on", () => {
    expect(() => decodePtg(Uint8Array.of(0x03), CONTEXT, "A1")).toThrow(/operator with no operand/);
  });

  it("reports an unknown token rather than skipping it", () => {
    // Skipping would silently drop part of an expression.
    expect(() => decodePtg(Uint8Array.of(0x7f), CONTEXT, "A1")).toThrow(ExcelNotSupportedError);
  });
});

describe("shared formulas", () => {
  it("reports a PtgExp deferral instead of treating it as an expression", () => {
    // `PtgExp` means the formula lives in another cell. Decoding it as an expression would
    // invent one.
    const tokens = Uint8Array.of(0x01, 4, 0, 0, 0, 2, 0);
    const decoded = decodePtg(tokens, CONTEXT, "C5");
    expect(decoded).toEqual({ sharedRow: 4, sharedColumn: 2 });
  });

  it("rejects a PtgExp that is not alone in the stream", () => {
    expect(() =>
      decodePtg(Uint8Array.of(0x01, 0, 0, 0, 0, 0, 0, 0x1e, 1, 0), CONTEXT, "A1")
    ).toThrow(/must be the only token/);
  });
});

describe("formulas through a whole package", () => {
  it("writes formula cells with their cached results and reads them back", async () => {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "Calc");
    Worksheet.addAoa(sheet, [
      [10, 20],
      [30, 40]
    ]);
    Cell.setValue(sheet, "C1", { formula: "A1+B1", result: 30 });
    Cell.setValue(sheet, "C2", { formula: "SUM(A1:B2)", result: 100 });
    Cell.setValue(sheet, "D1", { formula: 'IF(A1>5,"big","small")', result: "big" });
    Cell.setValue(sheet, "D2", { formula: "A1>B1", result: false });
    Cell.setValue(sheet, "E1", { formula: "ROUND(A1/3,2)", result: 3.33 });

    const written = await writeXlsbPackage(Workbook.getModel(workbook));
    await expectValidXlsb(written.bytes, { includeWarnings: true });
    expect(written.unsupported).toEqual([]);

    const entries = await extractAll(written.bytes);
    const sst = entries.get("xl/sharedStrings.bin");
    const { sheetNames, definedNames } = readWorkbookPart(
      entries.get("xl/workbook.bin")!.data,
      "xl/workbook.bin"
    );
    const read = readWorksheetPart(
      entries.get("xl/worksheets/sheet1.bin")!.data,
      "xl/worksheets/sheet1.bin",
      sst ? readSharedStrings(sst.data, "sst").texts : [],
      { sheetNames, definedNames }
    );

    const byAddress = new Map(
      read.cells.map(cell => [`${String.fromCharCode(65 + cell.column)}${cell.row + 1}`, cell])
    );
    expect(read.undecodedFormulas).toEqual([]);
    expect(byAddress.get("C1")).toMatchObject({ formula: "A1+B1", value: 30 });
    expect(byAddress.get("C2")).toMatchObject({ formula: "SUM(A1:B2)", value: 100 });
    expect(byAddress.get("D1")).toMatchObject({ formula: 'IF(A1>5,"big","small")', value: "big" });
    expect(byAddress.get("D2")).toMatchObject({ formula: "A1>B1", value: false });
    expect(byAddress.get("E1")).toMatchObject({ formula: "ROUND(A1/3,2)", value: 3.33 });
  });

  it("chooses the record by the cached result's type, not the formula's", async () => {
    // A reader skips to the token stream using the cached value's width, so the record has
    // to match the result. Getting this wrong desynchronises every formula cell.
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "Types");
    Cell.setValue(sheet, "A1", { formula: "1+1", result: 2 });
    Cell.setValue(sheet, "A2", { formula: '"a"&"b"', result: "ab" });
    Cell.setValue(sheet, "A3", { formula: "1>2", result: false });

    const written = await writeXlsbPackage(Workbook.getModel(workbook));
    const entries = await extractAll(written.bytes);
    const { describeBiffStream } = await import("@test/biff-dump");
    const listing = describeBiffStream(entries.get("xl/worksheets/sheet1.bin")!.data);
    expect(listing).toMatch(/BrtFmlaNum cell=col=0,style=0 value=2/);
    expect(listing).toMatch(/BrtFmlaString cell=col=0,style=0 value="ab"/);
    expect(listing).toMatch(/BrtFmlaBool cell=col=0,style=0 value=0/);
  });

  it("reports a formula it cannot encode and does not write a misleading value", async () => {
    // Emitting the cached result as a plain number would produce a cell that looks right and
    // never recalculates — the failure mode that makes a converter untrustworthy.
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "Hard");
    Cell.setValue(sheet, "A1", { formula: "MATCH(1,{1,2,3},0)", result: 1 });
    Cell.setValue(sheet, "A2", { formula: "1+1", result: 2 });

    const written = await writeXlsbPackage(Workbook.getModel(workbook));
    await expectValidXlsb(written.bytes, { includeWarnings: true });
    expect(written.unsupported).toEqual(["Hard!A1: formula"]);

    const entries = await extractAll(written.bytes);
    const read = readWorksheetPart(entries.get("xl/worksheets/sheet1.bin")!.data, "sheet1", [], {});
    // A1 survives as a blank cell; A2's formula is intact.
    expect(read.cells.find(cell => cell.row === 0)?.value).toBeNull();
    expect(read.cells.find(cell => cell.row === 1)?.formula).toBe("1+1");
  });

  it("resolves a cross-sheet formula through the workbook's sheet order", async () => {
    const workbook = Workbook.create();
    const first = Workbook.addWorksheet(workbook, "First");
    const second = Workbook.addWorksheet(workbook, "Second");
    Cell.setValue(second, "A1", 7);
    Cell.setValue(first, "A1", { formula: "Second!A1*2", result: 14 });

    const written = await writeXlsbPackage(Workbook.getModel(workbook));
    await expectValidXlsb(written.bytes, { includeWarnings: true });

    const entries = await extractAll(written.bytes);
    const { sheetNames, definedNames } = readWorkbookPart(
      entries.get("xl/workbook.bin")!.data,
      "wb"
    );
    const read = readWorksheetPart(entries.get("xl/worksheets/sheet1.bin")!.data, "sheet1", [], {
      sheetNames,
      definedNames
    });
    expect(read.cells[0]).toMatchObject({ formula: "Second!A1*2", value: 14 });
  });
});

describe("token streams observed in Excel's own output", () => {
  /**
   * Byte-for-byte fixtures taken from Excel-authored workbooks.
   *
   * The strongest test a codec can have, and the only kind that catches a decoder agreeing
   * with its own encoder while disagreeing with the format. Every one of these was read out
   * of a real `.bin` and its expected text checked against the cached value stored beside it
   * in the same record.
   */
  const observed: readonly {
    readonly bytes: readonly number[];
    readonly text: string;
    readonly note: string;
  }[] = [
    {
      // `="a"&"b"`, cached result "ab". Excel stores the `&` as a CONCATENATE call.
      bytes: [0x17, 0x01, 0x00, 0x61, 0x00, 0x17, 0x01, 0x00, 0x62, 0x00, 0x42, 0x02, 0x50, 0x01],
      text: 'CONCATENATE("a","b")',
      note: "two PtgStr and a variable-arity call"
    },
    {
      // `=A1>A2`, cached result FALSE.
      bytes: [
        0x44, 0x00, 0x00, 0x00, 0x00, 0x00, 0xc0, 0x44, 0x01, 0x00, 0x00, 0x00, 0x00, 0xc0, 0x0d
      ],
      text: "A1>A2",
      note: "two reference-class PtgRef and a comparison"
    }
  ];

  it.each(observed)("decodes $note", ({ bytes, text }) => {
    const decoded = decodePtg(Uint8Array.from(bytes), CONTEXT, "A1");
    expect("sharedRow" in decoded ? "<shared>" : printAst(decoded)).toBe(text);
  });

  it("pins PtgStr as a count and UTF-16, with no flag byte", () => {
    // `17 01 00 61 00` is five bytes: the ptg, a count of one, one code unit. Assuming BIFF8's
    // flag byte — the obvious guess, and what an earlier version did — consumes the `61` as
    // the flag and reads `00 17` as the character, producing a plausible string from the
    // wrong bytes and desynchronising everything after it.
    const decoded = decodePtg(Uint8Array.of(0x17, 0x01, 0x00, 0x61, 0x00), CONTEXT, "A1");
    expect(printAst(decoded as Parameters<typeof printAst>[0])).toBe('"a"');
  });

  it("pins CONCATENATE's function id", () => {
    // The id table is data read from the specification, and nothing else in this suite
    // exercises this entry — so a wrong name here would only show up on a real file.
    const tokens = Uint8Array.of(0x17, 0x01, 0x00, 0x78, 0x00, 0x42, 0x01, 0x50, 0x01);
    expect(printAst(decodePtg(tokens, CONTEXT, "A1") as Parameters<typeof printAst>[0])).toBe(
      'CONCATENATE("x")'
    );
  });

  it("pins the relative-reference flag polarity", () => {
    // `24 00000000 0000c0` is `A1`: the two high bits of the column word are *set*, and set
    // means relative. Reading them as "set means absolute" yields `$A$1` for every plain
    // reference — a formula that still parses and no longer fills correctly.
    // `0x44` is `PtgRef` in the reference class, which is what Excel emits.
    const tokens = Uint8Array.of(0x44, 0x00, 0x00, 0x00, 0x00, 0x00, 0xc0);
    expect(printAst(decodePtg(tokens, CONTEXT, "A1") as Parameters<typeof printAst>[0])).toBe("A1");

    // With both bits clear the same bytes are `$A$1`.
    const absolute = Uint8Array.of(0x44, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00);
    expect(printAst(decodePtg(absolute, CONTEXT, "A1") as Parameters<typeof printAst>[0])).toBe(
      "$A$1"
    );
  });
});

describe("3D references and defined names resolve through the tables that carry them", () => {
  /**
   * These closed two bugs of the same shape, and the shape is the one this whole module was built
   * to avoid: a reader and a writer that agree with each other and disagree with Excel, where a
   * round trip cannot tell because it reads back the *cached result* rather than the expression.
   *
   * A `PtgRef3d` carries an `ixti` — an index into `BrtExternSheet` — and a `PtgName` carries an
   * index into the `BrtName` records. Neither table was written. Every cross-sheet reference and
   * every named reference this library produced therefore pointed into nothing.
   */
  it("writes the BrtExternSheet table its own 3D references index", async () => {
    const workbook = Workbook.create();
    const one = Workbook.addWorksheet(workbook, "One");
    const two = Workbook.addWorksheet(workbook, "Two");
    Cell.setValue(two, "A1", 5);
    Cell.setValue(one, "A1", { formula: "Two!A1*2", result: 10 });

    const entries = await extractAll(await Workbook.toBuffer(workbook, { format: "xlsb" }));
    const listing = describeBiffStream(entries.get("xl/workbook.bin")!.data);
    expect(listing).toContain("BrtSupSelf");
    expect(listing).toContain("BrtExternSheet");
    // One entry per sheet, so `ixti = sheet position` holds by construction.
    expect(listing).toContain("BrtExternSheet count=2");
  });

  it("writes the BrtName table its own PtgName indexes", async () => {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "S1");
    Cell.setValue(sheet, "A1", 10);
    DefinedNames.add(Workbook.getDefinedNames(workbook), "S1!$A$1", "MyRate");
    Cell.setValue(sheet, "B1", { formula: "MyRate*2", result: 20 });

    const entries = await extractAll(await Workbook.toBuffer(workbook, { format: "xlsb" }));
    expect(describeBiffStream(entries.get("xl/workbook.bin")!.data)).toContain('name="MyRate"');
  });

  it("round-trips a cross-sheet reference and a named reference as expressions", async () => {
    // The assertion that would have failed before: the formula, not the cached number.
    const source = Workbook.create();
    const one = Workbook.addWorksheet(source, "One");
    const two = Workbook.addWorksheet(source, "Two");
    Cell.setValue(two, "A1", 5);
    Cell.setValue(two, "A2", 7);
    DefinedNames.add(Workbook.getDefinedNames(source), "Two!$A$1:$A$2", "Vals");
    Cell.setValue(one, "A1", { formula: "SUM(Two!A1:A2)", result: 12 });
    Cell.setValue(one, "A2", { formula: "SUM(Vals)", result: 12 });

    const reopened = Workbook.create();
    await Workbook.read(reopened, await Workbook.toBuffer(source, { format: "xlsb" }));
    const read = Workbook.getWorksheets(reopened)[0]!;
    expect(Cell.getValue(read, "A1")).toMatchObject({ formula: "SUM(Two!A1:A2)" });
    expect(Cell.getValue(read, "A2")).toMatchObject({ formula: "SUM(Vals)" });
    expect(DefinedNames.getAllEntries(Workbook.getDefinedNames(reopened))).toEqual([
      { name: "Vals", ranges: ["Two!$A$1:$A$2"] }
    ]);
  });

  it("resolves ixti through the table rather than as a sheet index", () => {
    // Exactly the shape `issues.xlsb` carries: the table's second entry names the *third* sheet,
    // so `ixti = 1` must not mean the second. Reading it as a sheet index silently retargets the
    // reference to a real, wrong sheet — which is why this is asserted rather than assumed.
    const tokens = new Uint8Array([0x3a, 0x01, 0x00, 0, 0, 0, 0, 0x00, 0x00]);
    const context = {
      sheetNames: ["datatypes", "issue2", "Sheet1"],
      externSheets: [
        { first: 0, last: 0 },
        { first: 2, last: 2 }
      ]
    };
    const decoded = decodePtg(tokens, context, "test");
    expect("sharedRow" in decoded).toBe(false);
    expect(printAst(decoded as AstNode)).toBe("Sheet1!$A$1");

    // Without the table the identity mapping stands, which is what this library's own output
    // means and what a file with no `BrtExternSheet` implies.
    const identity = decodePtg(tokens, { sheetNames: context.sheetNames }, "test");
    expect(printAst(identity as AstNode)).toBe("issue2!$A$1");
  });
});

describe("a formula the encoder refuses", () => {
  it("keeps the cell's formatting, losing only the expression", async () => {
    // The rejection branch used to read `styleIndex` back off the un-interned cell, where it is
    // never populated, so it always fell back to 0 — the "no formatting" entry. A cell whose
    // formula could not be encoded therefore lost its number format and font as well, which is
    // two silent losses reported as one.
    const source = Workbook.create();
    const sheet = Workbook.addWorksheet(source, "S1");
    Cell.setValue(sheet, "A1", { formula: "NoSuchNameAnywhere+1", result: 1 });
    Cell.setStyle(sheet, "A1", { numFmt: "0.00%", font: { bold: true } });

    const reopened = Workbook.create();
    await Workbook.read(
      reopened,
      await Workbook.toBuffer(source, { format: "xlsb", unsupported: "ignore" })
    );
    const style = Cell.getStyle(Workbook.getWorksheets(reopened)[0]!, "A1");
    expect(style?.numFmt).toBe("0.00%");
    expect(style?.font?.bold).toBe(true);
  });

  it("still reports the cell and the reason", async () => {
    const source = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(source, "S1"), "A1", {
      formula: "NoSuchNameAnywhere+1",
      result: 1
    });
    await expect(Workbook.toBuffer(source, { format: "xlsb" })).rejects.toThrow(/S1!A1: formula/);
  });
});

describe("a formula's cached result", () => {
  it("keeps a date-valued result as a date", async () => {
    // Found by putting every XLSX example's workbook through XLSB and comparing the two readings.
    // A `Date` cached result was dropped to null on the way in and written as `BrtFmlaNum` zero,
    // so a formula whose answer is a date read back as 1899-12-30 — the epoch, which is a
    // plausible-looking date rather than an error, and was not reported.
    const when = new Date(Date.UTC(2024, 5, 1));
    const source = Workbook.create();
    const sheet = Workbook.addWorksheet(source, "S");
    Cell.setValue(sheet, "A1", { formula: "TODAY()", result: when });
    Cell.setStyle(sheet, "A1", { numFmt: "yyyy-mm-dd" });

    const reopened = Workbook.create();
    await Workbook.read(reopened, await Workbook.toBuffer(source, { format: "xlsb" }));
    const value = Cell.getValue(Workbook.getWorksheets(reopened)[0]!, "A1");
    expect(value).toMatchObject({ formula: "TODAY()" });
    expect((value as { result: Date }).result).toBeInstanceOf(Date);
    expect((value as { result: Date }).result.toISOString()).toBe(when.toISOString());
  });

  it("keeps a date-valued result against the 1904 epoch too", async () => {
    // The serial has to come from the workbook's epoch, for the same reason a literal date cell's
    // does — a shared helper rather than a second copy of the arithmetic.
    const when = new Date(Date.UTC(2024, 5, 1));
    const source = Workbook.create();
    source.properties = { ...source.properties, date1904: true };
    const sheet = Workbook.addWorksheet(source, "S");
    Cell.setValue(sheet, "A1", { formula: "TODAY()", result: when });
    Cell.setStyle(sheet, "A1", { numFmt: "yyyy-mm-dd" });

    const reopened = Workbook.create();
    await Workbook.read(reopened, await Workbook.toBuffer(source, { format: "xlsb" }));
    const value = Cell.getValue(Workbook.getWorksheets(reopened)[0]!, "A1");
    expect((value as { result: Date }).result.toISOString()).toBe(when.toISOString());
  });

  it("round-trips the result types it could already carry", async () => {
    const source = Workbook.create();
    const sheet = Workbook.addWorksheet(source, "S");
    Cell.setValue(sheet, "A1", { formula: "1+1", result: 2 });
    Cell.setValue(sheet, "A2", { formula: "1>2", result: false });
    Cell.setValue(sheet, "A3", { formula: '"a"&"b"', result: "ab" });

    const reopened = Workbook.create();
    await Workbook.read(reopened, await Workbook.toBuffer(source, { format: "xlsb" }));
    const read = Workbook.getWorksheets(reopened)[0]!;
    expect(Cell.getValue(read, "A1")).toMatchObject({ result: 2 });
    expect(Cell.getValue(read, "A2")).toMatchObject({ result: false });
    expect(Cell.getValue(read, "A3")).toMatchObject({ result: "ab" });
  });
});

/**
 * A reference across a span of sheets — `Sheet1:Sheet3!A1`.
 *
 * The decoder has always read a `BrtExternSheet` entry whose `itabFirst` and `itabLast` differ as a span;
 * the encoder ignored `endSheet` and emitted the entry for the *first* sheet, so `SUM(Sheet1:Sheet3!A1)`
 * was written as `SUM(Sheet1!A1)`. That is not a fidelity loss but a **different answer**, and a round
 * trip could not see it because it compared the cached result.
 *
 * The entry layout is established from Excel's output (`issues.xlsb` carries `{0,0}` and `{2,2}`); what is
 * inferred is that a differing pair means a span, which `INFERRED_VALUES.externSheetSpan` records.
 */
describe("3D sheet spans", () => {
  it("round-trips the whole span rather than its first sheet", async () => {
    const workbook = Workbook.create();
    for (const name of ["S1", "S2", "S3"]) {
      Cell.setValue(Workbook.addWorksheet(workbook, name), "A1", 10);
    }
    Cell.setValue(Workbook.getWorksheet(workbook, "S1")!, "C1", {
      formula: "SUM(S1:S3!A1)",
      result: 30
    } as never);

    const reopened = Workbook.create();
    await Workbook.read(reopened, await Workbook.toBuffer(workbook, { format: "xlsb" }));
    expect(Cell.getFormula(Workbook.getWorksheet(reopened, "S1")!, "C1")).toBe("SUM(S1:S3!A1)");
  });

  it("appends the span entry without disturbing the identity table", async () => {
    // The identity mapping is what makes `ixti = sheet position` true for an ordinary 3D reference, so a
    // span has to be *added* rather than replace anything.
    const workbook = Workbook.create();
    for (const name of ["S1", "S2", "S3"]) {
      Cell.setValue(Workbook.addWorksheet(workbook, name), "A1", 1);
    }
    const sheet = Workbook.getWorksheet(workbook, "S1")!;
    Cell.setValue(sheet, "B1", { formula: "S3!A1", result: 1 } as never);
    Cell.setValue(sheet, "C1", { formula: "SUM(S1:S3!A1)", result: 3 } as never);

    const reopened = Workbook.create();
    await Workbook.read(reopened, await Workbook.toBuffer(workbook, { format: "xlsb" }));
    const read = Workbook.getWorksheet(reopened, "S1")!;
    expect(Cell.getFormula(read, "B1")).toBe("S3!A1");
    expect(Cell.getFormula(read, "C1")).toBe("SUM(S1:S3!A1)");
  });
});
