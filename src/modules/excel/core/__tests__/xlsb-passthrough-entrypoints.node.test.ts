import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Cell, Workbook } from "@excel/index";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Every way of writing an unmodified XLSB has to produce the *same* package.
 *
 * `toBuffer` returns the bytes the workbook arrived as; `writeStream` rebuilt unconditionally. So one unmodified workbook
 * produced two different files depending on which entry point the caller reached for — measured at 10,843 bytes against
 * 8,061 on a corpus file, the missing 2,782 being exactly what the passthrough exists to protect: parts this library
 * models imperfectly, kept as Excel wrote them.
 *
 * A caller cannot reasonably be expected to know that `toStream` is the lossy one, so the fidelity guarantee has to
 * belong to the workbook rather than to the API surface.
 *
 * The fixture is written here rather than taken from the corpus, so the test does not depend on a gitignored download.
 * What it needs is a package with something the writer would rebuild differently — a preserved chart part does that.
 */
let directory = "";
let source = "";

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "documonster-pte-"));
  const { Chart } = await import("@excel/index");
  const workbook = Workbook.create();
  const sheet = Workbook.addWorksheet(workbook, "Data");
  ["APAC", "EMEA", "AMER"].forEach((region, index) => {
    Cell.setValue(sheet, `A${index + 2}`, region);
    Cell.setValue(sheet, `B${index + 2}`, (index + 1) * 10);
  });
  Chart.add(
    sheet,
    {
      type: "bar",
      barDir: "col",
      grouping: "clustered",
      series: [{ name: "Units", categories: "Data!$A$2:$A$4", values: "Data!$B$2:$B$4" }]
    } as never,
    "D2:J20"
  );
  source = join(directory, "source.xlsb");
  await writeFile(
    source,
    await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" })
  );
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function streamed(name: string): Promise<Uint8Array> {
  const workbook = Workbook.create();
  await Workbook.readFile(workbook, source);
  const target = join(directory, name);
  const stream = createWriteStream(target);
  await Workbook.writeStream(workbook, stream, { format: "xlsb", unsupported: "ignore" });
  await new Promise<void>((resolve, reject) => {
    stream.on("close", () => resolve());
    stream.on("error", reject);
    stream.end();
  });
  return Uint8Array.from(await readFile(target));
}

describe("XLSB passthrough is a property of the workbook, not of the entry point", () => {
  it("toBuffer returns the original bytes", async () => {
    const original = Uint8Array.from(await readFile(source));
    const workbook = Workbook.create();
    await Workbook.readFile(workbook, source);
    const written = await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" });
    expect([...written]).toEqual([...original]);
  });

  it("writeStream returns the original bytes too", async () => {
    const original = Uint8Array.from(await readFile(source));
    expect([...(await streamed("unchanged.xlsb"))]).toEqual([...original]);
  });

  it("both rebuild once the workbook is edited", async () => {
    // The other half: the passthrough must not survive a change, or an edit would be silently discarded.
    const original = Uint8Array.from(await readFile(source));
    const workbook = Workbook.create();
    await Workbook.readFile(workbook, source);
    Cell.setValue(Workbook.getWorksheets(workbook)[0]!, "ZZ999", "edited");
    const written = await Workbook.toBuffer(workbook, { format: "xlsb", unsupported: "ignore" });
    expect([...written]).not.toEqual([...original]);

    const edited = Workbook.create();
    await Workbook.readFile(edited, source);
    Cell.setValue(Workbook.getWorksheets(edited)[0]!, "ZZ999", "edited");
    const target = join(directory, "edited.xlsb");
    const stream = createWriteStream(target);
    await Workbook.writeStream(edited, stream, { format: "xlsb", unsupported: "ignore" });
    await new Promise<void>(resolve => {
      stream.on("close", () => resolve());
      stream.end();
    });
    expect([...Uint8Array.from(await readFile(target))]).not.toEqual([...original]);
  });
});
