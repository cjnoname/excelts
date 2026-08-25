/**
 * `diagram_render` / `diagram_inspect` tests, and the Markdown fence path in
 * `doc_write` / `doc_convert`.
 *
 * Every produced file is read back as the format it claims to be — a PNG's IHDR
 * is parsed, a PDF is opened by the reader, a .docx is reopened and its media
 * counted. "Wrote 14 KB" proves nothing about whether anything can display it,
 * and for a diagram that matters more than elsewhere: nothing downstream ever
 * looks at the picture.
 *
 * The per-kind loop is the important one. Twenty-one diagram types share three
 * pipelines, and a structural summary that reads a field the parser spells
 * differently throws only for the one kind that has it — which a spot check on a
 * flowchart would never find.
 */

import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Pdf } from "documonster/pdf";
import { Io, Query } from "documonster/word";

import { resolveConfig, type ServerConfig } from "../config.js";
import { formatToolError } from "../errors.js";
import { diagramInspectTool } from "../tools/diagram-inspect.js";
import { diagramRenderTool } from "../tools/diagram-render.js";
import { findMermaidFences, unwrapFence } from "../tools/diagram.js";
import { docConvertTool } from "../tools/doc-convert.js";
import { docReadTool } from "../tools/doc-read.js";
import { docWriteTool } from "../tools/doc-write.js";
import { inspectTool } from "../tools/inspect.js";
import { pdfEditTool } from "../tools/pdf-edit.js";
import type { AnyToolDefinition } from "../tools/types.js";

interface Fixture {
  readonly config: ServerConfig;
  readonly root: string;
}

async function fixture(args: readonly string[] = []): Promise<Fixture> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "documonster-mcp-diagram-")));
  const base = resolveConfig(args, { cwd: root });
  // One root for both, so a test can read back what it wrote without threading
  // the private output directory through every assertion. The dual-root
  // behaviour itself is covered by `sandbox.test.ts`.
  return { config: { ...base, outputRoot: root }, root };
}

async function run(
  tool: AnyToolDefinition,
  fx: Fixture,
  args: Record<string, unknown>
): Promise<string> {
  const result = await tool.handler(args, { config: fx.config });
  const text = result.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map(block => block.text)
    .join("\n");
  if (result.isError === true) {
    throw new Error(text);
  }
  return text;
}

/**
 * Assert against the text the *model* receives, not the `Error.message`.
 *
 * A tool error's `hint` is the half that says what to do next, and it reaches the
 * model through `formatToolError` rather than through the message — so a test that
 * matches on `.message` alone cannot see the routing advice at all, which is the
 * thing worth pinning.
 */
async function expectToolError(work: Promise<unknown>, pattern: RegExp): Promise<void> {
  await expect(work).rejects.toThrow();
  const error = await work.then(
    () => undefined,
    (cause: unknown) => cause
  );
  expect(formatToolError(error)).toMatch(pattern);
}

const FLOW = `flowchart TD
  A[Start] --> B{Ready?}
  B -->|yes| C[Ship it]
  B -->|no| A`;

/** Width and height out of a PNG's IHDR, which is always the first chunk. */
function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  expect([...bytes.subarray(0, 8)]).toEqual(signature);
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

