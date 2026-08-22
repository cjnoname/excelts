/**
 * The `requirementDiagram`, `C4` and `block` parsers.
 *
 * All three describe a set of boxes and the arrows between them, which is why they can be
 * laid out by the same passes as a flowchart. What each spends its own grammar on is the
 * *metadata*: a requirement's risk and verification method, a C4 element's technology, a
 * block's column span.
 */

import { decodeLabel, splitStatements, unquote } from "@mermaid/parse/lex";
import type {
  BlockCell,
  BlockDiagram,
  C4Boundary,
  C4Diagram,
  C4Element,
  C4Relation,
  FlowEdge,
  FlowShape,
  Requirement,
  RequirementDiagram,
  RequirementElement,
  RequirementLink
} from "@mermaid/types";

const REQUIREMENT_TYPES = [
  "requirement",
  "functionalRequirement",
  "interfaceRequirement",
  "performanceRequirement",
  "physicalRequirement",
  "designConstraint"
];

const RELATION_VERBS = [
  "satisfies",
  "traces",
  "contains",
  "copies",
  "derives",
  "verifies",
  "refines"
];

/** Parse a requirement diagram. */
export function parseRequirement(source: string): RequirementDiagram {
  const requirements: Requirement[] = [];
  const elements: RequirementElement[] = [];
  const links: RequirementLink[] = [];
  let title: string | undefined;

  /** The block currently open, and the fields collected for it. */
  let open:
    | { kind: "requirement"; id: string; type: string; fields: Map<string, string> }
    | { kind: "element"; id: string; fields: Map<string, string> }
    | undefined;

  const close = (): void => {
    if (!open) {
      return;
    }
    if (open.kind === "requirement") {
      requirements.push({
        id: open.id,
        name: open.id,
        type: open.type,
        ...(open.fields.has("text") ? { text: open.fields.get("text")! } : {}),
        ...(open.fields.has("risk") ? { risk: open.fields.get("risk")! } : {}),
        ...(open.fields.has("verifymethod")
          ? { verifyMethod: open.fields.get("verifymethod")! }
          : {})
      });
    } else {
      elements.push({
        id: open.id,
        name: open.id,
        ...(open.fields.has("type") ? { type: open.fields.get("type")! } : {}),
        ...(open.fields.has("docref") ? { docRef: open.fields.get("docref")! } : {})
      });
    }
    open = undefined;
  };

  for (const text of splitStatements(source)) {
    if (/^requirementDiagram\b/i.test(text)) {
      continue;
    }
    if (text === "}") {
      close();
      continue;
    }

    if (open) {
      const field = /^(\w+)\s*:\s*(.*)$/.exec(text);
      if (field) {
        open.fields.set(field[1].toLowerCase(), decodeLabel(field[2]));
      }
      continue;
    }

    const titleMatch = /^title\s+(.+)$/i.exec(text);
    if (titleMatch) {
      title = decodeLabel(titleMatch[1]);
      continue;
    }

    // The brace may open a block or hold the whole thing on one line; the inline form is
    // what a short requirement is usually written as, and reading it as a block that never
    // closes loses every field it declared.
    const requirement = new RegExp(
      `^(${REQUIREMENT_TYPES.join("|")})\\s+(\\S+)\\s*\\{(.*)$`,
      "i"
    ).exec(text);
    if (requirement) {
      open = {
        kind: "requirement",
        id: unquote(requirement[2]),
        type: requirement[1],
        fields: new Map()
      };
      absorbInline(open.fields, requirement[3]);
      if (requirement[3].trimEnd().endsWith("}")) {
        close();
      }
      continue;
    }
    const element = /^element\s+(\S+)\s*\{(.*)$/i.exec(text);
    if (element) {
      open = { kind: "element", id: unquote(element[1]), fields: new Map() };
      absorbInline(open.fields, element[2]);
      if (element[2].trimEnd().endsWith("}")) {
        close();
      }
      continue;
    }

    // `A - satisfies -> B` and `B <- traces - A`
    const forward = new RegExp(
      `^(\\S+)\\s*-\\s*(${RELATION_VERBS.join("|")})\\s*->\\s*(\\S+)$`,
      "i"
    ).exec(text);
    if (forward) {
      links.push({ from: forward[1], to: forward[3], verb: forward[2].toLowerCase() });
      continue;
    }
    const backward = new RegExp(
      `^(\\S+)\\s*<-\\s*(${RELATION_VERBS.join("|")})\\s*-\\s*(\\S+)$`,
      "i"
    ).exec(text);
    if (backward) {
      links.push({ from: backward[3], to: backward[1], verb: backward[2].toLowerCase() });
    }
  }
  close();

  return {
    kind: "requirement",
    ...(title === undefined ? {} : { title }),
    requirements,
    elements,
    links
  };
}

/**
 * Take the fields an inline block declared: `requirement a { text: x risk: high }`.
 *
 * Split on the key rather than on whitespace, because a value is a phrase and splitting a
 * phrase would make every word after the first into a field of its own.
 */
function absorbInline(fields: Map<string, string>, body: string): void {
  const inner = body.replace(/\}\s*$/, "");
  // A quoted value is taken whole; an unquoted one runs to the next `key:`. Reading only the
  // unquoted form — `[^:]*?` — truncated at the first colon, so `text: "a: b"` matched nothing
  // and the field vanished.
  const matches = [...inner.matchAll(/(\w+)\s*:\s*(?:"([^"]*)"|([^:]*?)(?=\s+\w+\s*:|$))/g)];
  for (const match of matches) {
    fields.set(match[1].toLowerCase(), decodeLabel(match[2] ?? match[3] ?? ""));
  }
}

/** Parse a C4 diagram. */
export function parseC4(source: string): C4Diagram {
  const elements: C4Element[] = [];
  const boundaries: C4Boundary[] = [];
  const relations: C4Relation[] = [];
  let title: string | undefined;
  const open: string[] = [];

  for (const text of splitStatements(source)) {
    if (/^C4(Context|Container|Component|Dynamic|Deployment)\b/i.test(text)) {
      continue;
    }
    if (text === "}") {
      open.pop();
      continue;
    }

    const titleMatch = /^title\s+(.+)$/i.exec(text);
    if (titleMatch) {
      title = decodeLabel(titleMatch[1]);
      continue;
    }

    const boundary = /^(\w*Boundary)\s*\((.*?)\)\s*\{?$/i.exec(text);
    if (boundary) {
      const args = splitArgs(boundary[2]);
      const id = args[0] ?? `boundary${boundaries.length}`;
      boundaries.push({ id, label: args[1] ?? id, type: boundary[1] });
      open.push(id);
      continue;
    }

    // `Person(id, "Label", "Description")` and its many siblings.
    const element =
      /^(Person(?:_Ext)?|System(?:_Ext|Db|Queue)?|Container(?:_Ext|Db|Queue)?|Component(?:_Ext|Db|Queue)?|Node|ContainerDb|SystemDb)\s*\((.*)\)$/i.exec(
        text
      );
    if (element) {
      const args = splitArgs(element[2]);
      const id = args[0];
      if (id === undefined) {
        continue;
      }
      const container = /^Container|^Component|^Node/i.test(element[1]);
      elements.push({
        id,
        type: element[1],
        label: args[1] ?? id,
        // A container names its technology before its description; a person does not.
        ...(container && args[2] !== undefined ? { technology: args[2] } : {}),
        ...(container
          ? args[3] !== undefined
            ? { description: args[3] }
            : {}
          : args[2] !== undefined
            ? { description: args[2] }
            : {}),
        ...(open.length === 0 ? {} : { boundary: open[open.length - 1] })
      });
      continue;
    }

    const relation =
      /^(Rel|BiRel|Rel_Back|Rel_[UDLR]|Rel_Up|Rel_Down|Rel_Left|Rel_Right)\s*\((.*)\)$/i.exec(text);
    if (relation) {
      const args = splitArgs(relation[2]);
      if (args.length < 2) {
        continue;
      }
      relations.push({
        from: args[0],
        to: args[1],
        ...(args[2] === undefined ? {} : { label: args[2] }),
        ...(args[3] === undefined ? {} : { technology: args[3] }),
        reversed: /_back$/i.test(relation[1])
      });
    }
  }

  return {
    kind: "c4",
    ...(title === undefined ? {} : { title }),
    elements,
    boundaries,
    relations
  };
}

/**
 * Split a C4 argument list.
 *
 * Quote-aware, because a description is a sentence and sentences contain commas.
 */
function splitArgs(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  let quote = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') {
      quote = !quote;
      continue;
    }
    if (!quote && text[i] === ",") {
      out.push(decodeLabel(text.slice(start, i)));
      start = i + 1;
    }
  }
  out.push(decodeLabel(text.slice(start)));
  // Positional, so an empty argument keeps its slot. Dropping empties shifted every argument
  // after one down a place: `Container(a, "API", "", "Handles requests")` read the description
  // as the technology and lost the description entirely.
  //
  // A trailing run of empties carries nothing and would only pad the tuple, so those do go —
  // which is what lets `Person(a, "Customer")` read as two arguments rather than four.
  while (out.length > 0 && out[out.length - 1] === "") {
    out.pop();
  }
  return out;
}

