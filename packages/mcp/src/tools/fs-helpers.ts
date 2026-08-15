/**
 * Filesystem helpers shared by the write tools.
 *
 * Centralised because every tool that edits a user's file needs the same three
 * behaviours, and six divergent copies is six chances to get one of them wrong:
 * do not clobber silently, do not lose the original, and never leave a
 * half-written file behind.
 */

import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  rename,
  rm,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";

import { McpToolError } from "../errors.js";
import type { WriteTarget } from "../sandbox.js";

/** True when a path exists. A missing file is not an error here. */
export async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a write target's parent directory.
 *
 * Needed because a model naturally writes `out/report.xlsx` without first
 * checking that `out` exists, and none of the underlying writers create it.
 */
export async function ensureParent(target: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
}

/** Byte size of a file. */
export async function sizeOf(target: string): Promise<number> {
  return (await stat(target)).size;
}

/** Minimal optimistic-concurrency token for a file being edited. */
export interface FileFingerprint {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ino: number;
}

/** Capture the version a tool is about to read and edit. */
export async function fingerprint(target: string): Promise<FileFingerprint> {
  const current = await stat(target);
  return { size: current.size, mtimeMs: current.mtimeMs, ino: current.ino };
}

/**
 * Refuse to overwrite a file another process changed while this tool worked.
 *
 * This closes the common lost-update race: read A, somebody saves B, then this
 * tool writes an output derived from A over B. Node cannot bind every later
 * operation to an `openat` directory descriptor cross-platform, but a version
 * check immediately before backup/install prevents accidental concurrent edits
 * from being silently discarded.
 */
export async function assertUnchanged(target: string, expected: FileFingerprint): Promise<void> {
  const current = await fingerprint(target);
  if (
    current.size !== expected.size ||
    current.mtimeMs !== expected.mtimeMs ||
    current.ino !== expected.ino
  ) {
    throw new McpToolError(
      "invalid_input",
      "the input file changed while this operation was running",
      {
        hint: "Nothing was written. Read the latest file and retry so another process's changes are not lost."
      }
    );
  }
}

/**
 * Write bytes to `target` with atomic POSIX replacement / Windows rollback.
 *
 * The naive `writeFile(target, bytes)` truncates the destination before the new
 * content is complete, so a serialization error, a full disk or a killed
 * process destroys the user's file — which is precisely the outcome the
 * "atomic" claim in the edit tools is supposed to rule out. Writing a sibling
 * temporary file and renaming it makes the replacement a single filesystem
 * operation on POSIX: either the old file or the new one, never a truncated
 * hybrid. Windows uses the rollback-safe two-rename path described below.
 *
 * The temporary file is a sibling rather than in the OS temp directory so the
 * rename stays within one filesystem; `rename` across devices fails with
 * `EXDEV`.
 */
export async function writeFileAtomic(target: string, bytes: Uint8Array | string): Promise<void> {
  const temporary = await createPrivateTemporary(target);
  try {
    await writeFile(temporary, bytes);
    await preserveMode(target, temporary);
    await replaceInstalledFile(temporary, target);
  } finally {
    await rm(path.dirname(temporary), { recursive: true, force: true });
  }
}

/**
 * Run `produce` to build a file's new bytes, then replace `target` atomically.
 *
 * Used where a library insists on writing to a path itself: it writes to the
 * temporary sibling and the rename happens only after it returns successfully.
 */
export async function replaceAtomically(
  target: string,
  produce: (temporaryPath: string) => Promise<void>
): Promise<void> {
  const temporary = await createPrivateTemporary(target);
  try {
    await produce(temporary);
    await preserveMode(target, temporary);
    await replaceInstalledFile(temporary, target);
  } finally {
    await rm(path.dirname(temporary), { recursive: true, force: true });
  }
}

/**
 * Install a complete file only when `target` does not already exist.
 *
 * A pre-check followed by rename has a race: another process can create the
 * target in between and POSIX rename will silently replace it. `link` is an
 * atomic no-clobber operation on the same filesystem: it either installs the
 * already-complete inode or fails with EEXIST.
 */
export async function writeFileNoClobber(
  target: string,
  produce: (temporaryPath: string) => Promise<void>
): Promise<void> {
  const temporary = await createPrivateTemporary(target);
  try {
    await produce(temporary);
    await link(temporary, target);
    await unlink(temporary);
  } finally {
    await rm(path.dirname(temporary), { recursive: true, force: true });
  }
}