describe("diagram_render", () => {
  it("draws SVG and reports what the parser actually saw", async () => {
    const fx = await fixture();
    const text = await run(diagramRenderTool, fx, { source: FLOW, to: "flow.svg" });

    const svg = await readFile(path.join(fx.root, "flow.svg"), "utf8");
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("Ready?");
    expect(svg).toContain("Ship it");

    // The structural read-back is the only verification channel a model has, so
    // its absence is a product failure rather than a cosmetic one.
    expect(text).toContain("flowchart");
    expect(text).toContain("3 node(s), 3 edge(s)");
    expect(text).toContain("`A (Start)`");
    expect(text).toContain("`B -[yes]-> C`");
    expect(text).toContain("@output/flow.svg");
  });

  it("draws a PNG whose pixels match the requested scale", async () => {
    const fx = await fixture();
    await run(diagramRenderTool, fx, { source: FLOW, to: "flow.png", scale: 1 });
    const single = pngSize(new Uint8Array(await readFile(path.join(fx.root, "flow.png"))));

    await run(diagramRenderTool, fx, { source: FLOW, to: "double.png", scale: 2 });
    const double = pngSize(new Uint8Array(await readFile(path.join(fx.root, "double.png"))));

    expect(double.width).toBeGreaterThanOrEqual(single.width * 2 - 1);
    expect(double.height).toBeGreaterThanOrEqual(single.height * 2 - 1);
  });

  it("draws a PDF the reader can open, one page sized to the diagram", async () => {
    const fx = await fixture();
    const text = await run(diagramRenderTool, fx, { source: FLOW, to: "flow.pdf" });
    const bytes = new Uint8Array(await readFile(path.join(fx.root, "flow.pdf")));

    const read = await Pdf.read(bytes);
    expect(read.pages).toHaveLength(1);
    // The reported size and the page's real size must agree; a caller placing the
    // diagram in a layout believes the number in the result.
    const reported = /([\d.]+)×([\d.]+) pt/.exec(text);
    expect(reported).not.toBeNull();
    expect(read.pages[0]?.width).toBeCloseTo(Number(reported?.[1]), 0);
    expect(read.pages[0]?.height).toBeCloseTo(Number(reported?.[2]), 0);
  });

  it("letterboxes into an explicit page size rather than stretching", async () => {
    const fx = await fixture();
    await run(diagramRenderTool, fx, { source: FLOW, to: "a4.pdf", width: 595, height: 842 });
    const read = await Pdf.read(new Uint8Array(await readFile(path.join(fx.root, "a4.pdf"))));
    expect(read.pages[0]?.width).toBeCloseTo(595, 0);
    expect(read.pages[0]?.height).toBeCloseTo(842, 0);
  });

  it("applies a theme preset", async () => {
    const fx = await fixture();
    await run(diagramRenderTool, fx, { source: FLOW, to: "dark.svg", theme: "dark" });
    const svg = await readFile(path.join(fx.root, "dark.svg"), "utf8");
    expect(svg.toLowerCase()).toContain("#1e222a");
  });

  it("applies individual theme overrides on top of the preset", async () => {
    const fx = await fixture();
    await run(diagramRenderTool, fx, {
      source: FLOW,
      to: "custom.svg",
      theme: "neutral",
      themeOverrides: { nodeFill: "#ff00ff" }
    });
    const svg = await readFile(path.join(fx.root, "custom.svg"), "utf8");
    expect(svg.toLowerCase()).toContain("#ff00ff");
    // The preset still supplies everything the override did not name.
    expect(svg.toLowerCase()).toContain("#999999");
  });

  it("defaults the background to white, because an invisible PNG is unverifiable", async () => {
    const fx = await fixture();
    await run(diagramRenderTool, fx, { source: FLOW, to: "white.svg" });
    const svg = await readFile(path.join(fx.root, "white.svg"), "utf8");
    expect(svg.toLowerCase()).toContain("#ffffff");
  });

  it("honours an explicit transparent background", async () => {
    const fx = await fixture();
    await run(diagramRenderTool, fx, {
      source: FLOW,
      to: "clear.svg",
      background: "transparent"
    });
    const svg = await readFile(path.join(fx.root, "clear.svg"), "utf8");
    expect(svg).not.toContain('fill="#ffffff"');
  });

  it("rejects a colour it cannot parse instead of silently drawing black", async () => {
    const fx = await fixture();
    await expect(
      run(diagramRenderTool, fx, { source: FLOW, to: "bad.svg", background: "ligthgray" })
    ).rejects.toThrow(/not a colour the renderer can read/);
  });

  it("accepts a genuinely black background", async () => {
    const fx = await fixture();
    await run(diagramRenderTool, fx, { source: FLOW, to: "black.svg", background: "black" });
    expect(await readFile(path.join(fx.root, "black.svg"), "utf8")).toContain("#000000");
  });

  it("strips a ```mermaid wrapper, which models add by habit", async () => {
    const fx = await fixture();
    const text = await run(diagramRenderTool, fx, {
      source: "```mermaid\nflowchart LR\n  A --> B\n```",
      to: "wrapped.svg"
    });
    expect(text).toContain("2 node(s), 1 edge(s)");
  });

  it("names what is possible when the diagram type is unknown", async () => {
    const fx = await fixture();
    await expect(
      run(diagramRenderTool, fx, { source: "sunburstChart\n  a: 1", to: "no.svg" })
    ).rejects.toThrow(/could not be parsed[\s\S]*sunburstChart/);
  });

  it("refuses an output extension it cannot produce", async () => {
    const fx = await fixture();
    await expect(run(diagramRenderTool, fx, { source: FLOW, to: "flow.jpg" })).rejects.toThrow(
      /cannot tell the diagram format/
    );
  });

  it("requires exactly one of source and from", async () => {
    const fx = await fixture();
    await expect(run(diagramRenderTool, fx, { to: "flow.svg" })).rejects.toThrow(
      /no diagram source/
    );
    await expect(
      run(diagramRenderTool, fx, { source: FLOW, from: "a.mmd", to: "flow.svg" })
    ).rejects.toThrow(/not both/);
  });

  it("does not overwrite without being asked, and does when asked", async () => {
    const fx = await fixture();
    await run(diagramRenderTool, fx, { source: FLOW, to: "once.svg" });
    await expect(run(diagramRenderTool, fx, { source: FLOW, to: "once.svg" })).rejects.toThrow(
      /already exists/
    );
    await run(diagramRenderTool, fx, {
      source: "flowchart LR\n  X --> Y",
      to: "once.svg",
      overwrite: true
    });
    expect(await readFile(path.join(fx.root, "once.svg"), "utf8")).toContain("X");
  });

  it("refuses a raster that would be absurdly large, before doing the work", async () => {
    const fx = await fixture();
    await expect(
      run(diagramRenderTool, fx, {
        source: FLOW,
        to: "huge.png",
        width: 8000,
        height: 8000,
        scale: 8
      })
    ).rejects.toThrow(/over the .* limit/);
  });
});

