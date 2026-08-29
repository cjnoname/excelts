/**
 * Image sources, shared by every tool that can put a picture somewhere.
 *
 * There is exactly one shape for "which image", and it routes on the file
 * extension rather than on a discriminator the caller has to get right:
 *
 * - `from: "logo.png"` — a `.png` / `.jpg` / `.gif` file, embedded as it is.
 * - `from: "design.md"` — a Markdown file's ```mermaid fence, drawn server-side.
 * - `from: "flow.mmd"` — a diagram file, drawn server-side.
 * - `source: "flowchart LR\n A --> B"` — Mermaid text, drawn server-side.
 *
 * That ordering is the point. A Mermaid diagram is *one source of an image*, not a
 * separate feature: a tool that could only place diagrams would be a
 * mermaid-shaped hole where generic image support belongs, and a caller with a
 * PNG on disk would have no way in. The three raster formats are the three
 * `Image.add` accepts, which is what makes the workbook path total.
 *
 * The natural size of a raster file has to be *read*, because two of the three
 * destinations need it. A worksheet anchored to a single cell needs pixels; a Word
 * template placeholder needs EMU and has no default at all. Guessing would place a
 * portrait photograph as a square, and the model would never see it — so the
 * dimension readers below fail loudly on a file they cannot parse rather than
 * returning a 1×1 placeholder.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { crc32, unzlibSync } from "documonster/archive";
import type { MermaidDiagram } from "documonster/mermaid";
import { z } from "zod";

import type { ServerConfig } from "../config.js";
import { toolError } from "../errors.js";
import { resolveInRoot } from "../sandbox.js";
import {
  buildDrawList,
  parseDiagram,
  renderDiagram,
  resolveDiagramSource,
  toRenderOptions
} from "./diagram.js";
import { assertReadableSize } from "./fs-helpers.js";

/** Raster formats a workbook and a Word document both accept. */
export type RasterMediaType = "png" | "jpeg" | "gif";

const RASTER_EXTENSIONS: Readonly<Record<string, RasterMediaType>> = {
  ".png": "png",
  ".jpg": "jpeg",
  ".jpeg": "jpeg",
  ".gif": "gif"
};

/** Extensions whose contents are a diagram to be drawn rather than an image to embed. */
const DIAGRAM_EXTENSIONS: readonly string[] = [".mmd", ".mermaid", ".md", ".markdown"];

/** Pixels per inch a raster file's dimensions are read as — the CSS convention. */
const CSS_PIXELS_PER_INCH = 96;
/** Points per inch. A display list's unit. */
const POINTS_PER_INCH = 72;
/** EMU per inch, the unit Word measures a drawing in. */
const EMU_PER_INCH = 914400;

/** Metres per inch, for reading a PNG's `pHYs` pixels-per-metre. */
const METRES_PER_INCH = 0.0254;

/** Pixels per point a rendered diagram is rasterised at. 2 → 144 DPI. */
const DIAGRAM_RASTER_SCALE = 2;

/** Ceiling on a single embedded image's source bytes. */
const MAX_IMAGE_BYTES = 24 * 1024 * 1024;

/**
 * Aggregate ceilings for one tool call.
 *
 * A per-file limit is not a budget: twenty files each just under it, or twenty
 * diagrams each just under the rasteriser's own 40-megapixel cap, add up to
 * gigabytes — every one of which is held as a `Uint8Array` until the workbook or
 * document is serialised. The counts below are what a real report needs, and a
 * caller who genuinely wants more can make a second call.
 */
const MAX_IMAGES_PER_CALL = 20;
const MAX_TOTAL_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_PIXELS = 80_000_000;

/**
 * Largest intrinsic pixel dimension accepted from a raster header.
 *
 * A header is four bytes of attacker-controlled integer. `0xffffffff` parsed as a
 * size yielded a 3.2-billion-point placement, which reaches Excel as a nonsense
 * anchor and Word as an EMU value far outside the format's range. No real image is
 * anywhere near this, so the cap costs nothing and closes the whole class.
 */
const MAX_INTRINSIC_PIXELS = 40_000;

/**
 * Tracks what one tool call has spent, so the aggregate caps mean something.
 *
 * Threaded explicitly rather than kept in module state: two calls must never share
 * a budget, and a module-level counter is exactly how that goes wrong under
 * concurrency.
 */
