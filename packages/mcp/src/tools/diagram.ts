/**
 * Mermaid diagram helpers shared by `diagram_render`, `diagram_inspect` and the
 * Markdown fence rendering in `doc_write` / `doc_convert`.
 *
 * Three things live here that no tool should re-derive:
 *
 * 1. **Where the source comes from.** A model supplies a diagram inline, or names
 *    a `.mmd` file, or names a Markdown file with several ` ```mermaid ` fences in
 *    it. All three resolve to the same thing, and fence positions are needed again
 *    later to splice rendered images back into the Markdown.
 * 2. **What "render" means per format.** The diagram is converted to a display
 *    list *once*; SVG, PNG and PDF are three readings of that one list. Doing it
 *    any other way is how three backends come to disagree about one picture.
 * 3. **What the parser actually saw.** A model cannot look at the output, so the
 *    only way it can verify a diagram is a structural read-back. That is
 *    {@link describeDiagram}, and it is the reason `diagram_inspect` exists.
 *
 * Theme presets are deliberately *this package's* own, not a claim of parity with
 * Mermaid's named themes: only `default` is token-for-token Mermaid (the library
 * reproduces Mermaid's `base` exactly). `themeOverrides` exposes every colour
 * token, so nothing is reachable through the library that is not reachable here.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { encodePng } from "documonster/archive";
import { cssColour, rasterizeToRgba, renderDrawList, toSvg } from "documonster/draw";
import type { DrawList } from "documonster/draw";
import { MermaidSyntaxError, mermaidToDrawList, parseMermaid } from "documonster/mermaid";
import type { MermaidDiagram, MermaidRenderOptions, ThemeOptions } from "documonster/mermaid";
import { Pdf, createPdfDrawSurface } from "documonster/pdf";
import { z } from "zod";

import type { ServerConfig } from "../config.js";
import { toolError } from "../errors.js";
import { resolveInRoot } from "../sandbox.js";
import { assertReadableSize } from "./fs-helpers.js";
import { escapeTableCell } from "./result.js";

/** Output formats a diagram can be written as. */
export type DiagramFormat = "svg" | "png" | "pdf";

const DIAGRAM_EXTENSIONS: Readonly<Record<string, DiagramFormat>> = {
  ".svg": "svg",
  ".png": "png",
  ".pdf": "pdf"
};

/** Extensions whose whole content is one diagram. */
const MERMAID_EXTENSIONS: readonly string[] = [".mmd", ".mermaid"];

/** Extensions whose content is Markdown that may contain mermaid fences. */
const MARKDOWN_EXTENSIONS: readonly string[] = [".md", ".markdown"];

/**
 * Ceiling on a raster diagram's pixel count.
 *
 * The rasteriser has its own limit and throws a plain `Error`; this one exists so
 * the refusal arrives as a `too_large` tool error with a hint, before any work is
 * done, rather than as an `internal` after it.
 */
const MAX_RASTER_PIXELS = 40_000_000;

/** EMU per PDF point — a display list's unit is a point, as the PDF backend proves. */
export const EMU_PER_POINT = 12700;

/** Format a diagram output path denotes, or a tool error naming what is possible. */
export function requireDiagramFormat(filePath: string, field: string): DiagramFormat {
  const format = DIAGRAM_EXTENSIONS[path.extname(filePath).toLowerCase()];
  if (format === undefined) {
    throw toolError.invalidInput(
      `cannot tell the diagram format of ${field} from its extension: ${JSON.stringify(filePath)}`,
      "Use .svg (crisp, editable, smallest), .png (pastes anywhere) or .pdf (one page sized to the diagram)."
    );
  }
  return format;
}

// ---------------------------------------------------------------------------
// Themes
// ---------------------------------------------------------------------------

/**
 * Named colour sets, so a model asking for a dark diagram does not have to invent
 * eleven hex values — and cannot get half of them wrong, which produces a diagram
 * with unreadable labels that the model has no way to see.
 *
 * `default` is empty on purpose: the library's own default already reproduces
 * Mermaid's `base` theme token for token, so overriding anything here would move
 * away from it.
 */
export type ThemePreset = "default" | "dark" | "neutral";