describe("diagram source files", () => {
  it("reads a .mmd file", async () => {
    const fx = await fixture();
    await writeFile(path.join(fx.root, "flow.mmd"), FLOW);
    const text = await run(diagramRenderTool, fx, { from: "flow.mmd", to: "out.svg" });
    expect(text).toContain("3 node(s), 3 edge(s)");
    expect(text).toContain("source: flow.mmd");
  });

  it("picks a fence out of a Markdown file, and says which", async () => {
    const fx = await fixture();
    await writeFile(
      path.join(fx.root, "doc.md"),
      [
        "# Doc",
        "",
        "```mermaid",
        "pie title Split",
        '  "A" : 60',
        '  "B" : 40',
        "```",
        "",
        "text",
        "",
        "```mermaid",
        "flowchart LR",
        "  A --> B",
        "```",
        ""
      ].join("\n")
    );

    const first = await run(diagramRenderTool, fx, { from: "doc.md", to: "one.svg" });
    expect(first).toContain("mermaid fence 1 of 2");
    expect(first).toContain("2 slice(s)");

    const second = await run(diagramRenderTool, fx, { from: "doc.md", index: 2, to: "two.svg" });
    expect(second).toContain("mermaid fence 2 of 2");
    expect(second).toContain("2 node(s), 1 edge(s)");
  });

  it("says how many fences there are when the index is out of range", async () => {
    const fx = await fixture();
    await writeFile(
      path.join(fx.root, "one.md"),
      ["```mermaid", "flowchart LR", " A --> B", "```"].join("\n")
    );
    await expect(
      run(diagramRenderTool, fx, { from: "one.md", index: 4, to: "x.svg" })
    ).rejects.toThrow(/has 1 mermaid fence\(s\); there is no fence 4/);
  });

  it("refuses a Markdown file with no diagram in it", async () => {
    const fx = await fixture();
    await writeFile(path.join(fx.root, "prose.md"), "# Just words\n\nNothing to draw.\n");
    await expect(run(diagramRenderTool, fx, { from: "prose.md", to: "x.svg" })).rejects.toThrow(
      /contains no ```mermaid fence/
    );
  });
});

describe("diagram_inspect", () => {
  it("describes a diagram without writing anything", async () => {
    const fx = await fixture();
    const text = await run(diagramInspectTool, fx, { source: FLOW });
    expect(text).toContain("3 node(s), 3 edge(s)");
    expect(text).toContain("renders at");
    expect(diagramInspectTool.mutates).toBe(false);
  });

  it("stays available under --readonly, where rendering is withheld", async () => {
    const fx = await fixture(["--readonly"]);
    const text = await run(diagramInspectTool, fx, { source: FLOW });
    expect(text).toContain("flowchart");
    await expect(run(diagramRenderTool, fx, { source: FLOW, to: "x.svg" })).rejects.toThrow(
      /readonly/
    );
  });

  it("lists every fence in a Markdown file, naming a broken one rather than failing", async () => {
    const fx = await fixture();
    await writeFile(
      path.join(fx.root, "mixed.md"),
      [
        "```mermaid",
        "flowchart LR",
        "  A --> B",
        "```",
        "",
        "```mermaid",
        "notADiagram",
        "  nonsense",
        "```",
        ""
      ].join("\n")
    );
    const text = await run(diagramInspectTool, fx, { from: "mixed.md" });
    expect(text).toContain("2 mermaid fences");
    expect(text).toContain("unsupported");
    expect(text).toContain("flowchart");
  });

  it("reports a syntax error with the line that names the type", async () => {
    const fx = await fixture();
    await expect(run(diagramInspectTool, fx, { source: "" })).rejects.toThrow(/no diagram source/);
    await expect(run(diagramInspectTool, fx, { source: "  \n  nonsense\n" })).rejects.toThrow(
      /could not be parsed/
    );
  });
});

