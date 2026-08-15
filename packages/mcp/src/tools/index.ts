/**
 * Tool registry.
 *
 * The single list of every tool the server knows about. Selection is pure data
 * filtering, which keeps `--enable` / `--readonly` behaviour testable without
 * starting a transport.
 */

import type { ServerConfig } from "../config.js";
import { archiveReadTool } from "./archive-read.js";
import { archiveWriteTool } from "./archive-write.js";
import { docConvertTool } from "./doc-convert.js";
import { docPaginateTool } from "./doc-paginate.js";
import { docReadTool } from "./doc-read.js";
import { docReviewTool } from "./doc-review.js";
import { docEditTool, docSearchTool } from "./doc-search.js";
import { docWriteTool } from "./doc-write.js";
import { formFillTool } from "./form-fill.js";
import { formulaEvaluateTool } from "./formula-evaluate.js";
import { helpTool } from "./help.js";
import { inspectTool } from "./inspect.js";
import { pdfEditTool } from "./pdf-edit.js";
import { sheetEditTool } from "./sheet-edit.js";
import { sheetReadTool } from "./sheet-read.js";
import { sheetWriteTool } from "./sheet-write.js";
import { templateFillTool, templateInspectTool } from "./template.js";
import type { AnyToolDefinition } from "./types.js";

/**
 * All tools, in the order they are registered.
 *
 * Keep this list short. Every enabled tool's name, description and JSON Schema
 * is sent to the model on every single request, and the probability of the
 * model picking the wrong tool rises with the count. A capability that only
 * varies by a parameter belongs as a parameter, not as another tool.
 */
export const ALL_TOOLS: readonly AnyToolDefinition[] = [
  helpTool,
  inspectTool,
  sheetReadTool,
  sheetWriteTool,
  sheetEditTool,
  formulaEvaluateTool,
  docReadTool,
  docWriteTool,
  docConvertTool,
  docSearchTool,
  docEditTool,
  docPaginateTool,
  docReviewTool,
  pdfEditTool,
  templateInspectTool,
  templateFillTool,
  formFillTool,
  archiveReadTool,
  archiveWriteTool
];

/**
 * The tools a given configuration exposes.
 *
 * Always-mutating tools are removed under `--readonly`. Conditionally-writing
 * tools remain visible so their read-only mode (list fields, compare versions,
 * compute pages) still works; their write branch enforces `assertWritable`.
 *
 * @param tools - Defaults to {@link ALL_TOOLS}. Overridable so the filter can
 *   be tested against fixtures covering groups that no shipped tool uses yet —
 *   otherwise the only reachable path would be "nothing was filtered", which
 *   passes however broken the predicate is.
 */
export function selectTools(
  config: ServerConfig,
  tools: readonly AnyToolDefinition[] = ALL_TOOLS
): readonly AnyToolDefinition[] {
  return tools.filter(tool => {
    const groups = Array.isArray(tool.group) ? tool.group : [tool.group];
    if (!groups.some(group => config.groups.has(group))) {
      return false;
    }
    if (tool.mutates && config.readonly) {
      return false;
    }
    return true;
  });
}

export type { AnyToolDefinition, ToolContext, ToolDefinition } from "./types.js";
