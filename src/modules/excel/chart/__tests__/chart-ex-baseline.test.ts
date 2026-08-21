/**
 * Baselines for every ChartEx layout, on both backends.
 *
 * Captured from the paired string/PDF emitters before those were replaced by the
 * shared drawing engine, and hashed over the *normalised* output — geometry for
 * SVG, recorded drawing calls for PDF — so a re-implementation that draws the same
 * picture reproduces them. Hashing the markup or the renderer's own trace could
 * not survive being rewritten, leaving re-baselining as the only way past a
 * failure, which checks new output against itself.
 *
 * The shape census beside each SVG hash is the diagnostic: when a hash moves, the
 * counts say whether shapes appeared, vanished, or merely shifted.
 *
 * ## Deliberate changes are baked in
 *
 * Each was a divergence between the backends, not a regression:
 *
 * 1. **`getPlotRect` no longer reserves legend margins when there is no legend.**
 *    A histogram, which Excel gives no legend, was surrendering 186 of 240 px to
 *    empty space in the SVG output while the PDF output used the full width. Only
 *    `histogram` shifts; every other layout has a legend and is untouched.
 * 2. **The title is 18pt at y=26 in both backends.** PDF drew it at 16pt / y=20,
 *    so the two disagreed on size and position. 18/26 matches the SVG output and
 *    the classic renderer.
 * 3. **A zero-inner-radius sector is one wedge path, not a ring path with a
 *    degenerate arc.** ChartEx wrote `M p1 A p2 L centre A(r=0) centre Z` while the
 *    classic pie renderer wrote `M centre L p1 A p2 Z` for the same shape — a third
 *    inconsistency between the two, and the ChartEx form carried a zero-radius arc
 *    command that does nothing. Both describe the same closed region; only
 *    `sunburst` is affected, and its shape count is unchanged.
 * 4. **Coordinates round half-up.** The old emitters formatted with `toFixed(2)`,
 *    the shared SVG surface with `Math.round(v * 100) / 100`. They differ only on
 *    an exact half — a funnel label at `60.525` became `60.52` and is now `60.53`,
 *    one hundredth of a pixel. Half-up is the more predictable rule and is what
 *    every classic-chart baseline is already built on, so ChartEx follows it rather
 *    than keeping two rounding conventions in one renderer.
 * 5. **A box-and-whisker box is filled with real alpha.** The SVG emitter mixed the
 *    series colour 35 % towards white; the PDF emitter set a 0.35 alpha. Only the
 *    latter is translucent over gridlines, and it is the convention the classic
 *    renderer already uses for area and bubble fills, so both backends now do it.
 *    The PDF hash is the evidence the geometry did not move: it was unchanged when
 *    the box nodes replaced the hand-written PDF emitter.
 * 6. **A zero-extent rect draws nothing, on every backend.** SVG says so — "a value
 *    of zero disables rendering of the element" — but a content stream will stroke
 *    a zero-height rect into a visible line, so the same display list came out
 *    differently per backend. The walker now drops it. A box-and-whisker group
 *    whose quartiles coincide loses its (invisible) box outline: `rect:6` becomes
 *    `rect:2` and both backends fall to 32 primitives. The median line, whisker and
 *    mean marker still mark the group.
 * 7. **The treemap layout is squarified, not slice-and-dice.** The old layout split
 *    the plot along a single axis in one pass, so at one level every tile was full
 *    height and as wide as its share — a four-node treemap read as a bar chart and
 *    the narrow tiles fell under the label threshold. Only `treemap` moves, and its
 *    shape count and census are unchanged: the same six rects and two labels, in
 *    different places.
 * 8. **The legend margins scale down on a small canvas.** They are absolute pixel
 *    counts — 58 left, 128 right — sized for a comfortable chart, so at this 240x160
 *    baseline size they left 54 px of plot, 22 % of the width. They now shrink
 *    together once they would claim more than their share, and the legend's own
 *    position is derived from the same reservation rather than a matching constant,
 *    which is what previously let the two disagree.
 *
 *    Every layout with a legend widens. `histogram` has none and its hashes are
 *    untouched. Two layouts gain labels because tiles that were below the label
 *    threshold now clear it — `treemap` goes from 8 shapes to 10 and `regionMap` from
 *    8 to 12 — which is the point of the extra room.
 * 9. **Only the side the legend is on reserves room for it.** All four margins were
 *    reserved whatever `legendPos` said, so a top or bottom legend still surrendered 58 px
 *    on the left and 128 on the right — around 40 % of the width — for a legend nowhere
 *    near either edge. The left margin keeps a floor of `AXIS_LABEL_INSET`, because the
 *    value-axis labels are drawn outside the plot and have to fit whatever the legend
 *    does.
 *
 *    Every layout here uses a right legend, so each shifts left by the difference between
 *    the old reservation and the axis floor. Shape counts and censuses are unchanged, and
 *    the SVG and PDF counts still match each other.
 * 10. **A polyline is one path, not a run of line segments.** The PDF emitters
 *    issued `drawLine` per segment where the SVG output had a single
 *    `<polyline>`; the shared surface issues one `drawPath`, which is the same
 *    geometry with proper joins. Only `pareto` has such a run here, so its call
 *    count drops from 32 to 30.
 */

