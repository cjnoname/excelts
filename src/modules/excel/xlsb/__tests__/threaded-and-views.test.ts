import { extractAll } from "@archive/unzip/extract";
/**
 * Threaded comments and multiple sheet views.
 *
 * These two came off the loss list for opposite reasons, and the contrast is the point.
 *
 * A threaded comment has **no BIFF12 form at all** — the part is XML in both containers — so supporting
 * it meant writing the XLSX renderer's output into the package and adding two relationships. Nothing was
 * translated. A second *sheet view*, by contrast, needed no new machinery either, but for the opposite
 * reason: `BrtBeginWsViews` is a collection and the writer was emitting one record with `iWbkView`
 * hard-coded to 0.
 */
import { Cell, Workbook } from "@excel";
import { worksheetView } from "@excel/xlsb/defaults";
import { describe, expect, it } from "vitest";

describe("threaded comments", () => {
  /** A workbook with one threaded comment and the author it names. */
  function build() {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "S");
    Cell.setValue(sheet, "A1", 1);
    const model = Workbook.getModel(workbook);
    (model as unknown as Record<string, unknown>).persons = [
      {
        id: "{11111111-1111-1111-1111-111111111111}",
        displayName: "Ann",
        userId: "ann@example.com",
        providerId: "None"
      }
    ];
    (model.worksheets[0] as unknown as Record<string, unknown>).threadedComments = [
      {
        ref: "A1",
        comment: {
          id: "{22222222-2222-2222-2222-222222222222}",
          personId: "{11111111-1111-1111-1111-111111111111}",
          text: "first note",
          date: "2024-01-01T00:00:00Z"
        }
      }
    ];
    Workbook.setModel(workbook, model);
    return workbook;
  }

  it("writes both parts and declares both types", async () => {
    const bytes = await Workbook.toBuffer(build(), { format: "xlsb" });
    const parts = await extractAll(bytes);
    expect([...parts.keys()]).toContain("xl/threadedComments/threadedComment1.xml");
    // The author list is workbook-level, not per sheet — a comment's `personId` resolves through it, and
    // without it the comment is present and attributed to nobody.
    expect([...parts.keys()]).toContain("xl/persons/person.xml");
    const declared = new TextDecoder().decode(parts.get("[Content_Types].xml")!.data);
    expect(declared).toContain("application/vnd.ms-excel.threadedcomments+xml");
    expect(declared).toContain("application/vnd.ms-excel.person+xml");
  });

  it("keeps the personId a comment names, rather than minting a new one", async () => {
    // `registerPerson` mints a fresh GUID. Using it on read would leave every comment pointing at an id
    // no person carries, which is the outcome reading the part was meant to prevent.
    const reopened = Workbook.create();
    await Workbook.read(reopened, await Workbook.toBuffer(build(), { format: "xlsb" }));
    const model = Workbook.getModel(reopened);
    expect((model as unknown as { persons?: { id: string }[] }).persons?.[0]?.id).toBe(
      "{11111111-1111-1111-1111-111111111111}"
    );
    const comments = (
      model.worksheets[0] as unknown as {
        threadedComments?: { comment: { personId: string; text: string } }[];
      }
    ).threadedComments;
    expect(comments?.[0]?.comment.personId).toBe("{11111111-1111-1111-1111-111111111111}");
    expect(comments?.[0]?.comment.text).toBe("first note");
  });

  it("writes neither part for a workbook with none", async () => {
    const workbook = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(workbook, "S"), "A1", 1);
    const paths = [
      ...(await extractAll(await Workbook.toBuffer(workbook, { format: "xlsb" }))).keys()
    ];
    expect(paths.some(path => path.includes("threadedComment") || path.includes("person"))).toBe(
      false
    );
  });
});

describe("multiple sheet views", () => {
  it("names the workbook view each sheet view belongs to", () => {
    // `iWbkView` is the last field of the record. Zero for the only view, and the *position* for a
    // second — writing 0 for all of them is what made a second view unwritable rather than unwritten.
    const first = worksheetView({}, 0);
    const second = worksheetView({}, 1);
    expect(new DataView(first.buffer, first.byteOffset).getUint32(26, true)).toBe(0);
    expect(new DataView(second.buffer, second.byteOffset).getUint32(26, true)).toBe(1);
  });

  it("round-trips two views", async () => {
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "S", {
      views: [
        { state: "normal", showGridLines: false },
        { state: "normal", zoomScale: 150 }
      ]
    } as never);
    Cell.setValue(sheet, "A1", 1);
    const reopened = Workbook.create();
    await Workbook.read(reopened, await Workbook.toBuffer(workbook, { format: "xlsb" }));
    expect(
      (Workbook.getModel(reopened).worksheets[0] as unknown as { views?: unknown[] }).views
    ).toEqual([
      { state: "normal", showGridLines: false },
      { state: "normal", zoomScale: 150 }
    ]);
  });

  it("puts the pane on the first view only", async () => {
    // The model holds one pane per *sheet*, not one per view. Repeating it in every view would invent a
    // claim the model does not make.
    const workbook = Workbook.create();
    const sheet = Workbook.addWorksheet(workbook, "S", {
      views: [
        { state: "frozen", ySplit: 1 },
        { state: "normal", zoomScale: 150 }
      ]
    } as never);
    Cell.setValue(sheet, "A1", 1);
    const bytes = await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" });
    const { iterateInterpretableRecords } = await import("@excel/xlsb/binary");
    const { recordSpec } = await import("@excel/xlsb/spec/records");
    const sheetPart = (await extractAll(bytes)).get("xl/worksheets/sheet1.bin")!.data;
    const names = [...iterateInterpretableRecords(sheetPart, "s")].map(
      entry => recordSpec(entry.id)?.name
    );
    expect(names.filter(name => name === "BrtBeginWsView")).toHaveLength(2);
    expect(names.filter(name => name === "BrtPane")).toHaveLength(1);
  });
});
