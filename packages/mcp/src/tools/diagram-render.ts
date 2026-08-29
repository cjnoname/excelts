/**
 * `diagram_render` — draw a Mermaid diagram as SVG, PNG or PDF.
 *
 * The model cannot see the file it just produced, so the result reports what the
 * *parser* made of the source alongside the byte count. "Wrote 14 KB" is not
 * evidence that the diagram says what was meant; "3 nodes, 3 edges, A→B→C" is.
 *
 * One display list, three backends: the diagram is converted once and SVG, PNG and
 * PDF are three readings of that one list. That is the drawing engine's central
 * claim, and this tool is a consumer of the published API exercising it from
 * outside the library.
 */

import { z } from "zod";

import { toolError } from "../errors.js";
import { assertWritable, outputDisplay, resolveOutputPath } from "../sandbox.js";
import {
  buildDrawList,
  describeDiagram,
  diagramStyleShape,
  parseDiagram,
  renderDiagram,
  requireDiagramFormat,
  resolveDiagramSource,
  toRenderOptions
} from "./diagram.js";
import { writeBytesWithPolicy } from "./fs-helpers.js";
import { formatBytes, textResult } from "./result.js";
import { defineTool } from "./types.js";

export const diagramRenderTool = defineTool({
  name: "diagram_render",
  group: "diagram",
  title: "Render a Mermaid diagram",
  description:
    "Draw a Mermaid diagram as .svg, .png or .pdf. Takes the diagram text in `source`, or reads it from a .mmd file or a ```mermaid fence in a .md file via `from`. Supports flowchart, sequenceDiagram, classDiagram, stateDiagram, erDiagram, gantt, gitGraph, mindmap, timeline, journey, kanban, quadrantChart, xychart, radar, sankey, packet, block, pie, C4, requirementDiagram and architecture. The result reports the parsed structure, which is the only way to verify the picture is right.",
  inputSchema: {
    source: z
      .string()
      .optional()
      .describe(
        "Mermaid diagram text. Use this or `from`, not both. A ```mermaid wrapper is stripped for you."
      ),
    from: z
      .string()
      .optional()
      .describe(
        "Read the diagram from a file instead: a .mmd/.mermaid file, or a .md file containing ```mermaid fences."
      ),
    index: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Which ```mermaid fence to use when `from` is a Markdown file with several. 1-based, defaults to 1."
      ),
    to: z
      .string()
      .min(1)
      .describe(
        "Destination path below --output-root. The extension picks the format: .svg, .png or .pdf. Returned as @output/<path>."
      ),
    width: z
      .number()
      .positive()
      .max(20_000)
      .optional()
      .describe(
        "Output width in points. Omit to use the diagram's natural size; the drawing is fitted into the box uniformly, never stretched."
      ),
    height: z.number().positive().max(20_000).optional().describe("Output height in points."),
    scale: z
      .number()
      .min(0.5)
      .max(8)
      .optional()
      .describe(
        "PNG only — rejected for .svg/.pdf, which have no pixels. Pixels per point, so the file is width × scale pixels wide. Defaults to 2 (144 DPI)."
      ),
    ...diagramStyleShape,
    overwrite: z
      .boolean()
      .optional()
      .describe("Replace the destination if it exists. Defaults to false.")
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  },
  mutates: true,
  handler: async (args, context) => {
    const { config } = context;
    assertWritable(config);

    const format = requireDiagramFormat(args.to, "to");
    if (args.scale !== undefined && format !== "png") {
      // Accepting it and ignoring it is the problem: a caller who set `scale: 4`
      // for a PDF got the same file as `scale: 1` and no indication why. SVG and
      // PDF are resolution-independent, so the knob has no meaning there.
      throw toolError.invalidInput(
        `\`scale\` applies to PNG output only, not ${format}`,
        `${format.toUpperCase()} is resolution-independent — it has no pixels to scale. Use \`width\`/\`height\` to change its size, or write a .png if you want a specific pixel count.`
      );
    }
    const target = await resolveOutputPath(config, args.to);
    const resolved = await resolveDiagramSource(config, args);

    // Parsed separately from the draw list so the structural read-back reports the
    // same tree that was drawn, without drawing it twice.
    const diagram = parseDiagram(resolved.source);
    const style = toRenderOptions(args);
    const list = buildDrawList(resolved.source, style);
    const rendered = await renderDiagram(
      list,
      format,
      {
        ...(args.width === undefined ? {} : { width: args.width }),
        ...(args.height === undefined ? {} : { height: args.height }),
        ...(args.scale === undefined ? {} : { scale: args.scale })
      },
      style.background
    );

    await writeBytesWithPolicy(target, args.overwrite === true, rendered.bytes);

    const unit = format === "png" ? "px" : "pt";
    return textResult(
      config,
      [
        `Rendered **${outputDisplay(args.to)}** (${format}, ${formatBytes(rendered.bytes.byteLength)}, ${round(rendered.width)}×${round(rendered.height)} ${unit}).`,
        // Only when it came from a file; an inline source has nothing to name.
        ...(resolved.origin === "inline"
          ? []
          : [
              `- source: ${resolved.origin}${resolved.selected === undefined ? "" : ` (mermaid fence ${resolved.selected} of ${resolved.fences.length})`}`
            ]),
        "",
        "## What was drawn",
        "",
        ...describeDiagram(diagram),
        "",
        "Check that list against what you intended. The parser implements a subset of",
        "Mermaid and a statement it does not recognise is **dropped silently** — a missing",
        "node or edge here is the only sign, since nothing about the file itself looks wrong."
      ].join("\n")
    );
  }
});

/** One decimal place: a diagram's natural size is rarely a whole number. */
function round(value: number): number {
  return Math.round(value * 10) / 10;
}
