/**
 * The flowchart parser.
 *
 * ## Shape of the problem
 *
 * A flowchart statement is a chain: `A[Start] --> B{Ok?} -->|yes| C(Done)`. The chain
 * alternates node references and links, and both halves are written with punctuation
 * rather than keywords — `[]`, `{}`, `(())` pick an outline; `-->`, `-.->`, `==>` pick a
 * stroke and an arrowhead. So the parser scans rather than tokenises: it walks the
 * statement, taking a node reference or a link at each step.
 *
 * Scanning matters for correctness, not just convenience. A node's text can contain the
 * characters that delimit links — `A["a --> b"]` is one node whose label mentions an
 * arrow — so link detection has to happen *outside* a label, which a scanner knows and a
 * regular expression over the whole line does not.
 *
 * ## What a node reference looks like
 *
 * An id, optionally followed by a bracketed label, optionally followed by `:::class`.
 * Bare `A` is a node too: referencing an id declares it. The longest bracket pair wins,
 * because `[[` and `[` both open a label and only the length distinguishes a subroutine
 * from a box.
 */

import { decodeLabel, indexOfUnquoted, splitStatements } from "@mermaid/parse/lex";
import type {
  ClassDef,
  EdgeEnd,
  EdgeStroke,
  FlowDirection,
  FlowEdge,
  FlowNode,
  FlowShape,
  FlowSubgraph,
  FlowchartDiagram
} from "@mermaid/types";

/**
 * Bracket pairs that open a node label, longest first.
 *
 * Order is load-bearing: `[[` must be tried before `[`, or a subroutine parses as a box
 * whose label starts with `[`.
 */
const SHAPES: ReadonlyArray<{ open: string; close: string; shape: FlowShape }> = [
  { open: "[[", close: "]]", shape: "subroutine" },
  { open: "[(", close: ")]", shape: "cylinder" },
  { open: "[/", close: "\\]", shape: "trapezoid" },
  { open: "[\\", close: "/]", shape: "trapezoidAlt" },
  { open: "[/", close: "/]", shape: "parallelogram" },
  { open: "[\\", close: "\\]", shape: "parallelogramAlt" },
  { open: "(((", close: ")))", shape: "doubleCircle" },
  { open: "((", close: "))", shape: "circle" },
  { open: "([", close: "])", shape: "stadium" },
  { open: "{{", close: "}}", shape: "hexagon" },
  { open: "[", close: "]", shape: "rect" },
  { open: "(", close: ")", shape: "round" },
  { open: "{", close: "}", shape: "rhombus" },
  { open: ">", close: "]", shape: "asymmetric" }
];

/** A node reference and how far it extended. */
interface NodeRef {
  readonly id: string;
  readonly text?: string;
  readonly shape?: FlowShape;
  readonly classes: readonly string[];
  readonly next: number;
}

/** A parsed link and how far it extended. */
interface LinkRef {
  readonly stroke: EdgeStroke;
  readonly startEnd: EdgeEnd;
  readonly endEnd: EdgeEnd;
  readonly label?: string;
  readonly minRankSpan: number;
  readonly next: number;
}

