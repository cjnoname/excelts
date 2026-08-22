/**
 * The `gantt` parser.
 *
 * A task is written as `label : [tags,] [id,] start, length`, where almost every field is
 * optional and the meaning of a field depends on what the ones before it turned out to be.
 * So the fields are classified rather than positional: whichever one parses as a date is
 * the start, whichever parses as a duration is the length, `after x` is a dependency, and
 * what is left over is the id.
 *
 * Doing it positionally is how the common forms break — `Task : 30d` (no start, inherit it)
 * and `Task : a1, 2024-01-01, 30d` (id, start, length) have the same shape until you look
 * at what each field says.
 */

import {
  DAY,
  addMonths,
  addWorkingTime,
  parseCalendarDuration,
  parseDate,
  parseDuration,
  parseWithFormat
} from "@mermaid/parse/dates";
import { decodeLabel, splitStatements } from "@mermaid/parse/lex";
import type { GanttDiagram, GanttTask, TaskState } from "@mermaid/types";

const STATES: ReadonlySet<string> = new Set(["active", "done", "crit"]);

/** Parse a Gantt chart. */
export function parseGantt(source: string): GanttDiagram {
  const tasks: GanttTask[] = [];
  const sections: string[] = [];
  const byId = new Map<string, GanttTask>();
  let title: string | undefined;
  let section = "";
  /** Where the next task starts when it does not say: the end of the last one. */
  let cursor: number | undefined;
  /** The format the author writes dates in; ISO when they did not say. */
  let dateFormat: string | undefined;
  /** Weekday numbers the plan excludes, so duration counts working time only. */
  const excluded = new Set<number>();

  for (const text of splitStatements(source)) {
    if (/^gantt\b/i.test(text)) {
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
    const formatMatch = /^dateFormat\s+(.+)$/i.exec(text);
    if (formatMatch) {
      dateFormat = formatMatch[1].trim();
      continue;
    }
    const excludesMatch = /^excludes\s+(.+)$/i.exec(text);
    if (excludesMatch) {
      // An excluded day is not available to work in, so it lengthens every task that spans
      // it. This is calendar arithmetic, not styling.
      for (const entry of excludesMatch[1].split(/[\s,]+/)) {
        if (/^weekends$/i.test(entry)) {
          excluded.add(0);
          excluded.add(6);
          continue;
        }
        const day = WEEKDAYS[entry.toLowerCase()];
        if (day !== undefined) {
          excluded.add(day);
        }
      }
      continue;
    }
    // `axisFormat`, `todayMarker`, `tickInterval` and the rest describe presentation this
    // renderer decides for itself.
    if (
      /^(axisFormat|includes|todayMarker|tickInterval|weekday|inclusiveEndDates|topAxis|accTitle|accDescr)\b/i.test(
        text
      )
    ) {
      continue;
    }

    const colon = text.indexOf(":");
    if (colon === -1) {
      continue;
    }
    const label = decodeLabel(text.slice(0, colon));
    const fields = text
      .slice(colon + 1)
      .split(",")
      .map(field => field.trim())
      .filter(field => field !== "");

    const task = readTask(label, section, fields, byId, cursor, dateFormat, excluded);
    if (!task) {
      continue;
    }
    tasks.push(task);
    if (task.id !== undefined) {
      byId.set(task.id, task);
    }
    cursor = task.end;
  }

  if (sections.length === 0 && tasks.length > 0) {
    sections.push("");
  }

  return {
    kind: "gantt",
    ...(title === undefined ? {} : { title }),
    sections,
    tasks
  };
}

/** Weekday names, for `excludes`. */
const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6
};

/** Classify the fields after the colon and build the bar they describe. */
function readTask(
  label: string,
  section: string,
  fields: readonly string[],
  byId: ReadonlyMap<string, GanttTask>,
  cursor: number | undefined,
  dateFormat: string | undefined,
  excluded: ReadonlySet<number>
): GanttTask | undefined {
  let state: TaskState = "default";
  let milestone = false;
  let id: string | undefined;
  let start: number | undefined;
  let end: number | undefined;
  let length: number | undefined;
  let months: number | undefined;
  let after: number | undefined;

  for (const field of fields) {
    const lower = field.toLowerCase();
    if (STATES.has(lower)) {
      state = lower as TaskState;
      continue;
    }
    if (lower === "milestone") {
      milestone = true;
      continue;
    }

    const dependency = /^after\s+(.+)$/i.exec(field);
    if (dependency) {
      // The latest end among the named tasks, so a task waiting on several starts when the
      // last of them finishes.
      for (const name of dependency[1].split(/\s+/)) {
        const previous = byId.get(name);
        if (previous) {
          after = after === undefined ? previous.end : Math.max(after, previous.end);
        }
      }
      continue;
    }
    const until = /^until\s+(.+)$/i.exec(field);
    if (until) {
      for (const name of until[1].split(/\s+/)) {
        const other = byId.get(name);
        if (other) {
          end = end === undefined ? other.start : Math.min(end, other.start);
        }
      }
      continue;
    }

    // The author's own format first: `01-02-2024` under `dateFormat DD-MM-YYYY` is a date,
    // and reading only ISO turned it into the task's identifier — after which a task with
    // no other start had nothing to stand on and was dropped entirely.
    const date =
      (dateFormat === undefined ? undefined : parseWithFormat(field, dateFormat)) ??
      parseDate(field);
    if (date !== undefined) {
      if (start === undefined) {
        start = date;
      } else {
        end = date;
      }
      continue;
    }
    const duration = parseDuration(field);
    if (duration !== undefined) {
      length = duration;
      continue;
    }
    const calendar = parseCalendarDuration(field);
    if (calendar !== undefined) {
      months = calendar.months;
      continue;
    }
    // Anything left is the task's identifier.
    if (id === undefined) {
      id = field;
    }
  }

  const from = start ?? after ?? cursor;
  if (from === undefined) {
    // A chart whose first task says nothing about when it starts has no timeline at all.
    return undefined;
  }
  const to =
    end ??
    (months !== undefined
      ? addMonths(from, months)
      : addWorkingTime(from, length ?? DAY, excluded));

  // A milestone with a duration marks the *middle* of the span it was given, which is what
  // Mermaid draws and what "the point this finishes" means when the work took time.
  const at = milestone ? from + (Math.max(from, to) - from) / 2 : from;

  return {
    ...(id === undefined ? {} : { id }),
    label,
    section,
    start: milestone ? at : from,
    end: milestone ? at : Math.max(from, to),
    state,
    milestone
  };
}
