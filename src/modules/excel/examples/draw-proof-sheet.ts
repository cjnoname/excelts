/**
 * Visual proof sheet for the shared drawing engine.
 *
 * Writes, for each subject, the same display list through every backend that can
 * express it — SVG markup, a PNG raster, and a PDF page — so the three can be
 * compared side by side rather than trusted one at a time. A hash test says the
 * output did not change; this says whether it is right.
 *
 * Run: npx tsx src/modules/excel/examples/draw-proof-sheet.ts
 * Output: tmp/proof/
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { renderDrawList, toSvg } from "@draw/index";
import type { DrawList, DrawNode, DrawPathCommand } from "@draw/index";
import {
  fillChartCaches,
  fillChartExCaches,
  renderChartExPng,
  renderChartExSvg,
  renderChartPng,
  renderChartSvg
} from "@excel/chart";
import { rasterizeDrawList } from "@excel/chart/render/draw-raster-png";
import { addChart, addChartEx, getCharts } from "@excel/core/worksheet";
import { Chart, Workbook, Worksheet } from "@excel/index";
import { PdfDocumentBuilder } from "@pdf/builder/document-builder";
import { createPdfDrawSurface } from "@pdf/render/draw-surface";

const OUT = path.resolve("tmp/proof");
mkdirSync(OUT, { recursive: true });

const BLUE = { r: 0.27, g: 0.45, b: 0.77, a: 1 };
const WHITE = { r: 1, g: 1, b: 1, a: 1 };
const INK = { r: 0.15, g: 0.15, b: 0.15, a: 1 };

/** Render one display list to all three backends, at 2x for the raster. */
function threeWays(name: string, list: DrawList): void {
  writeFileSync(path.join(OUT, `${name}.svg`), toSvg(list));

  writeFileSync(
    path.join(OUT, `${name}.png`),
    rasterizeDrawList(list, { width: list.width, height: list.height, scale: 2 })
  );

  const builder = new PdfDocumentBuilder();
  const page = builder.addPage({ width: list.width, height: list.height });
  renderDrawList(
    list,
    createPdfDrawSurface(page, { x: 0, y: 0, width: list.width, height: list.height })
  );
  void builder.build().then(bytes => writeFileSync(path.join(OUT, `${name}.pdf`), bytes));
}

// ---------------------------------------------------------------------------
// 1. Every primitive, filled and stroked. The audit that found two backends
//    dropping a stroke they were supposed to draw.
// ---------------------------------------------------------------------------

const paint = { fill: BLUE, stroke: WHITE, strokeWidth: 3 };
const primitives: DrawNode[] = [
  { kind: "rect", x: 20, y: 20, width: 90, height: 70, paint },
  { kind: "rect", x: 130, y: 20, width: 90, height: 70, rx: 18, paint },
  { kind: "ellipse", cx: 285, cy: 55, rx: 45, ry: 35, paint },
  {
    kind: "sector",
    cx: 400,
    cy: 55,
    radius: 40,
    innerRadius: 0,
    startAngle: 0.3,
    endAngle: 2.6,
    paint
  },
  {
    kind: "sector",
    cx: 510,
    cy: 55,
    radius: 40,
    innerRadius: 18,
    startAngle: 0.3,
    endAngle: 2.6,
    paint
  },
  {
    kind: "polyline",
    closed: true,
    points: [
      { x: 30, y: 190 },
      { x: 105, y: 130 },
      { x: 110, y: 200 }
    ],
    paint
  },
  {
    kind: "path",
    commands: [
      { op: "move", x: 140, y: 195 },
      { op: "line", x: 215, y: 130 },
      { op: "cubic", x1: 240, y1: 165, x2: 205, y2: 205, x: 150, y: 200 },
      { op: "close" }
    ],
    paint
  },
  {
    kind: "polyline",
    points: [
      { x: 250, y: 190 },
      { x: 330, y: 130 }
    ],
    paint: { stroke: INK, strokeWidth: 3, dash: [9] }
  },
  {
    kind: "polyline",
    points: [
      { x: 360, y: 190 },
      { x: 440, y: 130 }
    ],
    paint: { stroke: INK, strokeWidth: 3, dash: [12, 6, 3] }
  },
  {
    kind: "polyline",
    points: [
      { x: 470, y: 195 },
      { x: 505, y: 130 },
      { x: 545, y: 195 }
    ],
    paint: { stroke: INK, strokeWidth: 7, lineJoin: "round", lineCap: "round" }
  },
  {
    kind: "text",
    x: 20,
    y: 235,
    lines: [{ text: "rect   rounded   ellipse   sector   ring", dy: 0 }],
    style: { size: 13, fill: INK, family: "Arial" }
  },
  {
    kind: "text",
    x: 20,
    y: 253,
    lines: [{ text: "polygon   path   dash[9]   dash[12,6,3]   round join", dy: 0 }],
    style: { size: 13, fill: INK, family: "Arial" }
  }
];

