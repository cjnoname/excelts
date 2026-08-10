import * as Workbook from "@excel/surface/workbook.browser";
import { XLSX } from "@excel/xlsx/xlsx.browser";
import { describe, expect, it } from "vitest";

class TestXlsx extends XLSX {
  writeWith(zip: unknown): Promise<void> {
    return this.writeToZip(zip as never, {});
  }
}

describe("XLSX entry backpressure", () => {
  it("waits for asynchronous entry output before checking drain", async () => {
    const workbook = Workbook.create();
    let finishEntry!: () => void;
    const entryFinished = new Promise<void>(resolve => {
      finishEntry = resolve;
    });
    let drainChecks = 0;
    const stop = new Error("stop after the first drain check");

    const zip = {
      createEntry() {
        return {
          write() {},
          end() {
            return entryFinished;
          }
        };
      },
      async waitForDrain() {
        drainChecks++;
        throw stop;
      }
    };

    const writing = new TestXlsx(workbook).writeWith(zip);

    // `writeToZip` has reached the first entry's asynchronous completion but
    // must not inspect backpressure until that output is observable by the sink.
    await Promise.resolve();
    expect(drainChecks).toBe(0);

    finishEntry();
    await expect(writing).rejects.toBe(stop);
    expect(drainChecks).toBe(1);
  });
});
