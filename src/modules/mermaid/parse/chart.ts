/**
 * The `quadrantChart`, `xychart` and `sankey` parsers.
 *
 * All three describe numbers rather than structure, which is why they are together: the
 * work is reading values and bounds, not resolving references between statements.
 *
 * Sankey is the odd one — its body is CSV, not a Mermaid grammar — so it is read with a
 * small quoted-field scanner rather than by splitting on commas, or a node whose name
 * contains a comma would become two nodes.
 */

import { decodeLabel, splitStatements, unquote, linesOf } from "@mermaid/parse/lex";
import type {
  QuadrantDiagram,
  QuadrantPoint,
  SankeyDiagram,
  SankeyLink,
  XyDiagram,
  XySeries
} from "@mermaid/types";

/** Parse a quadrant chart. */
export function parseQuadrant(source: string): QuadrantDiagram {
  const points: QuadrantPoint[] = [];
  const quadrants: [string, string, string, string] = ["", "", "", ""];
  let title: string | undefined;
  let xAxis: [string, string] | undefined;
  let yAxis: [string, string] | undefined;

  for (const text of splitStatements(source)) {
    if (/^quadrantChart\b/i.test(text)) {
      continue;
    }
    const titleMatch = /^title\s+(.+)$/i.exec(text);
    if (titleMatch) {
      title = decodeLabel(titleMatch[1]);
      continue;
    }

    const axis = /^([xy])-axis\s+(.+)$/i.exec(text);
    if (axis) {
      // `x-axis Low --> High` names both ends; `x-axis Low` names only the low one.
      const parts = axis[2].split("-->").map(part => decodeLabel(part));
      const pair: [string, string] = [parts[0] ?? "", parts[1] ?? ""];
      if (axis[1].toLowerCase() === "x") {
        xAxis = pair;
      } else {
        yAxis = pair;
      }
      continue;
    }

    const quadrant = /^quadrant-([1-4])\s+(.+)$/i.exec(text);
    if (quadrant) {
      quadrants[Number(quadrant[1]) - 1] = decodeLabel(quadrant[2]);
      continue;
    }

    // `Campaign A: [0.3, 0.6]`
    const point = /^(.+?)\s*:\s*\[\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\]$/.exec(text);
    if (point) {
      const x = Number.parseFloat(point[2]);
      const y = Number.parseFloat(point[3]);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        points.push({ label: decodeLabel(point[1]), x, y });
      }
    }
  }

  return {
    kind: "quadrant",
    ...(title === undefined ? {} : { title }),
    ...(xAxis === undefined ? {} : { xAxis }),
    ...(yAxis === undefined ? {} : { yAxis }),
    quadrants,
    points
  };
}

/** Parse an XY chart. */
export function parseXy(source: string): XyDiagram {
  const series: XySeries[] = [];
  let categories: string[] = [];
  let title: string | undefined;
  let xTitle: string | undefined;
  let yTitle: string | undefined;
  let yRange: [number, number] | undefined;
  let horizontal = false;

  for (const text of splitStatements(source)) {
    const header = /^xychart(?:-beta)?\b\s*(horizontal)?/i.exec(text);
    if (header) {
      horizontal = header[1] !== undefined;
      continue;
    }
    const titleMatch = /^title\s+(.+)$/i.exec(text);
    if (titleMatch) {
      title = decodeLabel(titleMatch[1]);
      continue;
    }

    const axis = /^([xy])-axis\s+(.+)$/i.exec(text);
    if (axis) {
      const body = axis[2].trim();
      const bracket = /\[(.*)\]/.exec(body);
      // The caption is whatever is left once the category list and the range have been
      // taken out — reading the rest of the line as the caption printed the bounds inside
      // the axis title.
      const caption = decodeLabel(
        body
          .replace(/\[.*\]/, "")
          .replace(/[-\d.]+\s*-->\s*[-\d.]+/, "")
          .trim()
      );
      if (axis[1].toLowerCase() === "x") {
        if (caption !== "") {
          xTitle = caption;
        }
        if (bracket) {
          categories = splitFields(bracket[1]).map(field => decodeLabel(field));
        }
        continue;
      }
      if (caption !== "") {
        yTitle = caption;
      }
      // `y-axis "Revenue" 0 --> 10000`
      const range = /([-\d.]+)\s*-->\s*([-\d.]+)/.exec(body);
      if (range) {
        const low = Number.parseFloat(range[1]);
        const high = Number.parseFloat(range[2]);
        if (Number.isFinite(low) && Number.isFinite(high)) {
          yRange = [low, high];
        }
      }
      continue;
    }

    const plot = /^(bar|line)\s+(.+)$/i.exec(text);
    if (plot) {
      const body = plot[2].trim();
      const bracket = /\[(.*)\]/.exec(body);
      if (!bracket) {
        continue;
      }
      const caption = decodeLabel(body.replace(/\[.*\]/, ""));
      const values = splitFields(bracket[1])
        .map(field => Number.parseFloat(field))
        .filter(value => Number.isFinite(value));
      series.push({
        type: plot[1].toLowerCase() as "bar" | "line",
        ...(caption === "" ? {} : { title: caption }),
        values
      });
    }
  }

  return {
    kind: "xy",
    ...(title === undefined ? {} : { title }),
    horizontal,
    ...(xTitle === undefined ? {} : { xTitle }),
    ...(yTitle === undefined ? {} : { yTitle }),
    categories,
    ...(yRange === undefined ? {} : { yRange }),
    series
  };
}

/** Parse a Sankey diagram. Its body is CSV: `source,target,value`. */
export function parseSankey(source: string): SankeyDiagram {
  const links: SankeyLink[] = [];
  let title: string | undefined;

  for (const raw of linesOf(source)) {
    // `linesOf` has already removed comments, including a trailing one — which this used to
    // leave in place, so `A,B,10 %% note` put `10 %% note` through `parseFloat`.
    const line = raw.trim();
    if (line === "" || /^sankey(?:-beta)?\s*$/i.test(line)) {
      continue;
    }
    const titleMatch = /^title\s+(.+)$/i.exec(line);
    if (titleMatch) {
      title = decodeLabel(titleMatch[1]);
      continue;
    }
    const fields = splitFields(line);
    if (fields.length < 3) {
      continue;
    }
    const value = Number.parseFloat(fields[2]);
    if (!Number.isFinite(value) || value <= 0) {
      continue;
    }
    links.push({ from: unquote(fields[0]), to: unquote(fields[1]), value });
  }

  return {
    kind: "sankey",
    ...(title === undefined ? {} : { title }),
    links
  };
}

/**
 * Split a comma-separated list, respecting quotes.
 *
 * A Sankey node may legitimately be called `Agriculture, forestry`, and an axis label may
 * contain a comma too; splitting on the character alone turns one field into two.
 */
function splitFields(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  let quote = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') {
      quote = !quote;
      continue;
    }
    if (!quote && text[i] === ",") {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(text.slice(start).trim());
  return out.filter(field => field !== "");
}
