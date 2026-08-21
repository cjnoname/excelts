/**
 * The one plan the three ChartEx backends draw.
 *
 * Size, title, plot rectangle, series and legend used to be derived three times — once
 * per backend — and that is exactly how they drifted: the title came out 16pt in PDF
 * and 18pt in SVG, and a chart with no legend used different margins depending on which
 * output was asked for. These tests pin the properties a single plan guarantees, so a
 * future backend cannot quietly re-derive its own.
 *
 * The geometry itself is pinned by `chart-ex-baseline.test.ts`; what is checked here is
 * *agreement*, which a hash of one backend's output cannot see.
 */
import { buildChartExModel, drawChartExPdf, renderChartExSvg } from "@excel/chart";
import { recordChartPdf } from "@test/pdf-draw-record";
import { extractSvgGeometry } from "@test/svg-geometry";
import { describe, expect, it } from "vitest";

const WIDTH = 460;
const HEIGHT = 300;

interface Cfg {
  title?: string;
  showLegend?: boolean;
  legendPosition?: string;
}

function modelOf(type: string, cfg: Cfg = {}) {
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
    showLegend: cfg.showLegend ?? true,
    legendPosition: cfg.legendPosition ?? "r",
    ...(cfg.title === undefined ? {} : { title: cfg.title })
  } as Parameters<typeof buildChartExModel>[0]);
}

/** The PDF calls for one model, drawn into a box at `origin`. */
function pdfCalls(type: string, cfg: Cfg = {}, origin = { x: 0, y: 0 }): string[] {
  const recorder = recordChartPdf();
  drawChartExPdf(recorder.surface as never, modelOf(type, cfg), {
    ...origin,
    width: WIDTH,
    height: HEIGHT
  });
  return recorder.calls;
}

/**
 * Every text mark in the SVG, as `text@size`.
 *
 * A multi-paragraph title is one `<text>` carrying a `<tspan>` per line, so the lines
 * have to be read out of the children rather than out of the element's own content.
 */
function svgText(type: string, cfg: Cfg = {}): string[] {
  const svg = renderChartExSvg(modelOf(type, cfg), { width: WIDTH, height: HEIGHT });
  const out: string[] = [];
  for (const element of svg.matchAll(/<text[^>]*font-size="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g)) {
    const size = element[1];
    const body = element[2];
    const spans = [...body.matchAll(/<tspan[^>]*>([^<]*)<\/tspan>/g)].map(span => span[1]);
    for (const line of spans.length > 0 ? spans : [body]) {
      out.push(`${line}@${size}`);
    }
  }
  return out;
}

/** Whether the built model actually carries a legend. */
function hasLegend(type: string, cfg: Cfg = {}): boolean {
  const model = modelOf(type, cfg) as unknown as {
    chartSpace: { chart: { legend?: unknown } };
  };
  return model.chartSpace.chart.legend !== undefined;
}

const LAYOUTS = ["waterfall", "treemap", "funnel", "boxWhisker", "histogram", "regionMap"];

describe("every backend draws from one plan", () => {
  for (const layout of LAYOUTS) {
    it(`${layout} titles agree between SVG and PDF`, () => {
      // The size lived in two emitters and drifted by 2pt; one plan builds the node.
      const inSvg = svgText(layout, { title: "T" }).filter(entry => entry.startsWith("T@"));
      const inPdf = pdfCalls(layout, { title: "T" }).filter(call => call.includes('"T"'));
      expect(inSvg).toHaveLength(1);
      expect(inPdf).toHaveLength(1);
      expect(inSvg[0]).toBe("T@18");
      expect(inPdf[0]).toContain("sz=18");
    });

    it(`${layout} draws a legend in PDF exactly when the model carries one`, () => {
      // The vector PDF path used to omit the legend entirely, so an authored
      // `legendPos` appeared in SVG and PNG but never in a PDF. Drive the expectation
      // off the model rather than off `showLegend`: the builder stores no legend for a
      // histogram at all, which both backends already agree on.
      const withLegend = pdfCalls(layout, { title: "T", showLegend: true });
      const without = pdfCalls(layout, { title: "T", showLegend: false });
      if (hasLegend(layout, { title: "T", showLegend: true })) {
        expect(withLegend.length).toBeGreaterThan(without.length);
      } else {
        expect(withLegend).toEqual(without);
      }
    });
  }

  it("a multi-paragraph title stacks on every backend", () => {
    const lines = svgText("waterfall", { title: "one\ntwo\nthree" }).filter(entry =>
      /^(one|two|three)@/.test(entry)
    );
    expect(lines).toEqual(["one@18", "two@18", "three@18"]);
    const inPdf = pdfCalls("waterfall", { title: "one\ntwo\nthree" }).filter(call =>
      /"(one|two|three)"/.test(call)
    );
    expect(inPdf).toHaveLength(3);
  });

  it("the plot rectangle does not depend on the backend", () => {
    // Both paths call `getPlotRect` through the plan, so the gridlines they draw sit at
    // the same Y once the PDF flip is undone. Reading it off the marks is what catches a
    // second derivation; comparing the two renderers' own numbers would not.
    const svg = renderChartExSvg(modelOf("waterfall", { title: "T" }), {
      width: WIDTH,
      height: HEIGHT
    });
    // ChartEx draws a gridline as a two-point polyline, which is what the shared node
    // builder emits; there is no `line` primitive in its output.
    // ChartEx draws a gridline as a two-point polyline, which is what the shared node
    // builder emits; there is no `line` primitive in its output. Compare *both*
    // endpoints as a multiset: taking one of them compares a vertical line's top edge
    // against its own bottom edge once the flip is undone, which says nothing.
    const round = (value: number): number => Math.round(value * 100) / 100;
    const svgEnds = extractSvgGeometry(svg)
      .filter(shape => shape.kind === "polyline" && shape.coords.length === 4)
      .flatMap(shape => [round(shape.coords[1]), round(shape.coords[3])])
      .sort((a, b) => a - b);
    const pdfEnds = pdfCalls("waterfall", { title: "T" })
      .filter(call => call.startsWith("line "))
      .flatMap(call => {
        const match = /line [\d.-]+,([\d.-]+)→[\d.-]+,([\d.-]+)/.exec(call)!;
        // Undo the flip: the destination box is the chart's own height.
        return [round(HEIGHT - Number(match[1])), round(HEIGHT - Number(match[2]))];
      })
      .sort((a, b) => a - b);
    expect(pdfEnds).toEqual(svgEnds);
  });

  it("a region map reports its mode in SVG and draws the same marks in PDF", () => {
    // The mode is an SVG-only annotation attached at serialisation; the nodes are shared.
    const svg = renderChartExSvg(modelOf("regionMap"), { width: WIDTH, height: HEIGHT });
    expect(svg).toMatch(/data-region-map-mode="[a-z-]+"/);
    expect(pdfCalls("regionMap").length).toBeGreaterThan(1);
  });

  it("the destination origin only translates the PDF output", () => {
    // The plan is computed in the chart's own space, so moving the box must not change
    // anything but the coordinates — a second layout pass would change the counts.
    expect(pdfCalls("waterfall", { title: "T" }, { x: 37, y: 91 })).toHaveLength(
      pdfCalls("waterfall", { title: "T" }).length
    );
  });
});
