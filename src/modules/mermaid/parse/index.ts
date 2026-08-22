/**
 * The entry point: recognise which diagram was written, then hand it to its parser.
 *
 * Mermaid names the diagram type on the first non-empty, non-comment line, so the
 * dispatcher only has to read that far. An unknown type is an error rather than an empty
 * diagram — rendering nothing would look like a diagram that draws nothing, and the
 * author would have no way to tell the two apart.
 */

import { parseArchitecture, parseKanban, parsePacket, parseRadar } from "@mermaid/parse/beta";
import { parseQuadrant, parseSankey, parseXy } from "@mermaid/parse/chart";
import { parseClass } from "@mermaid/parse/class";
import { parseEr } from "@mermaid/parse/er";
import { normaliseDirection, parseFlowchart } from "@mermaid/parse/flowchart";
import { parseGantt } from "@mermaid/parse/gantt";
import { splitStatements } from "@mermaid/parse/lex";
import { parseBlock, parseC4, parseRequirement } from "@mermaid/parse/model";
import { parsePie, parseSequence } from "@mermaid/parse/simple";
import { parseState } from "@mermaid/parse/state";
import { parseJourney, parseTimeline } from "@mermaid/parse/track";
import { parseGitGraph, parseMindmap } from "@mermaid/parse/tree";
import type { MermaidDiagram } from "@mermaid/types";

/** Thrown when the source names no diagram this module can draw. */
export class MermaidSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MermaidSyntaxError";
  }
}

/**
 * Parse Mermaid source.
 *
 * @throws {MermaidSyntaxError} when the first statement names no supported diagram.
 */
export function parseMermaid(source: string): MermaidDiagram {
  const statements = splitStatements(source);
  const header = statements[0] ?? "";

  const flow = /^(?:flowchart|graph)\b\s*(TB|TD|BT|LR|RL)?/i.exec(header);
  if (flow) {
    return parseFlowchart(source, normaliseDirection(flow[1] ?? "TB"));
  }
  const state = /^stateDiagram(?:-v2)?\b\s*(TB|TD|BT|LR|RL)?/i.exec(header);
  if (state) {
    return parseState(source, normaliseDirection(state[1] ?? "TB"));
  }
  const klass = /^classDiagram(?:-v2)?\b/i.exec(header);
  if (klass) {
    return parseClass(source, "TB");
  }
  if (/^erDiagram\b/i.test(header)) {
    return parseEr(source, "TB");
  }
  if (/^gantt\b/i.test(header)) {
    return parseGantt(source);
  }
  if (/^timeline\b/i.test(header)) {
    return parseTimeline(source);
  }
  if (/^journey\b/i.test(header)) {
    return parseJourney(source);
  }
  if (/^mindmap\b/i.test(header)) {
    return parseMindmap(source);
  }
  if (/^gitGraph\b/i.test(header)) {
    return parseGitGraph(source);
  }
  if (/^quadrantChart\b/i.test(header)) {
    return parseQuadrant(source);
  }
  if (/^xychart(?:-beta)?\b/i.test(header)) {
    return parseXy(source);
  }
  if (/^sankey(?:-beta)?\b/i.test(header)) {
    return parseSankey(source);
  }
  if (/^requirementDiagram\b/i.test(header)) {
    return parseRequirement(source);
  }
  if (/^C4(?:Context|Container|Component|Dynamic|Deployment)\b/i.test(header)) {
    return parseC4(source);
  }
  if (/^block(?:-beta)?\b/i.test(header)) {
    return parseBlock(source);
  }
  if (/^packet(?:-beta)?\b/i.test(header)) {
    return parsePacket(source);
  }
  if (/^kanban\b/i.test(header)) {
    return parseKanban(source);
  }
  if (/^radar(?:-beta)?\b/i.test(header)) {
    return parseRadar(source);
  }
  if (/^architecture(?:-beta)?\b/i.test(header)) {
    return parseArchitecture(source);
  }
  if (/^pie\b/i.test(header)) {
    return parsePie(source);
  }
  if (/^sequenceDiagram\b/i.test(header)) {
    return parseSequence(source);
  }

  const named = header.split(/\s+/)[0];
  throw new MermaidSyntaxError(
    named === ""
      ? "mermaid source is empty"
      : `unsupported diagram type '${named}' — this module draws flowchart, stateDiagram, classDiagram, erDiagram, gantt, timeline, journey, mindmap, gitGraph, quadrantChart, xychart, sankey, requirementDiagram, C4, block, packet, kanban, radar, architecture, pie and sequenceDiagram`
  );
}
