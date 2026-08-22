/**
 * The `packet`, `kanban`, `radar` and `architecture` parsers.
 *
 * Four small languages with nothing in common but their size. Each is read on its own
 * terms: a packet field is a bit range, a kanban card is an indented list item, a radar
 * axis is a named value, an architecture service is a declaration with an icon.
 */

import { decodeLabel, splitStatements, unquote, linesOf } from "@mermaid/parse/lex";
import type {
  ArchitectureDiagram,
  ArchitectureEdge,
  ArchitectureNode,
  KanbanCard,
  KanbanColumn,
  KanbanDiagram,
  PacketDiagram,
  PacketField,
  RadarDiagram,
  RadarSeries
} from "@mermaid/types";

/** Parse a packet diagram. */
export function parsePacket(source: string): PacketDiagram {
  const fields: PacketField[] = [];
  let title: string | undefined;
  let bitsPerRow = 32;

  for (const text of splitStatements(source)) {
    if (/^packet(?:-beta)?\s*$/i.test(text)) {
      continue;
    }
    const titleMatch = /^title\s+(.+)$/i.exec(text);
    if (titleMatch) {
      title = decodeLabel(titleMatch[1]);
      continue;
    }
    const bits = /^bits-per-row\s*:?\s*(\d+)$/i.exec(text);
    if (bits) {
      bitsPerRow = Math.max(1, Number(bits[1]));
      continue;
    }

    // `0-15: "Source port"` or `16: "Flag"`
    const field = /^(\d+)(?:\s*-\s*(\d+))?\s*:\s*(.+)$/.exec(text);
    if (field) {
      const start = Number(field[1]);
      const end = field[2] === undefined ? start : Number(field[2]);
      fields.push({
        start: Math.min(start, end),
        end: Math.max(start, end),
        label: decodeLabel(field[3])
      });
    }
  }

  return {
    kind: "packet",
    ...(title === undefined ? {} : { title }),
    bitsPerRow,
    fields
  };
}

/**
 * Parse a kanban board.
 *
 * Indentation carries the structure, as it does in a mind map: a column is written at the
 * outer level and its cards beneath it.
 */
export function parseKanban(source: string): KanbanDiagram {
  const columns: Array<{ id: string; title: string; cards: KanbanCard[] }> = [];
  let title: string | undefined;
  let columnIndent: number | undefined;

  for (const raw of linesOf(source)) {
    // Already comment-free: `linesOf` applies the shared, quote-aware rule.
    const line = raw;
    if (line.trim() === "") {
      continue;
    }
    const body = line.trim();
    if (/^kanban\b/i.test(body)) {
      continue;
    }
    const titleMatch = /^title\s+(.+)$/i.exec(body);
    if (titleMatch) {
      title = decodeLabel(titleMatch[1]);
      continue;
    }

    const indent = line.length - line.trimStart().length;
    const parsed = readKanbanItem(body);
    if (columnIndent === undefined || indent <= columnIndent) {
      columnIndent = indent;
      columns.push({ id: parsed.id, title: parsed.text, cards: [] });
      continue;
    }
    const column = columns.at(-1);
    if (column) {
      column.cards.push({
        id: parsed.id,
        text: parsed.text,
        ...(parsed.assigned === undefined ? {} : { assigned: parsed.assigned }),
        ...(parsed.priority === undefined ? {} : { priority: parsed.priority }),
        ...(parsed.ticket === undefined ? {} : { ticket: parsed.ticket })
      });
    }
  }

  return {
    kind: "kanban",
    ...(title === undefined ? {} : { title }),
    columns: columns as readonly KanbanColumn[]
  };
}

