/**
 * The region map's rendering-path marker, and the paint decisions it goes with.
 *
 * `data-region-map-mode` is the only channel through which the library reports which of
 * three paths drew a map — the caller's TopoJSON, the built-in centroid preview, or the
 * hex-tile fallback — and therefore the only way a caller learns whether their topology
 * matched their categories at all. The matcher options (`match: "id"`,
 * `match: ["property:name_zh", …]`) are unverifiable without it.
 *
 * Two of the four modes had assertions; `tile-fallback` and `unmatched` had none, so the
 * branches that report "nothing matched" and "these rows could not be placed" were
 * themselves unreported.
 */

import { buildChartExModel, renderChartExSvg } from "@excel/chart";
import { describe, expect, it } from "vitest";

/** A region map over the given category labels. */
function mapOf(categories: string[], options: Parameters<typeof renderChartExSvg>[1] = {}): string {
  return renderChartExSvg(
    buildChartExModel({
      type: "regionMap",
      series: [
        {
          values: "ignored",
          literalValues: categories.map((_, index) => 10 + index * 5),
          literalCategories: categories
        }
      ],
      layout: { regionLabels: "showAll" }
    } as Parameters<typeof buildChartExModel>[0]),
    { width: 420, height: 260, ...options }
  );
}

/** Every mode marker in the output, in document order. */
function modes(svg: string): string[] {
  return [...svg.matchAll(/data-region-map-mode="([^"]+)"/g)].map(match => match[1]);
}

/** A two-square topology, so a feature can match or fail to. */
const topology = {
  type: "Topology",
  arcs: [
    [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0]
    ]
  ],
  objects: {
    countries: {
      type: "GeometryCollection",
      geometries: [{ type: "Polygon", id: "Atlantis", arcs: [[0]] }]
    }
  }
} as const;

describe("the region map reports which path drew it", () => {
  it("says tile-fallback when no category resolves to a place", () => {
    // Nothing in the built-in coordinate table matches, so there is no map to draw and
    // the values are laid out as a hex grid instead. Without the marker a caller cannot
    // tell that from a map of somewhere they did not recognise.
    expect(modes(mapOf(["Widgets", "Gadgets", "Doohickeys"]))).toEqual(["tile-fallback"]);
  });

  it("says geographic-preview when categories resolve without a topology", () => {
    expect(modes(mapOf(["USA", "Canada"]))).toEqual(["geographic-preview"]);
  });

  it("marks the rows it could not place alongside the ones it could", () => {
    // A mixed set: the preview claims the panel and the leftovers get their own tile
    // grid, labelled separately so the caller can see which rows were dropped from the
    // map proper.
    expect(modes(mapOf(["USA", "Canada", "Nowhereland"]))).toEqual([
      "geographic-preview",
      "unmatched"
    ]);
  });

  it("says topojson when a supplied topology matches", () => {
    expect(
      modes(mapOf(["Atlantis"], { regionMap: { topology, objectName: "countries", match: "id" } }))
    ).toEqual(["topojson"]);
  });

  it("falls through to the preview when a topology matches nothing", () => {
    // The documented behaviour: a failed match still shows the caller something rather
    // than an empty panel — and says so, rather than looking like a successful map of
    // very little.
    expect(
      modes(
        mapOf(["USA", "Canada"], { regionMap: { topology, objectName: "countries", match: "id" } })
      )
    ).toEqual(["geographic-preview"]);
  });

  it("does not leave a half-drawn topology under the preview it fell through to", () => {
    // The topology branch buffers its nodes and returns them only once a feature has
    // matched. Emitting as it went left a world outline beneath the preview.
    const svg = mapOf(["USA", "Canada"], {
      regionMap: { topology, objectName: "countries", match: "id" }
    });
    expect(svg).not.toContain('data-region-map-mode="topojson"');
  });

  it("wraps each layer in a group of its own rather than tagging a shape", () => {
    // The marker describes a decision, not a shape, so it belongs on a wrapper. It used
    // to sit on the background rect, which meant it also had to be duplicated onto every
    // hexagon of a tile grid.
    const svg = mapOf(["USA", "Canada", "Nowhereland"]);
    expect(svg).toContain('<g data-region-map-mode="geographic-preview">');
    expect(svg).toContain('<g data-region-map-mode="unmatched">');
  });
});

describe("the region map's markers are drawn with real alpha", () => {
  it("keeps the circles at 0.92 on both paints", () => {
    // The original markup carried `opacity="0.92"` on the element. The display list has
    // no element-level opacity, so it became an alpha on each paint — a faithful
    // translation of the intent, though not of the compositing, which is documented in
    // the `draw` section of AGENTS.md.
    //
    // Pinned because it is a deliberate choice with a known, accepted difference. A
    // later change to element opacity, or to the value, should have to say so.
    const svg = mapOf(["USA", "Canada"]);
    const circle = /<circle[^>]*\/>/.exec(svg)?.[0] ?? "";
    expect(circle).toContain('fill-opacity="0.92"');
    expect(circle).toContain('stroke-opacity="0.92"');
    expect(circle).not.toContain(" opacity=");
  });
});
