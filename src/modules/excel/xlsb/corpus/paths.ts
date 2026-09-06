/**
 * Where the pinned corpus is cached.
 *
 * Its own module because the fetch script and the gate that reads it must agree, and a path duplicated
 * in two files is a path that eventually is not the same path. Under `tmp/`, which is gitignored: the
 * fixtures are third-party binaries that are deliberately not committed.
 */
export const XLSB_CORPUS_CACHE = "tmp/xlsb-corpus";
