/**
 * `diagram_inspect` — parse a Mermaid diagram and report what it says, without
 * writing anything.
 *
 * Exists because of an asymmetry the rest of this server does not have: for a
 * spreadsheet the model can read back the cells it wrote, but a diagram's output
 * is a picture it cannot look at. So the read-back has to happen on the *input*
 * side — parse the source, and say which nodes, edges, participants, tasks or
 * slices the parser actually recognised.
 *
 * That matters more than a syntax check. The parser implements a subset of
 * Mermaid, and a subset fails by silently omitting what it did not understand: a
 * mistyped arrow produces one fewer edge rather than an error. Counting them is
 * the only way that is visible.
 *
 * Read-only, so it stays available under `--readonly` — where `diagram_render` is
 * withheld and this is the only diagram capability left.
 */

import { z } from "zod";

import {
  buildDrawList,
  describeDiagram,
  parseDiagram,
  resolveDiagramSource,
  toRenderOptions
} from "./diagram.js";
import { textResult } from "./result.js";
import { defineTool } from "./types.js";

export const diagramInspectTool = defineTool({
  name: "diagram_inspect",
  group: "diagram",
  title: "Inspect a Mermaid diagram",
  description:
    "Parse Mermaid text and report what it means: diagram type, and every node/edge/participant/task/slice the parser recognised, plus the size it would render at. Writes nothing. Call this to check a diagram before rendering it, or to find out why a rendered diagram is missing something — an unrecognised statement is dropped silently, and its absence here is the only sign.",
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
        "Inspect a file instead: a .mmd/.mermaid file, or a .md file — in which case every ```mermaid fence is listed and one is described."
      ),
    index: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Which fence to describe when `from` is a Markdown file with several. 1-based, defaults to 1."
      )
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  mutates: false,
  handler: async (args, context) => {
    const { config } = context;
    const resolved = await resolveDiagramSource(config, args);
    const diagram = parseDiagram(resolved.source);

    // Laid out at the defaults, because the size is the one fact a caller cannot
    // work out from the source and it decides whether a diagram is page-shaped.
    const list = buildDrawList(resolved.source, toRenderOptions({}));

    const lines: string[] = [
      resolved.origin === "inline"
        ? "Parsed the diagram you supplied."
        : `Parsed **${resolved.origin}**.`
    ];

    if (resolved.fences.length > 1) {
      lines.push(
        "",
        `## ${resolved.fences.length} mermaid fences`,
        "",
        "| index | line | type | first line |",
        "| --- | --- | --- | --- |",
        ...resolved.fences.map(fence => {
          const kind = fenceKind(fence.source);
          const first = fence.source.split("\n")[0]?.trim() ?? "";
          return `| ${fence.ordinal}${fence.ordinal === resolved.selected ? " ←" : ""} | ${fence.line} | ${kind} | \`${first.slice(0, 40)}\` |`;
        }),
        "",
        `Fence ${resolved.selected} is described below; pass \`index\` to describe another.`
      );
    }

    lines.push(
      "",
      "## Structure",
      "",
      ...describeDiagram(diagram),
      `- renders at ${round(list.width)}×${round(list.height)} points at the default font and spacing`,
      "",
      "Compare that against what you intended before rendering. Anything the parser did",
      "not recognise is simply absent from the list above — it is not reported as an error."
    );

    return textResult(config, lines.join("\n"));
  }
});

/**
 * Name a fence's diagram type without failing the whole call on a broken one.
 *
 * The listing exists to help a caller choose an index, and one malformed fence in
 * a long document must not stop the other nine from being nameable.
 */
function fenceKind(source: string): string {
  try {
    return parseDiagram(source).kind;
  } catch {
    const first =
      source
        .split("\n")
        .find(line => line.trim().length > 0)
        ?.trim() ?? "";
    const named = first.split(/\s+/)[0] ?? "";
    return named.length === 0 ? "**empty**" : `**unsupported** (${named})`;
  }
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
