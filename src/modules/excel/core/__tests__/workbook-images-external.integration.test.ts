import { extractAll } from "@archive/unzip/extract";
import { expectValidXlsx } from "@excel/__tests__/helpers/expect-valid-xlsx";
import { entryText } from "@excel/__tests__/helpers/zip-text";
import { anchorCol, anchorRow } from "@excel/core/anchor";
import { cellSetValue } from "@excel/core/cell";
import { getImage } from "@excel/core/workbook";
import { addWorkbookImage } from "@excel/core/workbook-core";
import {
  addBackgroundImage,
  addImage,
  addWatermark,
  getImages,
  getWatermark
} from "@excel/core/worksheet";
import { Cell, Workbook } from "@excel/index";
import { WorkbookWriter } from "@excel/stream/workbook-writer";
import { Writable } from "@stream";
import { describe, it, expect } from "vitest";

const REMOTE_URL = "https://example.com/assets/logo.png";

/** Collect a streaming WorkbookWriter's output into a single buffer. */
function memoryStreamWriter(): {
  wb: InstanceType<typeof WorkbookWriter>;
  getBytes: () => Promise<Uint8Array>;
} {
  const chunks: Uint8Array[] = [];
  const stream = new Writable({
    write(chunk: Uint8Array, _encoding: string, callback: () => void) {
      chunks.push(chunk);
      callback();
    }
  });
  const wb = new WorkbookWriter({ stream });
  const getBytes = async () => {
    await wb.commit();
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return out;
  };
  return { wb, getBytes };
}

// =============================================================================
// External (linked) images
//
// An external image is referenced via `<a:blip r:link>` with a relationship
// using `TargetMode="External"`. No image bytes are embedded in the package.
// =============================================================================