threeWays("01-primitives", {
  width: 580,
  height: 265,
  children: [
    {
      kind: "rect",
      x: 0,
      y: 0,
      width: 580,
      height: 265,
      paint: { fill: { r: 0.97, g: 0.98, b: 1, a: 1 } }
    },
    ...primitives
  ]
});

// ---------------------------------------------------------------------------
// 2. A sector under the transforms it cannot survive as a sector.
// ---------------------------------------------------------------------------

const wedge = (transform: {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}): DrawNode => ({
  kind: "group",
  transform,
  children: [
    {
      kind: "sector",
      cx: 0,
      cy: 0,
      radius: 60,
      innerRadius: 0,
      startAngle: 0,
      endAngle: Math.PI / 2,
      paint: { fill: BLUE, stroke: WHITE, strokeWidth: 2 }
    }
  ]
});

// Stroke ends and corners, which every backend now expresses.
// Compound paths: a hole only exists if the rings are resolved together, and which
// region is inside depends on the winding rule.
threeWays("01c-compound-paths", {
  width: 460,
  height: 170,
  children: [
    {
      kind: "rect",
      x: 0,
      y: 0,
      width: 460,
      height: 170,
      paint: { fill: { r: 0.97, g: 0.98, b: 1, a: 1 } }
    },
    ...(
      [
        ["reversed ring", true, undefined],
        ["same, nonzero", false, "nonzero"],
        ["same, evenodd", false, "evenodd"]
      ] as Array<[string, boolean, "nonzero" | "evenodd" | undefined]>
    ).flatMap(([label, reversed, rule], index): DrawNode[] => {
      const x = 30 + index * 145;
      const inner: DrawPathCommand[] = reversed
        ? [
            { op: "move", x: x + 25, y: 45 },
            { op: "line", x: x + 25, y: 105 },
            { op: "line", x: x + 75, y: 105 },
            { op: "line", x: x + 75, y: 45 },
            { op: "close" }
          ]
        : [
            { op: "move", x: x + 25, y: 45 },
            { op: "line", x: x + 75, y: 45 },
            { op: "line", x: x + 75, y: 105 },
            { op: "line", x: x + 25, y: 105 },
            { op: "close" }
          ];
      return [
        {
          kind: "path",
          commands: [
            { op: "move", x, y: 25 },
            { op: "line", x: x + 100, y: 25 },
            { op: "line", x: x + 100, y: 125 },
            { op: "line", x, y: 125 },
            { op: "close" },
            ...inner
          ],
          paint: {
            fill: BLUE,
            stroke: WHITE,
            strokeWidth: 2,
            ...(rule === undefined ? {} : { fillRule: rule })
          }
        },
        {
          kind: "text",
          x: x + 50,
          y: 150,
          lines: [{ text: label, dy: 0 }],
          style: { size: 12, fill: INK, anchor: "middle", family: "Arial" }
        }
      ];
    })
  ]
});

// Mitred corners: the spike grows as the corner sharpens, then the limit drops it.
threeWays("01d-miter-limit", {
  width: 520,
  height: 170,
  children: [
    {
      kind: "rect",
      x: 0,
      y: 0,
      width: 520,
      height: 170,
      paint: { fill: { r: 0.97, g: 0.98, b: 1, a: 1 } }
    },
    ...[90, 40, 20, 10].flatMap((interior, index): DrawNode[] => {
      const angle = Math.PI * (interior / 180);
      const x = 40 + index * 128;
      return [
        {
          kind: "polyline",
          points: [
            { x: x - Math.cos(angle) * 70, y: 80 - Math.sin(angle) * 70 },
            { x, y: 80 },
            { x: x - Math.cos(angle) * 70, y: 80 + Math.sin(angle) * 70 }
          ],
          paint: { stroke: INK, strokeWidth: 12 }
        },
        {
          kind: "text",
          x: x - 30,
          y: 158,
          lines: [{ text: `${interior}\u00b0`, dy: 0 }],
          style: { size: 12, fill: INK, anchor: "middle", family: "Arial" }
        }
      ];
    })
  ]
});

