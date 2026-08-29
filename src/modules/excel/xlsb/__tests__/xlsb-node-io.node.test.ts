import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { Cell, Workbook, Xlsb } from "@excel";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true })));
});

describe("XLSB Node IO", () => {
  it("reads and writes file paths", async () => {
    const directory = await mkdtemp(join(tmpdir(), "documonster-xlsb-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "workbook.xlsb");
    const source = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(source, "Sheet1"), "A1", "file");

    await Xlsb.writeFile(source, filename);
    const target = Workbook.create();
    await Xlsb.readFile(target, filename);

    expect(Cell.getValue(Workbook.getWorksheet(target, "Sheet1")!, "A1")).toBe("file");
  });

  it("selects XLSB from the filename on the canonical Workbook surface", async () => {
    const directory = await mkdtemp(join(tmpdir(), "documonster-workbook-xlsb-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "workbook.xlsb");
    const source = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(source, "Sheet1"), "A1", "auto-file");

    await Workbook.writeFile(source, filename);
    const target = Workbook.create();
    await Workbook.readFile(target, filename);

    expect(Cell.getValue(Workbook.getWorksheet(target, "Sheet1")!, "A1")).toBe("auto-file");
  });

  it("supports pull and push byte streams", async () => {
    const source = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(source, "Sheet1"), "A1", "stream");

    const pullChunks: Uint8Array[] = [];
    for await (const chunk of Xlsb.toStream(source)) {
      pullChunks.push(chunk);
    }
    expect(pullChunks.length).toBeGreaterThan(0);

    const sink = new PassThrough();
    const pushChunks: Uint8Array[] = [];
    const consuming = (async () => {
      for await (const chunk of sink) {
        pushChunks.push(chunk);
      }
    })();
    await Xlsb.writeStream(source, sink);
    await consuming;
    expect(pushChunks.length).toBeGreaterThan(0);

    const target = Workbook.create();
    await Xlsb.readStream(target, pullChunks);
    expect(Cell.getValue(Workbook.getWorksheet(target, "Sheet1")!, "A1")).toBe("stream");
  });
});