export const THEME_PRESETS: Readonly<Record<ThemePreset, ThemeOptions>> = {
  default: {},
  dark: {
    background: "#1e222a",
    nodeFill: "#3b4252",
    nodeStroke: "#88c0d0",
    nodeText: "#eceff4",
    edge: "#d8dee9",
    edgeText: "#eceff4",
    edgeLabelBackground: "#434c5e",
    groupFill: "#2e3440",
    groupStroke: "#5e81ac",
    title: "#eceff4",
    paletteText: "#2e3440",
    palette: [
      "#88c0d0",
      "#bf616a",
      "#a3be8c",
      "#ebcb8b",
      "#b48ead",
      "#d08770",
      "#8fbcbb",
      "#81a1c1",
      "#e5e9f0",
      "#5e81ac",
      "#4c566a",
      "#d8dee9"
    ]
  },
  neutral: {
    background: "#ffffff",
    nodeFill: "#eeeeee",
    nodeStroke: "#999999",
    nodeText: "#111111",
    edge: "#555555",
    edgeText: "#111111",
    edgeLabelBackground: "#f4f4f4",
    groupFill: "#fafafa",
    groupStroke: "#cccccc",
    title: "#111111",
    paletteText: "#ffffff",
    palette: [
      "#555555",
      "#777777",
      "#999999",
      "#bbbbbb",
      "#444444",
      "#666666",
      "#888888",
      "#aaaaaa",
      "#333333",
      "#5f5f5f",
      "#7f7f7f",
      "#9f9f9f"
    ]
  }
};

const THEME_PRESET_NAMES = Object.keys(THEME_PRESETS) as [ThemePreset, ...ThemePreset[]];

/** Colour token names a caller may override individually. */
const themeOverridesSchema = z
  .object({
    background: z.string().optional(),
    nodeFill: z.string().optional(),
    nodeStroke: z.string().optional(),
    nodeText: z.string().optional(),
    edge: z.string().optional(),
    edgeText: z.string().optional(),
    edgeLabelBackground: z.string().optional(),
    groupFill: z.string().optional(),
    groupStroke: z.string().optional(),
    title: z.string().optional(),
    paletteText: z.string().optional(),
    palette: z.array(z.string()).min(1).max(24).optional()
  })
  .describe(
    "Individual colour overrides applied on top of `theme`. CSS colours. `palette` colours the slices/series of pie, xychart, radar, sankey, journey and quadrant diagrams."
  );

/**
 * The rendering fields both the render tool and the fence renderer accept.
 *
 * Exported as a raw shape so `diagram_render` can spread it into its own schema
 * without the two drifting apart.
 */
export const diagramStyleShape = {
  theme: z
    .enum(THEME_PRESET_NAMES)
    .optional()
    .describe(
      "Colour set. `default` reproduces Mermaid's own base theme; `dark` and `neutral` are this server's, not Mermaid's named themes. Defaults to `default`."
    ),
  themeOverrides: themeOverridesSchema.optional(),
  background: z
    .string()
    .optional()
    .describe(
      'Page background as a CSS colour, or "transparent". Defaults to white — a transparent PNG is unreadable in a dark viewer, which is a failure the model cannot see.'
    ),
  fontSize: z.number().min(6).max(72).optional().describe("Label font size. Defaults to 14."),
  fontFamily: z.string().optional().describe('Label font family. Defaults to "Arial".'),
  rankGap: z
    .number()
    .min(0)
    .max(400)
    .optional()
    .describe("Graph diagrams: gap between ranks, along the flow. Defaults to 56."),
  nodeGap: z
    .number()
    .min(0)
    .max(400)
    .optional()
    .describe("Graph diagrams: gap between siblings within a rank. Defaults to 34."),
  maxLabelWidth: z
    .number()
    .min(20)
    .max(2000)
    .optional()
    .describe("Longest label line before it wraps. Defaults to 220."),
  padding: z
    .number()
    .min(0)
    .max(200)
    .optional()
    .describe("Margin between the drawing and the edge of the image. Defaults to 16.")
} as const;

/** The parsed form of {@link diagramStyleShape}. */
export interface DiagramStyleArgs {
  readonly theme?: ThemePreset;
  readonly themeOverrides?: ThemeOptions;
  readonly background?: string;
  readonly fontSize?: number;
  readonly fontFamily?: string;
  readonly rankGap?: number;
  readonly nodeGap?: number;
  readonly maxLabelWidth?: number;
  readonly padding?: number;
}

/**
 * Turn tool arguments into library render options.
 *
 * The background is resolved here rather than left to the library because the
 * library's default is `"transparent"` — right for a caller compositing the list
 * onto something else, wrong for a file a human opens.
 */
export function toRenderOptions(args: DiagramStyleArgs): MermaidRenderOptions & {
  readonly background: string;
} {
  const preset = THEME_PRESETS[args.theme ?? "default"];
  // Every override is validated, not just the background. `cssColour` falls back to
  // black for anything it cannot read, so a misspelled `nodeFill` produced a diagram
  // with black boxes — and since nothing can look at the picture, the caller's only
  // clue was that it silently stopped matching the theme it asked for.
  const overrides = requireColours(args.themeOverrides ?? {});
  const background = requireColour(
    args.background ?? overrides.background ?? preset.background ?? "#ffffff",
    "background"
  );
  const theme: ThemeOptions = { ...preset, ...overrides, background };

  return {
    theme,
    background,
    ...(args.fontSize === undefined ? {} : { fontSize: args.fontSize }),
    ...(args.fontFamily === undefined ? {} : { fontFamily: args.fontFamily }),
    ...(args.rankGap === undefined ? {} : { rankGap: args.rankGap }),
    ...(args.nodeGap === undefined ? {} : { nodeGap: args.nodeGap }),
    ...(args.maxLabelWidth === undefined ? {} : { maxLabelWidth: args.maxLabelWidth }),
    ...(args.padding === undefined ? {} : { padding: args.padding })
  };
}

