/**
 * The `stateDiagram` parser.
 *
 * The language is small: transitions, descriptions, and composite states that nest. `[*]`
 * is the one piece of punctuation that carries meaning — it is the start marker on the
 * left of an arrow and the end marker on the right, and the same token therefore has to
 * become two different nodes, or every terminal state in the diagram would be wired to
 * every entry point.
 */

import { normaliseDirection } from "@mermaid/parse/flowchart";
import { decodeLabel, splitStatements, unquote } from "@mermaid/parse/lex";
import type {
  FlowDirection,
  FlowSubgraph,
  StateDiagram,
  StateNode,
  StateTransition
} from "@mermaid/types";

/** Parse a state diagram. The header has already been recognised by the dispatcher. */
export function parseState(source: string, direction: FlowDirection): StateDiagram {
  const states = new Map<
    string,
    { text?: string; marker: "none" | "start" | "end"; stereotype?: "choice" | "fork" | "join" }
  >();
  const transitions: StateTransition[] = [];
  const composites: FlowSubgraph[] = [];
  let title: string | undefined;
  let dir = direction;
  let markers = 0;

  const open: Array<{ id: string; text: string; nodeIds: string[] }> = [];

  const touch = (id: string, marker: "none" | "start" | "end" = "none"): string => {
    if (!states.has(id)) {
      states.set(id, { marker });
    }
    // Every enclosing composite state, not just the innermost: an outer state's frame has
    // to contain the whole machine nested inside it.
    for (const group of open) {
      if (!group.nodeIds.includes(id)) {
        group.nodeIds.push(id);
      }
    }
    return id;
  };

  /**
   * Resolve one side of a transition.
   *
   * Each `[*]` becomes its own node. Sharing one would join every ending to every
   * beginning, drawing transitions the source never wrote.
   */
  const resolve = (raw: string, side: "from" | "to"): string => {
    const text = raw.trim();
    if (text === "[*]") {
      return touch(
        `__${side === "from" ? "start" : "end"}${markers++}`,
        side === "from" ? "start" : "end"
      );
    }
    return touch(stripStereotype(text));
  };

  for (const text of splitStatements(source)) {
    if (/^stateDiagram(-v2)?\b/i.test(text)) {
      continue;
    }

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

    // `state Name { … }` opens a composite; the brace may sit on its own line.
    const composite = /^state\s+(?:"([^"]*)"\s+as\s+)?([A-Za-z0-9_.-]+)\s*\{$/i.exec(text);
    if (composite) {
      const id = composite[2];
      touch(id);
      open.push({
        id,
        text: composite[1] !== undefined ? decodeLabel(composite[1]) : id,
        nodeIds: []
      });
      continue;
    }
    if (text === "}") {
      const group = open.pop();
      if (group) {
        const parent = open.at(-1);
        composites.push({
          id: group.id,
          text: group.text,
          nodeIds: [...group.nodeIds],
          ...(parent === undefined ? {} : { parent: parent.id })
        });
      }
      continue;
    }

    // `state "Long description" as id`
    const named = /^state\s+"([^"]*)"\s+as\s+([A-Za-z0-9_.-]+)$/i.exec(text);
    if (named) {
      touch(named[2]);
      states.get(named[2])!.text = decodeLabel(named[1]);
      continue;
    }
    // `state id <<choice>>`
    const stereotyped = /^state\s+([A-Za-z0-9_.-]+)\s*<<\s*(choice|fork|join)\s*>>$/i.exec(text);
    if (stereotyped) {
      touch(stereotyped[1]);
      states.get(stereotyped[1])!.stereotype = stereotyped[2].toLowerCase() as
        | "choice"
        | "fork"
        | "join";
      continue;
    }

    const transition = /^(.+?)\s*-->\s*([^:]+?)(?::\s*(.*))?$/.exec(text);
    if (transition) {
      const from = resolve(transition[1], "from");
      const to = resolve(transition[2], "to");
      const label = transition[3] === undefined ? undefined : decodeLabel(transition[3]);
      transitions.push({ from, to, ...(label === undefined || label === "" ? {} : { label }) });
      continue;
    }

    // `id : description`
    const described = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(text);
    if (described) {
      touch(described[1]);
      states.get(described[1])!.text = decodeLabel(described[2]);
      continue;
    }

    if (/^(note|classDef|class|click|accTitle|accDescr)\b/i.test(text)) {
      continue;
    }
  }

  while (open.length > 0) {
    const group = open.pop()!;
    const parent = open.at(-1);
    composites.push({
      id: group.id,
      text: group.text,
      nodeIds: [...group.nodeIds],
      ...(parent === undefined ? {} : { parent: parent.id })
    });
  }

  const list: StateNode[] = [...states].map(([id, entry]) => ({
    id,
    text: entry.text ?? id,
    marker: entry.marker,
    ...(entry.stereotype === undefined ? {} : { stereotype: entry.stereotype })
  }));

  return {
    kind: "state",
    direction: dir,
    ...(title === undefined ? {} : { title }),
    states: list,
    transitions,
    composites
  };
}

/** Drop a trailing `<<…>>` from an inline reference. */
function stripStereotype(text: string): string {
  return unquote(text.replace(/<<[^>]*>>/g, "").trim());
}
