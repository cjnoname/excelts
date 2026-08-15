/**
 * `archive_read` — list or extract a ZIP/TAR archive.
 *
 * The entry point to most real work: documents arrive as email attachments and
 * export bundles, and a model cannot open a binary container by itself. It is
 * also where the security surface is widest, so three guards apply beyond the
 * generic path sandbox:
 *
 * 1. **Traversal, including through existing links.** Entries are written one at
 *    a time and every destination goes through `resolveInRoot`, so an entry name
 *    with `..` is rejected *and* so is an entry whose path passes through a
 *    symlink already sitting in the destination directory. Delegating to the
 *    library's `extractTo` was not enough: it validates entry names against the
 *    target directory but writes through a pre-existing `out/link -> /elsewhere`,
 *    which was verified to escape the sandbox.
 * 2. **Decompression bombs** — the archive file's own size is checked before it
 *    is opened, and the declared uncompressed sizes before anything is written.
 * 3. **Symlink and special entries** — never materialised. A `link ->
 *    /etc/passwd` entry would otherwise leave a live escape hatch inside the
 *    sandbox for a later tool to follow.
 * 4. **Permissions** — extracted files get the process default rather than the
 *    archive's mode bits, so an untrusted archive cannot produce something
 *    executable or world-writable.
 *
 * Encryption is not reported when listing: `ArchiveEntryInfo` carries an
 * `isEncrypted` flag at runtime but does not declare it, and this package reads
 * only documented public surface. Encryption therefore surfaces as a failed
 * extraction with a hint to pass `password`. (Worth declaring upstream.)
 */

import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { Archive, ArchiveFile } from "documonster/archive";
import { z } from "zod";

import type { ServerConfig } from "../config.js";
import { McpToolError, toolError } from "../errors.js";
import { assertWritable, resolveInRoot, resolveOutputPath } from "../sandbox.js";
import { ensureParent, exists, writeWithPolicy } from "./fs-helpers.js";
import { formatBytes, textResult } from "./result.js";
import { defineTool } from "./types.js";

/** Entries listed in one call. */
const MAX_LISTED = 300;

/** Total uncompressed bytes allowed in one extraction (256 MiB). */
const MAX_TOTAL_EXTRACTED = 256 * 1024 * 1024;

/** Entry count allowed in one extraction. */
const MAX_ENTRIES = 5_000;