/** Validate every colour in a set of overrides, including the palette. */
function requireColours(overrides: ThemeOptions): ThemeOptions {
  const checked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      continue;
    }
    checked[key] =
      key === "palette"
        ? (value as readonly string[]).map((entry, index) =>
            requireColour(entry, `themeOverrides.palette[${index}]`)
          )
        : requireColour(value as string, `themeOverrides.${key}`);
  }
  return checked as ThemeOptions;
}

/**
 * Reject a colour token the renderer cannot read.
 *
 * `cssColour` falls back to black for anything it fails to parse, so a misspelled
 * `background` would silently produce a black rectangle — an outcome a model has
 * no way to detect, since it never sees the image. Detecting the fallback needs
 * the "was it actually black?" question asked separately, which is what the
 * pattern below is for.
 */
function requireColour(token: string, field: string): string {
  if (token === "transparent") {
    return token;
  }
  const normalised = token.trim().toLowerCase();
  const parsed = cssColour(normalised);
  const isBlack = parsed.r === 0 && parsed.g === 0 && parsed.b === 0 && parsed.a === 1;
  const spelledBlack =
    normalised === "black" ||
    /^#0{3,8}$/.test(normalised) ||
    /^rgba?\(\s*0\s*,\s*0\s*,\s*0\s*(,\s*1(\.0+)?\s*)?\)$/.test(normalised);
  if (isBlack && !spelledBlack) {
    throw toolError.invalidInput(
      `${field} is not a colour the renderer can read: ${JSON.stringify(token)}`,
      'Use a hex value like "#ffffff", an rgb()/rgba() function, a CSS colour name, or "transparent".'
    );
  }
  return normalised;
}

// ---------------------------------------------------------------------------
// Source resolution
// ---------------------------------------------------------------------------

/** One ` ```mermaid ` fence found in a Markdown document. */
export interface MermaidFence {
  /** 1-based position among the mermaid fences in the document. */
  readonly ordinal: number;
  /** 1-based line the opening fence sits on, for a message a human can act on. */
  readonly line: number;
  /** The diagram source between the fences, without the fence lines. */
  readonly source: string;
  /** Character offset of the opening fence's first character. */
  readonly start: number;
  /** Character offset just past the closing fence's newline. */
  readonly end: number;
}

/**
 * Find every mermaid fence in a Markdown document.
 *
 * Scanned line by line rather than with one regular expression because a fence
 * may be opened with backticks or tildes, of any length from three up, and must
 * be closed by at least as many of the same character — a rule a single pattern
 * expresses badly and an unterminated fence at the end of a file breaks outright.
 * An unterminated fence is treated as running to the end of the document, which
 * is what every Markdown renderer does.
 */
export function findMermaidFences(markdown: string): MermaidFence[] {
  const fences: MermaidFence[] = [];
  const lines = markdown.split("\n");
  // Offset of the start of each line, so a fence can report its own span. Computed
  // from the raw line lengths, so a `\r` retained by the split is counted and the
  // offsets stay valid against the original string.
  const offsets: number[] = [];
  let cursor = 0;
  for (const line of lines) {
    offsets.push(cursor);
    cursor += line.length + 1;
  }

  let index = 0;
  while (index < lines.length) {
    const opening = OPENING_FENCE.exec(lines[index] ?? "");
    if (opening === null) {
      index += 1;
      continue;
    }

    const marker = opening[1] ?? "";
    const info = (opening[2] ?? "").trim().toLowerCase();
    const closer = closingFence(marker);
    let end = index + 1;
    while (end < lines.length && !closer.test(lines[end] ?? "")) {
      end += 1;
    }

    // Any fence at all opens a block, and only its own closer ends one. A
    // ```mermaid inside a ````markdown block is therefore *content* — an example of
    // a diagram, not a diagram. Treating it as real rendered a picture nobody asked
    // for, left the substituted reference sitting inside a code block where nothing
    // consumed it, and still reported the diagram as embedded.
    if (info === "mermaid") {
      const start = offsets[index] ?? 0;
      // An unterminated fence runs to the end of the document, as every Markdown
      // renderer does; a terminated one ends past its closing line.
      const afterClosing =
        end < lines.length
          ? Math.min(markdown.length, (offsets[end] ?? 0) + (lines[end] ?? "").length + 1)
          : markdown.length;

      fences.push({
        ordinal: fences.length + 1,
        line: index + 1,
        // `\r` is stripped from the diagram source: the Mermaid parser matches its
        // keywords against whole lines, and a trailing carriage return makes every
        // one of them fail.
        source: lines
          .slice(index + 1, end)
          .map(line => line.replace(/\r$/, ""))
          .join("\n"),
        start,
        end: afterClosing
      });
    }
    index = end + 1;
  }

  return fences;
}

