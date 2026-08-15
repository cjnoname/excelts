/**
 * Server assembly.
 *
 * Deliberately transport-agnostic: this builds an `McpServer` with tools
 * registered and hands it back. `cli.ts` attaches stdio; tests attach an
 * in-memory transport. Keeping the two apart is what makes protocol-level
 * tests possible without spawning a process, and leaves room to add a
 * Streamable HTTP entry point later without touching tool code.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { registerPrompts, registerResources } from "./capabilities.js";
import type { ServerConfig } from "./config.js";
import { formatToolError } from "./errors.js";
import { selectTools } from "./tools/index.js";
import { errorResult } from "./tools/result.js";
import type { AnyToolDefinition, ToolContext } from "./tools/types.js";

/** Package identity reported during the MCP handshake. */
export interface ServerIdentity {
  readonly name: string;
  readonly version: string;
}

/**
 * Fallback identity for programmatic callers that do not supply one.
 *
 * Deliberately not a plausible version number: the executable reads the real
 * one from the package manifest, so anything reporting `0.0.0-unknown` in a
 * client's logs is an embedder that should pass its own identity.
 */
const DEFAULT_IDENTITY: ServerIdentity = {
  name: "documonster",
  version: "0.0.0-unknown"
};

/**
 * Build a configured MCP server. Nothing is connected yet — call
 * `server.connect(transport)`.
 */
export function createServer(
  config: ServerConfig,
  identity: ServerIdentity = DEFAULT_IDENTITY
): McpServer {
  const server = new McpServer(
    { name: identity.name, version: identity.version },
    {
      instructions:
        "Document toolkit for Excel, Word, PDF, CSV and ZIP files. Plain paths read from the input root; writes go to a separate output root and are returned as @output/<path>, which later tools can read. Input files are never modified unless the operator explicitly enabled in-place writes. Call doc_inspect before reading any document, and read narrow ranges rather than whole files. Call documonster_help for detailed guidance.",
      capabilities: { tools: {}, resources: {}, prompts: {} }
    }
  );

  // Resources publish the help topics at stable URIs, and prompts encode the
  // inspect-then-read-then-verify order that the tool descriptions can only hint
  // at. Neither costs a slot in the model's tool list.
  registerResources(server);
  registerPrompts(server, config);

  const context: ToolContext = { config };

  for (const tool of selectTools(config)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        ...(tool.annotations === undefined ? {} : { annotations: tool.annotations })
      },
      async (args: Record<string, unknown>) => runTool(tool, args, context)
    );
  }

  return server;
}

/**
 * Invoke a tool, converting any throw into an `isError` result.
 *
 * A thrown exception would surface as a protocol-level failure, which tells
 * the model nothing it can act on. An `isError` result carries the code and
 * hint, which is what lets it correct itself and retry.
 */
async function runTool(
  tool: AnyToolDefinition,
  args: Record<string, unknown>,
  context: ToolContext
): Promise<CallToolResult> {
  try {
    return await tool.handler(args, context);
  } catch (error) {
    return errorResult(formatToolError(error));
  }
}
