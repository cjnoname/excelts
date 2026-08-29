import { loadIife } from "@test/browser/load-iife";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Smoke test for the shipped `documonster.mermaid.iife.min.js` bundle.
 *
 * This bundle exists because the module was public for several releases without one:
 * `exports` published `documonster/mermaid` while `rolldown.config.ts` built nine bundles
 * that did not include it, so the most obvious way to consume a diagram renderer — one
 * `<script>` in a page — was the one way that did not work.
 *
 * The passes are asserted separately because they are the module's three seams: text to
 * syntax tree, tree to coordinates, coordinates to a display list (and from there to
 * markup, which is what a page actually wants). A caller may stop after any of them, so
 * each has to work in the delivered artifact.
 */
describe("Documonster.Mermaid IIFE bundle", () => {
  let Mermaid: {
    parseMermaid: (text: string) => { kind: string; nodes: unknown[]; edges: unknown[] };
    layoutFlowchart: (tree: unknown) => {
      width: number;
      height: number;
      nodes: { width: number; height: number }[];
      edges: unknown[];
    };
    mermaidToDrawList: (text: string) => { width: number; height: number; children: unknown[] };
    mermaidToSvg: (text: string) => string;
    MermaidSyntaxError: new (...args: never[]) => Error;
  };

  const FLOWCHART = "flowchart TD\n  A[Start] --> B{Choice}\n  B -->|yes| C[Done]\n";

  beforeAll(async () => {
    Mermaid = await loadIife("mermaid", "Mermaid");
  }, 60000);

  it("exposes the documented surface", () => {
    expect(typeof Mermaid.parseMermaid).toBe("function");
    expect(typeof Mermaid.layoutFlowchart).toBe("function");
    expect(typeof Mermaid.mermaidToDrawList).toBe("function");
    expect(typeof Mermaid.mermaidToSvg).toBe("function");
    expect(typeof Mermaid.MermaidSyntaxError).toBe("function");
  });

  it("parses text into a syntax tree that says nothing about geometry", () => {
    const tree = Mermaid.parseMermaid(FLOWCHART);
    expect(tree.kind).toBe("flowchart");
    expect(tree.nodes.length).toBe(3);
    expect(tree.edges.length).toBe(2);
  });

  it("lays the tree out into coordinates", () => {
    const layout = Mermaid.layoutFlowchart(Mermaid.parseMermaid(FLOWCHART));
    // Scaffolding dummies steer the ordering and are dropped before the layout returns,
    // so every node left is a real one with a real box.
    expect(layout.nodes.length).toBe(3);
    expect(layout.nodes.every(node => node.width > 0 && node.height > 0)).toBe(true);
    expect(layout.edges.length).toBe(2);
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
  });

  it("renders a display list and serialises it to SVG", () => {
    const list = Mermaid.mermaidToDrawList(FLOWCHART);
    expect(list.children.length).toBeGreaterThan(0);
    expect(list.width).toBeGreaterThan(0);

    const svg = Mermaid.mermaidToSvg(FLOWCHART);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("Start");
    expect(svg).toContain("Done");
  });

  it("reports a syntax error rather than drawing nonsense", () => {
    expect(() => Mermaid.parseMermaid("not a diagram at all")).toThrow(Mermaid.MermaidSyntaxError);
  });
});