/**
 * A fence opener: three or more backticks or tildes, then an optional info string.
 *
 * The trailing `\r?` is what makes a CRLF document work at all. `split("\n")` leaves
 * the carriage return on every line, and a pattern anchored with `$` after
 * `[ \t]*` matched none of them — so a Windows-authored Markdown file reported zero
 * mermaid fences, and `doc_write` silently embedded the diagram as a code block.
 */
const OPENING_FENCE = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*([^\r\n]*?)[ \t]*\r?$/;

/** The matching closer: at least as many of the same character, and nothing else. */
function closingFence(marker: string): RegExp {
  return new RegExp(`^[ \\t]{0,3}${marker[0] === "~" ? "~" : "`"}{${marker.length},}[ \\t]*\\r?$`);
}

/**
 * Strip a fence a model wrapped its own answer in.
 *
 * A model asked for "mermaid source" very often produces a fenced block, because
 * that is how it has seen mermaid written everywhere. Passing that through to the
 * parser fails on the first line with "unsupported diagram type '```mermaid'",
 * which is a confusing report of the model's own formatting habit rather than of
 * anything wrong with the diagram.
 */
export function unwrapFence(source: string): string {
  const trimmed = source.trim();
  const fences = findMermaidFences(trimmed);
  if (fences.length === 1 && fences[0]?.start === 0 && fences[0].end >= trimmed.length) {
    return fences[0].source;
  }
  // A bare fence with no language tag, which is the other habit.
  const bare = /^(`{3,}|~{3,})[ \t]*\n([\s\S]*?)\n?\1[ \t]*$/.exec(trimmed);
  return bare?.[2] ?? source;
}

/** Where a diagram's text came from, and what else was in the same file. */
export interface ResolvedSource {
  readonly source: string;
  /** How to name it in a message: `inline`, or the caller's own path. */
  readonly origin: string;
  /** Every mermaid fence in the file, when the file was Markdown. */
  readonly fences: readonly MermaidFence[];
  /** Which fence was selected, 1-based, when there were several. */
  readonly selected?: number;
}

export interface SourceArgs {
  readonly source?: string;
  readonly from?: string;
  readonly index?: number;
}

/**
 * Resolve the diagram text from `source` or `from`.
 *
 * @throws {McpToolError} `invalid_input` when neither or both were given, or when
 *   a Markdown file holds no mermaid fence, or `index` names one that is not there.
 */
export async function resolveDiagramSource(
  config: ServerConfig,
  args: SourceArgs
): Promise<ResolvedSource> {
  const hasSource = typeof args.source === "string" && args.source.trim().length > 0;
  const hasFrom = typeof args.from === "string" && args.from.trim().length > 0;

  if (hasSource === hasFrom) {
    throw toolError.invalidInput(
      hasSource
        ? "pass either `source` or `from`, not both"
        : "no diagram source: pass `source` with the Mermaid text, or `from` with a path",
      "`source` is Mermaid text you write yourself. `from` reads a .mmd file, or picks a ```mermaid fence out of a .md file."
    );
  }

  if (hasSource) {
    return { source: unwrapFence(args.source as string), origin: "inline", fences: [] };
  }

  const display = args.from as string;
  const resolved = await resolveInRoot(config, display, { mustExist: true });
  await assertReadableSize(config, resolved, display);
  const text = await readFile(resolved, "utf8");
  const extension = path.extname(resolved).toLowerCase();

  if (MERMAID_EXTENSIONS.includes(extension)) {
    return { source: unwrapFence(text), origin: display, fences: [] };
  }

  const fences = findMermaidFences(text);
  if (fences.length === 0) {
    if (MARKDOWN_EXTENSIONS.includes(extension)) {
      throw toolError.invalidInput(
        `${display} contains no \`\`\`mermaid fence`,
        "Add one, or pass the diagram directly as `source`."
      );
    }
    // Not Markdown and not .mmd: treat the whole file as one diagram rather than
    // refusing over an extension, since the parser will say so if it is not.
    return { source: unwrapFence(text), origin: display, fences: [] };
  }

  const ordinal = args.index ?? 1;
  const chosen = fences.find(fence => fence.ordinal === ordinal);
  if (chosen === undefined) {
    throw toolError.invalidInput(
      `${display} has ${fences.length} mermaid fence(s); there is no fence ${ordinal}`,
      `Pass index between 1 and ${fences.length}, or call diagram_inspect on the file to list them.`
    );
  }

  return { source: chosen.source, origin: display, fences, selected: chosen.ordinal };
}

