import { extractAll } from "@archive/unzip/extract";
/**
 * User-drawn shapes.
 *
 * **A shape needed no new record.** It is an anchor inside the sheet's one drawing part, beside its
 * pictures — which is why `BrtDrawing` is a single relationship id rather than a collection. The reason
 * the XLSB writer had none was that `drawingForWorksheet` filtered for `type === "image"` and returned
 * early when there were none, and the sixty lines of anchoring arithmetic lived inside the XLSX worksheet
 * xform where nothing else could reach them.
 *
 * Those lines are now `buildShapeAnchors` in `utils/drawing-utils`, and **both writers call it** — which
 * is the part worth testing, because the three anchoring modes are dispatched on which fields are
 * *present* rather than on a discriminator, so two implementations would diverge silently.
 */
import { Cell, Form, Image, Workbook } from "@excel";
import { buildShapeAnchors } from "@excel/utils/drawing-utils";
import { describe, expect, it } from "vitest";

describe("buildShapeAnchors", () => {
  it("dispatches the three anchoring modes on which fields are present", () => {
    const anchors = buildShapeAnchors(
      [
        { anchorRange: { pos: { x: 1 }, ext: { width: 10, height: 10 } } },
        { anchorRange: { tl: { nativeCol: 0 }, br: { nativeCol: 2 } } },
        { anchorRange: { tl: { nativeCol: 0 }, ext: { width: 10, height: 10 } } }
      ],
      0
    );
    // `pos` present → absolute; `br` present → two-cell; neither → one-cell, which needs `ext` because
    // there is no second corner to size it from.
    expect((anchors[0] as { range: { editAs: string } }).range.editAs).toBe("absolute");
    expect((anchors[1] as { range: { br?: unknown } }).range.br).toBeDefined();
    expect((anchors[2] as { range: { ext?: unknown } }).range.ext).toBeDefined();
  });

  it("numbers cNvPrId past the anchors already in the drawing", () => {
    // Image and chart ids derive from their anchor position, so a shape numbering itself from 1 would
    // collide with the first picture in the same part.
    const anchors = buildShapeAnchors([{ anchorRange: { tl: {}, br: {} } }], 3);
    expect((anchors[0] as unknown as { shape: { cNvPrId: number } }).shape.cNvPrId).toBe(4);
  });

  it("skips a shape with no anchor rather than writing one with no position", () => {
    expect(buildShapeAnchors([{ name: "Floating" }], 0)).toEqual([]);
  });
});

describe("shapes through an XLSB workbook", () => {
  /** A workbook with one shape. */
  function build() {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "S");
    Cell.setValue(sheet, "A1", 1);
    Image.addShape(sheet, {
      range: "B2:D5",
      shapeType: "rect",
      name: "Box",
      text: "hello",
      fillColor: "FFFF0000"
    } as never);
    return workbook;
  }

  it("writes a drawing for a sheet with shapes and no pictures", async () => {
    // The early return on an empty media list is what used to stop this: a shape shares the drawing with
    // pictures, so a sheet with shapes and none of them still needs the part.
    const parts = await extractAll(await Workbook.toBuffer(build(), { format: "xlsb" }));
    expect([...parts.keys()]).toContain("xl/drawings/drawing1.xml");
    const xml = new TextDecoder().decode(parts.get("xl/drawings/drawing1.xml")!.data);
    expect(xml).toContain("Box");
    expect(xml).toContain("hello");
    expect(xml).toContain("FF0000");
  });

  it("names the drawing from the sheet, so Excel can reach it", async () => {
    const parts = await extractAll(await Workbook.toBuffer(build(), { format: "xlsb" }));
    const { iterateInterpretableRecords } = await import("@excel/xlsb/binary");
    const { recordSpec } = await import("@excel/xlsb/spec/records");
    const names = [
      ...iterateInterpretableRecords(parts.get("xl/worksheets/sheet1.bin")!.data, "s")
    ].map(entry => recordSpec(entry.id)?.name);
    // Without `BrtDrawing` the part is present with nothing pointing at it, which Excel offers to repair.
    expect(names).toContain("BrtDrawing");
    const rels = new TextDecoder().decode(parts.get("xl/worksheets/_rels/sheet1.bin.rels")!.data);
    expect(rels).toContain("../drawings/drawing1.xml");
  });

  it("keeps every shape byte through a read-modify-write", async () => {
    // The asymmetry worth pinning: this reader does not *model* drawings, so it preserves the part
    // verbatim. `Image.getShapes` on the reopened workbook returns nothing, and the shapes are still in
    // the file — asserting the bytes is what distinguishes "not modelled" from "lost".
    const first = await Workbook.toBuffer(build(), { format: "xlsb" });
    const reopened = Workbook.create();
    await Workbook.read(reopened, first);
    const second = await Workbook.toBuffer(reopened, { format: "xlsb" });
    const drawingOf = async (bytes: Uint8Array): Promise<string> =>
      new TextDecoder().decode((await extractAll(bytes)).get("xl/drawings/drawing1.xml")!.data);
    expect(await drawingOf(second)).toBe(await drawingOf(first));
    expect(Image.getShapes(Workbook.getWorksheet(reopened, "S")!)).toEqual([]);
  });

  it("no longer reports a shape as a loss", async () => {
    // The default is to refuse, so this is the behaviour that changed.
    await expect(Workbook.toBuffer(build(), { format: "xlsb" })).resolves.toBeDefined();
  });
});