/** Parse a flowchart. The header line has already been recognised by the dispatcher. */
export function parseFlowchart(source: string, direction: FlowDirection): FlowchartDiagram {
  const nodes = new Map<string, { text?: string; shape?: FlowShape; classes: string[] }>();
  const edges: FlowEdge[] = [];
  const subgraphs: FlowSubgraph[] = [];
  const classDefs: ClassDef[] = [];
  let title: string | undefined;
  let dir = direction;

  /** Subgraph nesting: a node joins the innermost open group. */
  const open: Array<{ id: string; text: string; nodeIds: string[] }> = [];

  const touch = (id: string): { text?: string; shape?: FlowShape; classes: string[] } => {
    let entry = nodes.get(id);
    if (!entry) {
      entry = { classes: [] };
      nodes.set(id, entry);
    }
    // A node joins every group it sits inside, not just the innermost. A frame is drawn
    // around the extent of its members, so an outer subgraph whose members were only
    // recorded against the inner one came out empty — and an empty frame is a group the
    // picture claims does not contain what the source put in it.
    for (const group of open) {
      if (!group.nodeIds.includes(id)) {
        group.nodeIds.push(id);
      }
    }
    return entry;
  };

  for (const text of splitStatements(source)) {
    // The header names the diagram and its direction; the dispatcher has already read
    // both. Left in, `flowchart TD` parses as a node whose id is `flowchart`.
    if (/^(?:flowchart|graph)\b/i.test(text)) {
      continue;
    }

    // A second `direction` statement inside a subgraph is Mermaid's per-group override.
    // The group box is laid out with the diagram's own direction here, so the statement
    // is recognised and skipped rather than mis-parsed as a node called `direction`.
    const directionMatch = /^direction\s+(TB|TD|BT|LR|RL)$/i.exec(text);
    if (directionMatch) {
      if (open.length === 0) {
        dir = normaliseDirection(directionMatch[1]);
      }
      continue;
    }

    const titleMatch = /^title\s+(.+)$/i.exec(text);
    if (titleMatch) {
      title = decodeLabel(titleMatch[1]);
      continue;
    }

    const subgraphMatch = /^subgraph\s+(.+)$/i.exec(text);
    if (subgraphMatch) {
      open.push(parseSubgraphHeader(subgraphMatch[1], subgraphs.length + open.length));
      continue;
    }
    if (/^end$/i.test(text)) {
      const group = open.pop();
      if (group) {
        const parent = open.at(-1);
        subgraphs.push({
          id: group.id,
          text: group.text,
          nodeIds: [...group.nodeIds],
          ...(parent === undefined ? {} : { parent: parent.id })
        });
      }
      continue;
    }

    const classDefMatch = /^classDef\s+(\S+)\s+(.+)$/i.exec(text);
    if (classDefMatch) {
      for (const name of classDefMatch[1].split(",")) {
        classDefs.push(parseClassDef(name.trim(), classDefMatch[2]));
      }
      continue;
    }

    const classMatch = /^class\s+([^\s]+)\s+(\S+)$/i.exec(text);
    if (classMatch) {
      for (const id of classMatch[1].split(",")) {
        touch(id.trim()).classes.push(classMatch[2].trim());
      }
      continue;
    }

    // `style`, `linkStyle`, `click` and `accTitle` carry no geometry; recognise them so
    // they are not read as nodes named `style`.
    if (/^(style|linkStyle|click|accTitle|accDescr)\b/i.test(text)) {
      continue;
    }

    parseChain(text, touch, edges);
  }

  // An unterminated `subgraph` still describes a group; Mermaid errors, but dropping the
  // members would silently lose nodes the author did declare.
  while (open.length > 0) {
    const group = open.pop()!;
    const parent = open.at(-1);
    subgraphs.push({
      id: group.id,
      text: group.text,
      nodeIds: [...group.nodeIds],
      ...(parent === undefined ? {} : { parent: parent.id })
    });
  }

  const list: FlowNode[] = [...nodes].map(([id, entry]) => ({
    id,
    text: entry.text ?? id,
    shape: entry.shape ?? "rect",
    classes: entry.classes
  }));

  return {
    kind: "flowchart",
    direction: dir,
    ...(title === undefined ? {} : { title }),
    nodes: list,
    edges,
    subgraphs,
    classDefs
  };
}

/** `TD` is Mermaid's spelling of `TB`; everything else is already canonical. */
export function normaliseDirection(raw: string): FlowDirection {
  const upper = raw.toUpperCase();
  return upper === "TD" ? "TB" : (upper as FlowDirection);
}

/** `subgraph id [Title]`, `subgraph Title`, or `subgraph id["Title"]`. */
function parseSubgraphHeader(
  rest: string,
  ordinal: number
): { id: string; text: string; nodeIds: string[] } {
  const bracketed = /^(\S+)\s*\[(.*)\]$/.exec(rest.trim());
  if (bracketed) {
    return { id: bracketed[1], text: decodeLabel(bracketed[2]), nodeIds: [] };
  }
  const text = decodeLabel(rest);
  // A title-only group still needs an identity for a caller to refer to it by.
  return { id: text === "" ? `subgraph${ordinal}` : text, text, nodeIds: [] };
}

/** `classDef name fill:#f9f,stroke:#333,stroke-width:2px`. */
function parseClassDef(name: string, body: string): ClassDef {
  const def: {
    -readonly [K in keyof ClassDef]: ClassDef[K];
  } = { name };
  for (const pair of body.split(",")) {
    const [rawKey, ...rest] = pair.split(":");
    if (rest.length === 0) {
      continue;
    }
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(":").trim();
    if (key === "fill") {
      def.fill = value;
    } else if (key === "stroke") {
      def.stroke = value;
    } else if (key === "color") {
      def.color = value;
    } else if (key === "stroke-width") {
      const width = Number.parseFloat(value);
      if (Number.isFinite(width)) {
        def.strokeWidth = width;
      }
    } else if (key === "stroke-dasharray") {
      const parts = value
        .split(/[\s,]+/)
        .map(part => Number.parseFloat(part))
        .filter(part => Number.isFinite(part));
      if (parts.length > 0) {
        def.strokeDasharray = parts;
      }
    }
  }
  return def;
}