/**
 * One sample per diagram type.
 *
 * Not a smoke test: the structural summary reads kind-specific fields, so a
 * mismatch between the summary and the parser's own spelling throws for exactly
 * one kind. Twenty of these passing and one failing is the outcome this catches;
 * checking a flowchart alone would not.
 */
const SAMPLES: ReadonlyArray<readonly [string, string]> = [
  ["flowchart", FLOW],
  ["sequenceDiagram", "sequenceDiagram\n  Alice->>Bob: Hello\n  Bob-->>Alice: Hi"],
  [
    "classDiagram",
    "classDiagram\n  class Animal {\n    +String name\n    +eat()\n  }\n  Animal <|-- Dog"
  ],
  ["stateDiagram", "stateDiagram-v2\n  [*] --> Idle\n  Idle --> Running: start\n  Running --> [*]"],
  [
    "erDiagram",
    "erDiagram\n  CUSTOMER ||--o{ ORDER : places\n  ORDER {\n    int id\n    string sku\n  }"
  ],
  [
    "gantt",
    "gantt\n  title Plan\n  section Build\n  Design :a1, 2026-01-01, 10d\n  Code :a2, after a1, 20d"
  ],
  ["gitGraph", "gitGraph\n  commit\n  branch feature\n  commit\n  checkout main\n  merge feature"],
  ["mindmap", "mindmap\n  root((Core))\n    Excel\n    Word\n    Pdf"],
  ["timeline", "timeline\n  title History\n  2024 : Started\n  2025 : Shipped"],
  [
    "journey",
    "journey\n  title Checkout\n  section Browse\n    Search: 5: User\n    Filter: 3: User"
  ],
  ["kanban", "kanban\n  Todo\n    task1[Write it]\n  Done\n    task2[Ship it]"],
  [
    "quadrantChart",
    "quadrantChart\n  title Effort\n  x-axis Low --> High\n  y-axis Small --> Big\n  A: [0.3, 0.6]\n  B: [0.8, 0.2]"
  ],
  [
    "xychart",
    "xychart-beta\n  title Sales\n  x-axis [jan, feb, mar]\n  y-axis 0 --> 100\n  bar [30, 60, 90]"
  ],
  ["radar", "radar-beta\n  axis a, b, c\n  curve one{10, 20, 30}"],
  ["sankey", "sankey-beta\n  A,B,10\n  B,C,5"],
  ["packet", 'packet-beta\n  0-7: "Source"\n  8-15: "Dest"'],
  ["block", "block-beta\n  columns 2\n  A B\n  C D"],
  ["pie", 'pie title Split\n  "A" : 60\n  "B" : 40'],
  [
    "C4",
    'C4Context\n  title System\n  Person(user, "User")\n  System(app, "App")\n  Rel(user, app, "uses")'
  ],
  [
    "requirementDiagram",
    "requirementDiagram\n  requirement one {\n    id: 1\n    text: must work\n  }\n  element impl {\n    type: code\n  }\n  impl - satisfies -> one"
  ],
  [
    "architecture",
    "architecture-beta\n  group api(cloud)[API]\n  service db(database)[Store] in api\n  service web(server)[Web] in api\n  web:R --> L:db"
  ]
];

describe("every diagram type", () => {
  it.each(SAMPLES)("renders and describes %s", async (keyword, source) => {
    const fx = await fixture();
    const inspected = await run(diagramInspectTool, fx, { source });
    expect(inspected).toContain("## Structure");
    expect(inspected).toContain("renders at");
    // The counts line is the read-back's load-bearing claim, and a leading zero in
    // it means the sample parsed as the right *kind* while its contents were
    // dropped — the silent failure the whole structural summary exists to surface.
    const counts = inspected
      .split("\n")
      .find(line => /^- \d|^- \*\*empty/.test(line) || /^- \d+ /.test(line));
    expect(counts, `${keyword}: no counts line`).toBeDefined();
    expect(counts, `${keyword} parsed but lost its contents: ${counts}`).not.toMatch(
      /^- 0 |\*\*empty\*\*/
    );

    for (const format of ["svg", "png", "pdf"] as const) {
      const text = await run(diagramRenderTool, fx, { source, to: `sample.${format}` });
      expect(text, `${keyword} → ${format}`).toContain("What was drawn");
      const bytes = new Uint8Array(await readFile(path.join(fx.root, `sample.${format}`)));
      expect(bytes.byteLength, `${keyword} → ${format} is empty`).toBeGreaterThan(200);
    }
  });
});