describe("form controls", () => {
  /** A workbook with one checkbox. */
  function build() {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "S");
    Cell.setValue(sheet, "A1", 1);
    Form.addCheckbox(sheet, "B2:C3" as never, { text: "Agree", checked: true } as never);
    return workbook;
  }

  it("writes all three parts a control needs", async () => {
    // A control is three things: a hidden DrawingML anchor bridging to a VML shape, the VML that draws it,
    // and an `xl/ctrlProps/ctrlPropN.xml` holding its properties. Omitting any one leaves a sheet Excel
    // offers to repair.
    const paths = [
      ...(await extractAll(await Workbook.toBuffer(build(), { format: "xlsb" }))).keys()
    ];
    expect(paths).toContain("xl/drawings/drawing1.xml");
    expect(paths).toContain("xl/drawings/vmlDrawing1.vml");
    expect(paths).toContain("xl/ctrlProps/ctrlProp1.xml");
  });

  it("declares all three relationships from the sheet", async () => {
    const parts = await extractAll(await Workbook.toBuffer(build(), { format: "xlsb" }));
    const rels = new TextDecoder().decode(parts.get("xl/worksheets/_rels/sheet1.bin.rels")!.data);
    const types = [...rels.matchAll(/Type="[^"]*\/(\w+)"/g)].map(match => match[1]);
    // The `vmlDrawing` one is the case that was wrong first: it was emitted only when the sheet had
    // *comments*, so a checkbox on a sheet with none reached Excel with its VML unreferenced.
    expect(types).toContain("drawing");
    expect(types).toContain("vmlDrawing");
    expect(types).toContain("ctrlProp");
  });

  it("names the VML from the sheet through BrtLegacyDrawing", async () => {
    const parts = await extractAll(await Workbook.toBuffer(build(), { format: "xlsb" }));
    const { iterateInterpretableRecords } = await import("@excel/xlsb/binary");
    const { recordSpec } = await import("@excel/xlsb/spec/records");
    const names = [
      ...iterateInterpretableRecords(parts.get("xl/worksheets/sheet1.bin")!.data, "s")
    ].map(entry => recordSpec(entry.id)?.name);
    expect(names).toContain("BrtLegacyDrawing");
    // And the DrawingML drawing too, because the hidden bridge anchors live in it.
    expect(names).toContain("BrtDrawing");
  });

  it("shares one VML file between a note and a control", async () => {
    // Excel writes a single `vmlDrawing{N}.vml` per sheet holding both, and the sheet has one
    // `BrtLegacyDrawing` — so writing two files would leave one of them unreachable.
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "S");
    Cell.setValue(sheet, "A1", 1);
    Cell.setNote(sheet, "A1", "a note");
    Form.addCheckbox(sheet, "B2:C3" as never, { text: "Agree" } as never);
    const parts = await extractAll(await Workbook.toBuffer(workbook, { format: "xlsb" }));
    expect([...parts.keys()].filter(path => path.includes("vmlDrawing"))).toHaveLength(1);
    const rels = new TextDecoder().decode(parts.get("xl/worksheets/_rels/sheet1.bin.rels")!.data);
    expect(rels.match(/vmlDrawing"/g) ?? []).toHaveLength(1);
    // The VML carries the control's caption; a note's *text* is in `comments1.bin`, not here — the VML
    // holds only the box.
    const vml = new TextDecoder().decode(parts.get("xl/drawings/vmlDrawing1.vml")!.data);
    expect(vml).toContain("Agree");
    expect(parts.has("xl/comments1.bin")).toBe(true);
  });

  it("numbers ctrlProp parts across the workbook, not within a sheet", async () => {
    // Two sheets each with one control would otherwise both write `ctrlProp1.xml`.
    const workbook = Workbook.create();
    for (const name of ["S1", "S2"] as const) {
      const sheet = Workbook.addWorksheet(workbook, name);
      Cell.setValue(sheet, "A1", 1);
      Form.addCheckbox(sheet, "B2:C3" as never, { text: name } as never);
    }
    const paths = [
      ...(await extractAll(await Workbook.toBuffer(workbook, { format: "xlsb" }))).keys()
    ];
    expect(paths.filter(path => path.startsWith("xl/ctrlProps/")).sort()).toEqual([
      "xl/ctrlProps/ctrlProp1.xml",
      "xl/ctrlProps/ctrlProp2.xml"
    ]);
  });

  it("no longer reports a form control as a loss", async () => {
    await expect(Workbook.toBuffer(build(), { format: "xlsb" })).resolves.toBeDefined();
  });
});
