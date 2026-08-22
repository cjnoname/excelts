/**
 * The `classDiagram` parser.
 *
 * Members arrive two ways — inside `Class { … }` braces or one at a time as
 * `Class : +field` — and both have to reach the same box, so the parser keeps a map keyed
 * by class name rather than building boxes as it meets them.
 *
 * A relationship's marks live at its *ends*, and which end depends on how it was written:
 * `A <|-- B` says B inherits A, while `A --|> B` says A inherits B. The arrow is read as a
 * whole for that reason, and normalised so the renderer only ever draws one direction.
 */

import { normaliseDirection } from "@mermaid/parse/flowchart";
import { decodeLabel, indexOfUnquoted, splitStatements, unquote } from "@mermaid/parse/lex";
import type {
  ClassBox,
  ClassDiagram,
  ClassLink,
  ClassMember,
  ClassRelation,
  FlowDirection,
  Visibility
} from "@mermaid/types";

/** The relationship each arrow spells, and whether it points backwards. */
const ARROWS: ReadonlyArray<{ token: string; relation: ClassRelation; reversed: boolean }> = [
  { token: "<|--", relation: "inheritance", reversed: true },
  { token: "--|>", relation: "inheritance", reversed: false },
  { token: "<|..", relation: "realization", reversed: true },
  { token: "..|>", relation: "realization", reversed: false },
  { token: "*--", relation: "composition", reversed: true },
  { token: "--*", relation: "composition", reversed: false },
  { token: "o--", relation: "aggregation", reversed: true },
  { token: "--o", relation: "aggregation", reversed: false },
  { token: "<--", relation: "association", reversed: true },
  { token: "-->", relation: "association", reversed: false },
  { token: "<..", relation: "dependency", reversed: true },
  { token: "..>", relation: "dependency", reversed: false },
  { token: "--", relation: "link", reversed: false },
  { token: "..", relation: "link", reversed: false }
];