import { buildChartExModel, drawChartExPdf, renderChartExSvg } from "@excel/chart";
import { collectTreemapCells } from "@excel/chart/render/chart-ex-renderer";
import { recordChartPdf } from "@test/pdf-draw-record";
import { describeSvgGeometry, extractSvgGeometry } from "@test/svg-geometry";
import { describe, expect, it } from "vitest";

import { stableHash } from "./chart-builder.helpers";

const WIDTH = 240;
const HEIGHT = 160;

interface Baseline {
  /** `[geometry hash, shape count, shape census]`. */
  readonly svg: readonly [string, number, string];
  /** `[hash of the recorded drawing, number of calls]`. */
  readonly pdf: readonly [string, number];
}

const BASELINES: Record<string, Baseline> = {
  sunburst: { svg: ["6ccf8500", 8, "path:4 rect:2 text:2"], pdf: ["08f6ba6b", 8] },
  treemap: { svg: ["66f96b37", 10, "rect:6 text:4"], pdf: ["0e4930be", 10] },
  funnel: { svg: ["d806a5e0", 12, "polygon:4 rect:2 text:6"], pdf: ["8a2581df", 12] },
  waterfall: { svg: ["840202d7", 27, "polyline:9 rect:6 text:12"], pdf: ["2156017f", 27] },
  histogram: { svg: ["d6a362f8", 18, "polyline:6 rect:3 text:9"], pdf: ["be217693", 18] },
  pareto: { svg: ["9c2fc671", 30, "circle:4 polyline:7 rect:6 text:13"], pdf: ["123152db", 30] },
  boxWhisker: {
    svg: ["31583b22", 32, "circle:4 polyline:14 rect:2 text:12"],
    pdf: ["c314b258", 32]
  },
  regionMap: { svg: ["93099fd1", 12, "polygon:4 rect:2 text:6"], pdf: ["0616ecc0", 12] }
};

/** A minimal but non-degenerate chart of the given layout, with a legend. */
function modelOf(type: string) {
  return buildChartExModel({
    type,
    categories: "Sheet1!$A$1:$A$4",
    series: [
      {
        name: "S",
        values: "Sheet1!$B$1:$B$4",
        literalValues: [10, 6, 3, 8],
        literalCategories: ["A", "B", "C", "D"]
      }
    ],
    showLegend: true,
    legendPosition: "r",
    title: "T"
  } as Parameters<typeof buildChartExModel>[0]);
}

/** Census of shape kinds, e.g. `"rect:6 text:2"`. */
function census(svg: string): string {
  const counts = new Map<string, number>();
  for (const shape of extractSvgGeometry(svg)) {
    counts.set(shape.kind, (counts.get(shape.kind) ?? 0) + 1);
  }
  return [...counts.keys()]
    .sort()
    .map(kind => `${kind}:${counts.get(kind)!}`)
    .join(" ");
}

/** Record what `drawChartExPdf` draws for one layout. */
function record(type: string) {
  const recorder = recordChartPdf();
  drawChartExPdf(recorder.surface as never, modelOf(type), {
    x: 0,
    y: 0,
    width: WIDTH,
    height: HEIGHT
  });
  return recorder;
}

