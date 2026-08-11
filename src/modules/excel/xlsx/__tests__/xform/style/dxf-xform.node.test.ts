import { extractAll } from "@archive/unzip/extract";
import { Cell, Workbook, Worksheet } from "@excel/index";
import { describe, expect, it } from "vitest";

/**
 * Regression: a conditional format's number format used to survive the first
 * save and then be destroyed by the next one.
 *
 * `DxfXform.parseClose` stores the parsed `{ id, formatCode }` pair on the dxf
 * model's `numFmt`, while `DxfXform.render` assumed a plain format-code string
 * and interpolated it directly — so a read → write round-trip emitted
 * `formatCode="[object Object]"` and Excel dropped the format.
 */
async function styleSheet(bytes: Uint8Array): Promise<string> {
  const entries = await extractAll(bytes);
  const entry = entries.get("xl/styles.xml");
  return entry ? new TextDecoder().decode(entry.data) : "";
}

const dxfs = (xml: string): string => /<dxfs[\s\S]*?<\/dxfs>/.exec(xml)?.[0] ?? "";

describe("dxf numFmt round-trip", () => {
  it("preserves the conditional-format number format across read → write", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Cell.setValue(ws, "A1", 5);
    Worksheet.addConditionalFormatting(ws, {
      ref: "A1:A10",
      rules: [
        {
          type: "cellIs",
          operator: "greaterThan",
          formulae: [3],
          priority: 1,
          style: { numFmt: "#,##0.00", font: { bold: true } }
        }
      ]
    });

    const first = await Workbook.toBuffer(wb);
    expect(dxfs(await styleSheet(first))).toContain('formatCode="#,##0.00"');

    // Read it back — the parsed dxf carries the `{ id, formatCode }` pair …
    const reloaded = Workbook.create();
    await Workbook.read(reloaded, first);
    const reloadedSheet = Workbook.getWorksheet(reloaded, "S")!;
    const numFmt = reloadedSheet.conditionalFormattings[0].rules[0].style?.numFmt;
    expect(typeof numFmt).toBe("object");

    // … and writing again must still emit the format code, not "[object Object]".
    const second = await Workbook.toBuffer(reloaded);
    const secondDxfs = dxfs(await styleSheet(second));
    expect(secondDxfs).toContain('formatCode="#,##0.00"');
    expect(secondDxfs).not.toContain("[object Object]");
  });
});
