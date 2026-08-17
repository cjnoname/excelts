/**
 * Tool result helpers.
 *
 * Every tool returns text, not binary — a model cannot see an image and this
 * toolkit has no PDF rasterizer, so a structured textual description is the
 * only channel that exists. These helpers keep truncation honest: a silently
 * cut-off table is worse than no table, because the model will reason over it
 * as if it were complete.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { ServerConfig } from "../config.js";

/** A successful text result, truncated to the configured output budget. */
export function textResult(config: ServerConfig, text: string): CallToolResult {
  return { content: [{ type: "text", text: truncate(config, text) }] };
}

/** An error result. The model reads this and decides whether to retry. */
export function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

/**
 * Cut `text` to the output budget, appending an explicit marker.
 *
 * The marker matters: it tells the model the data is incomplete so it asks for
 * a narrower range instead of drawing conclusions from a partial document.
 */
export function truncate(config: ServerConfig, text: string): string {
  if (text.length <= config.maxOutputChars) {
    return text;
  }
  const omitted = text.length - config.maxOutputChars;
  return `${text.slice(0, config.maxOutputChars)}\n\n[truncated: ${omitted} more characters. Request a narrower range or use pagination to see the rest.]`;
}

/**
 * Escape a value so it occupies exactly one Markdown table cell.
 *
 * A raw `|` would silently split one cell into two and shift every subsequent
 * column, which the model has no way to detect — and a newline would end the
 * row outright.
 *
 * The backslash has to be escaped too, and first. Escaping only the pipe turns
 * the input `\|` into `\\|`, which GFM reads as an escaped backslash followed by
 * a live cell delimiter: the very break the escaping exists to prevent. The same
 * applies to any odd-length backslash run before a pipe.
 *
 * `maxLength` clips the source text *before* escaping, so a limit can never cut
 * an escape sequence in half and leave a dangling backslash that swallows the
 * closing delimiter.
 */
export function escapeTableCell(text: string, maxLength?: number): string {
  const clipped = maxLength === undefined ? text : text.slice(0, maxLength);
  return clipped.replace(/[\\|]/g, "\\$&").replace(/\r\n|[\r\n]/g, " ");
}

/** Render a byte count for humans, e.g. `1.4 MiB`. */
export function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB"] as const;
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const unit = units[unitIndex] ?? "B";
  return unitIndex === 0 ? `${bytes} ${unit}` : `${value.toFixed(1)} ${unit}`;
}