describe("ChartEx SVG geometry is stable", () => {
  for (const [
    type,
    {
      svg: [hash, count, kinds]
    }
  ] of Object.entries(BASELINES)) {
    it(`${type} draws the same picture`, () => {
      const svg = renderChartExSvg(modelOf(type), { width: WIDTH, height: HEIGHT });
      expect(census(svg)).toBe(kinds);
      expect(extractSvgGeometry(svg)).toHaveLength(count);
      expect(stableHash(describeSvgGeometry(svg))).toBe(hash);
    });
  }

  it("distinguishes layouts from one another", () => {
    // A suite where every entry collided would pass while drawing nothing
    // layout-specific.
    const seen = new Map<string, string[]>();
    for (const [type, { svg }] of Object.entries(BASELINES)) {
      seen.set(svg[0], [...(seen.get(svg[0]) ?? []), type]);
    }
    for (const [hash, types] of seen) {
      expect(types, `layouts ${types.join(", ")} share geometry hash ${hash}`).toHaveLength(1);
    }
  });
});

describe("ChartEx backends agree", () => {
  // The two hashes above are independent, so they can drift apart silently — which
  // is exactly what happened while the layouts had one emitter per backend. Both
  // now consume the same display list, which makes primitive-for-primitive
  // agreement an invariant rather than a coincidence, so assert it directly.
  //
  // Counting primitives rather than comparing coordinates keeps this readable while
  // still catching the whole class of failure: a shape drawn by one backend and not
  // the other. Position agreement is covered by `draw-backend-parity.test.ts`,
  // which renders one list to markup, pixels and page operators and checks the
  // geometry matches modulo each backend's Y convention.
  /**
   * A shape reduced to what both backends can be held to: kind, geometry and paint.
   *
   * PDF coordinates are mirrored back into the SVG's Y-down space, and a rect's
   * origin moves from its bottom-left corner to its top-left one, so the two
   * descriptions are directly comparable.
   *
   * Two normalisations keep this honest rather than merely strict:
   *
   * - **Coordinates are compared at 0.1 px.** Rounding to two decimals at
   *   different points in an affine chain can differ by 0.01 while describing the
   *   same point: a funnel label sits at y = 60.525, which the SVG surface rounds
   *   to 60.53, while the PDF surface rounds the flipped 99.475 to 99.48. Every
   *   real divergence this test exists to catch was at least half a pixel.
   * - **A curved path is compared by its anchor and paint, not its points.** SVG
   *   keeps a sector's native arc while a content stream needs cubics, which is a
   *   deliberate choice recorded in `AGENTS.md`, so their point lists cannot match.
   *   `draw-backend-parity.test.ts` asserts that geometry agrees at the engine
   *   level; here the first point still pins the shape's position.
   */
  const canonical = (
    shape: {
      kind: string;
      coords: readonly number[];
      fill?: string;
      stroke?: string;
      text?: string;
    },
    mirror: boolean
  ): string => {
    // Snap to a fifth of a pixel rather than rounding to a tenth: rounding puts a
    // value that lands on the boundary — 72.15 — on either side of it depending on the
    // last bit of the arithmetic that produced it, which is not a difference in the
    // picture. A coarser grid with a consistent rule keeps the comparison stable while
    // staying far finer than any real divergence, all of which were half a pixel or
    // more.
    const q = (value: number): number => Math.floor(value * 5 + 0.5) / 5;
    const y = (value: number): number => q(mirror ? HEIGHT - value : value);
    let geometry: string;
    switch (shape.kind) {
      case "rect": {
        const [x, rawY, width, height] = shape.coords;
        // In PDF the recorded Y is the bottom edge; in SVG it is the top.
        geometry = `${q(x)},${mirror ? y(rawY + height) : q(rawY)} ${q(width)}x${q(height)}`;
        break;
      }
      case "circle": {
        const [cx, cy, r] = shape.coords;
        geometry = `${q(cx)},${y(cy)} r=${q(r)}`;
        break;
      }
      case "text": {
        const [x, ty] = shape.coords;
        geometry = `${q(x)},${y(ty)} "${shape.text ?? ""}"`;
        break;
      }
      case "path":
        geometry = `from ${q(shape.coords[0])},${y(shape.coords[1])}`;
        break;
      default: {
        // An outline is the same outline drawn either way round, so compare the
        // points as a set.
        const points: string[] = [];
        for (let i = 0; i + 1 < shape.coords.length; i += 2) {
          points.push(`${q(shape.coords[i])},${y(shape.coords[i + 1])}`);
        }
        geometry = [...points].sort().join(" ");
        break;
      }
    }
    // `polyline`, `polygon` and `line` are one concept — an outline — and each
    // backend legitimately picks a different primitive for it.
    const kind = ["polyline", "polygon", "line"].includes(shape.kind) ? "outline" : shape.kind;
    return `${kind} ${geometry} fill=${shape.fill ?? "-"} stroke=${shape.stroke ?? "-"}`;
  };

  for (const type of Object.keys(BASELINES)) {
    it(`${type} draws the same picture either way`, () => {
      // Both measured live, and compared shape by shape. Comparing the two baseline
      // constants instead would be a statement about this file, not the renderer,
      // and counting primitives alone would pass while every colour was wrong.
      const svgShapes = extractSvgGeometry(
        renderChartExSvg(modelOf(type), { width: WIDTH, height: HEIGHT })
      );
      const pdfShapes = record(type).shapes;
      // The first mark of each is the canvas: SVG fills the viewport, while the PDF
      // path frames the chart with a border instead — a deliberate difference the
      // classic renderer makes too, since a page needs a boundary and an embedded
      // SVG does not.
      const svgBody = svgShapes.slice(1).map(shape => canonical(shape, false));
      const pdfBody = pdfShapes.slice(1).map(shape => canonical(shape, true));
      expect(pdfBody).toEqual(svgBody);
    });
  }
});

