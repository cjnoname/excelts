# Mermaid Module

[中文](README_zh.md)

Mermaid diagram text to SVG, pixels, or a PDF page. Twenty-one diagram types, zero dependencies.

```typescript
import { mermaidToSvg, mermaidToDrawList, parseMermaid } from "documonster/mermaid";
```

## Features

- **Twenty-one diagram types** — flowcharts, state, class, ER, sequence, Gantt, mindmap, git graph, and more
- **No browser, no headless Chrome** — Layout and rendering are pure TypeScript; there is nothing to install and nothing to launch
- **Every backend for free** — The module produces a `DrawList` and implements no renderer, so markup, pixels and PDF pages all come from the same output
- **Layered layout** — Rank, order to reduce crossings, straighten, route: the same algorithm family Mermaid itself uses
- **Stop at any pass** — `parseMermaid` for the syntax tree, `layoutFlowchart` for coordinates, `mermaidToDrawList` for the picture
- **Themeable** — Mermaid's own default palette, token for token, with per-token overrides
- **Zero Dependencies** — Pure TypeScript, no external packages
- **Cross-Platform** — Same API in Node.js and browsers

---

## Quick Start

```typescript
import { mermaidToSvg } from "documonster/mermaid";

const svg = mermaidToSvg(`flowchart TD
  A[Start] --> B{Ready?}
  B -->|yes| C[Ship it]
  B -->|no| A`);
```

### Any backend, from the same list

The module is a _producer_: it stops at the display list. Nothing in it knows what SVG or a PDF page is, which is exactly what lets one implementation serve every output.

```typescript
import { mermaidToDrawList } from "documonster/mermaid";
import { rasterizeToRgba, toSvg } from "documonster/draw";

const list = mermaidToDrawList('pie title Split\n "A" : 60\n "B" : 40');

const svg = toSvg(list); // markup
const pixels = rasterizeToRgba(list, { scale: 2 }); // RGBA
```

```typescript
import { renderDrawList } from "documonster/draw";
import { Pdf, createPdfDrawSurface } from "documonster/pdf";

const doc = new Pdf.Builder();
const page = doc.addPage({ width: 595, height: 842 });
renderDrawList(
  list,
  createPdfDrawSurface(page, { x: 72, y: 500, width: list.width, height: list.height })
);
const bytes = await doc.build();
```

---

## Supported diagrams

Twenty-one types, but far fewer layouts — because most of them are the same picture in a different language.

**Laid out as a directed graph** (ranked, ordered, straightened, routed). Only the box shapes and the marks at the ends of the edges differ, which is the part that genuinely differs:

`flowchart` · `stateDiagram` · `classDiagram` · `erDiagram` · `requirementDiagram` · `C4` · `architecture`

**Laid out on their own terms** — a Gantt bar's position comes from the calendar, a journey's dot from a score, a mind-map node from the height of its own subtree, a commit from its lane and its ordinal. None of those is a graph, so none is forced through the graph layout:

`sequenceDiagram` · `gantt` · `timeline` · `journey` · `kanban` · `mindmap` · `gitGraph` · `quadrantChart` · `xychart` · `radar` · `sankey` · `packet` · `block` · `pie`

A box that sizes itself — a class compartment stack, a C4 element with its technology line — tells the layout its size through `LayoutOptions.measureNode`.

---

## Three passes

The parser, the layout and the renderer are separate, and a caller can stop after any of them.

```typescript
import { parseMermaid, layoutFlowchart, mermaidToDrawList } from "documonster/mermaid";

// 1. Text → syntax tree. Says nothing about geometry.
const diagram = parseMermaid("flowchart LR\n  A --> B");

// 2. Tree → coordinates, for the graph-shaped diagrams.
if (diagram.kind === "flowchart") {
  const layout = layoutFlowchart(diagram, { rankGap: 60 });
  console.log(layout.width, layout.height, layout.nodes, layout.edges);
}

// 3. Tree (or source) → display list.
const list = mermaidToDrawList(diagram);
```

Inspecting the tree or re-using the positions are real things to want, which is why both earlier passes are public rather than internal steps.

---

## Options

`mermaidToSvg` and `mermaidToDrawList` take `MermaidRenderOptions`, which extends `LayoutOptions`:

| Option          | Type                          | Description                                                       |
| --------------- | ----------------------------- | ----------------------------------------------------------------- |
| `theme`         | `ThemeOptions`                | Colour overrides; anything omitted keeps the default              |
| `background`    | `string`                      | Background fill. `"transparent"` (default) leaves no backdrop     |
| `fontSize`      | `number`                      | Label size                                                        |
| `fontFamily`    | `string`                      | Label family                                                      |
| `rankGap`       | `number`                      | Gap between adjacent ranks, along the flow                        |
| `nodeGap`       | `number`                      | Gap between siblings within a rank, across the flow               |
| `maxLabelWidth` | `number`                      | Longest label line before wrapping                                |
| `padding`       | `number`                      | Margin around the diagram                                         |
| `measureNode`   | `(node) => size \| undefined` | Size a node yourself, for a box design this module cannot measure |

The default background is transparent on purpose: a caller compositing the diagram onto something else gets what they asked for rather than an opaque rectangle.

### Theming

```typescript
const svg = mermaidToSvg(source, {
  theme: {
    nodeFill: "#eef2ff",
    nodeStroke: "#4f46e5",
    nodeText: "#1e1b4b",
    edge: "#6366f1",
    palette: ["#4f46e5", "#0ea5e9", "#10b981"]
  },
  background: "#ffffff"
});
```

Tokens omitted fall back to Mermaid's own `base` theme, taken from the values it resolves to rather than eyeballed, so a diagram drawn here and one drawn there are recognisably the same diagram. Text drawn on a palette colour picks ink or paper from that colour's luminance — a palette holds both light and dark entries, and white on Mermaid's pale first slice is unreadable.

---

## Errors

```typescript
import { mermaidToSvg, MermaidSyntaxError } from "documonster/mermaid";

try {
  mermaidToSvg("nonsenseDiagram\n  A --> B");
} catch (error) {
  if (error instanceof MermaidSyntaxError) {
    console.log(error.message);
  }
}
```

`MermaidSyntaxError` is thrown when the source names no supported diagram type.

---

## Notes on the rendering

Two details are worth knowing, because both were bugs first:

- **A rank is re-centred after its overlaps are resolved.** Pushing nodes left-to-right until every pair clears the gap is one-directional and drags the whole rank right, so the trunk of a diagram visibly bends away from a fork. Translating the finished rank back by its mean displacement cannot reintroduce an overlap, because it moves every node equally.
- **A long edge is threaded, not routed around.** An edge spanning several ranks gets a chain of narrow placeholders, one per rank it crosses, so it takes part in the ordering like any other edge and is drawn straight through the lane left for it. Without them it has no say in how the intervening ranks are arranged and has to be routed afterwards around whatever ended up in the way.

Arrowheads are lowered to small filled triangles aimed along the last segment rather than expressed as SVG markers: a marker has no counterpart in a PDF content stream or a scanline rasteriser, and the triangle is the same picture in all three backends.

---

## Examples

`src/modules/mermaid/examples/gallery.ts` renders every supported diagram type in one pass — the fastest way to see what the module draws.