export const archiveReadTool = defineTool({
  name: "archive_read",
  group: "archive",
  title: "List or extract an archive",
  description:
    "List the contents of a .zip/.tar/.tar.gz, or extract entries to a directory. Start with action 'list' to see what is inside, then extract only what you need. Encrypted archives are supported with a password. Symlink entries are never created.",
  inputSchema: {
    path: z.string().min(1).describe("Archive path, relative to the server root."),
    action: z
      .enum(["list", "extract"])
      .optional()
      .describe("'list' (default) reports the entries; 'extract' writes them to `out`."),
    out: z
      .string()
      .optional()
      .describe(
        "Destination directory for extract, relative to the server root. Created if missing."
      ),
    entries: z
      .array(z.string())
      .optional()
      .describe(
        'Extract only these entry paths, or glob-ish prefixes/suffixes such as "data/" or "*.xlsx". Omit to extract everything.'
      ),
    password: z.string().optional().describe("Password for an encrypted archive."),
    overwrite: z
      .boolean()
      .optional()
      .describe(
        "Replace files that already exist in `out`. Defaults to false so an extraction cannot silently clobber a working directory."
      ),
    format: z
      .enum(["zip", "tar"])
      .optional()
      .describe("Container format. Inferred from the extension when omitted.")
  },
  // destructiveHint: extraction replaces files that already exist at the
  // destination, which a client should be able to warn about.
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  // Listing is read-only and useful on a read-only server; extraction calls
  // assertWritable before touching disk. MCP annotations cannot vary by action,
  // so they conservatively describe the destructive branch.
  mutates: false,
  handler: async (args, context) => {
    const { config } = context;
    const archivePath = await resolveInRoot(config, args.path, { mustExist: true });
    const action = args.action ?? "list";

    // Before opening: the reader loads the container into memory, and a .tar.gz
    // is inflated during that call, so a bomb must be refused on its on-disk
    // size first — checking the declared entry sizes afterwards is too late.
    const archiveBytes = (await stat(archivePath)).size;
    if (archiveBytes > config.maxFileSize) {
      throw toolError.tooLarge(
        `${args.path} is ${formatBytes(archiveBytes)}, over the ${formatBytes(config.maxFileSize)} limit`,
        "Ask the user to raise --max-file-size if this archive is genuinely needed."
      );
    }

    const archive = await open(archivePath, args.path, args.format, args.password);
    const entries = await archive.getEntries();

    if (action === "list") {
      return textResult(config, describeEntries(args.path, entries));
    }

    assertWritable(config);

    if (args.out === undefined) {
      throw toolError.invalidInput(
        "extract requires `out`",
        'Pass a destination directory, e.g. out: "extracted".'
      );
    }

    let selected =
      args.entries === undefined
        ? entries
        : entries.filter(entry => matches(entry.path, args.entries ?? []));

    if (selected.length === 0) {
      throw toolError.invalidInput(
        `no entries matched ${JSON.stringify(args.entries)}`,
        `The archive contains: ${entries
          .slice(0, 20)
          .map(entry => entry.path)
          .join(", ")}`
      );
    }

    assertNoBomb(selected, config);

    // ArchiveFile's format-neutral entry type loses ZIP's file/symlink bit.
    // Recover it from the public streaming reader, or a ZIP symlink is exposed
    // as an ordinary 11-byte file and would be written despite our "skip
    // special entries" promise.
    const special =
      inferFormat(archivePath) === "zip"
        ? await zipSpecialEntries(archivePath, args.password)
        : tarSpecialEntries(entries);
    selected = selected.filter(entry => !special.has(entry.path));

    // Validate the destination directory itself, even when no entry ends up
    // being written: `out: "../elsewhere"` must fail rather than silently
    // succeed on an archive that happens to contain only directories.
    const target = await resolveOutputPath(config, args.out);
    const warnings: string[] = [];
    let written = 0;
    let bytesWritten = 0;

    // Validate every destination and overwrite decision before reading or
    // writing the first byte. This prevents a late traversal entry from leaving
    // earlier existing files replaced.
    const destinations = new Map<string, string>();
    for (const entry of selected) {
      if (entry.isDirectory) {
        continue;
      }
      try {
        const destination = await resolveOutputPath(config, path.posix.join(args.out, entry.path));
        if (args.overwrite !== true && (await exists(destination))) {
          throw toolError.invalidInput(
            `extraction would overwrite ${path.posix.join(args.out, entry.path)}`,
            "Pass overwrite: true to replace existing files, or choose an empty destination. Nothing was written."
          );
        }
        destinations.set(entry.path, destination);
      } catch (cause) {
        if (cause instanceof McpToolError && cause.code === "outside_root") {
          throw toolError.invalidInput(
            `extraction aborted: entry ${JSON.stringify(entry.path)} would be written outside the server root`,
            "Either the archive contains a traversal path, or the destination directory contains a symlink that leaves the sandbox. Nothing was written."
          );
        }
        throw cause;
      }
    }

    // Decrypt/decompress every selected entry into a private staging directory
    // before installing any output. A wrong password or corrupt late entry can
    // then fail without leaving a half-extracted tree.
    await ensureParent(target);
    const staging = await mkdtemp(path.join(path.dirname(target), ".documonster-extract-"));

    try {
      for (const [stagingIndex, entry] of selected.entries()) {
        if (entry.isDirectory) {
          continue;
        }
        let bytes: Uint8Array | null;
        try {
          bytes = await archive.readEntry(entry.path, args.password);
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          throw toolError.unsupported(
            `could not read entry ${JSON.stringify(entry.path)}: ${message}`,
            /password|encrypt|decrypt/i.test(message)
              ? "The archive is encrypted; pass `password`. Nothing was written."
              : "Nothing was written.",
            { cause }
          );
        }
        if (bytes === null) {
          warnings.push(`${entry.path}: no data (skipped)`);
          destinations.delete(entry.path);
          continue;
        }
        // The numeric directory makes duplicate basenames (`a/x.txt`,
        // `b/x.txt`) distinct in staging.
        const staged = path.join(staging, String(stagingIndex), path.basename(entry.path));
        await ensureParent(staged);
        await writeFile(staged, bytes);
        destinations.set(entry.path, `${destinations.get(entry.path)}\0${staged}`);
        bytesWritten += bytes.byteLength;
      }

      for (const encoded of destinations.values()) {
        const separator = encoded.indexOf("\0");
        const destination = encoded.slice(0, separator);
        const staged = encoded.slice(separator + 1);
        await writeWithPolicy(destination, args.overwrite === true, temporary =>
          copyFile(staged, temporary)
        );
        written += 1;
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }

    const lines = [
      `Extracted **${written}** entr${written === 1 ? "y" : "ies"} from ${args.path} to @output/${args.out}/`,
      `- total written: ${formatBytes(bytesWritten)}`,
      "- symlink and special entries were skipped, and file modes were not preserved",
      "",
      ...selected
        .filter(entry => !entry.isDirectory)
        .slice(0, MAX_LISTED)
        .map(
          entry =>
            `- \`@output/${path.posix.join(args.out ?? "", entry.path)}\` — ${formatBytes(entry.size)}`
        )
    ];
    if (selected.length > MAX_LISTED) {
      lines.push(`- [${selected.length - MAX_LISTED} more not listed]`);
    }
    if (warnings.length > 0) {
      lines.push("", "Warnings:", ...warnings.slice(0, 20).map(warning => `- ${warning}`));
    }
    lines.push("", "Inspect an extracted file with doc_inspect before reading it.");

    return textResult(config, lines.join("\n"));
  }
});

type ArchiveEntry = Awaited<ReturnType<ArchiveFile["getEntries"]>>[number];

async function open(
  archivePath: string,
  displayPath: string,
  format: "zip" | "tar" | undefined,
  password: string | undefined
): Promise<ArchiveFile<"zip"> | ArchiveFile<"tar">> {
  const resolvedFormat = format ?? inferFormat(archivePath);
  try {
    if (resolvedFormat === "tar") {
      return await ArchiveFile.fromFile(archivePath, { format: "tar" });
    }
    return await ArchiveFile.fromFile(archivePath, password === undefined ? {} : { password });
  } catch (cause) {
    throw toolError.unsupported(
      `could not open ${displayPath} as a ${resolvedFormat} archive`,
      "Run doc_inspect to confirm the container format, and pass `format` explicitly if the extension is misleading.",
      { cause }
    );
  }
}

/** `.tar` / `.tgz` / `.tar.gz` are tar; everything else is treated as zip. */
function inferFormat(archivePath: string): "zip" | "tar" {
  const lower = archivePath.toLowerCase();
  return lower.endsWith(".tar") || lower.endsWith(".tgz") || lower.endsWith(".tar.gz")
    ? "tar"
    : "zip";
}

/** Entry paths whose ZIP type is not a regular file or directory. */
async function zipSpecialEntries(
  archivePath: string,
  password: string | undefined
): Promise<ReadonlySet<string>> {
  const reader = Archive.unzip(new Uint8Array(await readFile(archivePath)), {
    ...(password === undefined ? {} : { password })
  });
  const special = new Set<string>();
  for await (const entry of reader.entries()) {
    if (entry.type !== "file" && entry.type !== "directory") {
      special.add(entry.path);
    }
    entry.discard();
  }
  return special;
}

/** TAR exposes its special-entry type on the format-neutral info object. */
function tarSpecialEntries(entries: readonly ArchiveEntry[]): ReadonlySet<string> {
  return new Set(
    entries
      .filter(entry => {
        const type = entry.type;
        return type !== undefined && type !== "file" && type !== "directory";
      })
      .map(entry => entry.path)
  );
}

function describeEntries(displayPath: string, entries: readonly ArchiveEntry[]): string {
  const files = entries.filter(entry => !entry.isDirectory);
  const lines = [
    `# Archive: ${displayPath}`,
    "",
    `- entries: ${entries.length} (${files.length} file(s))`,
    `- total uncompressed: ${formatBytes(totalSize(files))}`,
    ""
  ];

  lines.push("| entry | size |", "| --- | --- |");
  for (const entry of entries.slice(0, MAX_LISTED)) {
    lines.push(
      `| \`${entry.path}${entry.isDirectory ? "/" : ""}\` | ${entry.isDirectory ? "—" : formatBytes(entry.size)} |`
    );
  }
  if (entries.length > MAX_LISTED) {
    lines.push("", `[${entries.length - MAX_LISTED} more entries not listed]`);
  }

  lines.push("", 'Extract what you need with `action: "extract"` and an `out` directory.');
  return lines.join("\n");
}

function totalSize(entries: readonly ArchiveEntry[]): number {
  return entries.reduce((sum, entry) => sum + (entry.isDirectory ? 0 : entry.size), 0);
}

/**
 * Refuse a decompression bomb before writing anything.
 *
 * Sizes come from the archive's own directory, so a lying archive could still
 * under-report; the per-entry check against `--max-file-size` limits the damage
 * a single entry can do, and the total is what stops a thousand small ones.
 */
function assertNoBomb(entries: readonly ArchiveEntry[], config: ServerConfig): void {
  if (entries.length > MAX_ENTRIES) {
    throw toolError.tooLarge(
      `the selection has ${entries.length} entries, over the ${MAX_ENTRIES} limit`,
      "Narrow the `entries` filter to the files you actually need."
    );
  }

  const total = totalSize(entries);
  if (total > MAX_TOTAL_EXTRACTED) {
    throw toolError.tooLarge(
      `extracting would write ${formatBytes(total)}, over the ${formatBytes(MAX_TOTAL_EXTRACTED)} limit`,
      "Narrow the `entries` filter."
    );
  }

  for (const entry of entries) {
    if (!entry.isDirectory && entry.size > config.maxFileSize) {
      throw toolError.tooLarge(
        `entry ${JSON.stringify(entry.path)} is ${formatBytes(entry.size)}, over the per-file limit of ${formatBytes(config.maxFileSize)}`,
        "Exclude it, or ask the user to raise --max-file-size."
      );
    }
  }
}

/**
 * Match an entry against caller-supplied selectors.
 *
 * Supports exact paths, `dir/` prefixes and `*.ext` suffixes — the three shapes
 * a model reaches for. Not a full glob, and deliberately so: a half-working
 * glob is worse than a documented small set.
 */
function matches(entryPath: string, selectors: readonly string[]): boolean {
  return selectors.some(selector => {
    if (selector.startsWith("*.")) {
      return entryPath.toLowerCase().endsWith(selector.slice(1).toLowerCase());
    }
    if (selector.endsWith("/")) {
      return entryPath.startsWith(selector);
    }
    return entryPath === selector;
  });
}
