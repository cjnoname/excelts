/**
 * Generic image insertion: worksheets and Word template placeholders.
 *
 * The point of these tests is that a Mermaid diagram and a PNG on disk take the
 * *same* route. So every destination is exercised with both, and the raster path
 * is checked against a file whose real pixel size is known — because the unit
 * conversions are where this goes silently wrong: pixels at 96 dpi, points at 72,
 * EMU at 914400, and a worksheet anchor that wants the first of those while a Word
 * drawing wants the last.
 */

import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ArchiveFile, crc32, encodePng, zlibSync } from "documonster/archive";
import { Image, Workbook } from "documonster/excel";
import { Build, Document, Io, Query, Template } from "documonster/word";

import { resolveConfig, type ServerConfig } from "../config.js";
import { formatToolError } from "../errors.js";
import { diagramInspectTool } from "../tools/diagram-inspect.js";
import { docReadTool } from "../tools/doc-read.js";
import { docWriteTool } from "../tools/doc-write.js";
import { resolveImageSource, toCssPixels, toEmu } from "../tools/image.js";
import { inspectTool } from "../tools/inspect.js";
import { sheetEditTool } from "../tools/sheet-edit.js";
import { sheetReadTool } from "../tools/sheet-read.js";
import { sheetWriteTool } from "../tools/sheet-write.js";
import {
  assertImagePlaceholdersExist,
  templateFillTool,
  templateInspectTool
} from "../tools/template.js";
import type { AnyToolDefinition } from "../tools/types.js";

interface Fixture {
  readonly config: ServerConfig;
  readonly root: string;
}

async function fixture(args: readonly string[] = []): Promise<Fixture> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "documonster-mcp-image-")));
  const base = resolveConfig(args, { cwd: root });
  return { config: { ...base, outputRoot: root }, root };
}

async function run(
  tool: AnyToolDefinition,
  fx: Fixture,
  args: Record<string, unknown>
): Promise<string> {
  const result = await tool.handler(args, { config: fx.config });
  const text = result.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map(block => block.text)
    .join("\n");
  if (result.isError === true) {
    throw new Error(text);
  }
  return text;
}

/**
 * The synchronous counterpart, for a guard called directly.
 *
 * `toThrow(regex)` matches `Error.message` only, so it cannot see the `hint` — which
 * is where the *reason* lives, and the reason is the whole point of these guards.
 */
function expectToolErrorSync(work: () => unknown, pattern: RegExp): void {
  let thrown: unknown;
  try {
    work();
  } catch (cause) {
    thrown = cause;
  }
  expect(thrown, "expected a tool error").toBeDefined();
  expect(formatToolError(thrown)).toMatch(pattern);
}

async function expectToolError(work: Promise<unknown>, pattern: RegExp): Promise<void> {
  await expect(work).rejects.toThrow();
  const error = await work.then(
    () => undefined,
    (cause: unknown) => cause
  );
  expect(formatToolError(error)).toMatch(pattern);
}

/** A real PNG of a known size, so the unit conversions can be asserted. */
async function writePng(fx: Fixture, name: string, width: number, height: number): Promise<void> {
  const pixels = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    pixels[index * 4] = 220;
    pixels[index * 4 + 3] = 255;
  }
  await writeFile(path.join(fx.root, name), encodePng(pixels, width, height));
}

const FLOW = "flowchart LR\n  Ingest[Ingest] --> Clean[Clean] --> Report[Report]";

/** A PNG signature plus a well-formed IHDR, for header-level tests. */
function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes[24] = 8; // bit depth
  bytes[25] = 6; // colour type: truecolour with alpha
  return bytes;
}

/**
 * A JPEG with a real segment chain: SOI, optional JFIF APP0, optional fill bytes,
 * SOF0, SOS, EOI.
 *
 * Built rather than hard-coded so each test can vary the one thing it is about —
 * the density, the padding, the marker order — instead of pasting a byte array
 * whose relationship to the assertion is invisible.
 */
function jpeg(
  width: number,
  height: number,
  options: { readonly dpi?: number; readonly fillBytes?: number } = {}
): Uint8Array {
  const parts: number[] = [0xff, 0xd8];
  if (options.dpi !== undefined) {
    const density = options.dpi;
    parts.push(
      0xff,
      0xe0,
      0x00,
      0x10,
      0x4a,
      0x46,
      0x49,
      0x46,
      0x00, // "JFIF\0"
      0x01,
      0x02,
      0x01, // units: dots per inch
      (density >> 8) & 0xff,
      density & 0xff,
      (density >> 8) & 0xff,
      density & 0xff,
      0x00,
      0x00
    );
  }
  for (let index = 0; index < (options.fillBytes ?? 0); index += 1) {
    parts.push(0xff);
  }
  parts.push(
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03,
    0x01,
    0x11,
    0x00,
    0x02,
    0x11,
    0x01,
    0x03,
    0x11,
    0x01
  );
  // SOS, a byte of entropy data containing a coincidental `FF C0`, then EOI.
  parts.push(0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00);
  parts.push(0xff, 0x00, 0xff, 0xc0, 0x01, 0x2c, 0x01, 0x2c);
  parts.push(0xff, 0xd9);
  return new Uint8Array(parts);
}

/** A JPEG whose scan begins before any frame header, so no size is discoverable. */
function jpegSosBeforeFrame(): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
    // Entropy data that spells a frame header claiming 300x300.
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x01, 0x2c, 0x03, 0xff, 0xd9
  ]);
}

/**
 * A PNG whose IDAT holds `rows` scanlines instead of the declared height.
 *
 * Every chunk's CRC is correct, so nothing but comparing the inflated length against
 * width × height can tell that it is short.
 */
function pngWithIdatFor(width: number, height: number, rows: number): Uint8Array {
  const raw = new Uint8Array(rows * (1 + width * 4));
  return pngWithRawIdat(width, height, zlibSync(raw), height);
}

/** A structurally valid PNG with a caller-supplied (possibly invalid) IDAT payload. */
function pngWithRawIdat(
  width: number,
  height: number,
  idat: Uint8Array,
  declaredHeight = height
): Uint8Array {
  const chunks = [
    chunk("IHDR", ihdr(width, declaredHeight)),
    chunk("IDAT", idat),
    chunk("IEND", new Uint8Array(0))
  ];
  const total = 8 + chunks.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  let at = 8;
  for (const part of chunks) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function ihdr(width: number, height: number): Uint8Array {
  const payload = new Uint8Array(13);
  const view = new DataView(payload.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  payload[8] = 8; // bit depth
  payload[9] = 6; // truecolour with alpha
  return payload;
}

/** One PNG chunk: length, type, payload, CRC-32 over type and payload. */
function chunk(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, payload.length);
  for (let index = 0; index < 4; index += 1) {
    out[4 + index] = type.charCodeAt(index);
  }
  out.set(payload, 8);
  view.setUint32(8 + payload.length, crc32(out.subarray(4, 8 + payload.length)));
  return out;
}

/** A GIF89a header, colour table, image descriptor and trailer. */
function gif(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0x47,
    0x49,
    0x46,
    0x38,
    0x39,
    0x61, // "GIF89a"
    width & 0xff,
    (width >> 8) & 0xff,
    height & 0xff,
    (height >> 8) & 0xff,
    0x80,
    0x00,
    0x00, // packed: global colour table, 2 entries
    0x00,
    0x00,
    0x00,
    0xff,
    0xff,
    0xff, // the two colours
    0x2c,
    0x00,
    0x00,
    0x00,
    0x00,
    width & 0xff,
    (width >> 8) & 0xff,
    height & 0xff,
    (height >> 8) & 0xff,
    0x00,
    0x02,
    0x02,
    0x44,
    0x01,
    0x00, // minimal LZW data
    0x3b // trailer
  ]);
}

describe("unit conversions", () => {
  it("converts points to the unit each destination actually wants", () => {
    // 96 CSS pixels, 72 points and 914400 EMU to the inch. A worksheet anchor's
    // `ext` is the first; a Word drawing is the last. Confusing them scales a
    // picture by 4/3 or by 9525.
    expect(toCssPixels(72)).toBe(96);
    expect(toEmu(72)).toBe(914400);
    expect(toCssPixels(36)).toBe(48);
  });
});

