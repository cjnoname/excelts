/**
 * Every committed `.xlsx` fixture, put through XLSB and compared against reading the `.xlsx`.
 *
 * The comparison is the point. A single-format round trip only proves a writer and a reader agree with
 * each other; putting one model through two containers asks whether they agree with *each other*, and a
 * disagreement is a fact about one of them rather than a matter of opinion.
 *
 * **This replaced a bespoke script.** `verify:xlsb-parity` did the same comparison over the workbooks a
 * full example run leaves in `tmp/`, which was broader by count and worse in three ways: it was the only
 * module-specific step in CI, it crashed rather than skipped when that directory did not exist, and the
 * breadth was largely illusory. `describeWorkbook` compares *cell values* — not styles, formats or
 * widths — and what distinguished those example outputs was charts, pivots and formatting, which it
 * cannot see. Thirty-nine committed workbooks with real cell data are the coverage that comparison
 * actually wanted, and they are available in a watch loop.
 *
 * `.node` because it reads fixtures off disk, which the browser config excludes by glob.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { Workbook } from "@excel";
import { validateXlsbBuffer } from "@excel/utils/xlsb-validator";
import { writeXlsbPackage } from "@excel/xlsb/write/package";
import { describeWorkbook } from "@test/workbook-describe";
import { accountedFor, differingAddresses, knownCause } from "@test/workbook-parity";
import { describe, expect, it } from "vitest";

/**
 * Both committed fixture directories.
 *
 * `examples/data` holds what the examples read and `__tests__/data` what the tests read; the split is
 * about who may depend on them, not about what they contain, and this comparison wants every real
 * workbook it can get.
 */
const FIXTURE_DIRECTORIES = ["src/modules/excel/examples/data", "src/modules/excel/__tests__/data"];

const files = (
  await Promise.all(
    FIXTURE_DIRECTORIES.map(async directory =>
      (await readdir(directory))
        .filter(name => name.endsWith(".xlsx"))
        .map(name => join(directory, name))
    )
  )
)
  .flat()
  .sort();

describe("committed fixtures through XLSB", () => {
  it("has fixtures to compare", () => {
    // A gate over an empty set passes for the wrong reason.
    expect(files.length).toBeGreaterThan(30);
  });

  it.each(files)("%s reads the same through both containers", async file => {
    const viaXlsx = Workbook.create();
    await Workbook.read(viaXlsx, await readFile(file));

    // `writeXlsbPackage` rather than `toBuffer`, for the full report: the public entry throws an error
    // naming only the first ten unwritable cells, and this uses the report to decide which differences
    // are already accounted for. Reading it off the message would cap the measurement at ten and turn
    // every cell past that into an unexplained failure.
    const written = await writeXlsbPackage(Workbook.getModel(viaXlsx));

    const validation = await validateXlsbBuffer(written.bytes, { includeWarnings: true });
    expect(validation.problems, `${file}: validator`).toEqual([]);

    const viaXlsb = Workbook.create();
    await Workbook.read(viaXlsb, written.bytes);

    const reported = accountedFor(viaXlsx, written.unsupported);

    const left = describeWorkbook(viaXlsx);
    const right = describeWorkbook(viaXlsb);
    const changed = differingAddresses(left, right);
    const unexplained = changed.filter(
      address => !reported.has(address) && knownCause(address, left, right) === undefined
    );

    // Every difference must be one the writer named. A cell it could not express is expected to come
    // back absent; a cell it said nothing about must come back identical.
    expect(unexplained, `${file}: ${unexplained.slice(0, 6).join(", ")}`).toEqual([]);
  });
});
