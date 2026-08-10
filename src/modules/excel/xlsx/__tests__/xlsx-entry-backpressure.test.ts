import type { XlsxWritable } from "@excel/core/xlsx-io-types";
/**
 * Backpressure sampling protocol of the XLSX writer's ZIP adapter.
 *
 * The writer asks the sink whether to pause after each part. Browser deflate is
 * asynchronous, so an entry's bytes reach `write()` after the call that produced
 * them returned; sampling before they land reads a stale answer and lets the
 * writer serialize the whole package regardless of how slowly it is consumed.
 *
 * These cases run in both Node and a real browser: on Node the property holds
 * trivially because deflate is synchronous, in the browser it only holds because
 * the adapter joins outstanding output inside `waitForDrain()`.
 */
import * as Workbook from "@excel/surface/workbook.browser";
import type { IZipWriter, XlsxWriteOptions } from "@excel/xlsx/xlsx.browser";
import { XLSX } from "@excel/xlsx/xlsx.browser";
import { describe, expect, it } from "vitest";

/** Records how many bytes the sink had received each time drain was sampled. */
interface DrainProbe {
  bytesAtDrain: number[];
  bytesWritten: number;
}

function createProbedXlsx(workbook: Workbook.Handle, probe: DrainProbe) {
  return new (class extends XLSX {
    protected override createZipWriter(options?: XlsxWriteOptions["zip"]): IZipWriter {
      const zip = super.createZipWriter(options);
      const waitForDrain = zip.waitForDrain.bind(zip);
      zip.waitForDrain = async () => {
        await waitForDrain();
        probe.bytesAtDrain.push(probe.bytesWritten);
      };
      return zip;
    }
  })(workbook);
}

function createCountingSink(probe: DrainProbe): XlsxWritable {
  return {
    write(data) {
      probe.bytesWritten += data.length;
      return true;
    },
    end() {},
    on() {
      return this;
    },
    once() {
      return this;
    },
    off() {
      return this;
    }
  };
}

describe("XLSX backpressure sampling", () => {
  it("has handed an entry's output to the sink before sampling drain", async () => {
    const workbook = Workbook.create();
    Workbook.addWorksheet(workbook, "S");

    const probe: DrainProbe = { bytesAtDrain: [], bytesWritten: 0 };
    await createProbedXlsx(workbook, probe).write(createCountingSink(probe));

    expect(probe.bytesAtDrain.length).toBeGreaterThan(0);
    // The first sample already sees bytes: nothing may be checked "for free"
    // while its own output is still in flight.
    expect(probe.bytesAtDrain[0]).toBeGreaterThan(0);
    // And every later sample sees at least as much as the one before it.
    for (let i = 1; i < probe.bytesAtDrain.length; i++) {
      expect(probe.bytesAtDrain[i]).toBeGreaterThanOrEqual(probe.bytesAtDrain[i - 1]!);
    }
  });
});
