/**
 * `archive_write` — package files into an archive.
 *
 * Closes the loop that `archive_read` opens. A session that unpacked an archive,
 * analysed it and produced several outputs needs to hand back one file, and a
 * model cannot assemble a binary container itself. Small tool, high value.
 */

import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { ArchiveFile } from "documonster/archive";
import { z } from "zod";

import type { ServerConfig } from "../config.js";
import { toolError } from "../errors.js";
import { assertWritable, outputDisplay, resolveInRoot, resolveOutputPath } from "../sandbox.js";
import { writeWithPolicy } from "./fs-helpers.js";
import { formatBytes, textResult } from "./result.js";
import { defineTool } from "./types.js";

/** Files one archive may contain. */
const MAX_FILES = 5_000;

/** Total input bytes allowed in one archive (512 MiB). */
const MAX_TOTAL_INPUT = 512 * 1024 * 1024;

export const archiveWriteTool = defineTool({
  name: "archive_write",
  group: "archive",
  title: "Create an archive",
  description:
    "Package files and directories into a .zip or .tar. Use it to hand a set of produced documents back as one file. Directories are added recursively. Every input must be inside the server root.",
  inputSchema: {
    out: z
      .string()
      .min(1)
      .describe(
        "Archive path to create below --output-root. The result is returned as @output/<path>. The extension chooses .zip or .tar."
      ),
    entries: z
      .array(
        z.object({
          path: z
            .string()
            .min(1)
            .describe("File or directory to add, relative to the server root."),
          as: z
            .string()
            .optional()
            .describe(
              "Name inside the archive. For a directory this is the prefix. Defaults to the base name."
            )
        })
      )
      .min(1)
      .describe("Files and directories to include."),
    overwrite: z
      .boolean()
      .optional()
      .describe("Replace the archive if it exists. Defaults to false.")
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false
  },
  mutates: true,
  handler: async (args, context) => {
    const { config } = context;
    assertWritable(config);

    const format = formatFor(args.out);
    const target = await resolveOutputPath(config, args.out);

    // Resolve and measure everything before creating the archive, so a bad
    // entry fails before any file is written.
    //
    // Entry names are validated too: an archive is data we hand to someone else,
    // and `as: "../../escape.txt"` would make this tool the *producer* of a Zip
    // Slip payload. Neither the ZIP nor the TAR writer rejects it.
    const resolvedEntries = await Promise.all(
      args.entries.map(async entry => {
        const resolved = await resolveInRoot(config, entry.path, { mustExist: true });
        const stats = await stat(resolved);
        return {
          resolved,
          display: entry.path,
          name: assertSafeEntryName(entry.as ?? path.basename(entry.path)),
          isDirectory: stats.isDirectory(),
          size: stats.isDirectory() ? 0 : stats.size
        };
      })
    );

    await assertWithinBudget(resolvedEntries, config);

    // Branch rather than holding a union: ArchiveFile is generic in its format,
    // and `ArchiveFile<"zip"> | ArchiveFile<"tar">` collapses to `never` on any
    // shared method because the `format` field conflicts.
    try {
      // "overwrite" is safe here only because the archive is built into a
      // temporary sibling and renamed into place; the caller's `overwrite: false`
      // was enforced above, and the rename is what makes the replacement atomic
      // rather than a truncate-then-fill.
      await writeWithPolicy(target, args.overwrite === true, async temporary => {
        if (format === "tar") {
          const archive = new ArchiveFile({ format: "tar" });
          addAll(archive, resolvedEntries);
          await archive.writeToFile(temporary, { overwrite: "overwrite" });
        } else {
          const archive = new ArchiveFile();
          addAll(archive, resolvedEntries);
          await archive.writeToFile(temporary, { overwrite: "overwrite" });
        }
      });
    } catch (cause) {
      throw toolError.unsupported(
        `could not write the archive: ${cause instanceof Error ? cause.message : String(cause)}`,
        undefined,
        { cause }
      );
    }

    // Read it back and report the real entry list — "wrote 4 KB" says nothing
    // about whether the archive contains what was intended.
    const entries =
      format === "tar"
        ? await (await ArchiveFile.fromFile(target, { format: "tar" })).getEntries()
        : await (await ArchiveFile.fromFile(target)).getEntries();
    const files = entries.filter(entry => !entry.isDirectory);
    const size = (await stat(target)).size;

    return textResult(
      config,
      [
        `Created **${outputDisplay(args.out)}** (${format}, ${formatBytes(size)}) containing ${files.length} file(s).`,
        "",
        "| entry | size |",
        "| --- | --- |",
        ...entries
          .slice(0, 200)
          .map(
            entry =>
              `| \`${entry.path}${entry.isDirectory ? "/" : ""}\` | ${entry.isDirectory ? "—" : formatBytes(entry.size)} |`
          ),
        ...(entries.length > 200 ? ["", `[${entries.length - 200} more not listed]`] : []),
        "",
        "Verified by reading the archive back."
      ].join("\n")
    );
  }
});