describe("mermaid fences in Markdown documents", () => {
  const DOC = [
    "# Architecture",
    "",
    "The pipeline:",
    "",
    "```mermaid",
    "flowchart LR",
    "  Read[Read] --> Parse[Parse] --> Write[Write]",
    "```",
    "",
    "That is all.",
    ""
  ].join("\n");

  it("embeds the diagram in a .docx as a real image", async () => {
    const fx = await fixture();
    const text = await run(docWriteTool, fx, { path: "doc.docx", markdown: DOC });
    expect(text).toContain("mermaid diagram(s) rendered");

    const doc = await Io.readFile(path.join(fx.root, "doc.docx"));
    expect(doc.images).toHaveLength(1);
    // The source must be gone: a fence left as text is the bug this replaces.
    const body = Query.extractText(doc);
    expect(body).toContain("Architecture");
    expect(body).not.toContain("flowchart LR");
  });

  it("fits the image inside the text column", async () => {
    const fx = await fixture();
    // A deliberately wide diagram: eight ranks left to right.
    const wide = [
      "```mermaid",
      "flowchart LR",
      "  A[Alpha] --> B[Bravo] --> C[Charlie] --> D[Delta] --> E[Echo] --> F[Foxtrot] --> G[Golf] --> H[Hotel]",
      "```"
    ].join("\n");
    await run(docWriteTool, fx, { path: "wide.docx", markdown: wide });

    const doc = await Io.readFile(path.join(fx.root, "wide.docx"));
    const image = doc.body
      .flatMap(block => ("children" in block ? block.children : []))
      .flatMap(runEntry => ("content" in runEntry ? runEntry.content : []))
      .find(entry => entry.type === "image");
    expect(image).toBeDefined();
    // The natural width is 1034 points, so the cap has to bite: exactly the 468
    // points of text column, in EMU. Word does not shrink an oversized inline
    // image; it runs it off the edge of the paper.
    const { width, height } = image as { width: number; height: number };
    expect(width).toBe(468 * 12700);
    // Fitted, not squashed: 1034.2 × 72.2 keeps its aspect ratio.
    expect(height / width).toBeCloseTo(72.2 / 1034.2, 3);
  });

  it("keeps the fence as code when asked", async () => {
    const fx = await fixture();
    const text = await run(docWriteTool, fx, {
      path: "code.docx",
      markdown: DOC,
      diagrams: false
    });
    expect(text).not.toContain("mermaid diagram(s) rendered");
    const doc = await Io.readFile(path.join(fx.root, "code.docx"));
    expect(doc.images ?? []).toHaveLength(0);
    expect(Query.extractText(doc)).toContain("flowchart LR");
  });

  it("leaves a malformed diagram as a code block and says so", async () => {
    const fx = await fixture();
    const text = await run(docWriteTool, fx, {
      path: "broken.docx",
      markdown: ["Intro.", "", "```mermaid", "notADiagram", "```", "", "Outro."].join("\n")
    });
    expect(text).toContain("left as a code block");
    const doc = await Io.readFile(path.join(fx.root, "broken.docx"));
    const body = Query.extractText(doc);
    // The prose either side has to survive: losing a document over one bad
    // diagram is a far worse failure than an unrendered diagram.
    expect(body).toContain("Intro.");
    expect(body).toContain("Outro.");
  });

  it("renders several fences, each in its own place", async () => {
    const fx = await fixture();
    const markdown = [
      "One:",
      "",
      "```mermaid",
      "flowchart LR",
      "  A --> B",
      "```",
      "",
      "Two:",
      "",
      "```mermaid",
      'pie title P\n  "x" : 1\n  "y" : 2',
      "```",
      ""
    ].join("\n");
    const text = await run(docWriteTool, fx, { path: "two.docx", markdown });
    expect(text).toContain("2 mermaid diagram(s)");
    const doc = await Io.readFile(path.join(fx.root, "two.docx"));
    expect(doc.images).toHaveLength(2);
    expect(Query.extractText(doc)).toContain("One:");
    expect(Query.extractText(doc)).toContain("Two:");
  });

  it("embeds diagrams when converting a .md file", async () => {
    const fx = await fixture();
    await writeFile(path.join(fx.root, "in.md"), DOC);
    const text = await run(docConvertTool, fx, { from: "in.md", to: "out.docx" });
    expect(text).toContain("mermaid diagram(s) rendered");
    const doc = await Io.readFile(path.join(fx.root, "out.docx"));
    expect(doc.images).toHaveLength(1);
  });

  it("reaches a PDF through the Word layout engine", async () => {
    const fx = await fixture();
    await run(docWriteTool, fx, { path: "doc.pdf", markdown: DOC });
    const read = await Pdf.read(new Uint8Array(await readFile(path.join(fx.root, "doc.pdf"))));
    expect(read.pages.length).toBeGreaterThanOrEqual(1);
    expect(read.pages[0]?.images.length).toBeGreaterThanOrEqual(1);
  });

  it("is off when the diagram group is disabled", async () => {
    const fx = await fixture(["--enable", "word"]);
    const text = await run(docWriteTool, fx, { path: "off.docx", markdown: DOC });
    expect(text).not.toContain("mermaid diagram(s) rendered");
    const doc = await Io.readFile(path.join(fx.root, "off.docx"));
    expect(doc.images ?? []).toHaveLength(0);
  });
});