describe("ChartEx PDF output is stable", () => {
  for (const [
    type,
    {
      pdf: [hash, calls]
    }
  ] of Object.entries(BASELINES)) {
    it(`${type} issues the same drawing`, () => {
      const recorder = record(type);
      expect(recorder.calls).toHaveLength(calls);
      expect(stableHash(recorder.describe())).toBe(hash);
    });
  }

  it("distinguishes layouts from one another", () => {
    const seen = new Map<string, string[]>();
    for (const [type, { pdf }] of Object.entries(BASELINES)) {
      seen.set(pdf[0], [...(seen.get(pdf[0]) ?? []), type]);
    }
    for (const [hash, types] of seen) {
      expect(types, `layouts ${types.join(", ")} share PDF hash ${hash}`).toHaveLength(1);
    }
  });
});

describe("the plot keeps a usable share of a small canvas", () => {
  /** The plot rectangle, read back from the axis gridlines. */
  const plotOf = (width: number, height: number, legendPosition: string) => {
    const svg = renderChartExSvg(
      buildChartExModel({
        type: "waterfall",
        categories: "S!$A$1:$A$3",
        series: [
          {
            name: "Ser",
            values: "S!$B$1:$B$3",
            literalValues: [10, 6, 3],
            literalCategories: ["A", "B", "C"]
          }
        ],
        showLegend: true,
        legendPosition,
        title: "T"
      } as Parameters<typeof buildChartExModel>[0]),
      { width, height }
    );
    const shapes = extractSvgGeometry(svg);
    const horizontals = shapes.filter(
      shape =>
        shape.kind === "polyline" &&
        shape.coords.length === 4 &&
        Math.abs(shape.coords[1] - shape.coords[3]) < 0.01
    );
    const swatches = shapes.filter(
      shape => shape.kind === "rect" && shape.coords[2] === 10 && shape.coords[3] === 10
    );
    return {
      left: Math.min(...horizontals.map(s => Math.min(s.coords[0], s.coords[2]))),
      right: Math.max(...horizontals.map(s => Math.max(s.coords[0], s.coords[2]))),
      top: Math.min(...horizontals.map(s => s.coords[1])),
      bottom: Math.max(...horizontals.map(s => s.coords[1])),
      swatches: swatches.map(s => ({ x: s.coords[0], y: s.coords[1] }))
    };
  };

  it("does not let the legend margins swallow a narrow chart", () => {
    // The margins are absolute pixel counts sized for a comfortable chart: 58 on the
    // left and 128 on the right. On a 240-wide canvas that left 54 px of plot — 22 %
    // of it — and a 260-wide one was down to 74.
    for (const [width, height] of [
      [240, 160],
      [260, 420]
    ] as const) {
      const plot = plotOf(width, height, "r");
      expect(
        (plot.right - plot.left) / width,
        `${width}x${height} kept ${(plot.right - plot.left).toFixed(0)}px of plot`
      ).toBeGreaterThan(0.4);
    }
  });

  it("still gives a roomy chart its full margins", () => {
    // Scaling down is for the canvases that need it; a large chart keeps the comfortable
    // reservation. On the right that is the legend's own; on the left it is the axis
    // labels' floor, because a right legend needs no room there.
    const right = plotOf(900, 500, "r");
    expect(right.left).toBeCloseTo(44, 6);
    expect(900 - right.right).toBeCloseTo(128, 6);
    // A left legend does reserve its full width on that side.
    expect(plotOf(900, 500, "l").left).toBeCloseTo(58, 6);
  });

  it("gives a top or bottom legend the full width", () => {
    // The reservation follows `legendPos`: a legend above or below the plot needs no
    // horizontal room, and taking it anyway cost around 40 % of the width.
    for (const position of ["t", "b"]) {
      const plot = plotOf(460, 300, position);
      expect((plot.right - plot.left) / 460, position).toBeGreaterThan(0.8);
    }
  });

  it("keeps the legend out of the plot at every position and size", () => {
    // The plot's edge and the legend's position are two readings of one reservation.
    // They were written as separate constants — 128 reserved, the swatch at
    // `width - 116` — so scaling the reservation alone put the legend inside the plot.
    for (const position of ["r", "l", "b", "t", "tr"]) {
      for (const [width, height] of [
        [240, 160],
        [260, 420],
        [460, 300],
        [900, 500]
      ] as const) {
        const plot = plotOf(width, height, position);
        for (const swatch of plot.swatches) {
          const inside =
            swatch.x + 10 > plot.left &&
            swatch.x < plot.right &&
            swatch.y + 10 > plot.top &&
            swatch.y < plot.bottom;
          expect(
            inside,
            `${position} at ${width}x${height}: swatch at ${swatch.x},${swatch.y}`
          ).toBe(false);
        }
      }
    }
  });
});

