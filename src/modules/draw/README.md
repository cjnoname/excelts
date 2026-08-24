# Draw Module

[中文](README_zh.md)

The shared drawing engine: one structured display list, one walker, many backends. Zero dependencies.

```typescript
import { toSvg, rasterizeToRgba, type DrawList } from "documonster/draw";
```

## Features

- **One list, every backend** — Build a `DrawList` once and get markup, pixels, or a PDF page from it
- **No round trip** — Nothing passes an SVG string between renderers, so no backend has to re-parse another's output
- **Absolute coordinates** — The walker composes transforms and hands surfaces already-transformed values, so a new backend is a few dozen lines rather than a parallel renderer
- **Text measurement included** — `measureText` / `wrapText`, so a producer can size its boxes before it builds a list
- **Zero Dependencies** — Pure TypeScript, no external packages
- **Cross-Platform** — Same API in Node.js and browsers

---

## Quick Start

```typescript
import { rasterizeToRgba, toSvg, type DrawList } from "documonster/draw";

const list: DrawList = {
  width: 120,
  height: 60,
  children: [
    {
      kind: "rect",
      x: 10,
      y: 10,
      width: 100,
      height: 40,
      rx: 6,
      paint: {
        fill: { r: 0.2, g: 0.4, b: 0.8, a: 1 },
        stroke: { r: 0, g: 0, b: 0, a: 1 },
        strokeWidth: 1
      }
    },
    {
      kind: "text",
      x: 60,
      y: 30,
      lines: [{ text: "Hello", dy: 4 }],
      style: { size: 14, anchor: "middle", fill: { r: 1, g: 1, b: 1, a: 1 } }
    }
  ]
};

const svg = toSvg(list); // markup
const image = rasterizeToRgba(list, { scale: 2 }); // { width, height, data }
```

The same list on a PDF page — the third backend, which lives with the module that owns pages:

```typescript
import { renderDrawList } from "documonster/draw";
import { Pdf, createPdfDrawSurface } from "documonster/pdf";

const doc = new Pdf.Builder();
const page = doc.addPage({ width: 595, height: 842 });
renderDrawList(list, createPdfDrawSurface(page, { x: 72, y: 700, width: 120, height: 60 }));
const bytes = await doc.build();
```

---

## The display list

A `DrawList` is a size plus a tree of nodes. Nothing in it is backend-specific.

```typescript
interface DrawList {
  readonly width: number;
  readonly height: number;
  readonly children: readonly DrawNode[];
  /** Raw `<defs>` markup, referenced by `group.svgFilterId`. SVG-only by name. */
  readonly svgDefs?: readonly string[];
}
```

### Primitives

| `kind`     | Shape                                                      |
| ---------- | ---------------------------------------------------------- |
| `group`    | A transform, an optional axis-aligned `clip`, and children |
| `rect`     | Rectangle, optional `rx` corner radius                     |
| `ellipse`  | Ellipse by centre and radii                                |
| `line`     | A single segment                                           |
| `polyline` | An open or closed run of points                            |
| `path`     | Move / line / cubic commands                               |
| `sector`   | A pie or donut wedge, by radius and angles                 |
| `text`     | One or more baseline-positioned lines                      |

A sector is first-class rather than lowered to a path because the three backends do it three genuinely different ways — SVG has arcs, PDF needs cubics, and the rasteriser tests radius-and-angle per pixel for an exact edge — so lowering it upstream would make two of them worse.

### Paint

```typescript
interface DrawPaint {
  readonly fill?: Rgba01;
  readonly stroke?: Rgba01;
  readonly strokeWidth?: number; // user units, defaults to 1 when stroked
  readonly dash?: readonly number[]; // alternating on/off, SVG semantics
  readonly fillRule?: "nonzero" | "evenodd";
}
```

Colours are `Rgba01` — channels in `0..1`, alpha included. `cssColour("#3366cc")` parses a CSS token into one; `translucent("#3366cc", 0.5)` parses and sets alpha in one step.

### Text

Text is positioned by its **baseline**, because that is what every backend can honour. Vertical centring is arithmetic the producer does, not a portable attribute it can request.