/** Select atomic replace or atomic no-clobber from a public overwrite flag. */
export async function writeWithPolicy(
  target: string,
  overwrite: boolean,
  produce: (temporaryPath: string) => Promise<void>
): Promise<void> {
  if (overwrite) {
    await replaceAtomically(target, produce);
  } else {
    try {
      await writeFileNoClobber(target, produce);
    } catch (cause) {
      if ((cause as { code?: string }).code === "EEXIST") {
        throw new McpToolError("invalid_input", `${target} already exists`, {
          hint: "Pass overwrite: true to replace it, or choose a different path.",
          cause
        });
      }
      throw cause;
    }
  }
}

/** Byte/string counterpart of {@link writeWithPolicy}. */
export async function writeBytesWithPolicy(
  target: string,
  overwrite: boolean,
  bytes: Uint8Array | string
): Promise<void> {
  await writeWithPolicy(target, overwrite, temporary => writeFile(temporary, bytes));
}

/** A random, private sibling temporary path on the target filesystem. */
async function createPrivateTemporary(target: string): Promise<string> {
  await ensureParent(target);
  const directory = await mkdtemp(path.join(path.dirname(target), ".documonster-"));
  // mkdtemp normally uses 0700; enforce it so a permissive umask or platform
  // implementation cannot expose a document while it is being written.
  await chmod(directory, 0o700);
  return path.join(directory, path.basename(target));
}

/** Carry the original file's Unix permissions onto its replacement. */
async function preserveMode(target: string, temporary: string): Promise<void> {
  try {
    const current = await stat(target);
    await chmod(temporary, current.mode & 0o777);
  } catch (cause) {
    if ((cause as { code?: string }).code !== "ENOENT") {
      throw cause;
    }
  }
}

/**
 * Replace an installed file.
 *
 * POSIX rename atomically replaces an existing file. Windows commonly refuses
 * that operation, so use a rollback rename there: the target is never deleted,
 * and a failure to install the new file restores the old one.
 */
async function replaceInstalledFile(temporary: string, target: string): Promise<void> {
  if (process.platform !== "win32" || !(await exists(target))) {
    await rename(temporary, target);
    return;
  }

  const rollback = `${target}.rollback-${process.pid.toString(36)}-${Date.now().toString(36)}`;
  await rename(target, rollback);
  try {
    await rename(temporary, target);
    await rm(rollback, { force: true });
  } catch (cause) {
    await rename(rollback, target).catch(() => undefined);
    throw cause;
  }
}

/**
 * Copy the original aside before an in-place edit.
 *
 * Never overwrites an existing backup. A second edit would otherwise replace the
 * only copy of the user's original with the output of the first edit, which
 * defeats the purpose — the `.bak` a user reaches for is the pristine one, not
 * the previous intermediate state. Later backups get a numbered suffix.
 *
 * @returns The path written, or `undefined` when the source does not exist.
 */
export async function backupOnce(target: WriteTarget): Promise<string | undefined> {
  if (!(await exists(target.path))) {
    return undefined;
  }

  const chosen = await firstFreeBackupPath(target.backupPath);
  // COPYFILE_EXCL: fail rather than follow or overwrite anything that appeared
  // between the check above and this call.
  await copyFile(target.path, chosen, constants.COPYFILE_EXCL);
  return chosen;
}

async function firstFreeBackupPath(base: string): Promise<string> {
  if (!(await exists(base))) {
    return base;
  }
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}.${index}`;
    if (!(await exists(candidate))) {
      return candidate;
    }
  }
  throw new Error(`could not find a free backup filename beside ${base}`);
}

/** Describe a backup for a tool's report, relative to the caller's own path. */
export function describeBackup(display: string, backupPath: string | undefined): string[] {
  if (backupPath === undefined) {
    return [];
  }
  return [
    `- original copied to ${display}${backupPath.endsWith(".bak") ? ".bak" : `.bak (${path.basename(backupPath)})`}`
  ];
}

/**
 * True when two resolved paths denote the same file.
 *
 * `out: "./report.xlsx"` resolves to the same file as `path: "report.xlsx"`, and
 * a tool that decides "in place or not" by asking whether `out` was supplied
 * would then skip the backup while still overwriting the input.
 */
export function isSameFile(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

/**
 * Refuse an input document larger than the configured ceiling.
 *
 * `doc_inspect` tells the model that an oversized file "will be rejected", so
 * every tool that opens a document has to honour that — otherwise the limit is
 * advice, and a single huge file can exhaust the server's memory.
 */
export async function assertReadableSize(
  config: { readonly maxFileSize: number },
  target: string,
  display: string
): Promise<number> {
  const size = await sizeOf(target);
  if (size > config.maxFileSize) {
    throw new McpToolError(
      "too_large",
      `${display} is ${size} bytes, over the ${config.maxFileSize} byte limit`,
      {
        hint: "Ask the user to raise --max-file-size, or work with a smaller extract of the document."
      }
    );
  }
  return size;
}