/** Bracket pairs a block cell may use, longest first. */
const BLOCK_SHAPES: ReadonlyArray<{ open: string; close: string; shape: FlowShape }> = [
  { open: "((", close: "))", shape: "circle" },
  { open: "([", close: "])", shape: "stadium" },
  { open: "[[", close: "]]", shape: "subroutine" },
  { open: "{{", close: "}}", shape: "hexagon" },
  { open: "[", close: "]", shape: "rect" },
  { open: "(", close: ")", shape: "round" },
  { open: "{", close: "}", shape: "rhombus" },
  { open: ">", close: "]", shape: "asymmetric" }
];

/** Parse a block diagram. */
export function parseBlock(source: string): BlockDiagram {
  const cells: BlockCell[] = [];
  const edges: FlowEdge[] = [];
  let title: string | undefined;
  let columns = 0;

  for (const text of splitStatements(source)) {
    if (/^block(?:-beta)?\s*$/i.test(text)) {
      continue;
    }
    const titleMatch = /^title\s+(.+)$/i.exec(text);
    if (titleMatch) {
      title = decodeLabel(titleMatch[1]);
      continue;
    }
    const columnsMatch = /^columns\s+(\d+)$/i.exec(text);
    if (columnsMatch) {
      columns = Number(columnsMatch[1]);
      continue;
    }
    if (/^(block|end|style|classDef|class)\b/i.test(text)) {
      continue;
    }

    // An arrow line declares a connection rather than a cell.
    const arrow = /^(\S+)\s*(-{2,}>|-{2,})\s*(\S+)$/.exec(text);
    if (arrow) {
      edges.push({
        from: arrow[1],
        to: arrow[3],
        stroke: "solid",
        startEnd: "none",
        endEnd: arrow[2].endsWith(">") ? "arrow" : "none",
        minRankSpan: 1
      });
      continue;
    }

    for (const token of splitCells(text)) {
      const cell = readCell(token, cells.length);
      if (cell) {
        cells.push(cell);
      }
    }
  }

  return {
    kind: "block",
    ...(title === undefined ? {} : { title }),
    // Without a declaration every cell gets its own column, which is Mermaid's default.
    columns: columns > 0 ? columns : Math.max(1, cells.length),
    cells,
    edges
  };
}

