import { describe, it, expect } from "vitest";
import { StringBuf } from "../../../utils/string-buf.js";

describe("StringBuf", () => {
  // StringBuf is a lightweight string-builder used by the streaming writers to build
  // strings (e.g. for row data) without too many memory operations
  it("writes strings as UTF8", () => {
    const sb = new StringBuf({ size: 64 });
    sb.addText("Hello, World!");
    const chunk = sb.toBuffer();
    expect(chunk.toString("utf-8")).toBe("Hello, World!");
  });

  it("grows properly", () => {
    const sb = new StringBuf({ size: 8 });
    expect(sb.length).toBe(0);
    expect(sb.capacity).toBe(8);

    // write simple UTF8 string. Should use 7 bytes
    // that's within 4 bytes of 16
    sb.addText("Hello, ");
    expect(sb.length).toBe(7);
    expect(sb.capacity).toBe(16);

    // add some more (6 bytes)
    sb.addText("World!");
    expect(sb.length).toBe(13);
    expect(sb.capacity).toBe(32);

    // and more (7 bytes)
    sb.addText(" Hello.");
    expect(sb.length).toBe(20);
    expect(sb.capacity).toBe(32);

    // after all that - the string should be intact
    const chunk = sb.toBuffer();
    expect(chunk.toString("utf-8")).toBe("Hello, World! Hello.");
  });

  it("resets", () => {
    const sb = new StringBuf({ size: 64 });
    sb.addText("Hello, ");
    expect(sb.length).toBe(7);

    sb.reset();
    expect(sb.length).toBe(0);

    sb.addText("World!");
    expect(sb.length).toBe(6);

    const chunk = sb.toBuffer();
    expect(chunk.toString("utf-8")).toBe("World!");
  });
});