describe("Workbook external (linked) images", () => {
  it("writes a linked image as r:link + TargetMode=External and embeds no bytes", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "linked");

    const imageId = addWorkbookImage(wb, { extension: "png", link: REMOTE_URL });
    addImage(ws, imageId, "B2:D6");

    const buffer = new Uint8Array(await Workbook.toBuffer(wb));
    await expectValidXlsx(buffer, { label: "external image" });

    const entries = await extractAll(buffer);

    // No media bytes written.
    const mediaEntries = [...entries.keys()].filter(p => p.startsWith("xl/media/"));
    expect(mediaEntries).toHaveLength(0);

    // The drawing uses r:link (not r:embed).
    const drawingXml = entryText(entries, "xl/drawings/drawing1.xml");
    expect(drawingXml).toBeDefined();
    expect(drawingXml).toContain("r:link=");
    expect(drawingXml).not.toContain("r:embed=");

    // The drawing rels point at the external URL with TargetMode="External".
    const relsXml = entryText(entries, "xl/drawings/_rels/drawing1.xml.rels");
    expect(relsXml).toBeDefined();
    expect(relsXml).toContain(`Target="${REMOTE_URL}"`);
    expect(relsXml).toContain('TargetMode="External"');
    expect(relsXml).toContain(
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"'
    );

    // No image content-type Default is registered (no part exists).
    const contentTypes = entryText(entries, "[Content_Types].xml");
    expect(contentTypes).toBeDefined();
    expect(contentTypes).not.toContain('Extension="png"');
  });

  it("round-trips a linked image (link + range survive load)", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "linked");

    const imageId = addWorkbookImage(wb, { extension: "png", link: REMOTE_URL });
    addImage(ws, imageId, "C3:E6");

    const buffer = new Uint8Array(await Workbook.toBuffer(wb));

    const wb2 = Workbook.create();
    await Workbook.read(wb2, buffer);

    const ws2 = Workbook.getWorksheet(wb2, "linked")!;
    const images = getImages(ws2);
    expect(images).toHaveLength(1);

    const imageDesc = images[0];
    expect(anchorCol(imageDesc.range!.tl)).toBe(2);
    expect(anchorRow(imageDesc.range!.tl)).toBe(2);
    expect(anchorCol(imageDesc.range!.br!)).toBe(5);
    expect(anchorRow(imageDesc.range!.br!)).toBe(6);

    const medium = getImage(wb2, imageDesc.imageId!);
    expect(medium).toBeDefined();
    expect(medium!.link).toBe(REMOTE_URL);
    expect(medium!.buffer).toBeUndefined();
    expect(medium!.base64).toBeUndefined();
  });

  it("re-writes a loaded linked image as external again (no bytes leak in)", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "linked");
    const imageId = addWorkbookImage(wb, { extension: "png", link: REMOTE_URL });
    addImage(ws, imageId, "A1:B2");

    const first = new Uint8Array(await Workbook.toBuffer(wb));

    const wb2 = Workbook.create();
    await Workbook.read(wb2, first);
    const second = new Uint8Array(await Workbook.toBuffer(wb2));
    await expectValidXlsx(second, { label: "external image roundtrip" });

    const entries = await extractAll(second);
    const mediaEntries = [...entries.keys()].filter(p => p.startsWith("xl/media/"));
    expect(mediaEntries).toHaveLength(0);

    const relsXml = entryText(entries, "xl/drawings/_rels/drawing1.xml.rels");
    expect(relsXml).toContain('TargetMode="External"');
    expect(relsXml).toContain(`Target="${REMOTE_URL}"`);
  });

  it("deduplicates one rel when the same linked image is used twice", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "linked");
    const imageId = addWorkbookImage(wb, { extension: "png", link: REMOTE_URL });
    addImage(ws, imageId, "A1:B2");
    addImage(ws, imageId, "D1:E2");

    const buffer = new Uint8Array(await Workbook.toBuffer(wb));
    await expectValidXlsx(buffer, { label: "external dedup" });

    const entries = await extractAll(buffer);
    const relsXml = entryText(entries, "xl/drawings/_rels/drawing1.xml.rels")!;
    const occurrences = relsXml.split('TargetMode="External"').length - 1;
    expect(occurrences).toBe(1);
  });

  it("supports local file path links", async () => {
    const localPath = "file:///C:/images/logo.png";
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "linked");
    const imageId = addWorkbookImage(wb, { extension: "png", link: localPath });
    addImage(ws, imageId, "A1:C4");

    const buffer = new Uint8Array(await Workbook.toBuffer(wb));
    await expectValidXlsx(buffer, { label: "external local path" });

    const entries = await extractAll(buffer);
    const relsXml = entryText(entries, "xl/drawings/_rels/drawing1.xml.rels")!;
    expect(relsXml).toContain(`Target="${localPath}"`);
    expect(relsXml).toContain('TargetMode="External"');
  });

  it("supports a linked image with a hyperlink (two distinct External rels)", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "linked");
    const imageId = addWorkbookImage(wb, { extension: "png", link: REMOTE_URL });
    addImage(ws, imageId, {
      tl: { col: 1, row: 1 },
      br: { col: 3, row: 4 },
      hyperlinks: { hyperlink: "https://example.com/click", tooltip: "Open" }
    });

    const buffer = new Uint8Array(await Workbook.toBuffer(wb));
    await expectValidXlsx(buffer, { label: "external image + hyperlink" });

    const entries = await extractAll(buffer);
    const relsXml = entryText(entries, "xl/drawings/_rels/drawing1.xml.rels")!;
    // Both the image link and the hyperlink are External, with separate ids.
    expect(relsXml).toContain(`Target="${REMOTE_URL}"`);
    expect(relsXml).toContain('Target="https://example.com/click"');
    const externalCount = relsXml.split('TargetMode="External"').length - 1;
    expect(externalCount).toBe(2);

    const mediaEntries = [...entries.keys()].filter(p => p.startsWith("xl/media/"));
    expect(mediaEntries).toHaveLength(0);

    // Round-trip: both the external link and the hyperlink survive a load.
    const wb2 = Workbook.create();
    await Workbook.read(wb2, buffer);
    const images = getImages(Workbook.getWorksheet(wb2, "linked")!);
    expect(images).toHaveLength(1);
    expect(getImage(wb2, images[0].imageId!)!.link).toBe(REMOTE_URL);
    expect(images[0].range!.hyperlinks).toEqual({
      hyperlink: "https://example.com/click",
      tooltip: "Open"
    });
  });

  it("normalises the inferred extension on read (jpg URL -> jpeg)", async () => {
    const jpgUrl = "https://example.com/photo.jpg?cache=42";
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "linked");
    const imageId = addWorkbookImage(wb, { extension: "jpeg", link: jpgUrl });
    addImage(ws, imageId, "A1:B2");

    const buffer = new Uint8Array(await Workbook.toBuffer(wb));
    const wb2 = Workbook.create();
    await Workbook.read(wb2, buffer);

    const images = getImages(Workbook.getWorksheet(wb2, "linked")!);
    const medium = getImage(wb2, images[0].imageId!)!;
    expect(medium.link).toBe(jpgUrl);
    // jpg → jpeg, query string stripped.
    expect(medium.extension).toBe("jpeg");
  });

  it("XML-escapes special characters in the link target and round-trips them", async () => {
    const url = "https://example.com/img.png?a=1&b=2&c=<x>";
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "linked");
    const imageId = addWorkbookImage(wb, { extension: "png", link: url });
    addImage(ws, imageId, "A1:B2");

    const buffer = new Uint8Array(await Workbook.toBuffer(wb));
    await expectValidXlsx(buffer, { label: "external link escaping" });

    const entries = await extractAll(buffer);
    const relsXml = entryText(entries, "xl/drawings/_rels/drawing1.xml.rels")!;
    // The raw `&`/`<`/`>` must be entity-escaped in the XML, never literal.
    expect(relsXml).toContain("&amp;");
    expect(relsXml).not.toContain("?a=1&b=2");

    // The reader decodes them back to the exact original URL.
    const wb2 = Workbook.create();
    await Workbook.read(wb2, buffer);
    const images = getImages(Workbook.getWorksheet(wb2, "linked")!);
    expect(getImage(wb2, images[0].imageId!)!.link).toBe(url);
  });

  it("embedding takes precedence when both buffer and link are provided", async () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "mixed");
    const imageId = addWorkbookImage(wb, {
      extension: "png",
      buffer: pngBytes,
      link: REMOTE_URL
    });
    addImage(ws, imageId, "A1:B2");

    const buffer = new Uint8Array(await Workbook.toBuffer(wb));
    const entries = await extractAll(buffer);

    // Bytes embedded → media part exists, blip uses r:embed, no External rel.
    const mediaEntries = [...entries.keys()].filter(p => p.startsWith("xl/media/"));
    expect(mediaEntries).toHaveLength(1);

    const drawingXml = entryText(entries, "xl/drawings/drawing1.xml")!;
    expect(drawingXml).toContain("r:embed=");
    expect(drawingXml).not.toContain("r:link=");

    const relsXml = entryText(entries, "xl/drawings/_rels/drawing1.xml.rels")!;
    expect(relsXml).not.toContain('TargetMode="External"');
  });

  it("round-trips a linked image through the streaming writer", async () => {
    const { wb, getBytes } = memoryStreamWriter();

    const imageId = wb.addImage({ extension: "png", link: REMOTE_URL });
    const ws = wb.addWorksheet("linked");
    ws.addImage(imageId, "B2:D5");
    cellSetValue(ws.getCell("A1"), "data");
    ws.commit();
    const out = await getBytes();

    await expectValidXlsx(out, { label: "streaming external image" });

    const entries = await extractAll(out);
    const mediaEntries = [...entries.keys()].filter(p => p.startsWith("xl/media/"));
    expect(mediaEntries).toHaveLength(0);

    const wb2 = Workbook.create();
    await Workbook.read(wb2, out);
    const images = getImages(Workbook.getWorksheet(wb2, "linked")!);
    expect(images).toHaveLength(1);
    expect(getImage(wb2, images[0].imageId!)!.link).toBe(REMOTE_URL);
  });

  // ---------------------------------------------------------------------------
  // Background / watermark / header
  // ---------------------------------------------------------------------------

  it("rejects an external image as a worksheet background with a clear error", async () => {
    // Worksheet background pictures (<picture r:id>) do not support external
    // images — Excel silently drops a background whose relationship uses
    // TargetMode="External". So we reject it up front.
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "bg");
    const imageId = addWorkbookImage(wb, { extension: "png", link: REMOTE_URL });
    expect(() => addBackgroundImage(ws, imageId)).toThrow(/background images cannot be external/i);
  });

  it("supports an external overlay watermark (drawing rel External, no bytes)", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "wm");
    Cell.setValue(ws, "A1", "watermarked");
    const imageId = addWorkbookImage(wb, { extension: "png", link: REMOTE_URL });
    addWatermark(ws, { imageId, mode: "overlay", opacity: 0.2 });

    const buffer = new Uint8Array(await Workbook.toBuffer(wb));
    await expectValidXlsx(buffer, { label: "external watermark" });

    const entries = await extractAll(buffer);
    expect([...entries.keys()].filter(p => p.startsWith("xl/media/"))).toHaveLength(0);

    const drawingXml = entryText(entries, "xl/drawings/drawing1.xml")!;
    expect(drawingXml).toContain("r:link=");
    expect(drawingXml).not.toContain("r:embed=");

    const relsXml = entryText(entries, "xl/drawings/_rels/drawing1.xml.rels")!;
    expect(relsXml).toContain(`Target="${REMOTE_URL}"`);
    expect(relsXml).toContain('TargetMode="External"');
  });

  it("rejects an external image for a header watermark with a clear error", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "hdr");
    const imageId = addWorkbookImage(wb, { extension: "png", link: REMOTE_URL });
    expect(() => addWatermark(ws, { imageId, mode: "header" })).toThrow(/cannot be external/i);
  });

  it("does not mutate an existing watermark when a header external call is rejected", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "hdr");
    const embedId = addWorkbookImage(wb, {
      extension: "png",
      buffer: new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    });
    addWatermark(ws, { imageId: embedId, mode: "overlay", opacity: 0.25 });
    const before = getWatermark(ws);

    const extId = addWorkbookImage(wb, { extension: "png", link: REMOTE_URL });
    expect(() => addWatermark(ws, { imageId: extId, mode: "header" })).toThrow(
      /cannot be external/i
    );

    // The failed call must leave the prior watermark intact.
    expect(getWatermark(ws)).toEqual(before);
    expect(getWatermark(ws)!.imageId).toBe(String(embedId));
    expect(getWatermark(ws)!.mode).toBe("overlay");
  });

  it("does not crash when a background image id is invalid", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "bg");
    Cell.setValue(ws, "A1", "data");
    addBackgroundImage(ws, 999);

    // Must not throw; the dangling background is simply dropped.
    const buffer = new Uint8Array(await Workbook.toBuffer(wb));
    await expectValidXlsx(buffer, { label: "invalid background id" });

    const entries = await extractAll(buffer);
    const wsRels = entryText(entries, "xl/worksheets/_rels/sheet1.xml.rels");
    // No image relationship should have been written for the missing id.
    if (wsRels) {
      expect(wsRels).not.toContain("/relationships/image");
    }
  });

  it("rejects a header external watermark in the streaming writer without mutating media", async () => {
    const { wb, getBytes } = memoryStreamWriter();
    const embedId = wb.addImage({
      extension: "png",
      buffer: new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    });
    const ws = wb.addWorksheet("hdr");
    ws.addWatermark({ imageId: embedId, mode: "overlay", opacity: 0.25 });

    const extId = wb.addImage({ extension: "png", link: REMOTE_URL });
    expect(() => ws.addWatermark({ imageId: extId, mode: "header" })).toThrow(
      /cannot be external/i
    );

    // The overlay watermark survives and the workbook still commits cleanly.
    expect(ws.getWatermark()!.mode).toBe("overlay");
    cellSetValue(ws.getCell("A1"), "data");
    ws.commit();
    const out = await getBytes();
    await expectValidXlsx(out, { label: "streaming header rejection" });
  });

  it("rejects embedded header watermarks in the streaming writer explicitly", async () => {
    const { wb } = memoryStreamWriter();
    const imageId = wb.addImage({ buffer: new Uint8Array([1, 2, 3]), extension: "png" });
    const ws = wb.addWorksheet("Sheet1");

    expect(() => ws.addWatermark({ imageId, mode: "header" })).toThrow(
      /not supported by the streaming worksheet writer/i
    );
  });

  it("rejects an external background image in the streaming writer", async () => {
    const { wb } = memoryStreamWriter();
    const imageId = wb.addImage({ extension: "png", link: REMOTE_URL });
    const ws = wb.addWorksheet("bg");
    expect(() => ws.addBackgroundImage(imageId)).toThrow(/background images cannot be external/i);
  });
});