/**
 * Split a row into cells.
 *
 * Bracket- and quote-aware, because a label is prose: `A["Long label"]` split on whitespace
 * became `A["Long` and `label"]`, which parsed as two unrelated boxes and lost the label
 * the author wrote.
 */
function splitCells(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      quote = !quote;
      continue;
    }
    if (quote) {
      continue;
    }
    if (ch === "[" || ch === "(" || ch === "{" || ch === "<") {
      depth++;
    } else if (ch === "]" || ch === ")" || ch === "}" || ch === ">") {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0 && /\s/.test(ch)) {
      if (i > start) {
        out.push(text.slice(start, i));
      }
      start = i + 1;
    }
  }
  if (start < text.length) {
    out.push(text.slice(start));
  }
  return out.filter(part => part.trim() !== "");
}

/** `id["label"]:2`, `space:3`, or a bare id. */
function readCell(token: string, ordinal: number): BlockCell | undefined {
  const spanMatch = /^(.*?):(\d+)$/.exec(token);
  const body = spanMatch ? spanMatch[1] : token;
  const span = spanMatch ? Math.max(1, Number(spanMatch[2])) : 1;

  if (/^space$/i.test(body)) {
    return { id: `space${ordinal}`, label: "", shape: "rect", span, spacer: true };
  }
  if (body === "") {
    return undefined;
  }

  const idMatch = /^[A-Za-z0-9_\u00c0-\uffff][A-Za-z0-9_\-.\u00c0-\uffff]*/.exec(body);
  if (!idMatch) {
    return undefined;
  }
  const id = idMatch[0];
  const rest = body.slice(id.length);
  for (const candidate of BLOCK_SHAPES) {
    if (rest.startsWith(candidate.open) && rest.endsWith(candidate.close)) {
      const inner = rest.slice(candidate.open.length, rest.length - candidate.close.length);
      return {
        id,
        label: decodeLabel(inner),
        shape: candidate.shape,
        span,
        spacer: false
      };
    }
  }
  return { id, label: id, shape: "rect", span, spacer: false };
}