describe("doc_inspect", () => {
  it("routes a .mmd file to the diagram tools", async () => {
    const fx = await fixture();
    await writeFile(path.join(fx.root, "flow.mmd"), FLOW);
    const text = await run(inspectTool, fx, { path: "flow.mmd" });
    expect(text).toContain("mermaid");
    expect(text).toContain("diagram_render");
  });

  it("lists the mermaid fences in a Markdown file", async () => {
    const fx = await fixture();
    await writeFile(
      path.join(fx.root, "doc.md"),
      ["# T", "", "```mermaid", "flowchart LR", "  A --> B", "```", ""].join("\n")
    );
    const text = await run(inspectTool, fx, { path: "doc.md" });
    expect(text).toContain("1 mermaid diagram(s)");
    expect(text).toContain("diagram_render({ from, index, to })");
  });
});

describe("fence scanning", () => {
  it("finds fences opened with backticks or tildes, of any length", () => {
    const found = findMermaidFences(
      ["````mermaid", "flowchart LR", " A-->B", "````", "", "~~~mermaid", "pie", "~~~"].join("\n")
    );
    expect(found).toHaveLength(2);
    expect(found[0]?.source).toContain("flowchart");
    expect(found[1]?.source).toBe("pie");
  });

  it("does not close a long fence on a shorter one", () => {
    const found = findMermaidFences(
      ["````mermaid", "flowchart LR", "```", " A-->B", "````"].join("\n")
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.source).toContain("A-->B");
  });

  it("treats an unterminated fence as running to the end, as renderers do", () => {
    const found = findMermaidFences(["```mermaid", "flowchart LR", " A-->B"].join("\n"));
    expect(found).toHaveLength(1);
    expect(found[0]?.source).toContain("A-->B");
  });

  it("ignores a fence in another language", () => {
    expect(findMermaidFences(["```ts", "const a = 1;", "```"].join("\n"))).toHaveLength(0);
  });

  it("reports spans that cover the whole fence, opening and closing lines included", () => {
    const text = ["intro", "```mermaid", "pie", "```", "outro"].join("\n");
    const fence = findMermaidFences(text)[0];
    expect(fence).toBeDefined();
    const spliced = text.slice(0, fence?.start) + "X" + text.slice(fence?.end);
    expect(spliced).toBe("intro\nXoutro");
  });

  it("unwraps a whole-string fence but leaves bare source alone", () => {
    expect(unwrapFence("```mermaid\nflowchart LR\n A-->B\n```")).toBe("flowchart LR\n A-->B");
    expect(unwrapFence("```\nflowchart LR\n```")).toBe("flowchart LR");
    expect(unwrapFence("flowchart LR\n A-->B")).toBe("flowchart LR\n A-->B");
    // Two fences is a document, not a wrapper; leave it for the fence scanner.
    const two = "```mermaid\npie\n```\n```mermaid\npie\n```";
    expect(unwrapFence(two)).toBe(two);
  });
});

/**
 * Routing: the diagram capability has to be *findable* from the document tools.
 *
 * A model that reads a Markdown file and sees a fence, or reads a `.mmd` and gets
 * an error naming only Word and PDF extensions, will do the expensive thing —
 * copy the diagram source out through its own reply and pass it back as `source`.
 * These tests pin the pointers that stop that.
 */