/** Parse mermaid text, reporting a syntax error as a model-facing tool error. */
export function parseDiagram(source: string): MermaidDiagram {
  try {
    return parseMermaid(source);
  } catch (cause) {
    if (cause instanceof MermaidSyntaxError) {
      throw toolError.invalidInput(
        `the diagram could not be parsed: ${cause.message}`,
        DIAGRAM_HINT,
        {
          cause
        }
      );
    }
    throw cause;
  }
}

/** Build the display list, mapping a syntax error the same way. */
export function buildDrawList(source: string, options: MermaidRenderOptions): DrawList {
  try {
    return mermaidToDrawList(source, options);
  } catch (cause) {
    if (cause instanceof MermaidSyntaxError) {
      throw toolError.invalidInput(
        `the diagram could not be drawn: ${cause.message}`,
        DIAGRAM_HINT,
        {
          cause
        }
      );
    }
    throw cause;
  }
}

const DIAGRAM_HINT =
  'The first non-empty line names the diagram type, e.g. "flowchart TD" or "sequenceDiagram". Call documonster_help({ topic: "diagrams" }) for the list of supported types.';

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export interface RenderSizeArgs {
  /**
   * Output width in the diagram's own unit (a point). The drawing is fitted into
   * it uniformly. Defaults to the diagram's natural width.
   */
  readonly width?: number;
  readonly height?: number;
  /** PNG only: pixels per point, so the file is `width * scale` pixels wide. */
  readonly scale?: number;
}

export interface RenderedDiagram {
  readonly bytes: Uint8Array;
  /** Size of the artefact, in the format's own unit. */
  readonly width: number;
  readonly height: number;
}

/**
 * Render one display list to one format.
 *
 * The list is built once by the caller and read here — which is the whole claim
 * the drawing engine makes, tested from outside the library by this very function.
 */
export async function renderDiagram(
  list: DrawList,
  format: DiagramFormat,
  size: RenderSizeArgs,
  background: string
): Promise<RenderedDiagram> {
  const width = size.width ?? list.width;
  const height = size.height ?? list.height;

  if (format === "svg") {
    const svg = toSvg(list, {
      ...(size.width === undefined ? {} : { width }),
      ...(size.height === undefined ? {} : { height }),
      ...(background === "transparent" ? {} : { background })
    });
    return { bytes: new TextEncoder().encode(svg), width, height };
  }

  if (format === "png") {
    const scale = size.scale ?? 2;
    const pixels = Math.round(width * scale) * Math.round(height * scale);
    if (pixels > MAX_RASTER_PIXELS) {
      throw toolError.tooLarge(
        `a ${Math.round(width * scale)}x${Math.round(height * scale)} PNG is ${Math.round(pixels / 1e6)}M pixels, over the ${Math.round(MAX_RASTER_PIXELS / 1e6)}M limit`,
        "Lower `scale`, or render SVG instead — it is resolution-independent and much smaller."
      );
    }
    const image = rasterizeToRgba(list, {
      scale,
      ...(size.width === undefined ? {} : { width }),
      ...(size.height === undefined ? {} : { height })
    });
    return {
      // A display list's unit is a point, so `scale` pixels per point is
      // `72 * scale` dots per inch. Word, Excel and print pipelines read this
      // instead of assuming 96, and getting it wrong resizes the picture.
      bytes: encodePng(image.data, image.width, image.height, { dpi: Math.round(72 * scale) }),
      width: image.width,
      height: image.height
    };
  }

  const builder = new Pdf.Builder();
  const page = builder.addPage({ width, height });
  // Letterbox: fit the list into the page uniformly, so an explicit page size
  // produces a correct picture rather than a stretched one.
  const fit = Math.min(width / list.width, height / list.height);
  const drawnWidth = list.width * fit;
  const drawnHeight = list.height * fit;
  if (background !== "transparent") {
    // The list's own backdrop covers the drawing only; with letterboxing that
    // leaves the margin unpainted, and a PDF's unpainted area is not white.
    page.drawRect({ x: 0, y: 0, width, height, fill: toPdfColour(background) });
  }
  renderDrawList(
    list,
    createPdfDrawSurface(
      page,
      {
        x: (width - drawnWidth) / 2,
        y: (height - drawnHeight) / 2,
        width: drawnWidth,
        height: drawnHeight
      },
      fit
    )
  );
  return { bytes: await builder.build(), width, height };
}

function toPdfColour(token: string): { r: number; g: number; b: number; a?: number } {
  const colour = cssColour(token);
  return colour.a >= 1
    ? { r: colour.r, g: colour.g, b: colour.b }
    : { r: colour.r, g: colour.g, b: colour.b, a: colour.a };
}

