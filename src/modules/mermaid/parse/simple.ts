/**
 * The `pie` and `sequenceDiagram` parsers.
 *
 * Both are line-oriented in a way the flowchart is not — a statement is a whole line with
 * a fixed shape — so they read as a loop over statements rather than a scanner.
 */

import { decodeLabel, splitStatements, unquote } from "@mermaid/parse/lex";
import type {
  EdgeEnd,
  SequenceEntry,
  SequenceNote,
  PieDiagram,
  PieSlice,
  SequenceDiagram,
  SequenceLine,
  SequenceMessage,
  SequenceParticipant
} from "@mermaid/types";

/** Parse a `pie` diagram. `showData` and the title may both sit on the header line. */
export function parsePie(source: string): PieDiagram {
  const slices: PieSlice[] = [];
  let title: string | undefined;
  let showData = false;

  for (const text of splitStatements(source)) {
    const header = /^pie\b\s*(showData)?\s*(?:title\s+(.*))?$/i.exec(text);
    if (header) {
      showData = header[1] !== undefined;
      if (header[2] !== undefined && header[2].trim() !== "") {
        title = decodeLabel(header[2]);
      }
      continue;
    }
    const titleMatch = /^title\s+(.+)$/i.exec(text);
    if (titleMatch) {
      title = decodeLabel(titleMatch[1]);
      continue;
    }
    if (/^(accTitle|accDescr)\b/i.test(text)) {
      continue;
    }

    // `"Label" : 42`. The quotes are required by Mermaid but tolerated when missing,
    // because a label without spaces reads unambiguously either way.
    const slice = /^(.*?)\s*:\s*([-+]?[\d.]+(?:e[-+]?\d+)?)$/i.exec(text);
    if (slice) {
      const value = Number.parseFloat(slice[2]);
      if (Number.isFinite(value)) {
        slices.push({ label: decodeLabel(slice[1]), value });
      }
    }
  }

  return {
    kind: "pie",
    ...(title === undefined ? {} : { title }),
    showData,
    slices
  };
}

/**
 * Parse a `sequenceDiagram`.
 *
 * The body is a tree, because `loop`/`alt`/`opt`/`par` nest and each frame has to be drawn
 * around what it contains. `alt`/`else` and `par`/`and` are one frame with a rule through
 * it rather than two frames, so they are modelled as sections of a single block — drawing
 * them separately would lose the fact that the branches are alternatives of one decision.
 */
