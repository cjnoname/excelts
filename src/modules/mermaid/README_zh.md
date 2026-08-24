# Mermaid 模块

[English](README.md)

把 Mermaid 图表文本变成 SVG、像素或 PDF 页面。21 种图表类型,零依赖。

```typescript
import { mermaidToSvg, mermaidToDrawList, parseMermaid } from "documonster/mermaid";
```

## 特性

- **21 种图表类型** —— 流程图、状态图、类图、ER 图、时序图、甘特图、思维导图、Git 图等
- **不需要浏览器,不需要 headless Chrome** —— 布局与渲染都是纯 TypeScript,没有要装的东西,也没有要启动的进程
- **所有后端免费获得** —— 本模块产出 `DrawList` 且不实现任何渲染器,因此标记、像素和 PDF 页面来自同一份输出
- **分层布局** —— 分层、排序以减少交叉、拉直、走线:与 Mermaid 自己使用的算法族相同
- **可在任一阶段停下** —— `parseMermaid` 拿语法树,`layoutFlowchart` 拿坐标,`mermaidToDrawList` 拿图形
- **可换主题** —— 逐个 token 对齐 Mermaid 默认调色板,并支持按 token 覆盖
- **零依赖** —— 纯 TypeScript,无外部包
- **跨平台** —— Node.js 与浏览器 API 一致

---

## 快速开始

```typescript
import { mermaidToSvg } from "documonster/mermaid";

const svg = mermaidToSvg(`flowchart TD
  A[Start] --> B{Ready?}
  B -->|yes| C[Ship it]
  B -->|no| A`);
```

### 同一份列表,任意后端

本模块是一个*生产者*:它到显示列表就停下。它内部完全不知道 SVG 或 PDF 页面是什么,而这恰恰是一套实现能服务所有输出的原因。

```typescript
import { mermaidToDrawList } from "documonster/mermaid";
import { rasterizeToRgba, toSvg } from "documonster/draw";

const list = mermaidToDrawList('pie title Split\n "A" : 60\n "B" : 40');

const svg = toSvg(list); // 标记
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

## 支持的图表

21 种类型,但布局远少于 21 套 —— 因为其中大多数是同一张图换了种语言来写。

**按有向图布局**(分层、排序、拉直、走线)。差别只在盒子形状和边端的记号,而这正是真正有差别的部分:

`flowchart` · `stateDiagram` · `classDiagram` · `erDiagram` · `requirementDiagram` · `C4` · `architecture`

**按自身规则布局** —— 甘特条的位置来自日历,旅程图的点来自评分,思维导图节点来自自己子树的高度,提交来自它的泳道与序号。它们都不是图,所以都不被硬塞进图布局:

`sequenceDiagram` · `gantt` · `timeline` · `journey` · `kanban` · `mindmap` · `gitGraph` · `quadrantChart` · `xychart` · `radar` · `sankey` · `packet` · `block` · `pie`

会自己决定尺寸的盒子 —— 类图的分隔区堆叠、带技术说明行的 C4 元素 —— 通过 `LayoutOptions.measureNode` 把尺寸告诉布局。

---

## 三个阶段

解析器、布局、渲染器彼此分离,调用方可以在任一阶段停下。

```typescript
import { parseMermaid, layoutFlowchart, mermaidToDrawList } from "documonster/mermaid";

// 1. 文本 → 语法树。不涉及任何几何。
const diagram = parseMermaid("flowchart LR\n  A --> B");

// 2. 树 → 坐标,适用于图形状的那些图表。
if (diagram.kind === "flowchart") {
  const layout = layoutFlowchart(diagram, { rankGap: 60 });
  console.log(layout.width, layout.height, layout.nodes, layout.edges);
}

// 3. 树(或源文本)→ 显示列表。
const list = mermaidToDrawList(diagram);
```

检查语法树、复用坐标都是真实存在的需求,所以前两个阶段是公开的,而不是内部步骤。

---

## 选项

`mermaidToSvg` 与 `mermaidToDrawList` 接受 `MermaidRenderOptions`,它继承 `LayoutOptions`:

| 选项            | 类型                          | 说明                                      |
| --------------- | ----------------------------- | ----------------------------------------- |
| `theme`         | `ThemeOptions`                | 颜色覆盖;未指定的沿用默认值               |
| `background`    | `string`                      | 背景填充。`"transparent"`(默认)不生成背板 |
| `fontSize`      | `number`                      | 标签字号                                  |
| `fontFamily`    | `string`                      | 标签字体                                  |
| `rankGap`       | `number`                      | 相邻层之间的间距,沿流向                   |
| `nodeGap`       | `number`                      | 同层兄弟之间的间距,垂直于流向             |
| `maxLabelWidth` | `number`                      | 标签换行前的最大单行宽度                  |
| `padding`       | `number`                      | 图表四周留白                              |
| `measureNode`   | `(node) => size \| undefined` | 自己测量节点,用于本模块无法测量的盒子设计 |

默认背景透明是刻意的:要把图表合成到别的东西上的调用方,拿到的应当是他们要的东西,而不是一个不透明矩形。

### 主题

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

未指定的 token 回落到 Mermaid 自己的 `base` 主题 —— 取值来自它实际解析出的结果,而不是目测,因此这里画出的图和那里画出的图是可辨认的同一张图。画在调色板颜色上的文字,会依该颜色的亮度在深色与浅色之间选择:一套调色板同时包含亮色和暗色条目,而 Mermaid 首个浅紫色扇区上的白字是读不出来的。

---

## 错误

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

当源文本没有指明任何受支持的图表类型时抛出 `MermaidSyntaxError`。

---

## 关于渲染的两点说明

以下两点值得知道,因为它们都先是 bug:

- **一层在解决重叠之后会被重新居中。** 从左往右推动节点直到每对都满足间距,是单向的,会把整层往右拖,于是图的主干会明显地从分叉处弯开。把处理完的整层按其平均位移平移回去不可能重新引入重叠,因为它对每个节点的移动量相同。
- **跨层的边是穿线,不是绕行。** 跨越多层的边会获得一串窄占位节点,每跨一层一个,于是它像普通边一样参与排序,并沿着为它留出的通道直着画过去。没有这些占位节点,它对中间各层的排布就没有发言权,只能事后绕开碰巧挡在那里的东西。

箭头被降级为沿最后一段方向的小实心三角形,而不是用 SVG marker 表达:marker 在 PDF 内容流或扫描线光栅器里没有对应物,而三角形在三个后端里是同一张图。

---

## 示例

`src/modules/mermaid/examples/gallery.ts` 会一次渲染出全部受支持的图表类型 —— 这是了解本模块能画什么的最快途径。