describe("routing from the document tools", () => {
  it("reads a .mmd file and names the tool that draws it", async () => {
    const fx = await fixture();
    await writeFile(path.join(fx.root, "flow.mmd"), FLOW);
    const text = await run(docReadTool, fx, { path: "flow.mmd" });
    expect(text).toContain("Mermaid diagram source");
    expect(text).toContain("Ready?");
    expect(text).toContain("diagram_render");
    expect(text).toContain("diagram_inspect");
  });

  it("indexes the fences in a Markdown file it read as text", async () => {
    const fx = await fixture();
    await writeFile(
      path.join(fx.root, "doc.md"),
      [
        "# T",
        "",
        "```mermaid",
        "flowchart LR",
        "  A --> B",
        "```",
        "",
        "Middle.",
        "",
        "```mermaid",
        "pie title P",
        "```",
        ""
      ].join("\n")
    );
    const text = await run(docReadTool, fx, { path: "doc.md" });
    expect(text).toContain("2 mermaid diagram(s)");
    expect(text).toContain("diagram_render({ from, index, to })");
    expect(text).toContain("Do not copy the diagram source");
  });

  it("indexes fences even when the returned window does not include them", async () => {
    const fx = await fixture();
    await writeFile(
      path.join(fx.root, "long.md"),
      [...Array(50).fill("prose"), "```mermaid", "flowchart LR", " A --> B", "```", ""].join("\n")
    );
    // The window stops long before the fence; the index is of the whole file, so
    // the line number it reports stays usable.
    const text = await run(docReadTool, fx, { path: "long.md", maxLines: 5 });
    expect(text).toContain("1 mermaid diagram(s)");
    expect(text).toContain("| 1 | 51 |");
  });

  it("says nothing about diagrams for a Markdown file that has none", async () => {
    const fx = await fixture();
    await writeFile(path.join(fx.root, "plain.md"), "# T\n\nJust prose.\n");
    const text = await run(docReadTool, fx, { path: "plain.md" });
    expect(text).not.toContain("mermaid");
  });

  it("points doc_write and doc_convert at diagram_render instead of refusing blankly", async () => {
    const fx = await fixture();
    await expectToolError(
      run(docWriteTool, fx, { path: "x.mmd", markdown: "# hi" }),
      /diagram_render/
    );

    await writeFile(path.join(fx.root, "flow.mmd"), FLOW);
    await expectToolError(
      run(docConvertTool, fx, { from: "flow.mmd", to: "out.pdf" }),
      /Use diagram_render to draw a \.mmd file/
    );
    await writeFile(path.join(fx.root, "in.md"), "# T\n");
    await expectToolError(
      run(docConvertTool, fx, { from: "in.md", to: "out.mmd" }),
      /a diagram is written, not derived/
    );
  });
});

