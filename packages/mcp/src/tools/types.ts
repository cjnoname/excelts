/**
 * Tool definition contract.
 *
 * Tools are plain data plus a handler, collected in `./index.ts`. Keeping them
 * declarative is what makes `--enable` / `--readonly` filtering and the
 * registry test possible without booting a transport.
 */

import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { ZodRawShape } from "zod";

import type { ServerConfig, ToolGroup } from "../config.js";

/** Everything a handler is allowed to reach. Deliberately just the config. */
export interface ToolContext {
  readonly config: ServerConfig;
}

export interface ToolDefinition<Shape extends ZodRawShape> {
  /** Wire name, snake_case, stable — renaming one is a breaking change. */
  readonly name: string;
  readonly group: ToolGroup | readonly ToolGroup[];
  /** Human-facing label shown by some clients. */
  readonly title: string;
  /**
   * Sent to the model verbatim, in every request, for every enabled tool.
   * Treat it as a token budget: say what the tool does and when to reach for
   * it, and push detailed schema documentation into `documonster_help`.
   */
  readonly description: string;
  /**
   * Zod raw shape (a plain object of validators, not `z.object(...)`).
   *
   * This is serialized into JSON Schema and shipped to the model on every
   * request, so keep it to the top-level structure plus high-frequency
   * fields. Deep, rarely-used option trees belong in `documonster_help`.
   */
  readonly inputSchema: Shape;
  readonly annotations?: ToolAnnotations;
  /**
   * True when every useful mode of the tool writes to the filesystem. Such
   * tools are withheld entirely under `--readonly`.
   *
   * A conditionally-writing tool (for example `form_fill` with no values only
   * lists fields) sets this false so its read-only mode remains discoverable,
   * and must call `assertWritable` in the branch that writes. MCP annotations
   * stay conservative (`readOnlyHint: false`, `destructiveHint: true`).
   */
  readonly mutates: boolean;
  readonly handler: (args: ShapeInput<Shape>, context: ToolContext) => Promise<CallToolResult>;
}

/** The parsed-argument type the SDK hands a handler for a given shape. */
type ShapeInput<Shape extends ZodRawShape> = {
  [K in keyof Shape]: Shape[K] extends { _zod: { output: infer Out } } ? Out : unknown;
};

/**
 * A tool definition with its argument type erased, so tools with different
 * shapes can live in one array.
 */
export interface AnyToolDefinition {
  readonly name: string;
  readonly group: ToolGroup | readonly ToolGroup[];
  readonly title: string;
  readonly description: string;
  readonly inputSchema: ZodRawShape;
  readonly annotations?: ToolAnnotations;
  readonly mutates: boolean;
  readonly handler: (
    args: Record<string, unknown>,
    context: ToolContext
  ) => Promise<CallToolResult>;
}

/**
 * Register a tool with its argument type checked, then erase that type.
 *
 * The cast is the one unsound step in the package, and it is sound in practice
 * because the SDK validates arguments against `inputSchema` before the handler
 * runs — so `args` really does match `ShapeInput<Shape>` at the call site.
 */
export function defineTool<Shape extends ZodRawShape>(
  definition: ToolDefinition<Shape>
): AnyToolDefinition {
  return definition as unknown as AnyToolDefinition;
}