/** Walk one `A --> B --> C` chain, declaring nodes and recording edges. */
function parseChain(
  text: string,
  touch: (id: string) => { text?: string; shape?: FlowShape; classes: string[] },
  edges: FlowEdge[]
): void {
  let index = skipSpace(text, 0);
  // An edge can only be built once the node *after* the link is known, so the group just
  // read and the link leaving it are carried forward together. Threaded rather than held
  // in module state: a parser that remembers anything between calls cannot be re-entered,
  // and this one is called once per statement.
  let pending: { from: readonly string[]; link: LinkRef } | undefined;

  while (index < text.length) {
    const group = readNodeGroup(text, index);
    if (!group) {
      return;
    }
    for (const ref of group.refs) {
      const entry = touch(ref.id);
      if (ref.text !== undefined) {
        entry.text = ref.text;
      }
      if (ref.shape !== undefined) {
        entry.shape = ref.shape;
      }
      for (const cls of ref.classes) {
        if (!entry.classes.includes(cls)) {
          entry.classes.push(cls);
        }
      }
    }
    const targets = group.refs.map(ref => ref.id);
    if (pending) {
      for (const from of pending.from) {
        for (const to of targets) {
          edges.push(buildEdge(from, to, pending.link));
        }
      }
    }
    index = skipSpace(text, group.next);

    const link = readLink(text, index);
    if (!link) {
      // Ended on a node, which is the ordinary case.
      return;
    }
    pending = { from: targets, link };
    index = skipSpace(text, link.next);
  }
  // A chain may also end on a link with no destination (`A -->`), which declares nothing
  // beyond the nodes already recorded.
}

function buildEdge(from: string, to: string, link: LinkRef): FlowEdge {
  return {
    from,
    to,
    stroke: link.stroke,
    startEnd: link.startEnd,
    endEnd: link.endEnd,
    ...(link.label === undefined ? {} : { label: link.label }),
    minRankSpan: link.minRankSpan
  };
}

/**
 * Read `A & B & C` — Mermaid's shorthand for repeating a link across several nodes.
 */
function readNodeGroup(text: string, start: number): { refs: NodeRef[]; next: number } | undefined {
  const refs: NodeRef[] = [];
  let index = start;
  for (;;) {
    const ref = readNodeRef(text, index);
    if (!ref) {
      return refs.length > 0 ? { refs, next: index } : undefined;
    }
    refs.push(ref);
    index = skipSpace(text, ref.next);
    if (text[index] !== "&") {
      return { refs, next: index };
    }
    index = skipSpace(text, index + 1);
  }
}

/** Read one node reference: an id, an optional bracketed label, an optional `:::class`. */
function readNodeRef(text: string, start: number): NodeRef | undefined {
  const index = skipSpace(text, start);
  // A hyphen may sit inside an identifier, but not where it starts a link: `a-b` is one
  // node and `a-->b` is two. Stopping before a run that leads into `>`, `-`, `.` or `=`
  // keeps both readings — without it `n1-->n2` parsed as a single node called `n1--`, and
  // the arrow disappeared along with the edge it declared.
  const idMatch = /^[A-Za-z0-9_\u00c0-\uffff](?:[A-Za-z0-9_.\u00c0-\uffff]|-(?![->.=]))*/.exec(
    text.slice(index)
  );
  if (!idMatch) {
    return undefined;
  }
  const id = idMatch[0];
  let cursor = index + id.length;

  // The nearest closer wins, not the first one listed. One opener can end several ways —
  // `[/…/]` is a parallelogram and `[/…\]` a trapezoid — so trying them in table order
  // let `[/a/] --> b[\c\]` match the *second* node's `\]` and swallow the arrow. Among
  // candidates that close at the same place the longest opener wins, which is what keeps
  // `[[sub]]` from reading as a box whose label starts with `[`.
  let label: { text: string; shape: FlowShape; end: number; openLength: number } | undefined;
  for (const candidate of SHAPES) {
    if (!text.startsWith(candidate.open, cursor)) {
      continue;
    }
    const close = indexOfUnquoted(text, candidate.close, cursor + candidate.open.length);
    if (close === -1) {
      continue;
    }
    const beatsOnDistance = label === undefined || close < label.end - label.openLength;
    const tiesButOpensLonger =
      label !== undefined &&
      close === label.end - label.openLength &&
      candidate.open.length > label.openLength;
    if (beatsOnDistance || tiesButOpensLonger) {
      label = {
        text: decodeLabel(text.slice(cursor + candidate.open.length, close)),
        shape: candidate.shape,
        end: close + candidate.close.length,
        openLength: candidate.close.length
      };
    }
  }
  if (label) {
    cursor = label.end;
  }

  const classes: string[] = [];
  while (text.startsWith(":::", cursor)) {
    const rest = /^[A-Za-z0-9_-]+/.exec(text.slice(cursor + 3));
    if (!rest) {
      break;
    }
    classes.push(rest[0]);
    cursor += 3 + rest[0].length;
  }

  return {
    id,
    ...(label === undefined ? {} : { text: label.text, shape: label.shape }),
    classes,
    next: cursor
  };
}