```typescript
import { measureText, wrapText, POINTS_PER_PIXEL } from "documonster/draw";

const style = { size: 14, family: "Arial" };
const width = measureText("Revenue by region", style);
const lines = wrapText("A longer label that has to fit", style, 120);
```

Note the unit: `measureText` returns user units for a point size, applying `POINTS_PER_PIXEL` internally. Skipping that conversion over-reports every label by 4/3 — which is how legends come out too wide and centred titles sit left of centre.

### Clipping

`group.clip` is an axis-aligned rectangle, authored in the group's own coordinate space so it moves and scales with `transform`. Nested clips intersect. Every backend expresses it exactly: SVG `clipPath`, PDF `q … W n … Q`, a scissor test in the rasteriser.

### Transforms

`DrawMatrix` helpers: `IDENTITY`, `translate`, `scale`, `uniformScale`, `rotate`, `multiply`, `apply`, `rotationOf`. Path helpers: `arcToCubics`, `flattenPath`, `roundedRectToPath`, `sectorToPath`, `rectNode`.

---

## Backends

| Surface    | Where                                      | Output                              |
| ---------- | ------------------------------------------ | ----------------------------------- |
| SVG        | `documonster/draw` (`toSvg`)               | Markup                              |
| Raster     | `documonster/draw` (`rasterizeToRgba`)     | RGBA pixels via `BasicRasterCanvas` |
| PDF vector | `documonster/pdf` (`createPdfDrawSurface`) | Page operators; owns the Y flip     |

A surface lives with the engine when it needs nothing but the display list, and next to its target when it draws onto something the engine cannot know about — which is why the PDF one is in the PDF module.

Writing another backend means implementing `DrawSurface`. The walker owns transform composition, stroke and dash scaling, and text rotation, so a surface only puts marks down. `pushClip` / `popClip` are optional; omitting them draws unclipped rather than dropping content.

### Pixels, not a PNG

`rasterizeToRgba` returns an `RgbaImage` — `{ width, height, data }`, with `width * height * 4` bytes of straight-alpha RGBA — not an encoded file. Encoding a PNG needs DEFLATE, which lives a layer above this module, and pulling a compression library down here would make every consumer of the drawing engine pay for it.

The seam is therefore at the image, and the pairing is two lines. `documonster/archive` owns DEFLATE and CRC-32, which is all a PNG is:

```typescript
import { rasterizeToRgba } from "documonster/draw";
import { encodePng } from "documonster/archive";

const image = rasterizeToRgba(list, { scale: 2 });
const png = encodePng(image.data, image.width, image.height, { dpi: 192 });
```

In a browser you may prefer the platform's own encoder — put the pixels into a canvas with `putImageData` and call `toBlob`. Either way the drawing engine stays out of it.

---

## Deliberately absent

- **Element-level opacity.** Alpha is per-paint instead. The two differ only where a translucent stroke overlaps its own fill: element opacity composites the finished shape once, while per-paint alpha fades the fill and then blends the stroke over it. Closing that gap means offscreen compositing in every backend — a transparency group and a Form XObject in PDF, a second buffer in the rasteriser — which is a large amount of machinery for a sub-pixel seam.
- **Gradients and patterns.** Nothing produces them; the chart engine degrades a gradient fill to a representative colour before any renderer sees it. Adding them would grow the IR and every surface without changing a single output.
- **Filters**, except as an SVG-only escape hatch. A DrawingML shadow has no counterpart in a content stream or a scanline rasteriser, so `DrawList.svgDefs` plus `group.svgFilterId` say SVG in their names rather than pretending to be portable.

---

## Producers

Anything that emits a `DrawList` gets all three backends for free. In this repository the producers are the Excel chart engine (`documonster/chart`) and the Mermaid diagram engine ([`documonster/mermaid`](../mermaid/README.md)) — the latter implements no backend at all, which is the test of whether that claim holds outside this module.

Cross-backend agreement is enforced by `src/modules/pdf/__tests__/draw-backend-parity.test.ts`: the same display list is rendered to markup, pixels and PDF operators, and the geometry must match modulo each backend's coordinate convention.