threeWays("01b-stroke-shapes", {
  width: 420,
  height: 160,
  children: [
    {
      kind: "rect",
      x: 0,
      y: 0,
      width: 420,
      height: 160,
      paint: { fill: { r: 0.97, g: 0.98, b: 1, a: 1 } }
    },
    ...[
      ["butt / miter", {}],
      ["round", { lineJoin: "round" as const, lineCap: "round" as const }],
      ["square", { lineCap: "square" as const }]
    ].flatMap(([label, shape], index): DrawNode[] => {
      const x = 30 + index * 135;
      return [
        {
          kind: "polyline",
          points: [
            { x, y: 105 },
            { x: x + 40, y: 40 },
            { x: x + 80, y: 105 }
          ],
          paint: {
            stroke: INK,
            strokeWidth: 16,
            ...(shape as Record<string, unknown>)
          }
        },
        {
          kind: "text",
          x: x + 40,
          y: 140,
          lines: [{ text: label as string, dy: 0 }],
          style: { size: 13, fill: INK, anchor: "middle", family: "Arial" }
        }
      ];
    })
  ]
});

threeWays("02-sector-transforms", {
  width: 560,
  height: 180,
  children: [
    {
      kind: "rect",
      x: 0,
      y: 0,
      width: 560,
      height: 180,
      paint: { fill: { r: 0.97, g: 0.98, b: 1, a: 1 } }
    },
    // Identity, rotation, mirror, non-uniform scale — each wedge should occupy the
    // quadrant its transform puts it in, and the mirror must go left-and-down.
    {
      kind: "group",
      transform: { a: 1, b: 0, c: 0, d: 1, e: 70, f: 40 },
      children: [wedge({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })]
    },
    {
      kind: "group",
      transform: { a: 1, b: 0, c: 0, d: 1, e: 210, f: 40 },
      children: [
        wedge({
          a: Math.cos(0.6),
          b: Math.sin(0.6),
          c: -Math.sin(0.6),
          d: Math.cos(0.6),
          e: 0,
          f: 0
        })
      ]
    },
    {
      kind: "group",
      transform: { a: 1, b: 0, c: 0, d: 1, e: 350, f: 40 },
      children: [wedge({ a: -1, b: 0, c: 0, d: 1, e: 0, f: 0 })]
    },
    {
      kind: "group",
      transform: { a: 1, b: 0, c: 0, d: 1, e: 430, f: 40 },
      children: [wedge({ a: 1.8, b: 0, c: 0, d: 0.8, e: 0, f: 0 })]
    },
    {
      kind: "text",
      x: 40,
      y: 150,
      lines: [{ text: "identity", dy: 0 }],
      style: { size: 12, fill: INK, family: "Arial" }
    },
    {
      kind: "text",
      x: 180,
      y: 150,
      lines: [{ text: "rotate 34\u00b0", dy: 0 }],
      style: { size: 12, fill: INK, family: "Arial" }
    },
    {
      kind: "text",
      x: 300,
      y: 150,
      lines: [{ text: "mirror X", dy: 0 }],
      style: { size: 12, fill: INK, family: "Arial" }
    },
    {
      kind: "text",
      x: 430,
      y: 150,
      lines: [{ text: "scale(1.8, 0.8)", dy: 0 }],
      style: { size: 12, fill: INK, family: "Arial" }
    }
  ]
});

// ---------------------------------------------------------------------------
// 3. Real charts, SVG and PNG from the same display list.
// ---------------------------------------------------------------------------

function sheet(): {
  ws: ReturnType<typeof Workbook.addWorksheet>;
  wb: ReturnType<typeof Workbook.create>;
} {
  const wb = Workbook.create();
  const ws = Workbook.addWorksheet(wb, "S");
  Worksheet.addRows(ws, [
    ["Q1", 42, 30],
    ["Q2", 58, 44],
    ["Q3", 31, 52],
    ["Q4", 67, 38]
  ]);
  return { ws, wb };
}

