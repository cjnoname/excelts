/**
 * `typesVersions` must mirror the `exports` map.
 *
 * ## Why this needs a check
 *
 * `exports` carries a `types` condition, which is what a consumer on
 * `moduleResolution: "node16"` / `"nodenext"` / `"bundler"` reads. A consumer on
 * the older `node10` algorithm ignores `exports` entirely and resolves
 * `documonster/word` by looking for `word/index.d.ts` on disk — which does not
 * exist, because everything ships under `dist/`. `typesVersions` is the only way
 * to point those consumers at the right declaration file, so a subpath missing
 * from it type-checks for some users and fails with `TS2307` for others.
 *
 * Nothing about that failure shows up in this repository's own builds, and that is
 * exactly why it drifted: `./zip` was renamed to `./archive` in f5b3efbb, the
 * `typesVersions` key was left behind, and the result was a mapping for a subpath
 * that no longer existed next to a subpath with no mapping at all. `excel` and
 * `draw` were never listed either.
 *
 * Usage: node scripts/verify-types-versions.ts
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

/** The parts of the manifest this check reads. */
export interface TypesVersionsManifest {
  readonly exports: Record<string, unknown>;
  readonly typesVersions: Record<string, Record<string, readonly string[]>>;
}

/**
 * Every way the two maps can disagree, as human-readable problems.
 *
 * Split from the CLI so a test can drive it: a check that never fires is worse than no
 * check, and the only way to know this one fires is to hand it manifests that are wrong
 * on purpose. `scripts/` is outside the typed project, so the test runs this file as a
 * subprocess against a temporary manifest rather than importing it — see
 * `verify-types-versions.test.ts`.
 *
 * Reads `--manifest <path>` when given, so that test can point it at a fixture.
 */
export function typesVersionsProblems(manifest: TypesVersionsManifest, root?: string): string[] {
  // `./package.json` is a file, not an entry point, and the root `.` export — if one
  // is ever added — is resolved by `types` in the manifest rather than by subpath.
  const subpaths = Object.keys(manifest.exports)
    .filter(key => key.startsWith("./") && key !== "./package.json")
    .map(key => key.slice(2));
  const mapped = manifest.typesVersions?.["*"] ?? {};
  const problems: string[] = [];

  for (const subpath of subpaths) {
    const target = mapped[subpath];
    if (!target || target.length === 0) {
      problems.push(
        `exports has "./${subpath}" but typesVersions does not — consumers on ` +
          `moduleResolution "node10" will fail to find its types.`
      );
      continue;
    }
    for (const file of target) {
      if (!file.startsWith("dist/types/") || !file.endsWith(".d.ts")) {
        problems.push(
          `typesVersions["${subpath}"] points at "${file}", which is not a ` +
            `dist/types declaration.`
        );
        continue;
      }
      // Checking the shape catches a typo; checking the target catches a rename that
      // moved the declaration, and a subpath pointed at the wrong one. `pnpm check`
      // builds types before running this, so the files are there to look at — and when
      // they are not, the shape check above is all that can be said.
      if (root !== undefined && existsSync(path.join(root, file))) {
        const declared = declarationOf(manifest, subpath);
        if (declared !== undefined && declared !== file) {
          problems.push(
            `typesVersions["${subpath}"] points at "${file}" but its exports entry ` +
              `declares "${declared}" — the two must name the same declaration.`
          );
        }
      } else if (root !== undefined && !existsSync(path.join(root, "dist", "types"))) {
        // No build to compare against; the shape check stands on its own.
      } else if (root !== undefined) {
        problems.push(`typesVersions["${subpath}"] points at "${file}", which does not exist.`);
      }
    }
  }

  for (const subpath of Object.keys(mapped)) {
    if (!subpaths.includes(subpath)) {
      problems.push(
        `typesVersions has "${subpath}" but exports does not — a stale mapping, ` +
          `usually left behind by a rename.`
      );
    }
  }

  return problems;
}

/**
 * The declaration an `exports` entry names for the Node import condition.
 *
 * `typesVersions` and `exports` are two answers to the same question — where a
 * consumer's types are — so they have to agree. A rename that updates one and not the
 * other leaves older TypeScript resolving a different file from every other toolchain.
 */
function declarationOf(manifest: TypesVersionsManifest, subpath: string): string | undefined {
  const entry = manifest.exports[`./${subpath}`];
  if (typeof entry !== "object" || entry === null) {
    return undefined;
  }
  const importEntry = (entry as Record<string, unknown>).import;
  if (typeof importEntry !== "object" || importEntry === null) {
    return undefined;
  }
  const types = (importEntry as Record<string, unknown>).types;
  return typeof types === "string" ? types.replace(/^\.\//, "") : undefined;
}

/** Read the repository's own manifest and report. Exits non-zero on any problem. */
function main(): void {
  const flag = process.argv.indexOf("--manifest");
  const file = flag === -1 ? path.join(ROOT, "package.json") : process.argv[flag + 1];
  const manifest = JSON.parse(readFileSync(file, "utf8")) as TypesVersionsManifest;
  // Declarations are always resolved against the repository, whichever manifest was
  // read: a fixture describes the mapping, not a different `dist/`.
  const problems = typesVersionsProblems(manifest, ROOT);
  if (problems.length > 0) {
    console.error("typesVersions does not mirror exports:\n");
    for (const problem of problems) {
      console.error(`  - ${problem}`);
    }
    process.exit(1);
  }
  const count = Object.keys(manifest.exports).filter(
    key => key.startsWith("./") && key !== "./package.json"
  ).length;
  console.log(`\u2713 typesVersions mirrors exports — ${count} subpaths mapped.`);
}

// Only run when invoked directly, so importing it for tests does not exit the process.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main();
}