describe("the region map frames its data", () => {
  const preview = (categories: string[]) =>
    renderChartExSvg(
      buildChartExModel({
        type: "regionMap",
        series: [
          {
            values: "x",
            literalValues: categories.map((_, index) => 10 + index * 5),
            literalCategories: categories
          }
        ],
        layout: { regionLabels: "showAll" }
      } as Parameters<typeof buildChartExModel>[0]),
      { width: 420, height: 260 }
    );

  /** The drawn circles, which are the data points. */
  const circles = (svg: string) =>
    extractSvgGeometry(svg)
      .filter(shape => shape.kind === "circle")
      .map(shape => ({ x: shape.coords[0], y: shape.coords[1], r: shape.coords[2] }));

  it("spreads a regional cluster across the panel", () => {
    // The preview used to project the whole world onto the panel, so four American
    // countries landed within a fifth of it, overlapping each other with unreadable
    // labels. The TopoJSON branch already framed to its data.
    //
    // The test is on the dominant axis, not both: these four span 90 degrees of
    // latitude and 50 of longitude, so a faithful map is taller than it is wide and
    // demanding the same spread horizontally would be demanding distortion.
    const drawn = circles(preview(["USA", "Canada", "Brazil", "Chile"]));
    expect(drawn).toHaveLength(4);
    const spreadX = Math.max(...drawn.map(c => c.x)) - Math.min(...drawn.map(c => c.x));
    const spreadY = Math.max(...drawn.map(c => c.y)) - Math.min(...drawn.map(c => c.y));
    expect(Math.max(spreadX, spreadY)).toBeGreaterThan(120);
    expect(Math.min(spreadX, spreadY)).toBeGreaterThan(50);
  });

  it("does not stretch the map to the shape of the panel", () => {
    // Each axis of the extent is mapped onto its own side of the plot, so the extent
    // has to be widened to the panel's proportions first. Without that a degree of
    // longitude covered more pixels than a degree of latitude, and the same countries
    // came out a different shape on a landscape panel than on a portrait one.
    const ratio = (width: number, height: number): number => {
      const drawn = circles(
        renderChartExSvg(
          buildChartExModel({
            type: "regionMap",
            series: [
              {
                values: "x",
                literalValues: [10, 15, 20, 25],
                literalCategories: ["USA", "Canada", "Brazil", "Chile"]
              }
            ],
            layout: { regionLabels: "showAll" }
          } as Parameters<typeof buildChartExModel>[0]),
          { width, height }
        )
      );
      const spreadX = Math.max(...drawn.map(c => c.x)) - Math.min(...drawn.map(c => c.x));
      const spreadY = Math.max(...drawn.map(c => c.y)) - Math.min(...drawn.map(c => c.y));
      return spreadX / spreadY;
    };
    const landscape = ratio(420, 260);
    expect(ratio(260, 420)).toBeCloseTo(landscape, 2);
    expect(ratio(300, 300)).toBeCloseTo(landscape, 2);
  });

  it("keeps the circles from swallowing each other", () => {
    const drawn = circles(preview(["USA", "Canada", "Brazil", "Chile"]));
    for (let i = 0; i < drawn.length; i++) {
      for (let j = i + 1; j < drawn.length; j++) {
        const distance = Math.hypot(drawn[i].x - drawn[j].x, drawn[i].y - drawn[j].y);
        // Centres further apart than either radius: each marker's own centre, and so
        // its label, stays clear of its neighbour.
        expect(distance).toBeGreaterThan(Math.max(drawn[i].r, drawn[j].r));
      }
    }
  });

  it("does not zoom a single region to absurdity", () => {
    // With nothing to span, framing tightly would put one circle in the middle of a
    // panel at maximum zoom. A minimum span keeps some context.
    const drawn = circles(preview(["USA"]));
    expect(drawn).toHaveLength(1);
    expect(drawn[0].x).toBeGreaterThan(120);
    expect(drawn[0].x).toBeLessThan(300);
  });

  it("stays inside the panel", () => {
    const drawn = circles(preview(["USA", "Canada", "Brazil", "Chile"]));
    for (const circle of drawn) {
      expect(circle.x - circle.r).toBeGreaterThan(0);
      expect(circle.x + circle.r).toBeLessThan(420);
      expect(circle.y - circle.r).toBeGreaterThan(0);
      expect(circle.y + circle.r).toBeLessThan(260);
    }
  });
});

