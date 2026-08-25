/**
 * Server configuration: the command-line contract of `documonster-mcp`.
 *
 * Everything that constrains what the server is allowed to do lives here and
 * is decided ONCE at startup, never per tool call. The model can therefore
 * never widen its own permissions: `--root` and `--readonly` are invisible to it.
 */

import { chmodSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

/**
 * Tool groups, used by `--enable` to keep the number of tools exposed to a
 * model small. Every additional tool measurably increases the chance the model
 * picks the wrong one, so a caller who only ever touches spreadsheets should
 * not have to pay for the Word and PDF tool descriptions in its context.
 *
 * `core` (`documonster_help`, `doc_inspect`) is always enabled — it is how a
 * model orients itself before doing anything else.
 */
export const TOOL_GROUPS = ["core", "excel", "word", "pdf", "forms", "archive", "diagram"] as const;

export type ToolGroup = (typeof TOOL_GROUPS)[number];

/** Groups enabled when `--enable` is omitted. */
const DEFAULT_GROUPS: readonly ToolGroup[] = [
  "core",
  "excel",
  "word",
  "pdf",
  "forms",
  "archive",
  "diagram"
];

/** Default ceiling for a single input document, in bytes (64 MiB). */
const DEFAULT_MAX_FILE_SIZE = 64 * 1024 * 1024;

/**
 * Default ceiling for the text a single tool call may return, in characters.
 * A tool result goes straight into the model's context, so this is a token
 * budget in disguise: ~40 000 characters is roughly 10 000 tokens.
 */
const DEFAULT_MAX_OUTPUT_CHARS = 40_000;

export interface ServerConfig {
  /**
   * Absolute, symlink-resolved sandbox root. Every path a tool touches must
   * resolve inside it (see `sandbox.ts`).
   */
  readonly root: string;
  /**
   * Private, disjoint writable root. Plain write paths resolve here; tools and
   * prompts expose them as `@output/...` so later calls can read the result
   * without ever granting writes to the input root.
   */
  readonly outputRoot: string;
  /** Explicit compatibility escape hatch for modifying source files in place. */
  readonly allowInPlace: boolean;
  /** When true, every mutating tool is withheld from `tools/list` entirely. */
  readonly readonly: boolean;
  /** Enabled tool groups; always contains `core`. */
  readonly groups: ReadonlySet<ToolGroup>;
  /** Reject input documents larger than this many bytes. */
  readonly maxFileSize: number;
  /** Truncate tool output beyond this many characters. */
  readonly maxOutputChars: number;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

export interface ResolveConfigOptions {
  /** Overrides `process.cwd()`; used by tests. */
  readonly cwd?: string;
}

/**
 * Build a {@link ServerConfig} from CLI-style arguments.
 *
 * @param argv - Arguments *after* `node script.js`, i.e. `process.argv.slice(2)`.
 * @throws {ConfigError} On an unknown flag, a missing value, or a `--root`
 *   that does not exist. Failing loudly at startup is deliberate: a silently
 *   defaulted root would sandbox the model somewhere the operator never chose.
 */
export function resolveConfig(
  argv: readonly string[],
  options: ResolveConfigOptions = {}
): ServerConfig {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        root: { type: "string" },
        "output-root": { type: "string" },
        "allow-in-place": { type: "boolean", default: false },
        readonly: { type: "boolean", default: false },
        enable: { type: "string" },
        "max-file-size": { type: "string" },
        "max-output-chars": { type: "string" },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false }
      },
      allowPositionals: false,
      strict: true
    });
  } catch (cause) {
    throw new ConfigError(cause instanceof Error ? cause.message : String(cause), { cause });
  }

  const values = parsed.values;
  const cwd = options.cwd ?? process.cwd();
  const rootInput = values.root ?? cwd;

  let root: string;
  try {
    // realpath, not just resolve: the containment check in `sandbox.ts`
    // compares realpaths, so the root must already be one or a symlinked
    // root (`/tmp` -> `/private/tmp` on macOS) would reject everything.
    root = realpathSync(path.resolve(cwd, rootInput));
  } catch (cause) {
    throw new ConfigError(`--root does not exist or is not readable: ${rootInput}`, { cause });
  }

  let outputRoot: string;
  try {
    const outputInput = values["output-root"];
    if (outputInput === undefined) {
      outputRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), "documonster-mcp-output-")));
      chmodSync(outputRoot, 0o700);
    } else {
      const absolute = path.resolve(cwd, outputInput);
      mkdirSync(absolute, { recursive: true, mode: 0o700 });
      outputRoot = realpathSync(absolute);
    }
  } catch (cause) {
    throw new ConfigError("--output-root could not be created or is not writable", { cause });
  }

  if (containsPath(root, outputRoot) || containsPath(outputRoot, root)) {
    throw new ConfigError(
      "--output-root must be disjoint from --root (neither may contain the other)"
    );
  }

  return {
    root,
    outputRoot,
    allowInPlace: values["allow-in-place"] ?? false,
    readonly: values.readonly ?? false,
    groups: parseGroups(values.enable),
    maxFileSize: parseByteCount(values["max-file-size"], "--max-file-size", DEFAULT_MAX_FILE_SIZE),
    maxOutputChars: parseByteCount(
      values["max-output-chars"],
      "--max-output-chars",
      DEFAULT_MAX_OUTPUT_CHARS
    )
  };
}