export interface ImageBudget {
  count: number;
  bytes: number;
  pixels: number;
}

/** A fresh budget for one tool call. */
export function newImageBudget(): ImageBudget {
  return { count: 0, bytes: 0, pixels: 0 };
}

function spend(budget: ImageBudget, bytes: number, pixels: number, origin: string): void {
  budget.count += 1;
  budget.bytes += bytes;
  budget.pixels += pixels;
  if (budget.count > MAX_IMAGES_PER_CALL) {
    throw toolError.tooLarge(
      `this call places more than ${MAX_IMAGES_PER_CALL} images`,
      "Split it across several calls. Every picture is held in memory until the file is written."
    );
  }
  if (budget.bytes > MAX_TOTAL_IMAGE_BYTES) {
    throw toolError.tooLarge(
      `the images in this call total more than ${Math.round(MAX_TOTAL_IMAGE_BYTES / (1024 * 1024))} MiB (reached at ${origin})`,
      "Split it across several calls, or shrink the sources."
    );
  }
  if (budget.pixels > MAX_TOTAL_PIXELS) {
    throw toolError.tooLarge(
      `the images in this call total more than ${Math.round(MAX_TOTAL_PIXELS / 1e6)}M pixels (reached at ${origin})`,
      "Shrink the images, or lower the diagram sizes. Each one is decoded at full size before it is placed."
    );
  }
}

/**
 * Where an image comes from and how big it should be.
 *
 * Spread into a tool's schema rather than nested, so the fields read as the
 * tool's own and a caller does not have to discover an extra level of object.
 */