// ---------------------------------------------------------------------------
// Structural read-back
// ---------------------------------------------------------------------------

/** Human name for each diagram kind, and the Mermaid keyword that selects it. */
const KIND_NAMES: Readonly<Record<MermaidDiagram["kind"], string>> = {
  flowchart: "flowchart",
  state: "stateDiagram",
  class: "classDiagram",
  er: "erDiagram",
  sequence: "sequenceDiagram",
  requirement: "requirementDiagram",
  c4: "C4",
  architecture: "architecture",
  gantt: "gantt",
  timeline: "timeline",
  journey: "journey",
  kanban: "kanban",
  mindmap: "mindmap",
  git: "gitGraph",
  quadrant: "quadrantChart",
  xy: "xychart",
  radar: "radar",
  sankey: "sankey",
  packet: "packet",
  block: "block",
  pie: "pie"
};

/** Every diagram type the parser accepts, for help text and error hints. */
export const SUPPORTED_DIAGRAM_KEYWORDS: readonly string[] = Object.values(KIND_NAMES);

/** How many labels a structural summary lists before it stops. */
const MAX_LISTED = 40;

/**
 * What the parser made of a diagram, split into the counts and the detail.
 *
 * The split exists because two callers need different amounts of it. A file
 * rendered by `diagram_render` gets the whole read-back; a diagram stamped onto a
 * PDF page by `pdf_edit` gets one line inside a numbered list of operations. They
 * must not be allowed to disagree about the counts, so both derive from here
 * rather than each doing its own arithmetic.
 */
interface DiagramDetail {
  /** One line of counts, without a leading bullet. */
  readonly counts: string;
  /** Per-kind extra bullets: the labels, and anything only that kind has. */
  readonly extra: readonly string[];
}

