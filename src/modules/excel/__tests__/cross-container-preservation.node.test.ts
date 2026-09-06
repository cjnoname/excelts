/**
 * A preserved part survives a change of container, and a container-specific one does not.
 *
 * **Both halves are needed, and having only the first made things worse.** Each writer decided whether a preserved
 * part's inbound edge came "from the workbook" by comparing against *its own* container's path — `xl/workbook.xml` in
 * the XLSX writer, `xl/workbook.bin` in the XLSB one. So a part read from one container and written to the other had no
 * recognised inbound edge, was judged an orphan, and was dropped.
 *
 * Measured on `cal-any_sheets.xlsb`: its theme states `accent1 = 5B9BD5`, and the XLSX conversion carried the built-in
 * `4472C4` — the preserved theme dropped, the default written in its place. Every cell whose colour is a `{ theme: n }`
 * index therefore rendered in a different colour, with nothing reported.
 *
 * Recognising the edge then kept alive the one part that must *not* travel — `xl/chartsheets/sheet1.bin`, content type
 * `application/vnd.ms-excel.chartsheet`, a BIFF12 record stream inside a SpreadsheetML package — and surfaced a second
 * defect behind it: `ContentTypesXform` declares `xl/theme/theme1.xml` unconditionally, so a *preserved* theme was
 * declared twice and the writer's own validator refused the package with `content-types-duplicate-override`. That could
 * not happen before, because a preserved theme never reached an XLSX write.
 */
import { readFile } from "node:fs/promises";

import { extractAll } from "@archive/unzip/extract";
import { Workbook } from "@excel";
import { describe, expect, it } from "vitest";

const FIXTURE = "tmp/xlsb-corpus/cal-any_sheets.xlsb";

/** The fixture's bytes, or `undefined` when the corpus has not been fetched. */
async function fixture(): Promise<Uint8Array | undefined> {
  try {
    return Uint8Array.from(await readFile(FIXTURE));
  } catch {
    return undefined;
  }
}

/** Decoded text of one part. */
function text(parts: Awaited<ReturnType<typeof extractAll>>, path: string): string {
  return new TextDecoder().decode(parts.get(path)!.data);
}

describe("preserved parts crossing containers", () => {
  it("refuses the conversion by default, because the chartsheet is a real loss", async () => {
    const bytes = await fixture();
    if (bytes === undefined) {
      return;
    }
    // **`unsupported` defaults to `"error"` and used to be inert for XLSX.** The one thing an XLSX write cannot carry is
    // a preserved sheet part from the other container — this fixture's `xl/chartsheets/sheet1.bin` — so a caller
    // converting it now learns rather than discovering an empty tab in Excel. Every case below passes `"ignore"`, which
    // is the same decision made explicitly.
    const workbook = Workbook.create();
    await Workbook.read(workbook, bytes);
    await expect(Workbook.toBuffer(workbook, { format: "xlsx" })).rejects.toThrow(
      /preserved sheet part from the other container/
    );
  });

  it("keeps the workbook's own theme instead of substituting the built-in one", async () => {
    const bytes = await fixture();
    if (bytes === undefined) {
      return;
    }
    const original = text(await extractAll(bytes), "xl/theme/theme1.xml");
    const workbook = Workbook.create();
    await Workbook.read(workbook, bytes);
    const converted = await extractAll(
      await Workbook.toBuffer(workbook, { format: "xlsx", unsupported: "ignore" })
    );
    // Byte-for-byte, not merely "a theme is present": the failure this replaces produced a perfectly valid theme that
    // was the wrong one.
    expect(text(converted, "xl/theme/theme1.xml")).toBe(original);
    // And the accent that made it visible, asserted by value so a future default cannot quietly match.
    expect(original).toContain('<a:srgbClr val="5B9BD5"/>');
  });

  it("declares the theme exactly once", async () => {
    const bytes = await fixture();
    if (bytes === undefined) {
      return;
    }
    const workbook = Workbook.create();
    await Workbook.read(workbook, bytes);
    const converted = await extractAll(
      await Workbook.toBuffer(workbook, { format: "xlsx", unsupported: "ignore" })
    );
    const contentTypes = text(converted, "[Content_Types].xml");
    expect(contentTypes.match(/theme1\.xml/g) ?? []).toHaveLength(1);
  });

  it("does not carry a BIFF12 sheet part into a SpreadsheetML package", async () => {
    const bytes = await fixture();
    if (bytes === undefined) {
      return;
    }
    const workbook = Workbook.create();
    await Workbook.read(workbook, bytes);
    const converted = await extractAll(
      await Workbook.toBuffer(workbook, { format: "xlsx", unsupported: "ignore" })
    );
    expect([...converted.keys()].filter(name => name.endsWith(".bin"))).toEqual([]);
    // Nor may its content type be declared for a part that is not there.
    expect(text(converted, "[Content_Types].xml")).not.toContain("vnd.ms-excel.chartsheet");
  });

  it("still carries the container-neutral parts", async () => {
    const bytes = await fixture();
    if (bytes === undefined) {
      return;
    }
    const workbook = Workbook.create();
    await Workbook.read(workbook, bytes);
    const converted = await extractAll(
      await Workbook.toBuffer(workbook, { format: "xlsx", unsupported: "ignore" })
    );
    // The guard against over-correcting: a chart, its style and colour parts and its drawing are the same bytes in
    // either container, so excluding sheet parts must not take them with it.
    for (const path of [
      "xl/charts/chart1.xml",
      "xl/charts/style1.xml",
      "xl/charts/colors1.xml",
      "xl/drawings/drawing1.xml"
    ]) {
      expect([...converted.keys()]).toContain(path);
    }
  });

  it("leaves the same-container round trip byte-exact", async () => {
    const bytes = await fixture();
    if (bytes === undefined) {
      return;
    }
    // The property none of the above may cost: an unmodified XLSB comes back as the bytes it arrived as, which is the
    // strongest statement this library makes about a file whose features it does not all model.
    const workbook = Workbook.create();
    await Workbook.read(workbook, bytes);
    const again = await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" });
    expect([...again]).toEqual([...bytes]);
  });
});
