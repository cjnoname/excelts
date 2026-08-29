import * as archive from "@archive";
import {
  ARCHIVE_BROWSER_EXPORTS,
  ARCHIVE_NAMESPACE_EXPORTS,
  getRuntimeExportKeys
} from "@archive/__tests__/runtime/archive-runtime-exports";
import { describe, expect, it } from "vitest";

describe("archive/index runtime exports (browser)", () => {
  it("should match the export contract", () => {
    const actual = getRuntimeExportKeys(archive);
    const expected = [...ARCHIVE_BROWSER_EXPORTS].sort();
    expect(actual).toEqual(expected);
  });

  it("should expose the expected `Archive` namespace members", () => {
    const actual = getRuntimeExportKeys(archive.Archive);
    const expected = [...ARCHIVE_NAMESPACE_EXPORTS].sort();
    expect(actual).toEqual(expected);
  });

  it("encodes RGBA pixels with the browser compression backend", () => {
    const png = archive.encodePng(new Uint8Array([255, 0, 0, 255]), 1, 1, { dpi: 96 });
    expect(Array.from(png.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const chunks: string[] = [];
    for (let offset = 8; offset < png.length;) {
      const length = new DataView(png.buffer, png.byteOffset + offset, 4).getUint32(0);
      chunks.push(new TextDecoder().decode(png.subarray(offset + 4, offset + 8)));
      offset += 12 + length;
    }
    expect(chunks).toEqual(["IHDR", "pHYs", "IDAT", "IEND"]);
  });
});
