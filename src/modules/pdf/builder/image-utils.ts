/**
 * Shared image utilities for PDF generation.
 *
 * Centralises JPEG/PNG dimension parsing and PDF XObject writing so that
 * both the builder (`document-builder.ts`) and the exporter (`pdf-exporter.ts`)
 * share a single implementation.
 */

import { PdfDict, pdfRef, pdfNumber } from "@pdf/core/pdf-object";
import type { PdfWriter } from "@pdf/core/pdf-writer";
import { decodePng } from "@pdf/render/png-decoder";

// =============================================================================
// Image Dimension Parsing
// =============================================================================

/**
 * Parse image dimensions from raw bytes.
 */
export function parseImageDimensions(
  data: Uint8Array,
  format: "jpeg" | "png"
): { width: number; height: number } {
  if (format === "png") {
    return parsePngDimensions(data);
  }
  return parseJpegDimensions(data);
}

/**
 * Read width/height from a PNG IHDR chunk (bytes 16-23).
 */
export function parsePngDimensions(data: Uint8Array): { width: number; height: number } {
  // PNG header: 8 byte signature, then IHDR chunk: 4 byte length, 4 byte type, 4 byte width, 4 byte height
  if (
    data.length >= 24 &&
    data[12] === 0x49 &&
    data[13] === 0x48 &&
    data[14] === 0x44 &&
    data[15] === 0x52
  ) {
    const width = (data[16] << 24) | (data[17] << 16) | (data[18] << 8) | data[19];
    const height = (data[20] << 24) | (data[21] << 16) | (data[22] << 8) | data[23];
    return { width, height };
  }
  return { width: 1, height: 1 };
}

/**
 * Read width/height from JPEG SOF marker.
 *
 * Correctly excludes non-SOF markers in the 0xC0-0xCF range:
 * - 0xC4 = DHT (Define Huffman Table)
 * - 0xC8 = JPG (reserved)
 * - 0xCC = DAC (Define Arithmetic Coding)
 */
export function parseJpegDimensions(data: Uint8Array): { width: number; height: number } {
  let offset = 2; // skip SOI marker
  while (offset < data.length - 1) {
    // Skip padding 0xFF bytes
    while (offset < data.length && data[offset] === 0xff && data[offset + 1] === 0xff) {
      offset++;
    }
    if (offset >= data.length - 1 || data[offset] !== 0xff) {
      break;
    }
    const marker = data[offset + 1];
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof && offset + 8 < data.length) {
      return {
        width: (data[offset + 7] << 8) | data[offset + 8],
        height: (data[offset + 5] << 8) | data[offset + 6]
      };
    }
    if (offset + 3 >= data.length) {
      break;
    }
    const segLen = (data[offset + 2] << 8) | data[offset + 3];
    offset += 2 + segLen;
  }
  return { width: 1, height: 1 };
}

// =============================================================================
// PDF Image XObject Writing
// =============================================================================

/**
 * Write an image XObject (JPEG or PNG) to the writer.
 * Returns the allocated object number.
 */
export function writeImageXObject(
  writer: PdfWriter,
  data: Uint8Array,
  format: "jpeg" | "png",
  grayscale = false
): number {
  if (format === "png") {
    return writePngImageXObject(writer, data, grayscale);
  }
  return writeJpegImageXObject(writer, data, grayscale);
}

/**
 * Write the PostScript calculator function that converts an RGB triple to its
 * Rec. 601 luma, and return its object number.
 *
 * Used as the tint transform of a `/DeviceN` space so a JPEG can be recoloured
 * without decoding it: the samples stay untouched and the consumer applies the
 * transform per pixel. Unlike painting a blend on top, this cannot darken
 * transparent areas, because it *is* the color space rather than an overlay.
 */