function diagramDetail(diagram: MermaidDiagram): DiagramDetail {
  switch (diagram.kind) {
    case "flowchart":
      return {
        counts: `${diagram.nodes.length} node(s), ${diagram.edges.length} edge(s), ${diagram.subgraphs.length} subgraph(s)`,
        extra: [
          `- direction: ${diagram.direction}`,
          ...list(
            "nodes",
            diagram.nodes.map(node =>
              node.text === node.id ? node.id : `${node.id} (${node.text})`
            )
          ),
          ...list(
            "edges",
            diagram.edges.map(
              edge =>
                `${edge.from} ${edge.label === undefined ? "->" : `-[${edge.label}]->`} ${edge.to}`
            )
          )
        ]
      };
    case "state":
      return {
        counts: `${diagram.states.length} state(s), ${diagram.transitions.length} transition(s), ${diagram.composites.length} composite(s)`,
        extra: [
          `- direction: ${diagram.direction}`,
          ...list(
            "states",
            diagram.states.map(state => (state.text === state.id ? state.id : state.text))
          ),
          ...list(
            "transitions",
            diagram.transitions.map(
              transition =>
                `${transition.from} ${transition.label === undefined ? "->" : `-[${transition.label}]->`} ${transition.to}`
            )
          )
        ]
      };
    case "class":
      return {
        counts: `${diagram.classes.length} class(es), ${diagram.links.length} relation(s)`,
        extra: [
          ...list(
            "classes",
            diagram.classes.map(box => `${box.name} (${box.members.length} member(s))`)
          ),
          // Which classes relate, and how: inheritance drawn as composition is a
          // wrong diagram, and the count cannot show it.
          ...list(
            "relations",
            diagram.links.map(link => `${link.from} ${link.relation} ${link.to}`)
          )
        ]
      };
    case "er":
      return {
        counts: `${diagram.entities.length} entit(y/ies), ${diagram.relations.length} relation(s)`,
        extra: [
          ...list(
            "entities",
            diagram.entities.map(
              entity => `${entity.name} (${entity.attributes.length} attribute(s))`
            )
          ),
          ...list(
            "relations",
            diagram.relations.map(
              relation =>
                `${relation.from} ${relation.fromCardinality}–${relation.toCardinality} ${relation.to}${relation.label === undefined ? "" : ` (${relation.label})`}`
            )
          )
        ]
      };
    case "sequence":
      return {
        counts: `${diagram.participants.length} participant(s), ${diagram.messages.length} message(s)`,
        extra: [
          `- autonumber: ${diagram.autonumber}`,
          ...list(
            "participants",
            diagram.participants.map(participant => participant.text)
          ),
          // The messages *are* the diagram. A count cannot distinguish two
          // sequences that say opposite things, which defeats a read-back.
          ...list(
            "messages",
            diagram.messages.map(message => `${message.from} → ${message.to}: ${message.text}`)
          )
        ]
      };
    case "requirement":
      return {
        counts: `${diagram.requirements.length} requirement(s), ${diagram.elements.length} element(s), ${diagram.links.length} link(s)`,
        extra: [
          ...list(
            "requirements",
            diagram.requirements.map(requirement => requirement.name)
          ),
          ...list(
            "links",
            diagram.links.map(link => `${link.from} ${link.verb} ${link.to}`)
          )
        ]
      };
    case "c4":
      return {
        counts: `${diagram.elements.length} element(s), ${diagram.boundaries.length} boundar(y/ies), ${diagram.relations.length} relation(s)`,
        extra: [
          ...list(
            "elements",
            diagram.elements.map(element => element.label)
          ),
          ...list(
            "relations",
            diagram.relations.map(
              relation =>
                `${relation.from} → ${relation.to}${relation.label === undefined ? "" : `: ${relation.label}`}`
            )
          )
        ]
      };
    case "architecture":
      return {
        counts: `${diagram.nodes.length} node(s), ${diagram.edges.length} edge(s)`,
        extra: [
          ...list(
            "nodes",
            diagram.nodes.map(node => (node.isGroup ? `${node.label} (group)` : node.label))
          ),
          ...list(
            "edges",
            diagram.edges.map(edge => `${edge.from} → ${edge.to}`)
          )
        ]
      };
    case "gantt":
      return {
        counts: `${diagram.tasks.length} task(s) in ${diagram.sections.length} section(s)`,
        extra: list(
          "tasks",
          diagram.tasks.map(
            task =>
              // Dates, not the epoch milliseconds they are stored as: a bar in the
              // wrong place is not an ugly chart, it is a wrong one, and this is the
              // only way the model can check the date arithmetic it asked for.
              `${task.label} ${isoDay(task.start)}→${isoDay(task.end)}${task.milestone ? " (milestone)" : ""}`
          )
        )
      };
    case "timeline":
      return {
        counts: `${diagram.periods.length} period(s) in ${diagram.sections.length} section(s)`,
        extra: list(
          "periods",
          diagram.periods.map(period => `${period.label} (${period.events.length} event(s))`)
        )
      };
    case "journey":
      return {
        counts: `${diagram.tasks.length} task(s) in ${diagram.sections.length} section(s)`,
        extra: list(
          "tasks",
          diagram.tasks.map(task => `${task.label} — score ${task.score}`)
        )
      };
    case "kanban":
      return {
        counts: `${diagram.columns.length} column(s), ${diagram.columns.reduce((sum, column) => sum + column.cards.length, 0)} card(s)`,
        extra: list(
          "columns",
          diagram.columns.map(column => `${column.title} (${column.cards.length})`)
        )
      };
    case "mindmap":
      return {
        counts:
          diagram.root === undefined
            ? "**empty**: no root node was recognised"
            : `${countMindNodes(diagram.root)} node(s)`,
        extra:
          diagram.root === undefined
            ? []
            : [
                `- root: ${JSON.stringify(diagram.root.text)}`,
                ...list("nodes", mindNodeLabels(diagram.root).slice(1))
              ]
      };
    case "git":
      return {
        counts: `${diagram.commits.length} commit(s) on ${diagram.branches.length} branch(es)`,
        extra: [
          ...list("branches", diagram.branches),
          ...list(
            "commits",
            diagram.commits.map(
              commit =>
                `${commit.kind === "merge" ? "merge " : ""}${commit.id}@${commit.branch}${commit.tag === undefined ? "" : ` (${commit.tag})`}`
            )
          )
        ]
      };
    case "quadrant":
      return {
        counts: `${diagram.points.length} point(s)`,
        extra: [
          `- quadrants: ${diagram.quadrants.map(label => JSON.stringify(label)).join(", ")}`,
          ...list(
            "points",
            diagram.points.map(point => `${point.label} (${point.x}, ${point.y})`)
          )
        ]
      };
    case "xy":
      return {
        counts: `${diagram.series.length} series over ${diagram.categories.length} categor(y/ies)`,
        extra: [
          `- orientation: ${diagram.horizontal ? "horizontal" : "vertical"}`,
          ...list(
            "series",
            diagram.series.map(series => `${series.type} (${series.values.length} value(s))`)
          )
        ]
      };
    case "radar":
      return {
        counts: `${diagram.series.length} series over ${diagram.axes.length} ax(is/es)`,
        extra: list("axes", diagram.axes)
      };
    case "sankey":
      return {
        counts: `${diagram.links.length} link(s)`,
        extra: list(
          "links",
          diagram.links.map(link => `${link.from} → ${link.to} (${link.value})`)
        )
      };
    case "packet":
      return {
        counts: `${diagram.fields.length} field(s), ${diagram.bitsPerRow} bits per row`,
        extra: list(
          "fields",
          diagram.fields.map(field => `${field.start}-${field.end}: ${field.label}`)
        )
      };
    case "block":
      return {
        counts: `${diagram.cells.length} cell(s) in ${diagram.columns} column(s), ${diagram.edges.length} edge(s)`,
        extra: [
          ...list(
            "cells",
            diagram.cells.filter(cell => !cell.spacer).map(cell => cell.label)
          ),
          ...list(
            "edges",
            diagram.edges.map(edge => `${edge.from} → ${edge.to}`)
          )
        ]
      };
    case "pie":
      return {
        counts: `${diagram.slices.length} slice(s), values ${diagram.showData ? "shown" : "hidden"}`,
        extra: list(
          "slices",
          diagram.slices.map(slice => `${slice.label}: ${slice.value}`)
        )
      };
  }
}

