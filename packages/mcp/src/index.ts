/**
 * `@documonster/mcp` — programmatic entry point.
 *
 * Importing this package lets you embed the server in your own process (for
 * example to attach a different transport, or to drive it from an agent
 * framework) instead of spawning the `documonster-mcp` executable.
 *
 * ```ts
 * import { createServer, resolveConfig } from "@documonster/mcp";
 *
 * const server = createServer(resolveConfig(["--root", "./workspace", "--readonly"]));
 * await server.connect(myTransport);
 * ```
 */

export { ConfigError, readMetaFlags, resolveConfig, TOOL_GROUPS, usage } from "./config.js";
export type { ResolveConfigOptions, ServerConfig, ToolGroup } from "./config.js";
export { formatToolError, McpToolError, toolError } from "./errors.js";
export type { McpToolErrorOptions, ToolErrorCode } from "./errors.js";
export { assertWritable, isInside, resolveInRoot } from "./sandbox.js";
export type { ResolveOptions } from "./sandbox.js";
export { createServer } from "./server.js";
export type { ServerIdentity } from "./server.js";
export { ALL_TOOLS, selectTools } from "./tools/index.js";
export type { AnyToolDefinition, ToolContext, ToolDefinition } from "./tools/types.js";