describe("resolveImageSource", () => {
  it("reads a PNG's own size at 96 dpi", async () => {
    const fx = await fixture();
    await writePng(fx, "logo.png", 96, 48);
    const image = await resolveImageSource(fx.config, { from: "logo.png" });
    // 96 px at 96 dpi is one inch, which is 72 points.
    expect(image.width).toBeCloseTo(72, 5);
    expect(image.height).toBeCloseTo(36, 5);
    expect(image.mediaType).toBe("png");
    expect(image.altText).toBe("logo");
    expect(image.diagram).toBeUndefined();
  });

  it("keeps the aspect ratio when given one dimension", async () => {
    const fx = await fixture();
    await writePng(fx, "logo.png", 96, 48);
    const wide = await resolveImageSource(fx.config, { from: "logo.png", width: 144 });
    expect(wide.height).toBeCloseTo(72, 5);
    const tall = await resolveImageSource(fx.config, { from: "logo.png", height: 72 });
    expect(tall.width).toBeCloseTo(144, 5);
  });

  it("takes both dimensions literally, since a caller naming two means them", async () => {
    const fx = await fixture();
    await writePng(fx, "logo.png", 96, 48);
    const image = await resolveImageSource(fx.config, {
      from: "logo.png",
      width: 100,
      height: 100
    });
    expect(image.width).toBe(100);
    expect(image.height).toBe(100);
  });

  it("caps the width when asked, keeping the ratio", async () => {
    const fx = await fixture();
    await writePng(fx, "wide.png", 1000, 100);
    const image = await resolveImageSource(
      fx.config,
      { from: "wide.png" },
      { maxWidthPoints: 468 }
    );
    expect(image.width).toBe(468);
    expect(image.height).toBeCloseTo(46.8, 1);
  });

  it("draws a Mermaid source and reports the parsed diagram", async () => {
    const fx = await fixture();
    const image = await resolveImageSource(fx.config, { source: FLOW });
    expect(image.mediaType).toBe("png");
    expect(image.diagram?.kind).toBe("flowchart");
    expect(image.origin).toContain("Mermaid");
    // A PNG was really produced, not an SVG string.
    expect([...image.bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("draws a fence out of a Markdown file", async () => {
    const fx = await fixture();
    await writeFile(
      path.join(fx.root, "design.md"),
      ["# D", "", "```mermaid", "pie title P", '  "a" : 1', "```", ""].join("\n")
    );
    const image = await resolveImageSource(fx.config, { from: "design.md" });
    expect(image.diagram?.kind).toBe("pie");
    expect(image.fileName).toBe("pie-diagram.png");
  });

  it("refuses an extension it can neither embed nor draw", async () => {
    const fx = await fixture();
    await writeFile(path.join(fx.root, "notes.txt"), "hello");
    await expectToolError(
      resolveImageSource(fx.config, { from: "notes.txt" }),
      /cannot use "notes\.txt" as an image/
    );
  });

  it("requires exactly one of from and source", async () => {
    const fx = await fixture();
    await expectToolError(resolveImageSource(fx.config, {}), /no image source/);
    await expectToolError(
      resolveImageSource(fx.config, { from: "a.png", source: FLOW }),
      /not both/
    );
  });

  it("fails loudly on a header it cannot read rather than guessing 1x1", async () => {
    const fx = await fixture();
    // A .png extension over bytes that are not a PNG — the routine case of an
    // extension that lies. A 1x1 placement would be invisible and unreportable.
    await writeFile(path.join(fx.root, "fake.png"), "this is not a png");
    await expectToolError(
      resolveImageSource(fx.config, { from: "fake.png" }),
      /could not read the pixel size of fake\.png/
    );
  });

  it("reads a JPEG's size by walking the segment chain", async () => {
    const fx = await fixture();
    await writeFile(path.join(fx.root, "photo.jpg"), jpeg(300, 200));
    const image = await resolveImageSource(fx.config, { from: "photo.jpg" });
    expect(image.mediaType).toBe("jpeg");
    // 300x200 px at the assumed 96 dpi → 225x150 pt.
    expect(image.width).toBeCloseTo(225, 5);
    expect(image.height).toBeCloseTo(150, 5);
  });

  it("skips a run of JPEG fill bytes instead of stepping over the frame header", async () => {
    // `FF FF C0` is legal padding before a marker. Advancing two bytes at a time
    // lands on the second `FF` and then past `C0`, so the frame header — the only
    // place the size lives — was skipped and the whole file reported unreadable.
    const fx = await fixture();
    await writeFile(path.join(fx.root, "padded.jpg"), jpeg(300, 200, { fillBytes: 3 }));
    const image = await resolveImageSource(fx.config, { from: "padded.jpg" });
    expect(image.width).toBeCloseTo(225, 5);
  });

  it("honours a JPEG's JFIF density", async () => {
    const fx = await fixture();
    await writeFile(path.join(fx.root, "dense.jpg"), jpeg(300, 300, { dpi: 300 }));
    const image = await resolveImageSource(fx.config, { from: "dense.jpg" });
    // 300 px at 300 dpi is one inch, which is 72 points.
    expect(image.width).toBeCloseTo(72, 5);
  });

  it("stops at the start of scan rather than finding a marker in the pixel data", async () => {
    // After SOS comes entropy-coded data, and `FF C0` occurs in it by coincidence.
    // A parser that keeps walking reports whatever those bytes happen to spell.
    const fx = await fixture();
    await writeFile(path.join(fx.root, "sosfirst.jpg"), jpegSosBeforeFrame());
    await expectToolError(
      resolveImageSource(fx.config, { from: "sosfirst.jpg" }),
      /could not read the pixel size/
    );
  });

  it("reads a GIF's logical screen size", async () => {
    const fx = await fixture();
    await writeFile(path.join(fx.root, "anim.gif"), gif(64, 32));
    const image = await resolveImageSource(fx.config, { from: "anim.gif" });
    expect(image.mediaType).toBe("gif");
    expect(image.width).toBeCloseTo(48, 5); // 64 px → 48 pt
    expect(image.height).toBeCloseTo(24, 5); // 32 px → 24 pt
  });

  it("rejects a three-byte `GIF` prefix that is not a real signature", async () => {
    // Checking only `GIF` accepts anything that starts with those letters; the
    // version block is what makes it a GIF.
    const fx = await fixture();
    const bytes = gif(64, 32);
    bytes.set([0x39, 0x39, 0x39], 3);
    await writeFile(path.join(fx.root, "fake.gif"), bytes);
    await expectToolError(
      resolveImageSource(fx.config, { from: "fake.gif" }),
      /could not read the pixel size/
    );
  });

  it("refuses a header declaring an impossible size", async () => {
    // Four bytes of caller-controlled integer. `0xffffffff` read as a width
    // produced a 3.2-billion-point placement, which reaches Excel as a nonsense
    // anchor and Word as an EMU value outside the format's range.
    const fx = await fixture();
    const bytes = pngHeader(96, 48);
    new DataView(bytes.buffer).setUint32(16, 0xffffffff);
    await writeFile(path.join(fx.root, "huge.png"), bytes);
    await expectToolError(
      resolveImageSource(fx.config, { from: "huge.png" }),
      /over the 40000 pixel per-axis limit/
    );
  });

  it("refuses a PNG whose IHDR is not an IHDR", async () => {
    const fx = await fixture();
    const bytes = pngHeader(96, 48);
    new DataView(bytes.buffer).setUint32(8, 99); // IHDR must declare length 13
    await writeFile(path.join(fx.root, "bad.png"), bytes);
    await expectToolError(
      resolveImageSource(fx.config, { from: "bad.png" }),
      /could not read the pixel size/
    );
  });

  it("honours a PNG's pHYs resolution", async () => {
    const fx = await fixture();
    const pixels = new Uint8Array(300 * 300 * 4);
    await writeFile(path.join(fx.root, "p300.png"), encodePng(pixels, 300, 300, { dpi: 300 }));
    const image = await resolveImageSource(fx.config, { from: "p300.png" });
    // Word and Excel honour pHYs, so ignoring it placed a 300-dpi photograph at
    // 3⅛ inches where those applications show one inch.
    expect(image.width).toBeCloseTo(72, 1);
    expect(image.height).toBeCloseTo(72, 1);
  });

  it("cannot reach outside the sandbox", async () => {
    const fx = await fixture();
    await expectToolError(
      resolveImageSource(fx.config, { from: "../../etc/hosts.png" }),
      /outside_root|not_found/
    );
  });
});

describe("sheet_write images", () => {
  it("embeds a file and a diagram, and the workbook reads them back", async () => {
    const fx = await fixture();
    await writePng(fx, "logo.png", 96, 48);
    const text = await run(sheetWriteTool, fx, {
      path: "report.xlsx",
      overwrite: true,
      sheets: [
        {
          name: "Sheet1",
          rows: [["region", "units"]],
          images: [
            { at: "D2", from: "logo.png" },
            { at: "A6:H26", source: FLOW }
          ]
        }
      ]
    });

    expect(text).toContain("placed logo.png at D2 (72×36 pt, png)");
    expect(text).toContain("sized to the range");
    // The diagram's structure, because nothing can look at the picture.
    expect(text).toContain("flowchart — 3 node(s), 2 edge(s)");

    const wb = Workbook.create();
    await Workbook.readFile(wb, path.join(fx.root, "report.xlsx"));
    const ws = Workbook.getWorksheets(wb)[0];
    expect(ws).toBeDefined();
    const placed = Image.list(ws as never);
    expect(placed).toHaveLength(2);
    expect(wb.media.map(entry => entry.extension)).toEqual(["png", "png"]);
  });

  it("anchors a single cell at its own size, in CSS pixels", async () => {
    const fx = await fixture();
    await writePng(fx, "logo.png", 96, 48);
    await run(sheetWriteTool, fx, {
      path: "one.xlsx",
      overwrite: true,
      sheets: [{ name: "S", rows: [["a"]], images: [{ at: "D2", from: "logo.png" }] }]
    });

    const wb = Workbook.create();
    await Workbook.readFile(wb, path.join(fx.root, "one.xlsx"));
    const anchor = Image.list(Workbook.getWorksheets(wb)[0] as never)[0]?.range as {
      tl?: { nativeCol?: number; nativeRow?: number };
      br?: unknown;
      ext?: { width: number; height: number };
      editAs?: string;
    };
    // D2 is column 3, row 1 zero-based.
    expect(anchor.tl?.nativeCol).toBe(3);
    expect(anchor.tl?.nativeRow).toBe(1);
    // The original pixels round-trip, which only holds if `ext` was written in
    // CSS pixels rather than points or EMU.
    expect(anchor.ext).toEqual({ width: 96, height: 48 });
    expect(anchor.editAs).toBe("oneCell");
    expect(anchor.br).toBeUndefined();
  });

  it("binds a range anchor to its cells instead of a size", async () => {
    const fx = await fixture();
    await run(sheetWriteTool, fx, {
      path: "range.xlsx",
      overwrite: true,
      sheets: [{ name: "S", rows: [["a"]], images: [{ at: "A6:H26", source: FLOW }] }]
    });
    const wb = Workbook.create();
    await Workbook.readFile(wb, path.join(fx.root, "range.xlsx"));
    const anchor = Image.list(Workbook.getWorksheets(wb)[0] as never)[0]?.range as {
      tl?: { nativeCol?: number; nativeRow?: number };
      br?: { nativeCol?: number; nativeRow?: number };
      ext?: unknown;
    };
    expect(anchor.tl?.nativeCol).toBe(0);
    expect(anchor.tl?.nativeRow).toBe(5);
    expect(anchor.br?.nativeCol).toBe(8);
    expect(anchor.br?.nativeRow).toBe(26);
    expect(anchor.ext).toBeUndefined();
  });

  it("writes nothing when an image cannot be read", async () => {
    const fx = await fixture();
    await expectToolError(
      run(sheetWriteTool, fx, {
        path: "never.xlsx",
        sheets: [{ name: "S", rows: [["a"]], images: [{ at: "A1", from: "missing.png" }] }]
      }),
      /not_found|no such file/
    );
    await expect(readFile(path.join(fx.root, "never.xlsx"))).rejects.toThrow();
  });

  it("rejects a malformed anchor", async () => {
    const fx = await fixture();
    await expectToolError(
      run(sheetWriteTool, fx, {
        path: "bad.xlsx",
        sheets: [{ name: "S", rows: [["a"]], images: [{ at: "nonsense", source: FLOW }] }]
      }),
      /invalid_input/
    );
  });
});

describe("sheet_edit add_image", () => {
  async function baseWorkbook(fx: Fixture, name: string): Promise<void> {
    const wb = Workbook.create();
    Workbook.addWorksheet(wb, "Data");
    await Workbook.writeFile(wb, path.join(fx.root, name));
  }

  it("adds a picture to an existing workbook without disturbing it", async () => {
    const fx = await fixture();
    await baseWorkbook(fx, "book.xlsx");
    await writePng(fx, "logo.png", 96, 48);

    const text = await run(sheetEditTool, fx, {
      path: "book.xlsx",
      out: "out.xlsx",
      ops: [
        { op: "add_image", at: "J2", from: "logo.png", width: 144 },
        { op: "add_image", at: "A10:F20", source: FLOW }
      ]
    });
    expect(text).toContain("placed logo.png at J2 (144×72 pt, png)");
    expect(text).toContain("flowchart — 3 node(s), 2 edge(s)");

    const wb = Workbook.create();
    await Workbook.readFile(wb, path.join(fx.root, "out.xlsx"));
    expect(Image.list(Workbook.getWorksheets(wb)[0] as never)).toHaveLength(2);
  });

  it("describes the placement under dryRun and writes nothing", async () => {
    const fx = await fixture();
    await baseWorkbook(fx, "book.xlsx");
    await writePng(fx, "logo.png", 96, 48);
    const text = await run(sheetEditTool, fx, {
      path: "book.xlsx",
      out: "never.xlsx",
      dryRun: true,
      ops: [{ op: "add_image", at: "B2", from: "logo.png" }]
    });
    expect(text).toContain("Dry run");
    expect(text).toContain("placed logo.png at B2");
    await expect(readFile(path.join(fx.root, "never.xlsx"))).rejects.toThrow();
  });

  it("leaves the input untouched when the image is unreadable", async () => {
    const fx = await fixture();
    await baseWorkbook(fx, "book.xlsx");
    const before = await readFile(path.join(fx.root, "book.xlsx"));
    await expectToolError(
      run(sheetEditTool, fx, {
        path: "book.xlsx",
        out: "out.xlsx",
        ops: [{ op: "add_image", at: "B2", from: "gone.png" }]
      }),
      /not_found|no such file/
    );
    expect(await readFile(path.join(fx.root, "book.xlsx"))).toEqual(before);
  });
});

describe("template_fill images", () => {
  /** A template with a text placeholder and two image placeholders. */
  async function template(fx: Fixture, name: string): Promise<void> {
    const doc = Document.create();
    Document.addParagraph(doc, "Invoice for {{client}}");
    Document.addParagraph(doc, "{{%logo}}");
    Document.addParagraph(doc, "{{%flow}}");
    await Io.writeFile(Document.build(doc), path.join(fx.root, name));
  }

  it("fills an image placeholder from a file and from a diagram", async () => {
    const fx = await fixture();
    await template(fx, "tpl.docx");
    await writePng(fx, "logo.png", 96, 48);

    const text = await run(templateFillTool, fx, {
      template: "tpl.docx",
      out: "filled.docx",
      data: { client: "Acme" },
      images: { logo: { from: "logo.png" }, flow: { source: FLOW } }
    });

    expect(text).toContain("`{{%logo}}` ← logo.png (72×36 pt, `mcpimg-logo.png`)");
    expect(text).toContain("flowchart — 3 node(s), 2 edge(s)");
    expect(text).toContain("every placeholder was filled");

    const filled = await Io.readFile(path.join(fx.root, "filled.docx"));
    // Two real media parts, not two lines of JSON where the pictures should be.
    expect(filled.images).toHaveLength(2);
    const body = Query.extractText(filled);
    expect(body).toContain("Invoice for Acme");
    expect(body).not.toContain("{{%logo}}");
    expect(body).not.toContain("{{");
    expect(Template.listTemplateTags(filled)).toHaveLength(0);
  });

  it("writes the *filled* document, not the template it was handed", async () => {
    // The enhanced fill is not in-place: it returns a new document and leaves the
    // caller's untouched. Ignoring the return value produced a file that saved
    // successfully with every placeholder still in it, and reported success.
    const fx = await fixture();
    await template(fx, "tpl.docx");
    await writePng(fx, "logo.png", 96, 48);
    await run(templateFillTool, fx, {
      template: "tpl.docx",
      out: "filled.docx",
      data: { client: "Acme" },
      images: { logo: { from: "logo.png" }, flow: { source: FLOW } }
    });
    const filled = await Io.readFile(path.join(fx.root, "filled.docx"));
    expect(Query.extractText(filled)).not.toContain("{{");
  });

  it("still fills a text-only template with no images argument", async () => {
    const fx = await fixture();
    const doc = Document.create();
    Document.addParagraph(doc, "Hello {{name}}");
    await Io.writeFile(Document.build(doc), path.join(fx.root, "text.docx"));

    const text = await run(templateFillTool, fx, {
      template: "text.docx",
      out: "out.docx",
      data: { name: "World" }
    });
    expect(text).toContain("every placeholder was filled");
    expect(Query.extractText(await Io.readFile(path.join(fx.root, "out.docx")))).toContain(
      "Hello World"
    );
  });

  it("names the real placeholders when a key is misspelled", async () => {
    const fx = await fixture();
    await template(fx, "tpl.docx");
    await writePng(fx, "logo.png", 96, 48);
    await expectToolError(
      run(templateFillTool, fx, {
        template: "tpl.docx",
        out: "x.docx",
        data: { client: "A" },
        images: { logoo: { from: "logo.png" } }
      }),
      /no image placeholder for "logoo"[\s\S]*\{\{%logo\}\}/
    );
    await expect(readFile(path.join(fx.root, "x.docx"))).rejects.toThrow();
  });

  it("says so when the template has no image placeholder at all", async () => {
    const fx = await fixture();
    const doc = Document.create();
    Document.addParagraph(doc, "Hello {{name}}");
    await Io.writeFile(Document.build(doc), path.join(fx.root, "text.docx"));
    await writePng(fx, "logo.png", 96, 48);
    await expectToolError(
      run(templateFillTool, fx, {
        template: "text.docx",
        out: "x.docx",
        data: { name: "A" },
        images: { logo: { from: "logo.png" } }
      }),
      /no `\{\{%name\}\}` image placeholder at all/
    );
  });

  it("caps an oversized image to the text column", async () => {
    const fx = await fixture();
    await template(fx, "tpl.docx");
    await writePng(fx, "huge.png", 2000, 500);
    const text = await run(templateFillTool, fx, {
      template: "tpl.docx",
      out: "capped.docx",
      data: { client: "A" },
      images: { logo: { from: "huge.png" }, flow: { source: FLOW } }
    });
    // 2000 px → 1500 pt natural, capped to the 468 pt text column.
    expect(text).toContain("468×117 pt");
    const filled = await Io.readFile(path.join(fx.root, "capped.docx"));
    const widths = filled.body
      .flatMap(block => ("children" in block ? block.children : []))
      .flatMap(run_ => ("content" in run_ ? run_.content : []))
      .filter(entry => entry.type === "image")
      .map(entry => (entry as { width: number }).width);
    expect(widths[0]).toBe(468 * 12700);
  });
});

describe("template_inspect", () => {
  it("routes image placeholders to `images`, not to the data shape", async () => {
    const fx = await fixture();
    const doc = Document.create();
    Document.addParagraph(doc, "Invoice for {{client}}");
    Document.addParagraph(doc, "{{%logo}}");
    await Io.writeFile(Document.build(doc), path.join(fx.root, "tpl.docx"));

    const text = await run(templateInspectTool, fx, { path: "tpl.docx" });
    expect(text).toContain("image placeholders: 1");
    expect(text).toContain("## Image placeholders");
    expect(text).toContain("`{{%logo}}` → `images.logo`");
    expect(text).toContain("Pass the fillable ones in `images`");
    // The data shape must not invite a string for it.
    const shape = /```json\n([\s\S]*?)```/.exec(text)?.[1] ?? "";
    expect(shape).toContain("client");
    expect(shape).not.toContain("logo");
  });
});

describe("image placeholders outside the body", () => {
  // The engine's image pass walks `doc.body` only, so a header placeholder can
  // never be substituted. Asserted against the guard directly: building a header
  // template through the builder proves nothing extra about the rule.
  const bodyTag = { expression: "%logo", type: "image", location: "body paragraph 1" };
  const headerTag = { expression: "%mark", type: "image", location: "header:default" };
  const cellTag = { expression: "%cell", type: "image", location: "body table 0 row 1 cell 0" };
  const loopTag = { expression: "%.photo", type: "image", location: "body paragraph 2" };

  it("accepts a placeholder anywhere the engine now reaches", () => {
    // Body, header and table cell are all fillable; only the loop case is not.
    expect(() =>
      assertImagePlaceholdersExist([bodyTag, headerTag, cellTag], ["logo", "mark", "cell"])
    ).not.toThrow();
  });

  it("refuses a loop-scoped placeholder, which nothing can fill", () => {
    expectToolErrorSync(
      () => assertImagePlaceholdersExist([loopTag], [".photo"]),
      /scoped to a \{\{#each\}\} item/
    );
  });

  it("ignores a loop-scoped placeholder nobody supplied an image for", () => {
    expect(() => assertImagePlaceholdersExist([bodyTag, loopTag], ["logo"])).not.toThrow();
  });

  it("does nothing when no images were supplied", () => {
    expect(() => assertImagePlaceholdersExist([loopTag], [])).not.toThrow();
  });
});

/**
 * The verification loop.
 *
 * Every write tool here ends by telling the model to read the file back. For a
 * picture that instruction used to be unfollowable: `sheet_read` renders cells and
 * a picture occupies none, so a model that had just placed a logo could only take
 * the write tool's word for it. These pin the reports that close the loop.
 */
describe("reading images back", () => {
  async function workbookWithImages(fx: Fixture, name: string): Promise<void> {
    await writePng(fx, "logo.png", 96, 48);
    await run(sheetWriteTool, fx, {
      path: name,
      overwrite: true,
      sheets: [
        {
          name: "June",
          rows: [
            ["region", "units"],
            ["APAC", 10]
          ],
          images: [
            { at: "D1", from: "logo.png" },
            { at: "A6:H26", source: FLOW }
          ]
        },
        { name: "Blank", rows: [["x"]] }
      ]
    });
  }

  it("sheet_read names the pictures and their anchors", async () => {
    const fx = await fixture();
    await workbookWithImages(fx, "report.xlsx");
    const text = await run(sheetReadTool, fx, { path: "report.xlsx", sheet: "June" });
    expect(text).toContain("- images: 2");
    expect(text).toContain("D1");
    // The range the caller asked for, not the exclusive edge anchor the file
    // stores: reporting `A6:I27` here reads as an off-by-one in the placement.
    expect(text).toContain("A6:H26");
    expect(text).not.toContain("A6:I27");
    expect(text).toContain("a picture occupies no cell");
  });

  it("sheet_read says nothing about images on a sheet that has none", async () => {
    const fx = await fixture();
    await workbookWithImages(fx, "report.xlsx");
    const text = await run(sheetReadTool, fx, { path: "report.xlsx", sheet: "Blank" });
    expect(text).not.toContain("images:");
  });

  it("doc_inspect counts them per sheet", async () => {
    const fx = await fixture();
    await workbookWithImages(fx, "report.xlsx");
    const text = await run(inspectTool, fx, { path: "report.xlsx" });
    expect(text).toContain("| images |");
    expect(text).toContain("This workbook holds 2 picture(s).");
    // Two sheets, and only one of them holds anything.
    expect(text).toMatch(/\| `June` \|.*\| 2 \|/);
    expect(text).toMatch(/\| `Blank` \|.*\| 0 \|/);
  });

  it("doc_inspect stays quiet about pictures in a workbook with none", async () => {
    const fx = await fixture();
    await run(sheetWriteTool, fx, {
      path: "plain.xlsx",
      overwrite: true,
      sheets: [{ name: "S", rows: [["a"]] }]
    });
    const text = await run(inspectTool, fx, { path: "plain.xlsx" });
    expect(text).not.toContain("picture(s)");
  });

  it("doc_read already reports a Word document's image count", async () => {
    const fx = await fixture();
    const doc = Document.create();
    Document.addParagraph(doc, "Invoice for {{client}}");
    Document.addParagraph(doc, "{{%logo}}");
    await Io.writeFile(Document.build(doc), path.join(fx.root, "tpl.docx"));
    await writePng(fx, "logo.png", 96, 48);
    await run(templateFillTool, fx, {
      template: "tpl.docx",
      out: "filled.docx",
      data: { client: "Acme" },
      images: { logo: { from: "logo.png" } }
    });
    const text = await run(docReadTool, fx, { path: "filled.docx" });
    expect(text).toContain("- images: 1");
  });
});

/**
 * The three ways a template image cannot work, and how each is reported.
 *
 * All three used to end in a message that sent the model somewhere useless — the
 * generic "add it to `data`", which is the one place a picture can never go, and for
 * a loop-scoped placeholder is wrong twice because nothing can fill it at all.
 */
describe("template images that cannot be filled", () => {
  async function template(fx: Fixture, name: string, paragraphs: readonly string[]): Promise<void> {
    const doc = Document.create();
    for (const paragraph of paragraphs) {
      Document.addParagraph(doc, paragraph);
    }
    await Io.writeFile(Document.build(doc), path.join(fx.root, name));
  }

  it("refuses a placeholder scoped to a {{#each}} item, and says why", async () => {
    const fx = await fixture();
    await template(fx, "loop.docx", ["{{#each items}}", "{{%.photo}}", "{{/each}}"]);
    await writePng(fx, "logo.png", 96, 48);
    await expectToolError(
      run(templateFillTool, fx, {
        template: "loop.docx",
        out: "x.docx",
        data: { items: [{}] },
        images: { ".photo": { from: "logo.png" } }
      }),
      /scoped to a \{\{#each\}\} item[\s\S]*before loops are expanded/
    );
  });

  it("explains a loop-scoped placeholder even when no image was supplied for it", async () => {
    const fx = await fixture();
    await template(fx, "loop.docx", ["{{#each items}}", "{{%.photo}}", "{{/each}}"]);
    // The engine reports "Unresolved variable"; the hint has to say that nothing
    // can resolve it, rather than telling the model to add it to `data`.
    await expectToolError(
      run(templateFillTool, fx, { template: "loop.docx", out: "x.docx", data: { items: [{}] } }),
      /nothing can fill: it is scoped to a \{\{#each\}\} item/
    );
  });

  it("points an unfilled image placeholder at `images`, not at `data`", async () => {
    const fx = await fixture();
    await template(fx, "plain.docx", ["{{%logo}}"]);
    await expectToolError(
      run(templateFillTool, fx, { template: "plain.docx", out: "x.docx", data: {} }),
      /is an \*\*image\*\* placeholder — pass it in `images` \(keyed `logo`/
    );
  });

  it("template_inspect marks an unfillable placeholder instead of inventing a key", async () => {
    const fx = await fixture();
    await template(fx, "loop.docx", ["{{#each items}}", "{{%.photo}}", "{{/each}}"]);
    const text = await run(templateInspectTool, fx, { path: "loop.docx" });
    expect(text).toContain("cannot be filled");
    expect(text).toContain("scoped to a {{#each}} item");
    // The old behaviour derived a nonsense key from the dotted expression.
    expect(text).not.toContain("images..photo");
  });

  it("reports a picture dropped by a false conditional rather than claiming it landed", async () => {
    const fx = await fixture();
    await template(fx, "cond.docx", ["{{#if showLogo}}", "{{%logo}}", "{{/if}}", "End."]);
    await writePng(fx, "logo.png", 96, 48);

    // Images are substituted before conditionals are evaluated, so the picture is
    // put in and then removed with its block. The fill succeeds; the claim must not.
    const off = await run(templateFillTool, fx, {
      template: "cond.docx",
      out: "off.docx",
      data: { showLogo: false },
      images: { logo: { from: "logo.png" } }
    });
    expect(off).toContain("**not in the output**");
    expect(off).toContain("Do not report it as added");
    expect(Query.extractText(await Io.readFile(path.join(fx.root, "off.docx")))).not.toContain(
      "{{"
    );

    const on = await run(templateFillTool, fx, {
      template: "cond.docx",
      out: "on.docx",
      data: { showLogo: true },
      images: { logo: { from: "logo.png" } }
    });
    expect(on).not.toContain("not in the output");
  });

  it("fills a placeholder in a table cell", async () => {
    // The engine's image pass did not descend into tables, so the commonest
    // letterhead layout was the one placement that could not be filled. Fixed in
    // the engine rather than refused here.
    const fx = await fixture();
    const doc = Document.create();
    Document.addTable(doc, [["{{%logo}}", "Acme Ltd"]]);
    await Io.writeFile(Document.build(doc), path.join(fx.root, "table.docx"));
    await writePng(fx, "logo.png", 96, 48);

    const text = await run(templateFillTool, fx, {
      template: "table.docx",
      out: "out.docx",
      data: {},
      images: { logo: { from: "logo.png" } }
    });
    expect(text).not.toContain("could not be verified");
    expect((await Io.readFile(path.join(fx.root, "out.docx"))).images).toHaveLength(1);
  });

  it("fills a placeholder in a header, and does not then prune it", async () => {
    // Two bugs met here. The engine never ran its image pass over headers, and once
    // it did, this package's own unreferenced-media pruning — which only walked the
    // body — deleted the picture it had just correctly placed.
    const fx = await fixture();
    const doc = Document.create();
    Document.addParagraph(doc, "Body text");
    Document.setHeader(doc, "default", { children: [Build.textParagraph("{{%logo}}")] });
    await Io.writeFile(Document.build(doc), path.join(fx.root, "header.docx"));
    await writePng(fx, "logo.png", 96, 48);

    const text = await run(templateFillTool, fx, {
      template: "header.docx",
      out: "out.docx",
      data: {},
      images: { logo: { from: "logo.png" } }
    });
    expect(text).not.toContain("could not be verified");
    expect(text).not.toContain("not in the output");

    const archive = await ArchiveFile.fromFile(path.join(fx.root, "out.docx"));
    const media = (await archive.getEntries())
      .map(entry => entry.path)
      .filter(entryPath => entryPath.includes("media"));
    expect(media).toHaveLength(1);
  });

  it("verifies a header image by media name, not by a per-part relationship id", async () => {
    // A relationship is per part, so the header's `rId_x` and the document part's
    // `rId5` are unrelated numbers that merely look comparable. Matching them
    // reported a correctly placed header logo as unverifiable.
    const fx = await fixture();
    const doc = Document.create();
    Document.addParagraph(doc, "Body");
    Document.setHeader(doc, "default", { children: [Build.textParagraph("{{%logo}}")] });
    await Io.writeFile(Document.build(doc), path.join(fx.root, "hdr.docx"));
    await writePng(fx, "logo.png", 96, 48);
    await run(templateFillTool, fx, {
      template: "hdr.docx",
      out: "out.docx",
      data: {},
      images: { logo: { from: "logo.png" } }
    });

    const reopened = await Io.readFile(path.join(fx.root, "out.docx"));
    const headerRun = [...(reopened.headers?.values() ?? [])]
      .flatMap(part => part.content.children)
      .flatMap(block => ("children" in block ? block.children : []))
      .flatMap(entry => ("content" in entry ? entry.content : []))
      .find(entry => entry.type === "image") as { rId: string; name?: string } | undefined;
    expect(headerRun).toBeDefined();
    // The ids genuinely differ, which is why the name is what gets matched.
    expect(reopened.images?.[0]?.rId).not.toBe(headerRun?.rId);
    expect(headerRun?.name).toBe("mcpimg-logo.png");
  });

  it("still finds a legitimately placed image when checking the output", async () => {
    // The reference walk recurses into tables so that a picture the *engine* put in
    // a cell — via a loop expanding a row, say — is not reported as dropped. A false
    // alarm is as damaging as a missed one.
    const fx = await fixture();
    await template(fx, "plain.docx", ["{{%logo}}"]);
    await writePng(fx, "logo.png", 96, 48);
    const text = await run(templateFillTool, fx, {
      template: "plain.docx",
      out: "out.docx",
      data: {},
      images: { logo: { from: "logo.png" } }
    });
    expect(text).not.toContain("not in the output");
    expect((await Io.readFile(path.join(fx.root, "out.docx"))).images).toHaveLength(1);
  });
});

/**
 * The bugs an independent review found after the feature was "done and green".
 *
 * Grouped deliberately: every one of them passed the previous test suite, and all
 * but two produced a *successful* report over a wrong or absent result. That is the
 * failure mode of a tool whose output nobody can look at, so each gets a test that
 * asserts the artefact rather than the report.
 */
describe("template media integrity", () => {
  async function template(fx: Fixture, name: string, paragraphs: readonly string[]): Promise<void> {
    const doc = Document.create();
    for (const paragraph of paragraphs) {
      Document.addParagraph(doc, paragraph);
    }
    await Io.writeFile(Document.build(doc), path.join(fx.root, name));
  }

  it("refuses a name that is both a text field and an image", async () => {
    // Images share the engine's data namespace, so a flat merge let the image
    // object win — and `{{logo}}` then rendered the whole TemplateImage as JSON,
    // pixel bytes included, into the document where a client's name belonged.
    const fx = await fixture();
    await template(fx, "collide.docx", ["Client: {{logo}}", "{{%logo}}"]);
    await writePng(fx, "logo.png", 96, 48);
    await expectToolError(
      run(templateFillTool, fx, {
        template: "collide.docx",
        out: "x.docx",
        data: { logo: "Acme" },
        images: { logo: { from: "logo.png" } }
      }),
      /`images\.logo` collides with `data\.logo`/
    );
    await expect(readFile(path.join(fx.root, "x.docx"))).rejects.toThrow();
  });

  it("fills a dotted image placeholder, which is a path and not a name", async () => {
    // `{{%client.logo}}` resolves `client` then `logo`, so a flat
    // `data["client.logo"]` was never found and the fill failed on a placeholder
    // the guard had just reported as available.
    const fx = await fixture();
    await template(fx, "dotted.docx", ["{{%client.logo}}"]);
    await writePng(fx, "logo.png", 96, 48);
    await run(templateFillTool, fx, {
      template: "dotted.docx",
      out: "out.docx",
      data: {},
      images: { "client.logo": { from: "logo.png" } }
    });
    const filled = await Io.readFile(path.join(fx.root, "out.docx"));
    expect(filled.images).toHaveLength(1);
    expect(Query.extractText(filled)).not.toContain("{{");
  });

  it("keeps a dotted image alongside other data under the same parent", async () => {
    const fx = await fixture();
    await template(fx, "mixed.docx", ["{{client.name}}", "{{%client.logo}}"]);
    await writePng(fx, "logo.png", 96, 48);
    await run(templateFillTool, fx, {
      template: "mixed.docx",
      out: "out.docx",
      data: { client: { name: "Acme" } },
      images: { "client.logo": { from: "logo.png" } }
    });
    const filled = await Io.readFile(path.join(fx.root, "out.docx"));
    expect(Query.extractText(filled)).toContain("Acme");
    expect(filled.images).toHaveLength(1);
  });

  it("gives two pictures of the same kind distinct media parts", async () => {
    // The engine de-duplicates media by file name, and every Mermaid flowchart was
    // called `flowchart-diagram.png` — so a template with two flowchart
    // placeholders got one picture, shown twice, and reported as two.
    const fx = await fixture();
    await template(fx, "two.docx", ["{{%one}}", "{{%two}}"]);
    const text = await run(templateFillTool, fx, {
      template: "two.docx",
      out: "out.docx",
      data: {},
      images: {
        one: { source: "flowchart LR\n A --> B" },
        two: { source: "flowchart LR\n X --> Y" }
      }
    });
    expect(text).not.toContain("could not be verified");

    const filled = await Io.readFile(path.join(fx.root, "out.docx"));
    expect(filled.images).toHaveLength(2);
    const names = (filled.images ?? []).map(entry => entry.fileName);
    expect(new Set(names).size, `media names collided: ${names.join(", ")}`).toBe(2);
    // Two different diagrams, so two different byte strings.
    expect((filled.images ?? [])[0]?.data).not.toEqual((filled.images ?? [])[1]?.data);
  });

  it("does not collide with media the template already carries", async () => {
    const fx = await fixture();
    await writePng(fx, "logo.png", 96, 48);
    // A template that already holds an image, then a fill that adds another.
    const doc = Document.create();
    Document.addImage(
      doc,
      new Uint8Array(await readFile(path.join(fx.root, "logo.png"))),
      "png",
      914400,
      457200
    );
    Document.addParagraph(doc, "{{%logo}}");
    await Io.writeFile(Document.build(doc), path.join(fx.root, "has-media.docx"));

    await run(templateFillTool, fx, {
      template: "has-media.docx",
      out: "out.docx",
      data: {},
      images: { logo: { from: "logo.png" } }
    });
    const filled = await Io.readFile(path.join(fx.root, "out.docx"));
    const names = (filled.images ?? []).map(entry => entry.fileName);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBe(2);
  });

  it("drops the bytes of a picture a false conditional removed", async () => {
    // Not file bloat: the paragraph is gone but the media part remained, so anyone
    // who unzipped the .docx could recover a picture the document withheld. For a
    // signature or an ID photo behind a conditional that is a data leak.
    const fx = await fixture();
    await template(fx, "cond.docx", ["{{#if show}}", "{{%logo}}", "{{/if}}", "End."]);
    await writePng(fx, "logo.png", 96, 48);
    const text = await run(templateFillTool, fx, {
      template: "cond.docx",
      out: "off.docx",
      data: { show: false },
      images: { logo: { from: "logo.png" } }
    });
    expect(text).toContain("not in the output");
    expect(text).toContain("bytes were dropped from the package");

    const archive = await ArchiveFile.fromFile(path.join(fx.root, "off.docx"));
    const media = (await archive.getEntries())
      .map(entry => entry.path)
      .filter(entryPath => entryPath.includes("media"));
    expect(media, "the withheld picture is still recoverable from the package").toEqual([]);
  });

  it("keeps the bytes when the conditional is true", async () => {
    const fx = await fixture();
    await template(fx, "cond.docx", ["{{#if show}}", "{{%logo}}", "{{/if}}", "End."]);
    await writePng(fx, "logo.png", 96, 48);
    await run(templateFillTool, fx, {
      template: "cond.docx",
      out: "on.docx",
      data: { show: true },
      images: { logo: { from: "logo.png" } }
    });
    const archive = await ArchiveFile.fromFile(path.join(fx.root, "on.docx"));
    const media = (await archive.getEntries())
      .map(entry => entry.path)
      .filter(entryPath => entryPath.includes("media"));
    expect(media).toHaveLength(1);
  });

  it("verifies the written file, not the document handed to the writer", async () => {
    const fx = await fixture();
    await template(fx, "tpl.docx", ["{{%logo}}"]);
    await writePng(fx, "logo.png", 96, 48);
    const text = await run(templateFillTool, fx, {
      template: "tpl.docx",
      out: "out.docx",
      data: {},
      images: { logo: { from: "logo.png" } }
    });
    // The report names the media part, which only a re-read can supply.
    expect(text).toContain("`mcpimg-logo.png`");
    expect(text).not.toContain("could not be verified");

    // And the relationship really resolves in the package.
    const filled = await Io.readFile(path.join(fx.root, "out.docx"));
    const rIds = new Set((filled.images ?? []).map(entry => entry.rId));
    const referenced = filled.body
      .flatMap(block => ("children" in block ? block.children : []))
      .flatMap(run_ => ("content" in run_ ? run_.content : []))
      .filter(entry => entry.type === "image")
      .map(entry => (entry as { rId: string }).rId);
    expect(referenced).toHaveLength(1);
    expect(rIds.has(referenced[0] as string)).toBe(true);
  });
});

describe("aggregate resource budget", () => {
  it("refuses more images in one call than it will hold in memory", async () => {
    const fx = await fixture();
    await writePng(fx, "logo.png", 8, 8);
    await expectToolError(
      run(sheetWriteTool, fx, {
        path: "many.xlsx",
        sheets: [
          {
            name: "S",
            rows: [["a"]],
            images: Array.from({ length: 21 }, (_, index) => ({
              at: `A${index + 1}`,
              from: "logo.png"
            }))
          }
        ]
      }),
      /more than 20 images/
    );
    await expect(readFile(path.join(fx.root, "many.xlsx"))).rejects.toThrow();
  });

  it("counts the budget across sheets, not per sheet", async () => {
    // Twenty sheets of one picture each is the same memory as one sheet of twenty.
    const fx = await fixture();
    await writePng(fx, "logo.png", 8, 8);
    await expectToolError(
      run(sheetWriteTool, fx, {
        path: "spread.xlsx",
        sheets: Array.from({ length: 21 }, (_, index) => ({
          name: `S${index}`,
          rows: [["a"]],
          images: [{ at: "A1", from: "logo.png" }]
        }))
      }),
      /more than 20 images/
    );
  });

  it("caps the diagrams one document may embed", async () => {
    const fx = await fixture();
    const fence = ["```mermaid", "flowchart LR", " A --> B", "```", ""].join("\n");
    await expectToolError(
      run(docWriteTool, fx, {
        path: "many.docx",
        markdown: `# T\n\n${fence.repeat(21)}`
      }),
      /over the 20 limit/
    );
  });
});

describe("markdown fence scanning corrections", () => {
  it("finds a fence in a CRLF document", async () => {
    // `split("\n")` leaves the carriage return on every line, so a `$`-anchored
    // pattern matched none of them: a Windows-authored file reported zero fences
    // and doc_write silently embedded the diagram as a code block.
    const fx = await fixture();
    await writeFile(
      path.join(fx.root, "crlf.md"),
      "# T\r\n\r\n```mermaid\r\nflowchart LR\r\n  A --> B\r\n```\r\n"
    );
    const text = await run(diagramInspectTool, fx, { from: "crlf.md" });
    expect(text).toContain("2 node(s), 1 edge(s)");
  });

  it("embeds a CRLF document's diagram rather than leaving it as code", async () => {
    const fx = await fixture();
    const text = await run(docWriteTool, fx, {
      path: "crlf.docx",
      markdown: "Intro\r\n\r\n```mermaid\r\nflowchart LR\r\n  A --> B\r\n```\r\n\r\nEnd\r\n"
    });
    expect(text).toContain("1 mermaid diagram(s) rendered");
    expect((await Io.readFile(path.join(fx.root, "crlf.docx"))).images).toHaveLength(1);
  });

  it("treats a fence inside another fenced block as the example it is", async () => {
    // A ```mermaid inside a ````markdown block is documentation *about* a diagram.
    // Rendering it produced a picture nobody asked for, left the substituted
    // reference inside a code block where nothing consumed it, and still reported
    // the diagram as embedded.
    const fx = await fixture();
    const markdown = [
      "How to write one:",
      "",
      "````markdown",
      "```mermaid",
      "flowchart LR",
      "  A --> B",
      "```",
      "````",
      ""
    ].join("\n");
    const text = await run(docWriteTool, fx, { path: "doc.docx", markdown });
    expect(text).not.toContain("mermaid diagram(s) rendered");
    const doc = await Io.readFile(path.join(fx.root, "doc.docx"));
    expect(doc.images ?? []).toHaveLength(0);
    // The example survives as text, which is the whole point of writing it.
    expect(Query.extractText(doc)).toContain("flowchart LR");
  });

  it("still finds a plain fence, and one after a closed code block", async () => {
    const fx = await fixture();
    const markdown = [
      "```ts",
      "const a = 1;",
      "```",
      "",
      "```mermaid",
      "flowchart LR",
      "  A --> B",
      "```",
      ""
    ].join("\n");
    const text = await run(docWriteTool, fx, { path: "after.docx", markdown });
    expect(text).toContain("1 mermaid diagram(s) rendered");
  });
});

describe("worksheet anchor semantics", () => {
  it("binds a range anchor so it resizes with its cells, as documented", async () => {
    // Passing the range as a string defaults the anchor to `oneCell`, which moves
    // the picture with its cells but does not resize it — so the promise that it
    // "moves and resizes with them" was half false.
    const fx = await fixture();
    await writePng(fx, "logo.png", 96, 48);
    await run(sheetWriteTool, fx, {
      path: "range.xlsx",
      overwrite: true,
      sheets: [{ name: "S", rows: [["a"]], images: [{ at: "A6:H26", from: "logo.png" }] }]
    });

    const archive = await ArchiveFile.fromFile(path.join(fx.root, "range.xlsx"));
    const drawing = (await archive.getEntries()).find(entry =>
      entry.path.includes("drawings/drawing")
    );
    expect(drawing).toBeDefined();
    const entryBytes = await archive.readEntry(drawing?.path as string);
    expect(entryBytes).not.toBeNull();
    const xml = new TextDecoder().decode(entryBytes as Uint8Array);
    expect(xml).toContain("<xdr:twoCellAnchor>");
    // No `editAs` on a twoCellAnchor means the OOXML default, which is twoCell.
    expect(xml).not.toContain('twoCellAnchor editAs="oneCell"');
  });

  it("rejects a cell past Excel's last row", async () => {
    // The single-cell branch skipped the range parser, so `A1048577` reached the
    // drawing XML as an anchor Excel cannot open.
    const fx = await fixture();
    await writePng(fx, "logo.png", 96, 48);
    await expectToolError(
      run(sheetWriteTool, fx, {
        path: "bad.xlsx",
        sheets: [{ name: "S", rows: [["a"]], images: [{ at: "A1048577", from: "logo.png" }] }]
      }),
      /invalid_input|not a valid rectangle/
    );
  });

  it("rejects a size that rounds away to nothing", async () => {
    const fx = await fixture();
    await writePng(fx, "logo.png", 96, 48);
    await expectToolError(
      run(sheetWriteTool, fx, {
        path: "tiny.xlsx",
        sheets: [{ name: "S", rows: [["a"]], images: [{ at: "B2", from: "logo.png", width: 0.3 }] }]
      }),
      /rounds away to nothing/
    );
  });

  it("reports pictures on a sheet that has no cell data", async () => {
    // "Empty" is about cells. A sheet holding nothing but an image reported itself
    // empty, which made the placement unverifiable by the one call every write
    // tool tells you to make.
    const fx = await fixture();
    await writePng(fx, "logo.png", 96, 48);
    await run(sheetWriteTool, fx, {
      path: "pic.xlsx",
      overwrite: true,
      sheets: [{ name: "Pic", images: [{ at: "B3", from: "logo.png" }] }]
    });
    const text = await run(sheetReadTool, fx, { path: "pic.xlsx", sheet: "Pic" });
    expect(text).toContain("no cell data, but it does hold pictures");
    expect(text).toContain("B3");
  });
});

describe("doc_inspect on a raster image", () => {
  it("identifies it by magic bytes and reports the size it would be placed at", async () => {
    // The image tools tell the model to "run doc_inspect" when a header will not
    // parse. Before this, doc_inspect answered `unknown` for every .png.
    const fx = await fixture();
    const pixels = new Uint8Array(300 * 300 * 4);
    await writeFile(path.join(fx.root, "photo.png"), encodePng(pixels, 300, 300, { dpi: 300 }));
    const text = await run(inspectTool, fx, { path: "photo.png" });
    expect(text).toContain("image");
    expect(text).toContain("300×300");
    expect(text).toContain("300 dpi");
    expect(text).toContain("72×72 pt");
    expect(text).toContain("template_fill");
  });

  it("says so when the bytes are not a readable image", async () => {
    const fx = await fixture();
    await writeFile(path.join(fx.root, "broken.png"), pngHeader(96, 48).subarray(0, 20));
    const text = await run(inspectTool, fx, { path: "broken.png" });
    expect(text).toContain("could not be read");
  });
});

/**
 * Integrity, as distinct from a readable header.
 *
 * Truncation is how an image actually arrives broken — an interrupted download, a
 * partial copy — and a header check cannot see it: the first 24 bytes of a truncated
 * PNG are identical to the first 24 bytes of a whole one. Embedding it produces a
 * document showing a broken-image box, reported as a success, over a picture nobody
 * downstream can look at.
 */
describe("image integrity", () => {
  it("accepts a complete PNG", async () => {
    const fx = await fixture();
    await writePng(fx, "whole.png", 64, 64);
    const image = await resolveImageSource(fx.config, { from: "whole.png" });
    expect(image.width).toBeCloseTo(48, 5);
  });

  it("rejects a PNG truncated mid-stream", async () => {
    const fx = await fixture();
    await writePng(fx, "whole.png", 64, 64);
    const whole = new Uint8Array(await readFile(path.join(fx.root, "whole.png")));
    await writeFile(path.join(fx.root, "cut.png"), whole.subarray(0, whole.length - 40));
    await expectToolError(
      resolveImageSource(fx.config, { from: "cut.png" }),
      /not a usable PNG file[\s\S]*truncated/
    );
  });

  it("rejects a PNG with no IEND, even when every chunk before it is intact", async () => {
    const fx = await fixture();
    await writePng(fx, "whole.png", 32, 32);
    const whole = new Uint8Array(await readFile(path.join(fx.root, "whole.png")));
    // IEND is the final 12 bytes: length, type, empty payload, CRC.
    await writeFile(path.join(fx.root, "noend.png"), whole.subarray(0, whole.length - 12));
    await expectToolError(
      resolveImageSource(fx.config, { from: "noend.png" }),
      /no IEND chunk, so it is truncated/
    );
  });

  it("rejects a PNG whose bytes were altered, by its CRC", async () => {
    // The CRC is why PNG corruption is detectable at all, and checking it is what
    // turns "these bytes look like a PNG" into "these bytes are the PNG that was
    // written".
    const fx = await fixture();
    await writePng(fx, "whole.png", 32, 32);
    const bytes = new Uint8Array(await readFile(path.join(fx.root, "whole.png")));
    // Flip a byte inside the image data, leaving every length and marker intact.
    const at = bytes.length - 30;
    bytes[at] = (bytes[at] ?? 0) ^ 0xff;
    await writeFile(path.join(fx.root, "bitrot.png"), bytes);
    await expectToolError(
      resolveImageSource(fx.config, { from: "bitrot.png" }),
      /fails its CRC, so the file is corrupt/
    );
  });

  it("rejects a PNG whose image data is short for its declared size", async () => {
    // A file that inflates cleanly but holds too few scanlines: every CRC verifies,
    // so only comparing against width × height catches it.
    const fx = await fixture();
    const short = pngWithIdatFor(64, 64, 8);
    await writeFile(path.join(fx.root, "short.png"), short);
    await expectToolError(
      resolveImageSource(fx.config, { from: "short.png" }),
      /inflates to \d+ bytes where \d+ are needed for 64×64/
    );
  });

  it("rejects a PNG whose image data will not inflate", async () => {
    const fx = await fixture();
    await writeFile(path.join(fx.root, "garbage.png"), pngWithRawIdat(16, 16, new Uint8Array(20)));
    await expectToolError(
      resolveImageSource(fx.config, { from: "garbage.png" }),
      /will not inflate/
    );
  });

  it("accepts a complete JPEG and rejects one without its end marker", async () => {
    const fx = await fixture();
    await writeFile(path.join(fx.root, "whole.jpg"), jpeg(64, 64));
    await resolveImageSource(fx.config, { from: "whole.jpg" });

    const whole = jpeg(64, 64);
    await writeFile(path.join(fx.root, "cut.jpg"), whole.subarray(0, whole.length - 2));
    await expectToolError(
      resolveImageSource(fx.config, { from: "cut.jpg" }),
      /no end-of-image marker, so it is truncated/
    );
  });

  it("rejects a JPEG segment claiming a length past the end of the file", async () => {
    const fx = await fixture();
    const bytes = jpeg(64, 64);
    // Overstate the frame header's length.
    new DataView(bytes.buffer).setUint16(4, 0xfff0);
    await writeFile(path.join(fx.root, "long.jpg"), bytes);
    await expectToolError(
      resolveImageSource(fx.config, { from: "long.jpg" }),
      /past the end of the file|could not read the pixel size/
    );
  });

  it("accepts a complete GIF and rejects one without its trailer", async () => {
    const fx = await fixture();
    await writeFile(path.join(fx.root, "whole.gif"), gif(32, 16));
    await resolveImageSource(fx.config, { from: "whole.gif" });

    const whole = gif(32, 16);
    await writeFile(path.join(fx.root, "cut.gif"), whole.subarray(0, whole.length - 1));
    await expectToolError(
      resolveImageSource(fx.config, { from: "cut.gif" }),
      /not a usable GIF file/
    );
  });

  it("does not let a damaged image into a workbook", async () => {
    const fx = await fixture();
    await writePng(fx, "whole.png", 32, 32);
    const whole = new Uint8Array(await readFile(path.join(fx.root, "whole.png")));
    await writeFile(path.join(fx.root, "cut.png"), whole.subarray(0, whole.length - 20));
    await expectToolError(
      run(sheetWriteTool, fx, {
        path: "out.xlsx",
        sheets: [{ name: "S", rows: [["a"]], images: [{ at: "B2", from: "cut.png" }] }]
      }),
      /not a usable PNG/
    );
    await expect(readFile(path.join(fx.root, "out.xlsx"))).rejects.toThrow();
  });

  it("does not let a damaged image into a template", async () => {
    const fx = await fixture();
    const doc = Document.create();
    Document.addParagraph(doc, "{{%logo}}");
    await Io.writeFile(Document.build(doc), path.join(fx.root, "tpl.docx"));
    await writePng(fx, "whole.png", 32, 32);
    const whole = new Uint8Array(await readFile(path.join(fx.root, "whole.png")));
    await writeFile(path.join(fx.root, "cut.png"), whole.subarray(0, whole.length - 20));
    await expectToolError(
      run(templateFillTool, fx, {
        template: "tpl.docx",
        out: "out.docx",
        data: {},
        images: { logo: { from: "cut.png" } }
      }),
      /not a usable PNG/
    );
  });

  it("reports damage from doc_inspect too, rather than only refusing later", async () => {
    const fx = await fixture();
    await writePng(fx, "whole.png", 32, 32);
    const whole = new Uint8Array(await readFile(path.join(fx.root, "whole.png")));
    await writeFile(path.join(fx.root, "cut.png"), whole.subarray(0, whole.length - 20));
    const text = await run(inspectTool, fx, { path: "cut.png" });
    expect(text).toContain("truncated");
  });
});
