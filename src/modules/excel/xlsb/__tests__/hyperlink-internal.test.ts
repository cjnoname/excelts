import { extractAll } from "@archive/unzip/extract";
import { Cell, Workbook } from "@excel/index";
import { iterateInterpretableRecords } from "@excel/xlsb/binary";
import { recordSpec } from "@excel/xlsb/spec/records";
import { describe, expect, it } from "vitest";

/**
 * An internal hyperlink carries its destination in `BrtHLink`'s location field and has **no relationship**.
 *
 * This writer used to allocate a relationship for every link, so `#Linked!A1` went out as an *external* relationship
 * target — a link that navigated nowhere, in a file that opened cleanly and round-tripped through this library's own
 * reader without complaint. The comment in the writer asserted that "the destination is the relationship", justified by
 * both corpus files carrying an empty location; both corpus files hold only external links, so that was a true
 * observation about a biased sample.
 *
 * The assertions below read the emitted bytes rather than re-reading the workbook, because a reader that shares the
 * writer's assumption would confirm it.
 */
async function sheetRecords(bytes: Uint8Array): Promise<{
  readonly links: readonly { idLength: number; location: string }[];
  readonly relTargets: readonly string[];
}> {
  const parts = await extractAll(bytes);
  const sheetPath = [...parts.keys()].find(name => /worksheets\/sheet1\.bin$/.test(name));
  const links: { idLength: number; location: string }[] = [];
  for (const record of iterateInterpretableRecords(parts.get(sheetPath!)!.data, "s")) {
    if (recordSpec(record.id)?.name !== "BrtHLink") {
      continue;
    }
    // Payload: RfX (16 bytes), then relationship id, location, tooltip and display as `XLWideString`s —
    // each a `u32` character count followed by UTF-16LE.
    const view = new DataView(
      record.payload.buffer,
      record.payload.byteOffset,
      record.payload.length
    );
    const idLength = view.getUint32(16, true);
    let offset = 20 + idLength * 2;
    const locationLength = view.getUint32(offset, true);
    offset += 4;
    let location = "";
    for (let index = 0; index < locationLength; index += 1) {
      location += String.fromCharCode(view.getUint16(offset + index * 2, true));
    }
    links.push({ idLength, location });
  }
  const relsPath = [...parts.keys()].find(name =>
    /worksheets\/_rels\/sheet1\.bin\.rels$/.test(name)
  );
  const rels = relsPath === undefined ? "" : new TextDecoder().decode(parts.get(relsPath)!.data);
  return {
    links,
    relTargets: [...rels.matchAll(/Type="[^"]*\/hyperlink"[^>]*Target="([^"]+)"/g)].map(
      match => match[1]!
    )
  };
}

async function written(): Promise<Uint8Array> {
  const workbook = Workbook.create();
  const sheet = Workbook.addWorksheet(workbook, "Sheet1");
  Workbook.addWorksheet(workbook, "Linked");
  Cell.setValue(sheet, "A1", {
    text: "Outside",
    hyperlink: "https://example.invalid/one"
  });
  Cell.setValue(sheet, "A2", { text: "Inside", hyperlink: "#Linked!A1" });
  return Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" });
}

describe("BrtHLink, internal versus external", () => {
  it("writes an internal link's destination in the location field", async () => {
    const { links } = await sheetRecords(await written());
    const internal = links.filter(link => link.idLength === 0);
    expect(internal).toHaveLength(1);
    expect(internal[0]!.location).toBe("Linked!A1");
  });

  it("gives an internal link no relationship id", async () => {
    // The `#` form used to become `rId{N}`, which is the defect: an id implies a relationship, and the relationship
    // declared the fragment as an external URL.
    const { links } = await sheetRecords(await written());
    expect(links.filter(link => link.idLength === 0)).toHaveLength(1);
  });

  it("declares only the external link in the sheet's relationships", async () => {
    const { relTargets } = await sheetRecords(await written());
    expect(relTargets).toEqual(["https://example.invalid/one"]);
  });

  it("reads an internal link back as the fragment it wrote", async () => {
    // **The byte assertions above passed while this was broken.** The writer put `Linked!A1` in the location field and
    // no relationship, exactly as it should; the *reader* then treated "no relationship" as "unresolvable" and dropped
    // the link, reporting `hyperlink to Linked!A1` as a loss. So a link this library wrote correctly did not survive
    // being read by this library — which the writer-side tests could not see, and which is the reason this case reads
    // the workbook back instead.
    const reopened = Workbook.create();
    const report = await Workbook.readWithDiagnostics(reopened, await written());
    const sheet = Workbook.getWorksheet(reopened, "Sheet1")!;
    expect(Cell.getValue(sheet, "A2")).toEqual({ text: "Inside", hyperlink: "#Linked!A1" });
    // And the external one still resolves through its relationship.
    expect(Cell.getValue(sheet, "A1")).toEqual({
      text: "Outside",
      hyperlink: "https://example.invalid/one"
    });
    expect(report.lost.filter(entry => entry.includes("hyperlink"))).toEqual([]);
  });

  it("still writes an external link through a relationship, with an empty location", async () => {
    // The fix must not swing the other way: an external link's destination does not belong in `location`.
    const { links } = await sheetRecords(await written());
    const external = links.filter(link => link.idLength > 0);
    expect(external).toHaveLength(1);
    expect(external[0]!.location).toBe("");
  });
});