describe("the treemap layout is squarified", () => {
  interface Node {
    name: string;
    value: number;
    children: Node[];
  }
  const leaf = (name: string, value: number): Node => ({ name, value, children: [] });
  const root: Node = {
    name: "root",
    value: 100,
    children: [leaf("A", 40), leaf("B", 25), leaf("C", 18), leaf("D", 12), leaf("E", 5)]
  };
  const box = { x: 0, y: 0, width: 400, height: 260 };
  const cells = collectTreemapCells(root as never, box);

  it("gives every tile a usable aspect ratio", () => {
    // The old slice-and-dice layout split the plot along one axis in a single pass,
    // so each tile was full height and as wide as its share: the 5 % node came out
    // 20 x 260, a ratio of 13, which reads as a bar chart rather than a treemap and
    // is impossible to compare by area.
    for (const cell of cells) {
      const ratio = Math.max(
        cell.rect.width / cell.rect.height,
        cell.rect.height / cell.rect.width
      );
      expect(ratio, `${cell.label ?? "unlabelled"} is ${ratio.toFixed(2)}:1`).toBeLessThan(4);
    }
  });

  it("keeps each tile's area proportional to its value", () => {
    // Readability is worthless if the areas stop meaning anything.
    const total = box.width * box.height;
    const expected = [40, 25, 18, 12, 5];
    const areas = cells.map(cell => cell.rect.width * cell.rect.height);
    areas.forEach((area, index) => {
      expect(area / total).toBeCloseTo(expected[index] / 100, 3);
    });
  });

  it("tiles the plot without gaps or overlap", () => {
    const covered = cells.reduce((sum, cell) => sum + cell.rect.width * cell.rect.height, 0);
    expect(covered).toBeCloseTo(box.width * box.height, 6);
  });

  it("leaves every tile large enough to label", () => {
    // The narrow strips fell under the 40 x 18 label threshold, so the smallest
    // nodes were drawn as anonymous colour bands.
    expect(cells.every(cell => cell.label !== undefined)).toBe(true);
  });
});

