/**
 * The built-in number formats, end to end through a file on disk.
 *
 * **Split out of `numfmt-builtins.test.ts` so that file keeps its browser coverage.** This one case reads a template
 * with `Workbook.readFile`, which is Node-only — and the browser configuration excludes `*.node.test.ts` by glob,
 * which is the repository's rule for exactly this. Left where it was, it failed in the browser with
 * `Workbook.readFile is not a function` and took the other ten cases' browser run down with it.
 */
import { extractAll } from "@archive/unzip/extract";
import { Workbook } from "@excel";
import { iterateInterpretableRecords } from "@excel/xlsb/binary";
import { recordSpec } from "@excel/xlsb/spec/records";
import { describe, expect, it } from "vitest";

describe("a format code read out of a file", () => {
  it("survives a round trip through a workbook without becoming a custom id", async () => {
    // End-to-end, because the three defects only combined into the symptom at the far end: a built-in format
    // that fails to match is written as a `BrtFmt` with an id of 164 or above, and a styles part full of those
    // is what Excel discarded.
    const source = "src/modules/excel/examples/data/comments.xlsx";
    const workbook = Workbook.create();
    await Workbook.readFile(workbook, source);
    const parts = await extractAll(
      await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" })
    );

    const customIds: number[] = [];
    for (const record of iterateInterpretableRecords(parts.get("xl/styles.bin")!.data, "b")) {
      if (recordSpec(record.id)?.name !== "BrtFmt") {
        continue;
      }
      customIds.push(
        new DataView(record.payload.buffer, record.payload.byteOffset).getUint16(0, true)
      );
    }
    // The template's four formats are built-ins, so nothing should be registered as custom at all.
    expect(customIds).toEqual([]);
  });
});