/**
 * Describe what the parser made of a diagram, in full.
 *
 * This is the tool surface's answer to a hard problem: the model cannot see the
 * picture, so "it rendered" is not evidence the diagram says what was meant. The
 * parser implements a subset of Mermaid, and the way a subset fails is by
 * *silently omitting* what it did not recognise — a mistyped arrow simply produces
 * one fewer edge. Reporting counts and labels is what lets that be caught.
 */
export function describeDiagram(diagram: MermaidDiagram): string[] {
  const detail = diagramDetail(diagram);
  return [
    `- type: **${KIND_NAMES[diagram.kind]}** (\`kind: "${diagram.kind}"\`)`,
    ...(diagram.title === undefined || diagram.title.length === 0
      ? []
      : [`- title: ${JSON.stringify(diagram.title)}`]),
    `- ${detail.counts}`,
    ...detail.extra
  ];
}

/**
 * The same facts on one line, for a report that has no room for a list.
 *
 * Used by `pdf_edit`, where a diagram is one entry in a numbered list of
 * operations and the alternative — saying only "drew a diagram" — would leave the
 * model with no way to check what it drew short of another tool call.
 */
export function summariseDiagram(diagram: MermaidDiagram): string {
  const detail = diagramDetail(diagram);
  return `${KIND_NAMES[diagram.kind]}${diagram.title === undefined || diagram.title.length === 0 ? "" : ` ${JSON.stringify(diagram.title)}`} — ${detail.counts}`;
}

/**
 * List the mermaid fences in a Markdown document, for a reader that will not
 * render them.
 *
 * `doc_inspect` and `doc_read` both hand back Markdown as text, so a fence
 * arrives at the model as source code. Without this note the model's next move is
 * to copy that source into its own output and pass it back as `source` — spending
 * tokens on data the server already has, which is the one habit this server's
 * whole design tries to break. Naming the index makes `{ from, index }` the
 * obvious call instead.
 */
export function describeFences(
  markdown: string,
  options: { readonly sampled?: boolean } = {}
): string[] {
  const fences = findMermaidFences(markdown);
  if (fences.length === 0) {
    return [];
  }
  return [
    `## ${fences.length} mermaid diagram(s)${options.sampled === true ? " in the first 64 KiB" : ""}`,
    "",
    "| index | line | first line |",
    "| --- | --- | --- |",
    ...fences.map(
      fence =>
        `| ${fence.ordinal} | ${fence.line} | ${escapeTableCell(fence.source.split("\n")[0] ?? "", 60)} |`
    ),
    "",
    "Draw one with `diagram_render({ from, index, to })`, or read its structure with",
    "`diagram_inspect({ from, index })`. Do not copy the diagram source into your own",
    "output in order to render it — name the file and the index instead."
  ];
}

/**
 * Render a capped list of what the parser found.
 *
 * Omitted entirely when empty, because the counts line above already carries the
 * quantity. An emphatic "none recognised" beside a diagram that legitimately
 * declares no edges reads as a failure, which is the opposite of the point: the
 * signal for something dropped is a zero in the counts, and duplicating it here in
 * stronger language made a correct block diagram look broken.
 */
function list(label: string, entries: readonly string[]): string[] {
  if (entries.length === 0) {
    return [];
  }
  const shown = entries.slice(0, MAX_LISTED);
  const suffix = entries.length > shown.length ? `, … ${entries.length - shown.length} more` : "";
  return [`- ${label}: ${shown.map(entry => `\`${entry}\``).join(", ")}${suffix}`];
}

function countMindNodes(node: { readonly children: readonly unknown[] }): number {
  return (
    1 +
    (node.children as readonly { readonly children: readonly unknown[] }[]).reduce(
      (sum, child) => sum + countMindNodes(child),
      0
    )
  );
}

/** Every label in a mind map, depth first, so the tree itself can be checked. */
function mindNodeLabels(node: {
  readonly text: string;
  readonly children: readonly unknown[];
}): string[] {
  return [
    node.text,
    ...(node.children as readonly { text: string; children: readonly unknown[] }[]).flatMap(
      mindNodeLabels
    )
  ];
}

/** A Gantt bound as a plain date. Epoch milliseconds prove nothing to a reader. */
function isoDay(time: number): string {
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : "?";
}
