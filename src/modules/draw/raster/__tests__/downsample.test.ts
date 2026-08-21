/**
 * The box filter behind the rasteriser's anti-aliasing.
 *
 * Driven directly rather than through a render, because the weighting is the kind of
 * arithmetic that looks right and is wrong by a factor: a render shows a fringe or a
 * shade that is off, and leaves you guessing which of the projection, the coverage or
 * the filter produced it.
 *
 * Every geometric primitive decides each pixel in or out — only glyphs carry coverage
 * of their own — so smooth edges come entirely from rendering at `samples`× and
 * averaging back down. If this function is wrong, every curve and every sloped line in
 * every PNG is wrong with it.
 */

import { downsample, normalizeSamples } from "@draw/raster/surface";
import { describe, expect, it } from "vitest";

/** Build a `factor`×`factor` block of samples, row-major RGBA. */
function block(samples: Array<[number, number, number, number]>): Uint8Array {
  const out = new Uint8Array(samples.length * 4);
  samples.forEach(([r, g, b, a], index) => {
    out[index * 4] = r;
    out[index * 4 + 1] = g;
    out[index * 4 + 2] = b;
    out[index * 4 + 3] = a;
  });
  return out;
}

/** The single output pixel of a one-pixel downsample. */
function only(source: Uint8Array, factor: number): [number, number, number, number] {
  const out = downsample(source, 1, 1, factor);
  return [out[0], out[1], out[2], out[3]];
}

const RED: [number, number, number, number] = [255, 0, 0, 255];
const CLEAR: [number, number, number, number] = [0, 0, 0, 0];

describe("downsampling a supersampled buffer", () => {
  it("leaves a fully covered pixel exactly as it was", () => {
    expect(only(block([RED, RED, RED, RED]), 2)).toEqual([255, 0, 0, 255]);
  });

  it("turns partial coverage into partial alpha", () => {
    // Three of four samples covered is three quarters of an alpha.
    expect(only(block([RED, RED, RED, CLEAR]), 2)).toEqual([255, 0, 0, 191]);
  });

  it("keeps the colour of a partly covered pixel", () => {
    // The buffer holds straight alpha. Averaging the channels without weighting them
    // by alpha drags an edge pixel towards whatever the transparent samples carry —
    // black — so a red edge came out a dark red rather than a translucent red.
    const [r, g, b, a] = only(block([RED, CLEAR, CLEAR, CLEAR]), 2);
    expect(r).toBe(255);
    expect(g).toBe(0);
    expect(b).toBe(0);
    expect(a).toBe(64);
  });

  it("weights two colours by how much of the pixel each covers", () => {
    const white: [number, number, number, number] = [255, 255, 255, 255];
    const black: [number, number, number, number] = [0, 0, 0, 255];
    // Three white samples and one black, all opaque: three quarters of the way to
    // white.
    expect(only(block([white, white, white, black]), 2)).toEqual([191, 191, 191, 255]);
  });

  it("weights by alpha, not by sample count", () => {
    // A sample covering a quarter of its own area contributes a quarter as much colour
    // as a fully opaque one. Counting samples instead would put this halfway between
    // the two colours.
    const solidRed: [number, number, number, number] = [255, 0, 0, 255];
    const faintBlue: [number, number, number, number] = [0, 0, 255, 64];
    const [r, , b] = only(block([solidRed, faintBlue, CLEAR, CLEAR]), 2);
    expect(r).toBeGreaterThan(b * 3);
  });

  it("leaves an entirely empty pixel transparent and untinted", () => {
    expect(only(block([CLEAR, CLEAR, CLEAR, CLEAR]), 2)).toEqual([0, 0, 0, 0]);
  });

  it("filters each output pixel from its own block", () => {
    // A 2x1 output from a 4x2 source: the left pixel must not see the right one's
    // samples.
    const source = new Uint8Array(4 * 2 * 4);
    const set = (x: number, y: number, rgba: [number, number, number, number]): void => {
      const index = (y * 4 + x) * 4;
      source[index] = rgba[0];
      source[index + 1] = rgba[1];
      source[index + 2] = rgba[2];
      source[index + 3] = rgba[3];
    };
    for (const [x, y] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1]
    ]) {
      set(x, y, RED);
    }
    const out = downsample(source, 2, 1, 2);
    expect([out[0], out[1], out[2], out[3]]).toEqual([255, 0, 0, 255]);
    expect(out[7]).toBe(0);
  });

  it("handles a factor of three, the default", () => {
    const samples = Array.from({ length: 9 }, (_, index) => (index < 3 ? RED : CLEAR));
    const [, , , alpha] = only(block(samples), 3);
    // Three of nine.
    expect(alpha).toBe(85);
  });
});

describe("choosing a sample count", () => {
  it("defaults to three, which is nine coverage levels per pixel", () => {
    expect(normalizeSamples(undefined, 100, 100)).toBe(3);
  });

  it("never returns zero, whatever it is handed", () => {
    // A zero would produce a zero-sized buffer rather than a sharp image.
    for (const request of [1, 1.9, 2.5]) {
      expect(normalizeSamples(request, 100, 100)).toBeGreaterThanOrEqual(1);
    }
  });

  it("floors a fractional request rather than allocating a fractional buffer", () => {
    expect(normalizeSamples(2.9, 100, 100)).toBe(2);
  });
});