export function parseSequence(source: string): SequenceDiagram {
  const participants = new Map<string, SequenceParticipant>();
  const messages: SequenceMessage[] = [];
  let title: string | undefined;
  let autonumber = false;

  const declare = (id: string, text?: string, actor = false): void => {
    const existing = participants.get(id);
    if (!existing) {
      participants.set(id, { id, text: text ?? id, actor });
      return;
    }
    if (text !== undefined && existing.text === existing.id) {
      participants.set(id, { ...existing, text });
    }
  };

  const root: SequenceEntry[] = [];
  // Each open block contributes a frame; entries land in the innermost one's last section.
  const open: Array<{
    keyword: string;
    sections: Array<{ label: string; body: SequenceEntry[] }>;
  }> = [];
  const current = (): SequenceEntry[] => {
    const block = open.at(-1);
    return block ? block.sections[block.sections.length - 1].body : root;
  };

  for (const text of splitStatements(source)) {
    if (/^sequenceDiagram\b/i.test(text)) {
      continue;
    }

    const titleMatch = /^title\s*:?\s+(.+)$/i.exec(text);
    if (titleMatch) {
      title = decodeLabel(titleMatch[1]);
      continue;
    }
    if (/^autonumber\b/i.test(text)) {
      autonumber = true;
      continue;
    }

    const participantMatch = /^(participant|actor)\s+(.+)$/i.exec(text);
    if (participantMatch) {
      const body = participantMatch[2].trim();
      const aliased = /^(\S+)\s+as\s+(.+)$/i.exec(body);
      const isActor = participantMatch[1].toLowerCase() === "actor";
      if (aliased) {
        declare(aliased[1], decodeLabel(aliased[2]), isActor);
      } else {
        declare(unquote(body), undefined, isActor);
      }
      continue;
    }

    const note = readNote(text);
    if (note) {
      for (const id of note.participants) {
        declare(id);
      }
      current().push(note);
      continue;
    }

    const blockStart = /^(loop|alt|opt|par|critical|break|rect)\b\s*(.*)$/i.exec(text);
    if (blockStart) {
      open.push({
        keyword: blockStart[1].toLowerCase(),
        sections: [{ label: decodeLabel(blockStart[2]), body: [] }]
      });
      continue;
    }

    const sectionStart = /^(else|and|option)\b\s*(.*)$/i.exec(text);
    if (sectionStart && open.length > 0) {
      open.at(-1)!.sections.push({ label: decodeLabel(sectionStart[2]), body: [] });
      continue;
    }

    if (/^end$/i.test(text)) {
      const block = open.pop();
      if (block) {
        current().push({ kind: "block", keyword: block.keyword, sections: block.sections });
      }
      continue;
    }

    // Activation bars are not drawn, but the participant they name is real.
    const activate = /^(activate|deactivate)\s+(\S+)$/i.exec(text);
    if (activate) {
      declare(activate[2]);
      continue;
    }
    if (/^(box|links?|properties|accTitle|accDescr)\b/i.test(text)) {
      continue;
    }

    const message = readMessage(text);
    if (message) {
      declare(message.from);
      declare(message.to);
      messages.push(message);
      current().push({ kind: "message", ...message });
    }
  }

  // An unterminated block still frames what it holds; dropping it would lose the messages.
  while (open.length > 0) {
    const block = open.pop()!;
    current().push({ kind: "block", keyword: block.keyword, sections: block.sections });
  }

  return {
    kind: "sequence",
    ...(title === undefined ? {} : { title }),
    participants: [...participants.values()],
    messages,
    body: root,
    autonumber
  };
}

/**
 * `Note over A,B: text`, `Note left of A: text`, `Note right of A: text`.
 */
function readNote(text: string): SequenceNote | undefined {
  const over = /^note\s+over\s+([^:]+):\s*(.*)$/i.exec(text);
  if (over) {
    return {
      kind: "note",
      placement: "over",
      participants: over[1]
        .split(",")
        .map(part => unquote(part.trim()))
        .filter(part => part !== ""),
      text: decodeLabel(over[2])
    };
  }
  const beside = /^note\s+(left|right)\s+of\s+([^:]+):\s*(.*)$/i.exec(text);
  if (beside) {
    return {
      kind: "note",
      placement: beside[1].toLowerCase() as "left" | "right",
      participants: [unquote(beside[2].trim())],
      text: decodeLabel(beside[3])
    };
  }
  return undefined;
}

/**
 * `A->>B: text`.
 *
 * Mermaid's message arrows encode two things in one token: the shaft (`-` solid,
 * `--` dotted) and the head (`>` open, `>>` filled, `x` cross, `)` open circle). The
 * longest head is matched first so `->>` is not read as `->` followed by a stray `>`.
 */
function readMessage(text: string): SequenceMessage | undefined {
  // `+` and `-` after the arrow activate and deactivate the target. They are part of the
  // arrow, not of the name: read as a name they produced participants called `+B` and `-A`,
  // so a perfectly ordinary exchange came out as four participants who never spoke.
  const match = /^([^\s:>-]+)\s*(-{1,2})(>>|>|\)|x)\s*([+-]?)\s*([^\s:]+)\s*:\s*(.*)$/.exec(text);
  if (!match) {
    return undefined;
  }
  const line: SequenceLine = match[2] === "--" ? "dotted" : "solid";
  const head = match[3];
  const arrow: EdgeEnd = head === "x" ? "cross" : head === ")" ? "circle" : "arrow";
  return {
    from: match[1],
    to: match[5],
    text: decodeLabel(match[6]),
    line,
    arrow,
    ...(match[4] === "+" ? { activates: true } : {}),
    ...(match[4] === "-" ? { deactivates: true } : {})
  };
}
