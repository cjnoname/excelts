import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { StreamBuf } from "../../../utils/stream-buf.js";
import { StringBuf } from "../../../utils/string-buf.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("StreamBuf", () => {
  // StreamBuf is designed as a general-purpose writable-readable stream
  // However its use in ExcelTS is primarily as a memory buffer between
  // the streaming writers and the archive, hence the tests here will
  // focus just on that.
  it("writes strings as UTF8", () => {
    const stream = new StreamBuf();
    stream.write("Hello, World!");
    const chunk = stream.read();
    expect(chunk instanceof Buffer).toBeTruthy();
    expect(chunk.toString("UTF8")).toBe("Hello, World!");
  });

  // Note: Using async/await here because our ES6 module fix requires it
  // Original test worked synchronously due to CommonJS instanceof check succeeding
  it("writes StringBuf chunks", async () => {
    const stream = new StreamBuf();
    const strBuf = new StringBuf({ size: 64 });
    strBuf.addText("Hello, World!");
    await stream.write(strBuf);
    const chunk = stream.read();
    expect(chunk instanceof Buffer).toBeTruthy();
    expect(chunk.toString("UTF8")).toBe("Hello, World!");
  });

  it("signals end", () =>
    new Promise<void>(resolve => {
      const stream = new StreamBuf();
      stream.on("finish", () => {
        resolve(undefined);
      });
      stream.write("Hello, World!");
      stream.end();
    }));

  it("handles buffers", () =>
    new Promise<void>((resolve, reject) => {
      const s = fs.createReadStream(path.join(__dirname, "data/image1.png"));
      const sb = new StreamBuf();
      sb.on("finish", () => {
        const buf = sb.toBuffer();
        expect(buf.length).toBe(1672);
        resolve(undefined);
      });
      sb.on("error", reject);
      s.pipe(sb);
    }));
  it("handle unsupported type of chunk", async () => {
    const stream = new StreamBuf();
    try {
      await stream.write({});
      expect.fail("should fail for given argument");
    } catch (e: any) {
      expect(e.message).toBe("Chunk must be one of type String, Buffer or StringBuf.");
    }
  });
});
