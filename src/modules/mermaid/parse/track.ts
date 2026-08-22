/**
 * The `timeline` and `journey` parsers.
 *
 * Both lay a sequence of labelled stops along one axis, and both write a stop as
 * `label : payload`. What differs is the payload — a timeline's is a list of events, a
 * journey's is a score and a cast — so they share a shape and not a grammar.
 */

import { decodeLabel, splitStatements } from "@mermaid/parse/lex";
import type { JourneyDiagram, JourneyTask, TimelineDiagram, TimelinePeriod } from "@mermaid/types";

/** Parse a timeline. */
export function parseTimeline(source: string): TimelineDiagram {
  const periods: TimelinePeriod[] = [];
  const sections: string[] = [];
  let title: string | undefined;
  let section = "";

  for (const text of splitStatements(source)) {
    if (/^timeline\b/i.test(text)) {
      continue;
    }
    const titleMatch = /^title\s+(.+)$/i.exec(text);
    if (titleMatch) {
      title = decodeLabel(titleMatch[1]);
      continue;
    }
    const sectionMatch = /^section\s+(.+)$/i.exec(text);
    if (sectionMatch) {
      section = decodeLabel(sectionMatch[1]);
      if (!sections.includes(section)) {
        sections.push(section);
      }
      continue;
    }
    if (/^(accTitle|accDescr)\b/i.test(text)) {
      continue;
    }

    // `2004 : Facebook : Google` — the first field is the period, the rest are events.
    const parts = text.split(":").map(part => decodeLabel(part));
    const label = parts[0];
    if (label === "") {
      // A continuation line adds more events to the period above it.
      const previous = periods.at(-1);
      if (previous) {
        periods[periods.length - 1] = {
          ...previous,
          events: [...previous.events, ...parts.slice(1).filter(part => part !== "")]
        };
      }
      continue;
    }
    periods.push({
      label,
      events: parts.slice(1).filter(part => part !== ""),
      section
    });
  }

  return {
    kind: "timeline",
    ...(title === undefined ? {} : { title }),
    sections,
    periods
  };
}

/** Parse a user journey. */
export function parseJourney(source: string): JourneyDiagram {
  const tasks: JourneyTask[] = [];
  const sections: string[] = [];
  let title: string | undefined;
  let section = "";

  for (const text of splitStatements(source)) {
    if (/^journey\b/i.test(text)) {
      continue;
    }
    const titleMatch = /^title\s+(.+)$/i.exec(text);
    if (titleMatch) {
      title = decodeLabel(titleMatch[1]);
      continue;
    }
    const sectionMatch = /^section\s+(.+)$/i.exec(text);
    if (sectionMatch) {
      section = decodeLabel(sectionMatch[1]);
      if (!sections.includes(section)) {
        sections.push(section);
      }
      continue;
    }
    if (/^(accTitle|accDescr)\b/i.test(text)) {
      continue;
    }

    // `Make tea: 5: Me, Cat`
    const parts = text.split(":");
    if (parts.length < 2) {
      continue;
    }
    const score = Number.parseInt(parts[1].trim(), 10);
    if (!Number.isFinite(score)) {
      continue;
    }
    tasks.push({
      label: decodeLabel(parts[0]),
      section,
      // Out-of-range scores are clamped rather than dropped: the step still happened.
      score: Math.min(5, Math.max(1, score)),
      actors: (parts[2] ?? "")
        .split(",")
        .map(actor => decodeLabel(actor))
        .filter(actor => actor !== "")
    });
  }

  return {
    kind: "journey",
    ...(title === undefined ? {} : { title }),
    sections,
    tasks
  };
}