/** Parse a class diagram. */
export function parseClass(source: string, direction: FlowDirection): ClassDiagram {
  const classes = new Map<string, { name: string; stereotype?: string; members: ClassMember[] }>();
  const links: ClassLink[] = [];
  let title: string | undefined;
  let dir = direction;
  /** The class whose `{ … }` block is currently open. */
  let openClass: string | undefined;

  const touch = (name: string): { name: string; stereotype?: string; members: ClassMember[] } => {
    const id = unquote(name.trim()).replace(/~[^~]*~/g, "");
    let entry = classes.get(id);
    if (!entry) {
      entry = { name: id, members: [] };
      classes.set(id, entry);
    }
    return entry;
  };

  for (const text of splitStatements(source)) {
    if (/^classDiagram(-v2)?\b/i.test(text)) {
      continue;
    }

    if (openClass !== undefined) {
      if (text === "}") {
        openClass = undefined;
        continue;
      }
      // A stereotype is written inside the braces as often as beside them, and reading it
      // as a member would put `«interface»` in the field list instead of the header.
      const inlineStereotype = /^<<\s*(.+?)\s*>>$/.exec(text);
      if (inlineStereotype) {
        touch(openClass).stereotype = inlineStereotype[1];
        continue;
      }
      const member = readMember(text);
      if (member) {
        touch(openClass).members.push(member);
      }
      continue;
    }

    const directionMatch = /^direction\s+(TB|TD|BT|LR|RL)$/i.exec(text);
    if (directionMatch) {
      dir = normaliseDirection(directionMatch[1]);
      continue;
    }
    const titleMatch = /^title\s+(.+)$/i.exec(text);
    if (titleMatch) {
      title = decodeLabel(titleMatch[1]);
      continue;
    }

    const blockStart = /^class\s+([^\s{]+)\s*\{$/i.exec(text);
    if (blockStart) {
      touch(blockStart[1]);
      openClass = unquote(blockStart[1]).replace(/~[^~]*~/g, "");
      continue;
    }
    const bare = /^class\s+([^\s{:]+)\s*$/i.exec(text);
    if (bare) {
      touch(bare[1]);
      continue;
    }

    const link = readLink(text);
    if (link) {
      touch(link.from);
      touch(link.to);
      links.push(link);
      continue;
    }

    // `Class : +member` and `Class : <<interface>>`
    const attached = /^([^\s:]+)\s*:\s*(.+)$/.exec(text);
    if (attached) {
      const entry = touch(attached[1]);
      const stereotype = /^<<\s*(.+?)\s*>>$/.exec(attached[2].trim());
      if (stereotype) {
        entry.stereotype = stereotype[1];
        continue;
      }
      const member = readMember(attached[2]);
      if (member) {
        entry.members.push(member);
      }
      continue;
    }

    if (/^(note|style|click|callback|link|cssClass|namespace|accTitle|accDescr)\b/i.test(text)) {
      continue;
    }
  }

  const boxes: ClassBox[] = [...classes].map(([id, entry]) => ({
    id,
    name: entry.name,
    ...(entry.stereotype === undefined ? {} : { stereotype: entry.stereotype }),
    members: entry.members
  }));

  return {
    kind: "class",
    direction: dir,
    ...(title === undefined ? {} : { title }),
    classes: boxes,
    links
  };
}

/**
 * `A <|-- B : label`, with optional multiplicities: `A "1" *-- "0..*" B`.
 */
function readLink(text: string): ClassLink | undefined {
  for (const arrow of ARROWS) {
    const at = indexOfUnquoted(text, arrow.token);
    if (at === -1) {
      continue;
    }
    const left = text.slice(0, at).trim();
    const rest = text.slice(at + arrow.token.length);
    const [rightRaw, labelRaw] = splitLabel(rest);

    const leftParts = splitCardinality(left, "end");
    const rightParts = splitCardinality(rightRaw.trim(), "start");
    if (leftParts.name === "" || rightParts.name === "") {
      return undefined;
    }

    // Normalise so the renderer always draws the mark at `to`.
    const from = arrow.reversed ? rightParts.name : leftParts.name;
    const to = arrow.reversed ? leftParts.name : rightParts.name;
    const fromCardinality = arrow.reversed ? rightParts.cardinality : leftParts.cardinality;
    const toCardinality = arrow.reversed ? leftParts.cardinality : rightParts.cardinality;

    return {
      from,
      to,
      relation: arrow.relation,
      ...(fromCardinality === undefined ? {} : { fromCardinality }),
      ...(toCardinality === undefined ? {} : { toCardinality }),
      ...(labelRaw === undefined || labelRaw === "" ? {} : { label: decodeLabel(labelRaw) })
    };
  }
  return undefined;
}

/**
 * Where an arrow token starts, ignoring one inside quotes.
 *
 * Longer tokens are tried first by {@link ARROWS}, so `<|--` is never read as `--`; this
 * only has to keep a multiplicity like `"1..*"` from looking like a link.
 */

/** Split `B : label` into its two halves. */
function splitLabel(text: string): [string, string | undefined] {
  const colon = text.indexOf(":");
  return colon === -1 ? [text, undefined] : [text.slice(0, colon), text.slice(colon + 1).trim()];
}

/** Pull a quoted multiplicity off whichever side of the name it sits on. */
function splitCardinality(
  text: string,
  side: "start" | "end"
): { name: string; cardinality?: string } {
  const pattern = side === "end" ? /^(.*?)\s*"([^"]*)"\s*$/ : /^\s*"([^"]*)"\s*(.*)$/;
  const match = pattern.exec(text);
  if (!match) {
    return {
      name: unquote(text)
        .replace(/~[^~]*~/g, "")
        .trim()
    };
  }
  const name = side === "end" ? match[1] : match[2];
  const cardinality = side === "end" ? match[2] : match[1];
  return {
    name: unquote(name)
      .replace(/~[^~]*~/g, "")
      .trim(),
    cardinality
  };
}

/** `+name(args) : type`, `-field`, `#protected`, `~package`. */
function readMember(text: string): ClassMember | undefined {
  const body = text.trim();
  if (body === "") {
    return undefined;
  }
  const marks: Record<string, Visibility> = {
    "+": "public",
    "-": "private",
    "#": "protected",
    "~": "package"
  };
  const visibility = marks[body[0]] ?? "none";
  const rest = visibility === "none" ? body : body.slice(1).trim();
  return {
    text: decodeLabel(rest),
    visibility,
    // A method is written with parentheses; everything else is a field.
    method: /\(.*\)/.test(rest)
  };
}
