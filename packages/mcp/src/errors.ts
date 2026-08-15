/**
 * Error model.
 *
 * A tool error is not a crash — it is a message to the model, and the model
 * will try again based on what it reads. So every error carries a machine
 * `code` plus, wherever we can produce one, a `hint` telling the model what to
 * do differently. Error text quality directly determines retry success rate,
 * which makes this file part of the product rather than plumbing.
 */

export type ToolErrorCode =
  /** Arguments were structurally valid but semantically wrong. */
  | "invalid_input"
  /** The path does not exist. */
  | "not_found"
  /** The path resolved outside the sandbox root. */
  | "outside_root"
  /** A mutating tool was reached while `--readonly` is active. */
  | "readonly"
  /** Input exceeded `--max-file-size`, or output would exceed its budget. */
  | "too_large"
  /** A capability the server deliberately does not expose. */
  | "unsupported"
  /** Anything unclassified — a bug in the server or an unmapped library error. */
  | "internal";

export interface McpToolErrorOptions extends ErrorOptions {
  /** Actionable next step for the model, e.g. "call doc_inspect first". */
  readonly hint?: string;
}

/**
 * An error that is safe and useful to hand back to a model.
 *
 * Anything thrown that is NOT an `McpToolError` is treated as unclassified and
 * reported as `internal` — so a stack-leaking library error can never be
 * mistaken for a designed, model-facing message.
 */
export class McpToolError extends Error {
  override readonly name = "McpToolError";
  readonly code: ToolErrorCode;
  readonly hint: string | undefined;

  constructor(code: ToolErrorCode, message: string, options: McpToolErrorOptions = {}) {
    super(message, options);
    this.code = code;
    this.hint = options.hint;
  }
}

/**
 * Convenience constructors for the codes used most often.
 *
 * Each takes an optional `cause`, because documonster's own errors chain via
 * `{ cause }` and the innermost message is usually the one naming the cell,
 * OOXML part or ZIP entry that actually failed — dropping it would leave the
 * model with a generic message it cannot act on.
 */
export const toolError = {
  invalidInput(message: string, hint?: string, options?: ErrorOptions): McpToolError {
    return new McpToolError("invalid_input", message, { hint, ...options });
  },
  notFound(message: string, hint?: string, options?: ErrorOptions): McpToolError {
    return new McpToolError("not_found", message, { hint, ...options });
  },
  outsideRoot(message: string, hint?: string, options?: ErrorOptions): McpToolError {
    return new McpToolError("outside_root", message, { hint, ...options });
  },
  readonly(message: string, hint?: string, options?: ErrorOptions): McpToolError {
    return new McpToolError("readonly", message, { hint, ...options });
  },
  tooLarge(message: string, hint?: string, options?: ErrorOptions): McpToolError {
    return new McpToolError("too_large", message, { hint, ...options });
  },
  unsupported(message: string, hint?: string, options?: ErrorOptions): McpToolError {
    return new McpToolError("unsupported", message, { hint, ...options });
  }
} as const;

/**
 * Render any thrown value as the text body of an `isError` tool result.
 *
 * Includes the `cause` chain because documonster's own errors chain via
 * `{ cause }`, and the innermost message is usually the one that says which
 * cell, part or ZIP entry actually failed.
 */
export function formatToolError(error: unknown): string {
  if (error instanceof McpToolError) {
    const lines = [`[${error.code}] ${error.message}`];
    const chain = describeCauseChain(error.cause);
    if (chain !== undefined) {
      lines.push(`Caused by: ${chain}`);
    }
    if (error.hint !== undefined) {
      lines.push(`Hint: ${error.hint}`);
    }
    return lines.join("\n");
  }

  if (error instanceof Error) {
    const lines = [`[internal] ${error.name}: ${error.message}`];
    const chain = describeCauseChain(error.cause);
    if (chain !== undefined) {
      lines.push(`Caused by: ${chain}`);
    }
    return lines.join("\n");
  }

  return `[internal] ${String(error)}`;
}

/** Flatten `cause` links into `A: msg -> B: msg`, with a depth guard. */
function describeCauseChain(cause: unknown, depth = 0): string | undefined {
  if (cause === undefined || cause === null || depth >= 5) {
    return undefined;
  }
  if (!(cause instanceof Error)) {
    return String(cause);
  }
  const head = `${cause.name}: ${cause.message}`;
  const tail = describeCauseChain(cause.cause, depth + 1);
  return tail === undefined ? head : `${head} -> ${tail}`;
}