/**
 * Reject an archive entry name that would escape on extraction.
 *
 * Absolute paths, `..` segments and Windows drive letters are all refused, and
 * separators are normalised to the forward slashes an archive uses.
 */
function assertSafeEntryName(name: string): string {
  const normalised = name.replace(/\\/g, "/").replace(/^\/+/, "").trim();

  if (normalised.length === 0) {
    throw toolError.invalidInput("an entry name cannot be empty");
  }
  if (/^[a-zA-Z]:/.test(normalised)) {
    throw toolError.invalidInput(
      `entry name ${JSON.stringify(name)} must not be an absolute Windows path`
    );
  }
  if (normalised.split("/").some(segment => segment === "..")) {
    throw toolError.invalidInput(
      `entry name ${JSON.stringify(name)} must not contain ".."`,
      "Entry names are relative paths inside the archive. A `..` would make the archive unsafe for whoever extracts it."
    );
  }
  return normalised;
}

/** `.tar` is tar; `.zip` is zip; anything else is rejected by name. */
function formatFor(out: string): "zip" | "tar" {
  const extension = path.extname(out).toLowerCase();
  if (extension === ".tar") {
    return "tar";
  }
  if (extension === ".zip") {
    return "zip";
  }
  throw toolError.invalidInput(
    `cannot tell the archive format from ${JSON.stringify(out)}`,
    "Use a .zip or .tar extension. Compressed tarballs (.tar.gz) are not produced yet."
  );
}

interface ResolvedEntry {
  readonly resolved: string;
  readonly display: string;
  readonly name: string;
  readonly isDirectory: boolean;
  readonly size: number;
}

/** Add every entry to an archive of either format. */
function addAll(
  archive: ArchiveFile<"zip"> | ArchiveFile<"tar">,
  entries: readonly ResolvedEntry[]
): void {
  for (const entry of entries) {
    if (entry.isDirectory) {
      (archive as ArchiveFile<"zip">).addDirectory(entry.resolved, { prefix: entry.name });
    } else {
      (archive as ArchiveFile<"zip">).addFile(entry.resolved, { name: entry.name });
    }
  }
}

/**
 * Refuse an archive that would read too much.
 *
 * Directories are walked to measure them, because "add this directory" is how a
 * caller accidentally packages a whole workspace.
 */
async function assertWithinBudget(
  entries: readonly ResolvedEntry[],
  config: ServerConfig
): Promise<void> {
  let total = 0;
  let count = 0;

  for (const entry of entries) {
    if (entry.isDirectory) {
      // The per-file cap applies inside a directory as well: "add this folder"
      // is exactly how a caller accidentally packages one enormous file.
      const walked = await measureDirectory(entry.resolved, config, entry.display);
      total += walked.bytes;
      count += walked.files;
    } else {
      if (entry.size > config.maxFileSize) {
        throw toolError.tooLarge(
          `${entry.display} is ${formatBytes(entry.size)}, over the per-file limit of ${formatBytes(config.maxFileSize)}`,
          "Exclude it, or ask the user to raise --max-file-size."
        );
      }
      total += entry.size;
      count += 1;
    }

    if (count > MAX_FILES) {
      throw toolError.tooLarge(
        `the selection contains more than ${MAX_FILES} files`,
        "Name specific files or a narrower directory."
      );
    }
    if (total > MAX_TOTAL_INPUT) {
      throw toolError.tooLarge(
        `the selection totals more than ${formatBytes(MAX_TOTAL_INPUT)}`,
        "Name specific files or a narrower directory."
      );
    }
  }
}

async function measureDirectory(
  dir: string,
  config: ServerConfig,
  display: string
): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;

  const walk = async (current: string): Promise<void> => {
    for (const item of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, item.name);
      if (item.isDirectory()) {
        await walk(full);
      } else if (item.isFile()) {
        const size = (await stat(full)).size;
        if (size > config.maxFileSize) {
          throw toolError.tooLarge(
            `${display}/${path.relative(dir, full)} is ${formatBytes(size)}, over the per-file limit of ${formatBytes(config.maxFileSize)}`,
            "Name specific files instead of the whole directory, or ask the user to raise --max-file-size."
          );
        }
        files += 1;
        bytes += size;
      }
    }
  };

  await walk(dir);
  return { bytes, files };
}