function containsPath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

/** True when `--help` or `--version` was passed; the CLI short-circuits on these. */
export function readMetaFlags(argv: readonly string[]): { help: boolean; version: boolean } {
  return {
    help: argv.includes("--help") || argv.includes("-h"),
    version: argv.includes("--version") || argv.includes("-v")
  };
}

function parseGroups(raw: string | undefined): ReadonlySet<ToolGroup> {
  if (raw === undefined) {
    return new Set(DEFAULT_GROUPS);
  }

  const requested = raw
    .split(",")
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0);

  if (requested.length === 0) {
    throw new ConfigError(`--enable needs at least one group (known: ${TOOL_GROUPS.join(", ")})`);
  }

  const groups = new Set<ToolGroup>(["core"]);
  for (const entry of requested) {
    if (!isToolGroup(entry)) {
      throw new ConfigError(
        `--enable: unknown group "${entry}" (known: ${TOOL_GROUPS.join(", ")})`
      );
    }
    groups.add(entry);
  }
  return groups;
}

function isToolGroup(value: string): value is ToolGroup {
  return (TOOL_GROUPS as readonly string[]).includes(value);
}

function parseByteCount(raw: string | undefined, flag: string, fallback: number): number {
  if (raw === undefined) {
    return fallback;
  }
  const parsedValue = Number(raw);
  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    throw new ConfigError(`${flag} must be a positive integer, got "${raw}"`);
  }
  return parsedValue;
}

/** Usage text for `--help`. */
export function usage(): string {
  return `documonster-mcp — Model Context Protocol server for documonster

Usage:
  documonster-mcp [options]

Options:
  --root <dir>                Sandbox root. Every path a tool touches must
                              resolve inside it. Read-only by default.
  --output-root <dir>         Separate writable root. Default: a private 0700
                              temporary directory. Outputs are addressed as
                              @output/<path> in later tool calls.
  --allow-in-place            Permit explicit in-place edits under --root.
                              Off by default; weakens the filesystem boundary.
  --readonly                  Withhold every mutating tool.
  --enable <groups>           Comma-separated tool groups to expose.
                              Known: ${TOOL_GROUPS.join(", ")}. "core" is always on.
                              Default: all.
  --max-file-size <bytes>     Reject larger input documents. Default: ${DEFAULT_MAX_FILE_SIZE}.
  --max-output-chars <n>      Truncate tool output. Default: ${DEFAULT_MAX_OUTPUT_CHARS}.
  -h, --help                  Show this help.
  -v, --version               Show version.

Transport: stdio. Point an MCP client at this command, for example

  {
    "mcpServers": {
      "documonster": {
        "command": "npx",
        "args": ["-y", "@documonster/mcp", "--root", "/path/to/documents"]
      }
    }
  }
`;
}
