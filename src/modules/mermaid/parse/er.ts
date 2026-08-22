/**
 * The `erDiagram` parser.
 *
 * A relationship is written as two cardinality tokens with a line between them —
 * `CUSTOMER ||--o{ ORDER : places` — and the tokens are mirror images: `||` on the left is
 * the same cardinality as `||` on the right, but `|o` and `o|` are the same thing written
 * from opposite ends. Reading each side against its own table is what keeps "zero or one"
 * from being parsed as "one" plus a stray circle.
 */

import { decodeLabel, splitStatements, unquote } from "@mermaid/parse/lex";
import type {
  Cardinality,
  Entity,
  EntityAttribute,
  EntityRelation,
  ErDiagram,
  FlowDirection
} from "@mermaid/types";

/** Left-hand cardinality tokens, longest first so `||` beats `|`. */
const LEFT: ReadonlyArray<[string, Cardinality]> = [
  ["||", "exactlyOne"],
  ["|o", "zeroOrOne"],
  ["}o", "zeroOrMore"],
  ["}|", "oneOrMore"]
];

/** Right-hand tokens: the same shapes, mirrored. */
const RIGHT: ReadonlyArray<[string, Cardinality]> = [
  ["||", "exactlyOne"],
  ["o|", "zeroOrOne"],
  ["o{", "zeroOrMore"],
  ["|{", "oneOrMore"]
];

/** Parse an entity-relationship diagram. */
export function parseEr(source: string, direction: FlowDirection): ErDiagram {
  const entities = new Map<string, { name: string; attributes: EntityAttribute[] }>();
  const relations: EntityRelation[] = [];
  let title: string | undefined;
  let open: string | undefined;

  const touch = (name: string): { name: string; attributes: EntityAttribute[] } => {
    const id = unquote(name.trim());
    let entry = entities.get(id);
    if (!entry) {
      entry = { name: id, attributes: [] };
      entities.set(id, entry);
    }
    return entry;
  };

  for (const text of splitStatements(source)) {
    if (/^erDiagram\b/i.test(text)) {
      continue;
    }

    if (open !== undefined) {
      if (text === "}") {
        open = undefined;
        continue;
      }
      const attribute = readAttribute(text);
      if (attribute) {
        touch(open).attributes.push(attribute);
      }
      continue;
    }

    const titleMatch = /^title\s+(.+)$/i.exec(text);
    if (titleMatch) {
      title = decodeLabel(titleMatch[1]);
      continue;
    }

    // `ENTITY {` opens an attribute block, and the whole block may sit on one line. Reading
    // only the multi-line form left an inline entity with no attributes at all — the
    // author wrote them and the picture did not show them.
    const block = /^([A-Za-z0-9_"'-]+)\s*\{(.*)$/.exec(text);
    if (block) {
      const entry = touch(block[1]);
      const inline = block[2].trim();
      if (inline.endsWith("}")) {
        for (const row of splitInlineRows(inline.slice(0, -1))) {
          const attribute = readAttribute(row);
          if (attribute) {
            entry.attributes.push(attribute);
          }
        }
      } else {
        open = entry.name;
        if (inline !== "") {
          const attribute = readAttribute(inline);
          if (attribute) {
            entry.attributes.push(attribute);
          }
        }
      }
      continue;
    }

    const relation = readRelation(text);
    if (relation) {
      touch(relation.from);
      touch(relation.to);
      relations.push(relation);
      continue;
    }

    // A bare entity name declares it with no attributes.
    const bare = /^([A-Za-z0-9_"'-]+)$/.exec(text);
    if (bare) {
      touch(bare[1]);
    }
  }

  const list: Entity[] = [...entities].map(([id, entry]) => ({
    id,
    name: entry.name,
    attributes: entry.attributes
  }));

  return {
    kind: "er",
    direction,
    ...(title === undefined ? {} : { title }),
    entities: list,
    relations
  };
}

/** `CUSTOMER ||--o{ ORDER : places`. */
function readRelation(text: string): EntityRelation | undefined {
  const match = /^(\S+)\s+(\S+?)(--|\.\.)(\S+?)\s+([^:]+?)\s*:\s*(.*)$/.exec(text);
  if (!match) {
    return undefined;
  }
  const from = unquote(match[1]);
  const left = LEFT.find(([token]) => token === match[2]);
  const right = RIGHT.find(([token]) => token === match[4]);
  if (!left || !right) {
    return undefined;
  }
  const label = decodeLabel(match[6]);
  return {
    from,
    to: unquote(match[5]),
    fromCardinality: left[1],
    toCardinality: right[1],
    // A solid line identifies; a dotted one does not.
    identifying: match[3] === "--",
    ...(label === "" || label === '""' ? {} : { label })
  };
}

/**
 * Split the rows of an inline block.
 *
 * An attribute is `type name [keys] ["comment"]`, so a row ends where the next type begins.
 * Splitting on whitespace alone would make every word its own row.
 */
function splitInlineRows(body: string): string[] {
  const rows: string[] = [];
  let current: string[] = [];
  let quote = false;
  for (const token of body.split(/\s+/).filter(part => part !== "")) {
    if (quote) {
      current.push(token);
      if (token.endsWith('"')) {
        quote = false;
      }
      continue;
    }
    // Two names already collected and this is neither a key nor a comment: a new row.
    const isKey = /^(PK|FK|UK)$/i.test(token);
    const startsComment = token.startsWith('"');
    if (current.length >= 2 && !isKey && !startsComment) {
      rows.push(current.join(" "));
      current = [];
    }
    current.push(token);
    if (startsComment && !token.endsWith('"')) {
      quote = true;
    }
  }
  if (current.length > 0) {
    rows.push(current.join(" "));
  }
  return rows;
}

/** `string name PK "comment"`. */
function readAttribute(text: string): EntityAttribute | undefined {
  const quoted = /^(.*?)\s*"([^"]*)"\s*$/.exec(text);
  const body = (quoted ? quoted[1] : text).trim();
  const parts = body.split(/\s+/).filter(part => part !== "");
  if (parts.length < 2) {
    return undefined;
  }
  const [type, name, ...rest] = parts;
  const keys = rest.filter(part => /^(PK|FK|UK)$/i.test(part)).map(part => part.toUpperCase());
  return {
    type,
    name,
    keys,
    ...(quoted === null ? {} : { comment: decodeLabel(quoted[2]) })
  };
}