export const imageSourceShape = {
  from: z
    .string()
    .optional()
    .describe(
      "Image path. A .png/.jpg/.gif is embedded as it is; a .mmd file or a ```mermaid fence in a .md file is drawn as a diagram first. Use this or `source`."
    ),
  source: z
    .string()
    .optional()
    .describe("Mermaid diagram text, drawn server-side. Use this or `from`."),
  index: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Which ```mermaid fence, when `from` is a Markdown file with several. Defaults to 1."
    ),
  width: z
    .number()
    .positive()
    .max(20_000)
    .optional()
    .describe(
      "Display width in points (72 per inch). Omit for the image's natural size; the aspect ratio is kept whichever is given."
    ),
  height: z.number().positive().max(20_000).optional().describe("Display height in points."),
  altText: z
    .string()
    .optional()
    .describe(
      "Alternative text, for accessibility. Defaults to the file name or the diagram type."
    ),
  theme: z
    .enum(["default", "dark", "neutral"])
    .optional()
    .describe("Diagram sources only: colour set. Defaults to `default`."),
  background: z
    .string()
    .optional()
    .describe('Diagram sources only: page colour, or "transparent". Defaults to white.')
} as const;

/** The parsed form of {@link imageSourceShape}. */
export interface ImageSourceArgs {
  readonly from?: string;
  readonly source?: string;
  readonly index?: number;
  readonly width?: number;
  readonly height?: number;
  readonly altText?: string;
  readonly theme?: "default" | "dark" | "neutral";
  readonly background?: string;
}

export interface ResolvedImage {
  readonly bytes: Uint8Array;
  readonly mediaType: RasterMediaType;
  /** Display size in points, after `width`/`height` and any cap were applied. */
  readonly width: number;
  readonly height: number;
  /** Suggested `word/media` / `xl/media` file name. */
  readonly fileName: string;
  readonly altText: string;
  /** How to name the source in a report. */
  readonly origin: string;
  /**
   * Present when the image was drawn from Mermaid, so the tool can report what
   * the parser recognised — the only way a model can check a picture it cannot see.
   */
  readonly diagram?: MermaidDiagram;
}

export interface ResolveImageOptions {
  /** Shrink to at most this many points wide, keeping the aspect ratio. */
  readonly maxWidthPoints?: number;
  /** Running total for the call, so the aggregate caps apply across images. */
  readonly budget?: ImageBudget;
}

/**
 * Turn an image source into bytes and a display size.
 *
 * @throws {McpToolError} `invalid_input` for a missing or ambiguous source, an
 *   unsupported extension, or a raster file whose header cannot be read.
 */
export async function resolveImageSource(
  config: ServerConfig,
  args: ImageSourceArgs,
  options: ResolveImageOptions = {}
): Promise<ResolvedImage> {
  const hasFrom = typeof args.from === "string" && args.from.trim().length > 0;
  const hasSource = typeof args.source === "string" && args.source.trim().length > 0;
  if (hasFrom === hasSource) {
    throw toolError.invalidInput(
      hasFrom
        ? "pass either `from` or `source` for the image, not both"
        : "no image source: pass `from` with a path, or `source` with Mermaid diagram text",
      "`from` takes a .png/.jpg/.gif to embed, or a .mmd/.md to draw. `source` takes Mermaid text."
    );
  }

  const extension = hasFrom ? path.extname(args.from as string).toLowerCase() : "";
  const raster = RASTER_EXTENSIONS[extension];

  if (hasFrom && raster === undefined && !DIAGRAM_EXTENSIONS.includes(extension)) {
    throw toolError.invalidInput(
      `cannot use ${JSON.stringify(args.from)} as an image`,
      `Supported: ${Object.keys(RASTER_EXTENSIONS).join(", ")} to embed, or ${DIAGRAM_EXTENSIONS.join(", ")} to draw a diagram.`
    );
  }

  const natural =
    raster === undefined
      ? await drawDiagram(config, args, options.maxWidthPoints)
      : await readRaster(config, args.from as string, raster);

  const scaled = fit(natural.width, natural.height, args, options.maxWidthPoints);
  if (options.budget !== undefined) {
    spend(options.budget, natural.bytes.length, natural.pixels, natural.origin);
  }

  return {
    bytes: natural.bytes,
    mediaType: natural.mediaType,
    width: scaled.width,
    height: scaled.height,
    fileName: natural.fileName,
    altText: args.altText ?? natural.altText,
    origin: natural.origin,
    ...(natural.diagram === undefined ? {} : { diagram: natural.diagram })
  };
}

interface NaturalImage {
  readonly bytes: Uint8Array;
  readonly mediaType: RasterMediaType;
  /** Natural size in points. */
  readonly width: number;
  readonly height: number;
  /** Decoded pixel count, for the aggregate budget. */
  readonly pixels: number;
  readonly fileName: string;
  readonly altText: string;
  readonly origin: string;
  readonly diagram?: MermaidDiagram;
}

/** Read a raster file and its intrinsic size. */
async function readRaster(
  config: ServerConfig,
  display: string,
  mediaType: RasterMediaType
): Promise<NaturalImage> {
  const resolved = await resolveInRoot(config, display, { mustExist: true });
  const size = await assertReadableSize(config, resolved, display);
  if (size > MAX_IMAGE_BYTES) {
    throw toolError.tooLarge(
      `${display} is ${size} bytes, over the ${MAX_IMAGE_BYTES} byte image limit`,
      "Embedding it would be held in memory twice. Shrink the image first."
    );
  }
  const bytes = new Uint8Array(await readFile(resolved));
  const measured = readIntrinsicSize(bytes, mediaType, display);
  // The file's own declared resolution when it has one, else the CSS convention of
  // 96 per inch. This matters: Word and Excel honour a PNG's `pHYs` chunk and a
  // JPEG's JFIF density, so a 300-dpi photograph they place at one inch would be
  // placed by this tool at 3⅛ inches if the declaration were ignored.
  const dpi = measured.dpi ?? CSS_PIXELS_PER_INCH;
  return {
    bytes,
    mediaType,
    width: (measured.width * POINTS_PER_INCH) / dpi,
    height: (measured.height * POINTS_PER_INCH) / dpi,
    pixels: measured.width * measured.height,
    fileName: path.basename(display),
    altText: path.basename(display, path.extname(display)),
    origin: display
  };
}

/**
 * Draw a Mermaid source to PNG.
 *
 * `maxWidthPoints` is applied to the **raster**, not only to the display size. A
 * 1034-point flowchart headed for a 468-point text column was previously rasterised
 * at its full natural size and then merely declared smaller, so more than half the
 * pixels — and the CPU and memory that produced them — were thrown away by Word.
 */
async function drawDiagram(
  config: ServerConfig,
  args: ImageSourceArgs,
  maxWidthPoints: number | undefined
): Promise<NaturalImage> {
  const resolved = await resolveDiagramSource(config, args);
  const diagram = parseDiagram(resolved.source);
  const style = toRenderOptions({
    ...(args.theme === undefined ? {} : { theme: args.theme }),
    ...(args.background === undefined ? {} : { background: args.background })
  });
  const list = buildDrawList(resolved.source, style);
  // Points the picture will actually occupy, so the pixels are sized to that.
  const targetWidth =
    maxWidthPoints === undefined ? list.width : Math.min(list.width, maxWidthPoints);
  const scale = (DIAGRAM_RASTER_SCALE * targetWidth) / list.width;
  const rendered = await renderDiagram(list, "png", { scale }, style.background);
  return {
    bytes: rendered.bytes,
    mediaType: "png",
    // A display list's unit is a point, so its own size is already the size the
    // picture should occupy — the raster scale only decides how sharp it is.
    width: list.width,
    height: list.height,
    pixels: rendered.width * rendered.height,
    fileName: `${diagram.kind}-diagram.png`,
    altText: diagram.title ?? `${diagram.kind} diagram`,
    origin: resolved.origin === "inline" ? "an inline Mermaid diagram" : resolved.origin,
    diagram
  };
}

/**
 * Apply the requested display size.
 *
 * One of `width`/`height` scales the other, because an image squashed to an
 * aspect ratio nobody asked for is a defect the model cannot see. Both together
 * are taken literally — a caller naming two numbers means them.
 */
function fit(
  naturalWidth: number,
  naturalHeight: number,
  args: ImageSourceArgs,
  maxWidthPoints: number | undefined
): { width: number; height: number } {
  let width = naturalWidth;
  let height = naturalHeight;

  if (args.width !== undefined && args.height !== undefined) {
    width = args.width;
    height = args.height;
  } else if (args.width !== undefined) {
    width = args.width;
    height = (naturalHeight * args.width) / naturalWidth;
  } else if (args.height !== undefined) {
    height = args.height;
    width = (naturalWidth * args.height) / naturalHeight;
  }

  if (maxWidthPoints !== undefined && width > maxWidthPoints) {
    height = (height * maxWidthPoints) / width;
    width = maxWidthPoints;
  }

  return { width, height };
}

/** Display size in EMU, the unit Word measures a drawing in. */
export function toEmu(points: number): number {
  return Math.round((points * EMU_PER_INCH) / POINTS_PER_INCH);
}

/** Display size in CSS pixels, the unit a worksheet anchor's `ext` is in. */
export function toCssPixels(points: number): number {
  return Math.round((points * CSS_PIXELS_PER_INCH) / POINTS_PER_INCH);
}

/** An image's intrinsic size, and its declared resolution when it states one. */
interface IntrinsicSize {
  readonly width: number;
  readonly height: number;
  /** Dots per inch the file itself declares, or `undefined`. */
  readonly dpi?: number;
}

/**
 * Read an image's intrinsic size and resolution from its header.
 *
 * Deliberately strict, in two ways the library's own reader is not.
 *
 * It **refuses** what it cannot parse. `parseImageDimensions` answers `1×1` for an
 * unreadable file, which is right for a renderer that must draw something and wrong
 * here: a 1×1 placement is invisible, and nothing downstream can look at the result
 * to notice. So a bad header is an `invalid_input` naming the file.
 *
 * It also **bounds** what it accepts. A header is four bytes of caller-controlled
 * integer; `0xffffffff` read as a width produced a placement 3.2 billion points
 * wide. Real images are nowhere near {@link MAX_INTRINSIC_PIXELS}.
 *
 * What it is still not: a decoder. A structurally plausible header over truncated
 * pixel data passes, and would reach Word or Excel as a media part they cannot
 * display. Proving decodability means decoding, which is a different order of cost
 * for a check whose purpose is to size a box — so the boundary is stated here rather
 * than implied.
 */
function readIntrinsicSize(
  bytes: Uint8Array,
  mediaType: RasterMediaType,
  display: string
): IntrinsicSize {
  const size =
    mediaType === "png" ? pngSize(bytes) : mediaType === "gif" ? gifSize(bytes) : jpegSize(bytes);

  if (size === undefined || size.width <= 0 || size.height <= 0) {
    throw toolError.invalidInput(
      `could not read the pixel size of ${display}`,
      `The bytes are not a readable ${mediaType.toUpperCase()} header. Run doc_inspect on it — the extension may not match the content.`
    );
  }
  if (size.width > MAX_INTRINSIC_PIXELS || size.height > MAX_INTRINSIC_PIXELS) {
    throw toolError.tooLarge(
      `${display} declares ${size.width}×${size.height} pixels, over the ${MAX_INTRINSIC_PIXELS} pixel per-axis limit`,
      "Either the file is enormous or its header is corrupt. Check it with doc_inspect."
    );
  }

  // A readable header is not a usable file. Embedding a truncated or corrupt image
  // produces a media part Word and Excel cannot display — and since nothing
  // downstream can look at a picture, the report would claim success over a
  // document that shows a broken-image box. So the container is checked through to
  // its end marker before the bytes are allowed into a package.
  const damage = describeDamage(bytes, mediaType, size);
  if (damage !== undefined) {
    throw toolError.invalidInput(
      `${display} is not a usable ${mediaType.toUpperCase()} file: ${damage}`,
      "Embedding it would produce a document with a broken image. Re-export or re-download the file."
    );
  }
  return size;
}

/**
 * What is wrong with the container, or `undefined` when it is intact.
 *
 * This is an integrity check, not a decoder. It proves the file is *complete and
 * uncorrupted* — every PNG chunk's CRC-32 verifies and its compressed image data
 * inflates to exactly the expected byte count; a JPEG's segment chain reaches its
 * end-of-image marker; a GIF's block chain reaches its trailer. What it deliberately
 * does not do is reconstruct pixels: un-filtering a PNG scanline or entropy-decoding
 * a JPEG would answer the same question at many times the cost, because a container
 * that passes these tests and still fails to render is a decoder bug rather than a
 * damaged file.
 *
 * The distinction that matters is truncation, which is overwhelmingly the way a real
 * image arrives broken — an interrupted download, a partial copy, a `head -c` — and
 * which a header check cannot see at all.
 */
function describeDamage(
  bytes: Uint8Array,
  mediaType: RasterMediaType,
  size: IntrinsicSize
): string | undefined {
  if (mediaType === "png") {
    return pngDamage(bytes, size);
  }
  if (mediaType === "gif") {
    return gifDamage(bytes);
  }
  return jpegDamage(bytes);
}

/**
 * Walk a PNG's chunk chain, verifying each CRC and the image data itself.
 *
 * The CRC is the point: PNG stores one per chunk precisely so corruption is
 * detectable, and checking it turns "these bytes look like a PNG" into "these bytes
 * are the PNG that was written". Inflating the concatenated `IDAT` payload then
 * confirms the compressed stream is complete and that it holds exactly one filter
 * byte plus one row of samples for every scanline — the check that catches a file
 * cut off half way.
 */
function pngDamage(bytes: Uint8Array, size: IntrinsicSize): string | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const idat: Uint8Array[] = [];
  let offset = 8;
  let sawIhdr = false;
  let sawIend = false;
  let interlaced = false;

  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const end = offset + 12 + length;
    if (length > bytes.length || end > bytes.length) {
      return "the chunk stream is truncated";
    }
    const type = new TextDecoder("latin1").decode(bytes.subarray(offset + 4, offset + 8));
    // The CRC covers the type and the payload, but not the length.
    const expected = view.getUint32(end - 4);
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== expected) {
      return `the ${type} chunk fails its CRC, so the file is corrupt`;
    }
    if (type === "IHDR") {
      sawIhdr = true;
      interlaced = bytes[offset + 8 + 12] === 1;
    } else if (type === "IDAT") {
      idat.push(bytes.subarray(offset + 8, end - 4));
    } else if (type === "IEND") {
      sawIend = true;
      break;
    }
    offset = end;
  }

  if (!sawIhdr) {
    return "it has no IHDR chunk";
  }
  if (idat.length === 0) {
    return "it contains no image data";
  }
  if (!sawIend) {
    return "it has no IEND chunk, so it is truncated";
  }

  // Interlaced PNGs split the image into seven passes, so the inflated length is not
  // a simple product. The stream is still inflated to prove it is complete; only the
  // length assertion is skipped.
  const expectedBytes = interlaced ? undefined : expectedRawSize(bytes, size);
  try {
    const inflated = unzlibSync(concat(idat));
    if (expectedBytes !== undefined && inflated.length !== expectedBytes) {
      return `its image data inflates to ${inflated.length} bytes where ${expectedBytes} are needed for ${size.width}×${size.height}`;
    }
  } catch {
    return "its compressed image data will not inflate";
  }
  return undefined;
}

/** Bytes a non-interlaced PNG's scanlines occupy: a filter byte plus samples per row. */
function expectedRawSize(bytes: Uint8Array, size: IntrinsicSize): number | undefined {
  const bitDepth = bytes[24] ?? 0;
  const colourType = bytes[25] ?? 0;
  const channels = PNG_CHANNELS[colourType];
  if (channels === undefined) {
    return undefined;
  }
  const bitsPerRow = size.width * channels * bitDepth;
  return size.height * (1 + Math.ceil(bitsPerRow / 8));
}

/** Samples per pixel for each PNG colour type. */
const PNG_CHANNELS: Readonly<Record<number, number>> = {
  0: 1, // greyscale
  2: 3, // truecolour
  3: 1, // palette index
  4: 2, // greyscale + alpha
  6: 4 // truecolour + alpha
};

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * Walk a JPEG's segments to the end-of-image marker.
 *
 * Entropy-coded data cannot be walked as segments, so once SOS is reached the only
 * thing left to establish is that the file ends where a JPEG ends. `FF D9` at the
 * tail is exactly the evidence a truncated download lacks.
 */
function jpegDamage(bytes: Uint8Array): string | undefined {
  let offset = 2;
  let sawFrame = false;

  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      return "its segment chain is malformed";
    }
    const marker = bytes[offset + 1] ?? 0;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9) {
      return sawFrame ? undefined : "it ends before declaring an image";
    }
    if (offset + 3 >= bytes.length) {
      return "it is truncated inside a segment header";
    }
    const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(
      offset + 2
    );
    if (length < 2 || offset + 2 + length > bytes.length) {
      return "a segment declares a length past the end of the file";
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      sawFrame = true;
    }
    if (marker === 0xda) {
      // Scan data follows; a complete file ends with EOI.
      const tail = bytes.subarray(Math.max(0, bytes.length - 2));
      return tail[0] === 0xff && tail[1] === 0xd9
        ? undefined
        : "it has no end-of-image marker, so it is truncated";
    }
    offset += 2 + length;
  }
  return "it contains no image data";
}

/**
 * Walk a GIF's block chain to the trailer.
 *
 * Every GIF block is length-prefixed, so the chain either arrives at `0x3B` or the
 * file is short. Sub-block lists are followed rather than skipped, because that is
 * where a truncated file runs out.
 */
function gifDamage(bytes: Uint8Array): string | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 13;
  // A global colour table, when the packed field says so.
  const packed = bytes[10] ?? 0;
  if ((packed & 0x80) !== 0) {
    offset += 3 * 2 ** ((packed & 0x07) + 1);
  }

  while (offset < bytes.length) {
    const block = bytes[offset];
    if (block === 0x3b) {
      return undefined;
    }
    if (block === 0x21) {
      // Extension: label, then sub-blocks.
      offset += 2;
      const after = skipSubBlocks(bytes, offset);
      if (after === undefined) {
        return "an extension block runs past the end of the file";
      }
      offset = after;
      continue;
    }
    if (block === 0x2c) {
      if (offset + 10 > bytes.length) {
        return "an image descriptor is truncated";
      }
      const localPacked = bytes[offset + 9] ?? 0;
      offset += 10;
      if ((localPacked & 0x80) !== 0) {
        offset += 3 * 2 ** ((localPacked & 0x07) + 1);
      }
      // The LZW minimum code size, then the image's sub-blocks.
      offset += 1;
      const after = skipSubBlocks(bytes, offset);
      if (after === undefined) {
        return "the image data runs past the end of the file";
      }
      offset = after;
      continue;
    }
    return `it contains an unknown block type 0x${(block ?? 0).toString(16)}`;
  }
  void view;
  return "it has no trailer, so it is truncated";
}

/** Walk a GIF sub-block list, returning the offset just past its terminator. */
function skipSubBlocks(bytes: Uint8Array, start: number): number | undefined {
  let offset = start;
  while (offset < bytes.length) {
    const size = bytes[offset] ?? 0;
    if (size === 0) {
      return offset + 1;
    }
    offset += 1 + size;
  }
  return undefined;
}

/**
 * PNG: IHDR is always the first chunk, and `pHYs` carries the resolution.
 *
 * The IHDR length is checked rather than assumed, because a file whose fourth word
 * is not 13 is not a PNG and the bytes at 16–23 would then be something else
 * entirely.
 */
function pngSize(bytes: Uint8Array): IntrinsicSize | undefined {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 33 || !signature.every((byte, index) => bytes[index] === byte)) {
    return undefined;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== 13 || !hasChunkType(bytes, 12, "IHDR")) {
    return undefined;
  }
  const bitDepth = bytes[24] ?? 0;
  const colourType = bytes[25] ?? 0xff;
  // The values PNG actually defines. A file outside them is not one.
  if (![1, 2, 4, 8, 16].includes(bitDepth) || ![0, 2, 3, 4, 6].includes(colourType)) {
    return undefined;
  }
  const dpi = pngResolution(bytes, view);
  return {
    width: view.getUint32(16),
    height: view.getUint32(20),
    ...(dpi === undefined ? {} : { dpi })
  };
}

/**
 * Walk PNG chunks for `pHYs`, which states pixels per metre.
 *
 * Stops at the first `IDAT`: `pHYs` must precede the image data, so continuing past
 * it would only scan the payload for a byte pattern that happens to spell a chunk
 * name.
 */
function pngResolution(bytes: Uint8Array, view: DataView): number | undefined {
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    if (hasChunkType(bytes, offset + 4, "IDAT")) {
      return undefined;
    }
    if (hasChunkType(bytes, offset + 4, "pHYs") && offset + 8 + 9 <= bytes.length) {
      const perUnitX = view.getUint32(offset + 8);
      const unit = bytes[offset + 8 + 8];
      // unit 1 is metres; unit 0 means "aspect ratio only" and states no resolution.
      return unit === 1 && perUnitX > 0 ? perUnitX * METRES_PER_INCH : undefined;
    }
    // 4 length + 4 type + payload + 4 CRC.
    const next = offset + 12 + length;
    if (next <= offset) {
      return undefined;
    }
    offset = next;
  }
  return undefined;
}

function hasChunkType(bytes: Uint8Array, offset: number, type: string): boolean {
  for (let index = 0; index < 4; index += 1) {
    if (bytes[offset + index] !== type.charCodeAt(index)) {
      return false;
    }
  }
  return true;
}

/**
 * GIF: the logical screen size sits at a fixed offset, little-endian.
 *
 * The full `GIF87a`/`GIF89a` signature is checked, not just `GIF` — three bytes is
 * a prefix a great many files share by accident. GIF declares no resolution.
 */
function gifSize(bytes: Uint8Array): IntrinsicSize | undefined {
  if (bytes.length < 13) {
    return undefined;
  }
  const signature = new TextDecoder("latin1").decode(bytes.subarray(0, 6));
  if (signature !== "GIF87a" && signature !== "GIF89a") {
    return undefined;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
}

/**
 * JPEG: walk the segment chain to the frame header, and read JFIF density on the way.
 *
 * There is no fixed offset — a JPEG is a chain of length-prefixed segments and the
 * size lives in whichever SOF marker comes first. Three details are easy to get
 * wrong and all three were:
 *
 * - The markers excluded below are the three in the `0xC0`–`0xCF` range that are
 *   *not* frame headers (DHT, JPG, DAC); reading one as a frame yields a plausible
 *   but wrong size.
 * - A run of `0xFF` fill bytes is legal padding before a marker. Advancing by two
 *   over `FF FF C0` steps onto `FF` and then past `C0`, skipping the very frame
 *   header being looked for.
 * - The scan is abandoned at SOS, because entropy-coded data follows and searching
 *   it for `FF C0` finds coincidences.
 */
function jpegSize(bytes: Uint8Array): IntrinsicSize | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return undefined;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  let dpi: number | undefined;

  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      return undefined;
    }
    const marker = bytes[offset + 1] ?? 0;
    // Fill byte: this is still the marker prefix, so advance one and look again.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // Standalone markers carry no length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    if (offset + 3 >= bytes.length) {
      return undefined;
    }
    const length = view.getUint16(offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) {
      return undefined;
    }
    // SOS: entropy-coded data follows, so stop rather than scan it.
    if (marker === 0xda) {
      return undefined;
    }
    if (marker === 0xe0 && dpi === undefined) {
      dpi = jfifResolution(bytes, view, offset + 4, length - 2);
    }
    const isFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (offset + 9 >= bytes.length) {
        return undefined;
      }
      return {
        height: view.getUint16(offset + 5),
        width: view.getUint16(offset + 7),
        ...(dpi === undefined ? {} : { dpi })
      };
    }
    offset += 2 + length;
  }
  return undefined;
}

/** The X density from a JFIF APP0 segment, in dots per inch. */
function jfifResolution(
  bytes: Uint8Array,
  view: DataView,
  payload: number,
  length: number
): number | undefined {
  if (length < 12 || payload + 12 > bytes.length) {
    return undefined;
  }
  if (new TextDecoder("latin1").decode(bytes.subarray(payload, payload + 5)) !== "JFIF\0") {
    return undefined;
  }
  const units = bytes[payload + 7];
  const density = view.getUint16(payload + 8);
  if (density === 0) {
    return undefined;
  }
  // 1 = dots per inch, 2 = dots per centimetre, 0 = aspect ratio only.
  if (units === 1) {
    return density;
  }
  return units === 2 ? density * 2.54 : undefined;
}

/** What {@link tryReadImageHeader} found, including the size it would be placed at. */
export interface ProbedImage {
  readonly mediaType: RasterMediaType;
  readonly width: number;
  readonly height: number;
  readonly dpi?: number;
  /** The size it would occupy when placed, in points. */
  readonly points: { readonly width: number; readonly height: number };
  /**
   * What is wrong with the file, when anything is.
   *
   * Reported rather than thrown, because the two callers want opposite things from
   * the same finding: placing must refuse a damaged file, while inspecting exists to
   * *say* it is damaged. Leaving it out made the advice the placement tools give —
   * "run doc_inspect on it" — lead to a report that the file was fine.
   */
  readonly damage?: string;
}

/**
 * Read a raster header without throwing, for `doc_inspect`.
 *
 * Identification and placement want the same parse but different failure
 * behaviour: placing must refuse a file it cannot size, whereas inspecting exists
 * precisely to *report* that it cannot be sized. Sharing the parsers keeps the two
 * answers consistent — a file `doc_inspect` calls unreadable is exactly one the
 * placement tools reject.
 */
export function tryReadImageHeader(bytes: Uint8Array): ProbedImage | undefined {
  const candidates: readonly RasterMediaType[] = ["png", "jpeg", "gif"];
  for (const mediaType of candidates) {
    const size =
      mediaType === "png" ? pngSize(bytes) : mediaType === "gif" ? gifSize(bytes) : jpegSize(bytes);
    if (size === undefined || size.width <= 0 || size.height <= 0) {
      continue;
    }
    const dpi = size.dpi ?? CSS_PIXELS_PER_INCH;
    const damage =
      size.width > MAX_INTRINSIC_PIXELS || size.height > MAX_INTRINSIC_PIXELS
        ? `it declares ${size.width}×${size.height} pixels, past the ${MAX_INTRINSIC_PIXELS} per-axis limit`
        : describeDamage(bytes, mediaType, size);
    return {
      mediaType,
      width: size.width,
      height: size.height,
      ...(size.dpi === undefined ? {} : { dpi: size.dpi }),
      points: {
        width: (size.width * POINTS_PER_INCH) / dpi,
        height: (size.height * POINTS_PER_INCH) / dpi
      },
      ...(damage === undefined ? {} : { damage })
    };
  }
  return undefined;
}

/**
 * Describe a placed image for a tool report.
 *
 * The diagram line is the load-bearing part: for a Mermaid source the model has
 * no other way to check that the picture says what it meant.
 */
export function describePlacedImage(image: ResolvedImage, where: string): string {
  const size = `${Math.round(image.width)}×${Math.round(image.height)} pt`;
  return `placed ${image.origin} at ${where} (${size}, ${image.mediaType})`;
}