const classic: Array<[string, Record<string, unknown>]> = [
  [
    "pie",
    {
      type: "pie",
      series: [{ categories: "S!$A$1:$A$4", values: "S!$B$1:$B$4" }],
      showLegend: true
    }
  ],
  [
    "doughnut",
    {
      type: "doughnut",
      series: [{ categories: "S!$A$1:$A$4", values: "S!$B$1:$B$4" }],
      showLegend: true
    }
  ],
  [
    "line-smooth",
    {
      type: "line",
      series: [
        { name: "Plan", categories: "S!$A$1:$A$4", values: "S!$B$1:$B$4" },
        { name: "Actual", categories: "S!$A$1:$A$4", values: "S!$C$1:$C$4" }
      ],
      smooth: true,
      showLegend: true,
      title: "Smooth line\nrounded joins"
    }
  ],
  [
    "area",
    {
      type: "area",
      series: [{ name: "A", categories: "S!$A$1:$A$4", values: "S!$B$1:$B$4" }],
      showLegend: true,
      title: "Translucent area"
    }
  ],
  [
    "bar",
    {
      type: "bar",
      series: [
        { name: "A", categories: "S!$A$1:$A$4", values: "S!$B$1:$B$4" },
        { name: "B", categories: "S!$A$1:$A$4", values: "S!$C$1:$C$4" }
      ],
      showLegend: true
    }
  ]
];

for (const [name, options] of classic) {
  const { ws, wb } = sheet();
  addChart(ws, options as never, "E1:L14");
  const model = Chart.chartModel(getCharts(ws)[0])!;
  // Without the caches the renderer has no category strings to read and falls back
  // to 1..n, which would make a real labelling bug indistinguishable from a
  // half-built example.
  fillChartCaches(model, wb);
  const size = { width: 460, height: 300 };
  writeFileSync(path.join(OUT, `03-${name}.svg`), renderChartSvg(model, size));
  void renderChartPng(model, size).then(png =>
    writeFileSync(path.join(OUT, `03-${name}.png`), png)
  );
}

// ---------------------------------------------------------------------------
// 4. ChartEx, including the two layouts whose layout bugs this round fixed.
// ---------------------------------------------------------------------------

const chartEx: Array<[string, Record<string, unknown>]> = [
  [
    "sunburst",
    {
      type: "sunburst",
      series: [
        {
          values: "x",
          literalValues: [10, 20, 5, 15],
          literalCategories: ["A", "B", "C", "D"],
          literalHierarchy: [["North", "North", "South", "South"]]
        }
      ],
      showLegend: true,
      title: "Sunburst"
    }
  ],
  [
    "treemap",
    {
      type: "treemap",
      series: [
        {
          values: "x",
          literalValues: [40, 25, 18, 12, 5],
          literalCategories: ["A", "B", "C", "D", "E"]
        }
      ],
      title: "Treemap"
    }
  ],
  [
    "funnel",
    {
      type: "funnel",
      categories: "S!$A$1:$A$4",
      series: [{ name: "Stages", values: "S!$B$1:$B$4" }],
      showLegend: true,
      title: "Funnel"
    }
  ],
  [
    "waterfall",
    {
      type: "waterfall",
      categories: "S!$A$1:$A$4",
      series: [{ name: "Delta", values: "S!$B$1:$B$4" }],
      showLegend: true,
      title: "Waterfall"
    }
  ],
  [
    "boxWhisker",
    {
      type: "boxWhisker",
      series: [
        {
          name: "Spread",
          values: "x",
          literalValues: [3, 5, 6, 6, 7, 8, 9, 12, 30],
          literalCategories: ["G", "G", "G", "G", "G", "G", "G", "G", "G"]
        }
      ],
      showLegend: true,
      title: "Box & whisker"
    }
  ],
  [
    "regionMap",
    {
      type: "regionMap",
      series: [
        {
          values: "x",
          literalValues: [30, 55, 12, 44],
          literalCategories: ["USA", "Canada", "Brazil", "Chile"]
        }
      ],
      layout: { regionLabels: "showAll" },
      title: "Region map"
    }
  ],
  [
    "legend-multiline-title",
    {
      type: "funnel",
      categories: "S!$A$1:$A$4",
      series: [{ name: "Stages", values: "S!$B$1:$B$4" }],
      showLegend: true,
      legendPosition: "t",
      title: "Three paragraph title\nsecond line here\nthird line here"
    }
  ]
];

for (const [name, options] of chartEx) {
  const { ws, wb } = sheet();
  addChartEx(ws, options as never, "E1:L14");
  const model = Chart.chartExModel(getCharts(ws)[0])!;
  fillChartExCaches(model, wb);
  const size = { width: 460, height: 300 };
  writeFileSync(path.join(OUT, `04-${name}.svg`), renderChartExSvg(model, size));
  void renderChartExPng(model, size).then(png =>
    writeFileSync(path.join(OUT, `04-${name}.png`), png)
  );
}

console.log(`Wrote proof sheet to ${OUT}`);
