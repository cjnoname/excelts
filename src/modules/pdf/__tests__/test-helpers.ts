/**
 * Shared test helpers for PDF tests.
 */
import { inflateSync } from "node:zlib";

import { expect } from "vitest";

/**
 * A 1x1 PNG, the smallest valid raster fixture. Shared so every test embeds
 * byte-identical image data.
 */
export const TINY_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1,
  0, 0, 0, 1, 8, 2, 0, 0, 0, 0x90, 0x77, 0x53, 0xde, 0, 0, 0, 0x0c, 0x49, 0x44, 0x41, 0x54, 8, 0xd7,
  0x63, 0xf8, 0xcf, 0xc0, 0, 0, 0, 2, 0, 1, 0xe2, 0x21, 0xbc, 0x33, 0, 0, 0, 0, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82
]);

/**
 * Concatenate every content stream in a PDF, inflating those that are
 * Flate-compressed. Streams that are not deflate data are kept verbatim.
 */
export function decompressPdfContent(pdfBytes: Uint8Array): string {
  const raw = Buffer.from(pdfBytes).toString("latin1");
  const parts: string[] = [];
  for (const match of raw.matchAll(/stream\r?\n([\s\S]*?)endstream/g)) {
    const buf = Buffer.from(match[1], "latin1");
    try {
      parts.push(inflateSync(buf).toString("latin1"));
    } catch {
      parts.push(buf.toString("latin1"));
    }
  }
  return parts.join("\n");
}

/**
 * Every color operator in the content streams, as `[r, g, b]` triples.
 * Covers both non-stroking (`rg`) and stroking (`RG`) colors.
 */
export function pdfColorOps(pdfBytes: Uint8Array): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  for (const m of decompressPdfContent(pdfBytes).matchAll(
    /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+(?:rg|RG)\b/g
  )) {
    out.push([parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])]);
  }
  return out;
}

/** Assert every emitted color is neutral gray (r == g == b). */
export function expectAllGray(colors: Array<[number, number, number]>): void {
  // Guard against a vacuous pass when no colors were captured at all.
  expect(colors.length).toBeGreaterThan(0);
  for (const [r, g, b] of colors) {
    expect(Math.abs(r - g)).toBeLessThan(0.01);
    expect(Math.abs(g - b)).toBeLessThan(0.01);
  }
}

/**
 * Decode a PDF Uint8Array to string for assertion.
 */
export function pdfToString(pdf: Uint8Array): string {
  return new TextDecoder().decode(pdf);
}

/**
 * Verify basic PDF structure (header, xref, trailer, EOF).
 */
export function expectValidPdf(pdf: Uint8Array): void {
  const text = pdfToString(pdf);
  expect(text).toContain("%PDF-2.0");
  expect(text).toContain("xref");
  expect(text).toContain("trailer");
  expect(text).toContain("%%EOF");
  expect(text).toContain("/Catalog");
  expect(text).toContain("/Pages");
}