describe("ChartEx legend clears a multi-paragraph title", () => {
  /**
   * A title paragraph past the first has to push the top legend row down.
   *
   * `getPlotRect` already scaled the plot's top margin by the line count, but the
   * legend layout only received a `hasTitle` boolean, so its row stayed at a fixed
   * y=40 while the second title line sat at baseline 47.6 — the title was drawn
   * through the swatches, and a three-line title had the legend wedged between its
   * paragraphs. Both backends share the layout, so both were wrong.
   */
  const titled = (title: string) =>
    buildChartExModel({
      type: "funnel",
      categories: "S!$A$1:$A$3",
      series: [
        {
          name: "Ser",
          values: "S!$B$1:$B$3",
          literalValues: [10, 6, 3],
          literalCategories: ["A", "B", "C"]
        }
      ],
      showLegend: true,
      legendPosition: "t",
      title
    } as Parameters<typeof buildChartExModel>[0]);

  /** Baselines of the title's paragraphs, in document order. */
  const titleBaselines = (svg: string): number[] => {
    const text = /<text[^>]*font-size="18"[^>]*>([\s\S]*?)<\/text>/.exec(svg);
    if (!text) {
      return [];
    }
    const spans = [...text[1].matchAll(/<tspan[^>]*y="([\d.]+)"/g)].map(match => Number(match[1]));
    return spans.length > 0 ? spans : [Number(/y="([\d.]+)"/.exec(text[0])![1])];
  };

  const swatchTop = (svg: string): number =>
    Number(/<rect x="[\d.]+" y="([\d.]+)" width="10" height="10"/.exec(svg)![1]);

  for (const [lines, title] of [
    [1, "One"],
    [2, "Line one\nLine two"],
    [3, "A\nB\nC"]
  ] as const) {
    it(`${lines}-paragraph title does not overlap the top legend`, () => {
      const svg = renderChartExSvg(titled(title), { width: 360, height: 240 });
      const baselines = titleBaselines(svg);
      expect(baselines).toHaveLength(lines);
      // The swatch has to start below the last paragraph's descender. 18-unit text
      // descends roughly a fifth of its size below the baseline.
      const lastDescender = baselines[baselines.length - 1] + 18 * 0.2;
      expect(swatchTop(svg)).toBeGreaterThan(lastDescender);
    });
  }

  it("keeps the legend above the plot area", () => {
    // Clearing the title is only half of it — the row must still sit in the band
    // between the title and the plot, not get pushed into the data.
    const svg = renderChartExSvg(titled("A\nB\nC"), { width: 360, height: 240 });
    const gridlineTop = Math.min(
      ...extractSvgGeometry(svg)
        .filter(shape => shape.kind === "polyline")
        .map(shape => shape.coords[1])
    );
    expect(swatchTop(svg) + 10).toBeLessThanOrEqual(gridlineTop);
  });
});

describe("ChartEx backends agree with each other", () => {
  /**
   * Legend swatches are the sharpest cross-backend probe: a fixed 10x10 rect
   * positioned from one shared layout, present in both outputs.
   */
  for (const type of Object.keys(BASELINES)) {
    it(`${type} puts its legend in the same place in both backends`, () => {
      // `buildChartExModel` only attaches a legend to the layouts Excel gives one
      // — histogram has none, so there is nothing to compare.
      if (!modelOf(type).chartSpace.chart.legend) {
        return;
      }
      const svgSwatches = extractSvgGeometry(
        renderChartExSvg(modelOf(type), { width: WIDTH, height: HEIGHT })
      )
        .filter(shape => shape.kind === "rect" && shape.coords[2] === 10 && shape.coords[3] === 10)
        .map(shape => ({ x: shape.coords[0], y: shape.coords[1] }));
      const pdfSwatches = record(type)
        .calls.filter(call => / 10x10 /.test(call))
        .map(call => {
          const match = /^rect ([\d.-]+),([\d.-]+) /.exec(call)!;
          return { x: Number(match[1]), y: Number(match[2]) };
        });

      expect(svgSwatches.length).toBeGreaterThan(0);
      expect(pdfSwatches).toHaveLength(svgSwatches.length);
      svgSwatches.forEach((swatch, index) => {
        expect(pdfSwatches[index].x).toBeCloseTo(swatch.x, 6);
        // SVG's top edge is PDF's bottom edge measured from the other side.
        expect(pdfSwatches[index].y).toBeCloseTo(HEIGHT - (swatch.y + 10), 6);
      });
    });
  }
});