/**
 * Read a link.
 *
 * The three strokes are written with different fill characters — `-` solid, `.` dotted,
 * `=` thick — and each can carry a decoration at either end and a label in the middle
 * (`-- text -->`) or after (`-->|text|`). Length is meaningful: every dash past the
 * minimum asks for one more rank of separation.
 */
function readLink(text: string, start: number): LinkRef | undefined {
  let index = skipSpace(text, start);
  const startEnd = readEnd(text, index, true);
  index += startEnd.length;

  // `-.-`, `-..-`, `-...-` … each extra dot is one more rank, so the whole dotted run has
  // to be taken in one bite; matching a single dot left `-..->` unparsed entirely.
  const body = /^(-\.+-|-+|=+)/.exec(text.slice(index));
  if (!body) {
    return undefined;
  }
  const raw = body[0];
  const stroke: EdgeStroke = raw.includes(".") ? "dotted" : raw.startsWith("=") ? "thick" : "solid";
  index += raw.length;

  // `-- text --> B`: the label sits between two halves of the link.
  let label: string | undefined;
  const inline = /^([^-=>|][^-=]*?)\s*(-{2,}>|-{2,}|={2,}>|={2,}|-\.->|-\.-)/.exec(
    text.slice(index)
  );
  if (stroke !== "dotted" && inline && !text.slice(index).startsWith(">")) {
    label = decodeLabel(inline[1]);
    index += inline[0].length - inline[2].length;
    const tail = /^(-{2,}>|-{2,}|={2,}>|={2,})/.exec(text.slice(index));
    if (tail) {
      index += tail[0].length;
      const end = readEndFromTail(tail[0]);
      const span = rankSpan(raw, tail[0], end === "arrow", true);
      return finishLink(text, index, stroke, startEnd.end, end, label, span);
    }
  }

  const end = readEnd(text, index, false);
  index += end.length;
  return finishLink(
    text,
    index,
    stroke,
    startEnd.end,
    end.end,
    label,
    rankSpan(raw, "", end.end === "arrow", false)
  );
}

/** `-->|label|` — the label follows the whole link. */
function finishLink(
  text: string,
  start: number,
  stroke: EdgeStroke,
  startEnd: EdgeEnd,
  endEnd: EdgeEnd,
  label: string | undefined,
  minRankSpan: number
): LinkRef {
  let index = start;
  let text_ = label;
  if (text[index] === "|") {
    const close = text.indexOf("|", index + 1);
    if (close !== -1) {
      text_ = decodeLabel(text.slice(index + 1, close));
      index = close + 1;
    }
  }
  return {
    stroke,
    startEnd,
    endEnd,
    ...(text_ === undefined || text_ === "" ? {} : { label: text_ }),
    minRankSpan,
    next: index
  };
}

/** A decoration at one end of a link. */
function readEnd(text: string, index: number, atStart: boolean): { end: EdgeEnd; length: number } {
  const ch = text[index];
  if (atStart) {
    // Only an arrow can open a link (`<-->`); `o` and `x` at the start would be a node id.
    return ch === "<" ? { end: "arrow", length: 1 } : { end: "none", length: 0 };
  }
  if (ch === ">") {
    return { end: "arrow", length: 1 };
  }
  if (ch === "o") {
    return { end: "circle", length: 1 };
  }
  if (ch === "x") {
    return { end: "cross", length: 1 };
  }
  return { end: "none", length: 0 };
}

function readEndFromTail(tail: string): EdgeEnd {
  return tail.endsWith(">") ? "arrow" : "none";
}

/**
 * How many ranks a link asks for.
 *
 * Mermaid reads a longer link as a request for more separation, which is how an author
 * keeps two branches of unequal depth level with each other. The base length differs per
 * form, because the arrowhead occupies a character the open form spends on the shaft:
 * `-->` and `---` are both the minimum, and each character past it adds a rank. A dotted
 * link counts its dots (`-.->`, `-..->`), and splitting a link around an inline label
 * (`-- text -->`) adds one shaft character on each side that the author did not ask for.
 */
function rankSpan(head: string, tail: string, hasArrow: boolean, split: boolean): number {
  if (head.includes(".")) {
    // `-.->` is one, `-..->` is two: the dots are the length.
    const dots = (head + tail).replace(/[^.]/g, "").length;
    return Math.max(1, dots);
  }
  const shaft = (head + tail).replace(/[^-=]/g, "").length;
  const base = (hasArrow ? 2 : 3) + (split ? 2 : 0);
  return Math.max(1, shaft - base + 1);
}

function skipSpace(text: string, index: number): number {
  let i = index;
  while (i < text.length && (text[i] === " " || text[i] === "\t")) {
    i++;
  }
  return i;
}
