/**
 * Path helpers shared by the build and verification scripts.
 *
 * Every script here compares paths against strings written by hand — an exceptions
 * map keyed `"modules/csv/parse/config.ts"`, a layer name, an import specifier — and
 * those strings are POSIX because that is what a specifier looks like. `path.relative`
 * is not: on Windows it yields `modules\csv\parse\config.ts`, so an unnormalised
 * comparison silently fails there and nowhere else.
 *
 * That is not hypothetical. `verify-public-types.ts` built its allowlist key straight
 * from `path.relative` and reported all thirty of its deliberate exceptions as
 * violations on the Windows CI leg, which is the only leg that could see it.
 *
 * {@link relPosix} exists so the fix is not a discipline. A script that needs a
 * relative path calls it and cannot forget the second half; sharing only
 * {@link toPosixPath} would have de-duplicated three identical functions without
 * preventing the bug, which was a missing call, not a wrong implementation.
 *
 * Lives under `scripts/` rather than `src/utils/`: these are build-time tools, and
 * putting them in the published tree would make the scripts that audit `src/` depend
 * on it, and would emit a script-only helper into `dist/esm` and `dist/cjs`.
 */

import path from "node:path";

/** Rewrite a native path to POSIX separators. A no-op everywhere but Windows. */
export function toPosixPath(p: string): string {
  return p.split(path.sep).join("/");
}

/** `path.relative`, with the result in the POSIX form every comparison assumes. */
export function relPosix(from: string, to: string): string {
  return toPosixPath(path.relative(from, to));
}