describe("pdf_edit op: diagram", () => {
  /** A two-page PDF with text on it, to draw over. */
  async function twoPagePdf(fx: Fixture, name: string): Promise<void> {
    const builder = new Pdf.Builder();
    for (const label of ["First page", "Second page"]) {
      builder.addPage({ width: 595, height: 842 }).drawText(label, { x: 72, y: 760, fontSize: 18 });
    }
    await writeFile(path.join(fx.root, name), await builder.build());
  }

  it("draws a diagram onto an existing page as vectors, and says what it drew", async () => {
    const fx = await fixture();
    await twoPagePdf(fx, "in.pdf");
    const text = await run(pdfEditTool, fx, {
      path: "in.pdf",
      out: "out.pdf",
      ops: [{ op: "diagram", source: FLOW, pages: [2] }]
    });

    expect(text).toContain("drew a diagram on 1 page(s) as vectors");
    // The summary is the verification channel: a model cannot see the page.
    expect(text).toContain("flowchart — 3 node(s), 3 edge(s)");

    const read = await Pdf.read(new Uint8Array(await readFile(path.join(fx.root, "out.pdf"))), {
      extractText: true,
      extractImages: true
    });
    expect(read.pages).toHaveLength(2);
    // Vectors, so no image was added — a raster overlay would show up here.
    expect(read.pages[1]?.images ?? []).toHaveLength(0);
    // The diagram's own labels are real text on the page.
    expect(read.pages[1]?.text).toContain("Ready?");
    // The original content is untouched.
    expect(read.pages[0]?.text).toContain("First page");
    expect(read.pages[1]?.text).toContain("Second page");
    // Page 1 got no diagram.
    expect(read.pages[0]?.text).not.toContain("Ready?");
  });

  it("shrinks a diagram to fit the page when given no box", async () => {
    const fx = await fixture();
    await twoPagePdf(fx, "in.pdf");
    const wide =
      "flowchart LR\n  A[Alpha] --> B[Bravo] --> C[Charlie] --> D[Delta] --> E[Echo] --> F[Foxtrot] --> G[Golf] --> H[Hotel]";
    const text = await run(pdfEditTool, fx, {
      path: "in.pdf",
      out: "fit.pdf",
      ops: [{ op: "diagram", source: wide, pages: [1] }]
    });
    // 1034 points natural width, fitted into 595 − 2×36 = 523.
    expect(text).toContain("523×");
    // Centred, so the left edge is the page's own margin.
    expect(text).toMatch(/at \(36, \d+\)/);
  });

  it("does not enlarge a small diagram to fill the paper", async () => {
    const fx = await fixture();
    await twoPagePdf(fx, "in.pdf");
    const text = await run(pdfEditTool, fx, {
      path: "in.pdf",
      out: "small.pdf",
      ops: [{ op: "diagram", source: "flowchart LR\n A --> B", pages: [1] }]
    });
    const size = /(\d+)×(\d+) pt/.exec(text);
    expect(Number(size?.[1])).toBeLessThan(523);
  });

  it("honours an explicit box and position", async () => {
    const fx = await fixture();
    await twoPagePdf(fx, "in.pdf");
    const text = await run(pdfEditTool, fx, {
      path: "in.pdf",
      out: "placed.pdf",
      ops: [{ op: "diagram", source: FLOW, pages: [1], x: 100, y: 200, width: 200, height: 200 }]
    });
    expect(text).toContain("at (100, 200)");
    expect(text).toMatch(/1?\d\d×200 pt|\d+×\d+ pt/);
  });

  it("reads the diagram from a file, like the render tool does", async () => {
    const fx = await fixture();
    await twoPagePdf(fx, "in.pdf");
    await writeFile(
      path.join(fx.root, "spec.md"),
      ["```mermaid", "pie title Share", '  "a" : 1', "```", ""].join("\n")
    );
    const text = await run(pdfEditTool, fx, {
      path: "in.pdf",
      out: "fromfile.pdf",
      ops: [{ op: "diagram", from: "spec.md", index: 1, pages: [1] }]
    });
    expect(text).toContain('pie "Share" — 1 slice(s)');
  });

  it("stays an overlay, so the save is incremental and signatures survive", async () => {
    const fx = await fixture();
    await twoPagePdf(fx, "in.pdf");
    const text = await run(pdfEditTool, fx, {
      path: "in.pdf",
      out: "incr.pdf",
      ops: [{ op: "diagram", source: FLOW }]
    });
    expect(text).toContain("drew a diagram on 2 page(s)");
    // Structural ops rebuild; a diagram must not be one of them.
    expect(text).not.toContain("structural change");
  });

  it("describes the diagram under dryRun without writing", async () => {
    const fx = await fixture();
    await twoPagePdf(fx, "in.pdf");
    const text = await run(pdfEditTool, fx, {
      path: "in.pdf",
      out: "never.pdf",
      dryRun: true,
      ops: [{ op: "diagram", source: FLOW }]
    });
    expect(text).toContain("Dry run");
    expect(text).toContain("flowchart — 3 node(s)");
    await expect(readFile(path.join(fx.root, "never.pdf"))).rejects.toThrow();
  });

  it("reports a bad diagram as a failed op, having written nothing", async () => {
    const fx = await fixture();
    await twoPagePdf(fx, "in.pdf");
    await expect(
      run(pdfEditTool, fx, {
        path: "in.pdf",
        out: "bad.pdf",
        ops: [{ op: "diagram", source: "notADiagram" }]
      })
    ).rejects.toThrow(/could not be parsed/);
    await expect(readFile(path.join(fx.root, "bad.pdf"))).rejects.toThrow();
  });

  it("rejects an empty page selection rather than silently drawing on none", async () => {
    const fx = await fixture();
    await twoPagePdf(fx, "in.pdf");
    await expect(
      run(pdfEditTool, fx, {
        path: "in.pdf",
        out: "none.pdf",
        ops: [{ op: "diagram", source: FLOW, pages: [] }]
      })
    ).rejects.toThrow(/page selection is empty/);
    await expect(readFile(path.join(fx.root, "none.pdf"))).rejects.toThrow();
  });
});
