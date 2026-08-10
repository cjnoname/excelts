import { ZipDeflate } from "@archive/zip/stream";
import { rowCommit } from "@excel/core/worksheet";
import { WorkbookWriter } from "@excel/stream/workbook-writer.browser";
import { EventEmitter } from "@utils/event-emitter";
import { afterEach, describe, expect, it, vi } from "vitest";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

class ProtocolSink extends EventEmitter {
  acceptWrites = false;

  write(): boolean {
    return this.acceptWrites;
  }

  end(): void {
    this.emit("finish");
    this.emit("close");
  }
}

describe("WorkbookWriter ZIP/backpressure protocol", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not emit zipped or inspect drain before the final ZIP push completes", async () => {
    const finalPushCalled = deferred();
    const releaseFinalPush = deferred();
    const originalPush = ZipDeflate.prototype.push;
    let heldFinalPush = false;

    vi.spyOn(ZipDeflate.prototype, "push").mockImplementation(
      function (this: ZipDeflate, data, final, callback) {
        const completion = originalPush.call(this, data, final, callback);
        if (!final || heldFinalPush) {
          return completion;
        }
        heldFinalPush = true;
        finalPushCalled.resolve();
        return completion.then(() => releaseFinalPush.promise);
      }
    );

    const sink = new ProtocolSink();
    const workbook = new WorkbookWriter({ stream: sink as any, trueStreaming: true });
    const worksheet = workbook.addWorksheet("Data");
    rowCommit(worksheet.addRow(["value"]));

    let zipped = false;
    worksheet.stream.once("zipped", () => {
      zipped = true;
    });

    let drainChecks = 0;
    const drainCheckEntered = deferred();
    const writer = workbook as any;
    const waitForDrain = writer._waitForUserSinkDrain.bind(workbook);
    writer._waitForUserSinkDrain = async () => {
      drainChecks++;
      drainCheckEntered.resolve();
      await waitForDrain();
    };

    // This public method is synchronous. wb.commit() must still adopt the
    // in-flight async ZIP push instead of skipping an already-committed sheet.
    worksheet.commit();
    let committed = false;
    const commit = workbook.commit().then(() => {
      committed = true;
    });

    await finalPushCalled.promise;
    await Promise.resolve();
    expect(zipped).toBe(false);
    expect(drainChecks).toBe(0);

    releaseFinalPush.resolve();
    await drainCheckEntered.promise;
    expect(zipped).toBe(true);
    expect(drainChecks).toBe(1);
    expect(committed).toBe(false);

    sink.acceptWrites = true;
    sink.emit("drain");
    await commit;
  });
});