function writeLumaTintTransform(writer: PdfWriter): number {
  const objNum = writer.allocObject();
  const dict = new PdfDict()
    .set("FunctionType", "4")
    .set("Domain", "[0 1 0 1 0 1]")
    .set("Range", "[0 1]");
  // Stack on entry is R G B (B on top):
  //   0.114 mul  -> R G 0.114B
  //   exch       -> R 0.114B G
  //   0.587 mul  -> R 0.114B 0.587G
  //   add        -> R (0.114B + 0.587G)
  //   exch       -> (0.114B + 0.587G) R
  //   0.299 mul  -> (0.114B + 0.587G) 0.299R
  //   add        -> luma
  const program = "{ 0.114 mul exch 0.587 mul add exch 0.299 mul add }";
  writer.addStreamObject(objNum, dict, new TextEncoder().encode(program));
  return objNum;
}

/**
 * Write a JPEG image using DCTDecode (raw JPEG data embedded directly).
 */
function writeJpegImageXObject(writer: PdfWriter, data: Uint8Array, grayscale = false): number {
  const dims = parseJpegDimensions(data);
  // Grayscale without a JPEG decoder: keep the DCTDecode samples and reinterpret
  // the three components through a `/DeviceN` space whose tint transform is the
  // luma formula. Component count still matches the JPEG, as PDF requires.
  const tintRef = grayscale ? writeLumaTintTransform(writer) : undefined;
  const objNum = writer.allocObject();
  const dict = new PdfDict()
    .set("Type", "/XObject")
    .set("Subtype", "/Image")
    .set("Width", pdfNumber(dims.width))
    .set("Height", pdfNumber(dims.height))
    .set(
      "ColorSpace",
      tintRef === undefined
        ? "/DeviceRGB"
        : `[/DeviceN [/C1 /C2 /C3] /DeviceGray ${pdfRef(tintRef)}]`
    )
    .set("BitsPerComponent", "8")
    .set("Filter", "/DCTDecode");
  writer.addStreamObject(objNum, dict, data);
  return objNum;
}

/** Rec. 601 luma of an 8-bit RGB triple. */
function lumaByte(r: number, g: number, b: number): number {
  return Math.round(0.299 * r + 0.587 * g + 0.114 * b);
}

/**
 * Write a PNG image: decode to raw RGB, create SMask for alpha if needed.
 */
function writePngImageXObject(writer: PdfWriter, data: Uint8Array, grayscale = false): number {
  const png = decodePng(data);
  const objNum = writer.allocObject();

  // PNG is already decoded to raw samples here, so grayscale is a real pixel
  // conversion: collapse RGB to one luma component and switch to DeviceGray.
  // The alpha channel lives in a separate SMask and is untouched, so transparent
  // regions stay transparent.
  let pixels = png.pixels;
  if (grayscale) {
    const gray = new Uint8Array(png.width * png.height);
    for (let i = 0, p = 0; i < gray.length; i++, p += 3) {
      gray[i] = lumaByte(pixels[p], pixels[p + 1], pixels[p + 2]);
    }
    pixels = gray;
  }

  const dict = new PdfDict()
    .set("Type", "/XObject")
    .set("Subtype", "/Image")
    .set("Width", pdfNumber(png.width))
    .set("Height", pdfNumber(png.height))
    .set("ColorSpace", grayscale ? "/DeviceGray" : "/DeviceRGB")
    .set("BitsPerComponent", pdfNumber(png.bitsPerComponent));

  if (png.alpha) {
    const smaskObjNum = writer.allocObject();
    const smaskDict = new PdfDict()
      .set("Type", "/XObject")
      .set("Subtype", "/Image")
      .set("Width", pdfNumber(png.width))
      .set("Height", pdfNumber(png.height))
      .set("ColorSpace", "/DeviceGray")
      .set("BitsPerComponent", "8");
    writer.addStreamObject(smaskObjNum, smaskDict, png.alpha);
    dict.set("SMask", pdfRef(smaskObjNum));
  }

  writer.addStreamObject(objNum, dict, pixels);
  return objNum;
}