/** `id[Text]@{ assigned: "x", priority: "High" }`, or just `Text`. */
function readKanbanItem(body: string): {
  id: string;
  text: string;
  assigned?: string;
  priority?: string;
  ticket?: string;
} {
  const meta: Record<string, string> = {};
  let head = body;
  const at = body.indexOf("@{");
  if (at !== -1) {
    head = body.slice(0, at).trim();
    for (const match of body.slice(at + 2).matchAll(/(\w+)\s*:\s*("([^"]*)"|[^,}]+)/g)) {
      meta[match[1].toLowerCase()] = decodeLabel(match[3] ?? match[2]);
    }
  }
  const bracket = /^([^[\s]+)\s*\[(.*)\]$/.exec(head);
  const id = bracket ? bracket[1] : head;
  const text = bracket ? decodeLabel(bracket[2]) : decodeLabel(head);
  return {
    id: unquote(id),
    text,
    ...(meta.assigned === undefined ? {} : { assigned: meta.assigned }),
    ...(meta.priority === undefined ? {} : { priority: meta.priority }),
    ...(meta.ticket === undefined ? {} : { ticket: meta.ticket })
  };
}

/** Parse a radar chart. */
export function parseRadar(source: string): RadarDiagram {
  const axes: string[] = [];
  const series: RadarSeries[] = [];
  let title: string | undefined;
  let max: number | undefined;

  for (const text of splitStatements(source)) {
    if (/^radar(?:-beta)?\s*$/i.test(text)) {
      continue;
    }
    const titleMatch = /^title\s+(.+)$/i.exec(text);
    if (titleMatch) {
      title = decodeLabel(titleMatch[1]);
      continue;
    }
    const maxMatch = /^max\s+([\d.]+)$/i.exec(text);
    if (maxMatch) {
      const value = Number.parseFloat(maxMatch[1]);
      if (Number.isFinite(value)) {
        max = value;
      }
      continue;
    }
    const axisMatch = /^axis\s+(.+)$/i.exec(text);
    if (axisMatch) {
      for (const entry of axisMatch[1].split(",")) {
        // `axis a["Label"], b["Other"]` — the display name wins when both are given.
        const named = /^\s*\S+\s*\[(.*)\]\s*$/.exec(entry);
        axes.push(decodeLabel(named ? named[1] : entry));
      }
      continue;
    }
    const curve = /^curve\s+(.+)$/i.exec(text);
    if (curve) {
      const body = curve[1];
      const bracket = /\{(.*)\}/.exec(body) ?? /\[(.*)\]/.exec(body);
      if (!bracket) {
        continue;
      }
      const named = /^\s*\S+\s*\[(.*?)\]/.exec(body);
      const label = decodeLabel(named ? named[1] : body.replace(/[{[].*/, ""));
      const values = bracket[1]
        .split(",")
        .map(part => Number.parseFloat(part.replace(/^[^:]*:/, "")))
        .filter(value => Number.isFinite(value));
      series.push({ label: label === "" ? `series ${series.length + 1}` : label, values });
    }
  }

  return {
    kind: "radar",
    ...(title === undefined ? {} : { title }),
    axes,
    series,
    ...(max === undefined ? {} : { max })
  };
}

/** Parse an architecture diagram. */
export function parseArchitecture(source: string): ArchitectureDiagram {
  const nodes: ArchitectureNode[] = [];
  const edges: ArchitectureEdge[] = [];
  let title: string | undefined;

  for (const text of splitStatements(source)) {
    if (/^architecture(?:-beta)?\s*$/i.test(text)) {
      continue;
    }
    const titleMatch = /^title\s+(.+)$/i.exec(text);
    if (titleMatch) {
      title = decodeLabel(titleMatch[1]);
      continue;
    }

    // `group api(cloud)[API]` and `service db(database)[Database] in api`
    const declaration =
      /^(group|service|junction)\s+(\S+?)(?:\((.*?)\))?(?:\[(.*?)\])?(?:\s+in\s+(\S+))?$/i.exec(
        text
      );
    if (declaration) {
      const id = declaration[2];
      nodes.push({
        id,
        label: declaration[4] === undefined ? id : decodeLabel(declaration[4]),
        ...(declaration[3] === undefined ? {} : { icon: declaration[3] }),
        ...(declaration[5] === undefined ? {} : { group: declaration[5] }),
        isGroup: declaration[1].toLowerCase() === "group"
      });
      continue;
    }

    // `db:R --> L:server`
    const edge = /^(\S+?)(?::([LRTB]))?\s*(--+>?|<--+>?)\s*(?:([LRTB]):)?(\S+)$/.exec(text);
    if (edge) {
      edges.push({
        from: edge[1],
        to: edge[5],
        ...(edge[2] === undefined ? {} : { fromSide: edge[2] }),
        ...(edge[4] === undefined ? {} : { toSide: edge[4] }),
        arrow: edge[3].includes(">")
      });
    }
  }

  return {
    kind: "architecture",
    ...(title === undefined ? {} : { title }),
    nodes,
    edges
  };
}
