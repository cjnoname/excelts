#!/usr/bin/env node
/**
 * Run every example and fail if any of them cannot run.
 *
 * Examples are the first thing a consumer copies, so a broken one is a broken
 * public contract. Nothing verified them until this script did: the previous
 * version carried a **hand-written list covering a sixth of the tree**, so the
 * rest was unexecuted, and CI never invoked it at all. The first automated run
 * found six failures — five that could not even resolve their imports and one
 * that hit a real `RangeError: Maximum call stack size exceeded` in the PDF
 * exporter. A list a human maintains is eventually wrong; discovery is not.
 *
 * ## Why `@oxc-node/core` and not `tsx`
 *
 * Examples import through the repository's path aliases (`@excel/index`, …), so
 * the runner has to resolve `tsconfig.json#paths`. `tsx` does that, but it then
 * hands the resolved path to Node's ESM resolver, which treats anything with a
 * dot-suffix as a complete filename — so a specifier ending in `.node` or
 * `.browser` never gets `.ts` appended. That is precisely this repository's
 * platform-variant convention (`archive/io/archive-source.node`,
 * `excel/bridge/markdown-bridge.node`), which is why four archive examples and
 * the markdown workbook example failed with `ERR_MODULE_NOT_FOUND` while the
 * same imports work everywhere else.
 *
 * `node --import @oxc-node/core/register` resolves both — tsconfig `paths` and an
 * extensionless TypeScript target — and transpiles with oxc. Node's own
 * `--experimental-strip-types` is not enough on its own: it is strip-only, and
 * this source tree uses parameter properties (`excel/errors.ts`), which it
 * rejects outright.
 *
 * The package is patched (see `pnpm-workspace.yaml`) to use the synchronous
 * `module.registerHooks()` rather than the deprecated `module.register()`.
 *
 * ## Why child processes
 *
 * Examples are scripts, not modules: they run at import time, several call
 * `process.exit()`, and several read `process.argv`. Importing them into this
 * process would let one of them terminate the run.
 *
 * ## Arguments
 *
 * None are passed. Every example that accepts an output path defaults it to
 * `tmp/` (`process.argv[2] ?? path.join(outDir, …)`), which is where examples
 * are supposed to write. The old list passed paths under
 * `src/modules/excel/examples/data/`, writing generated files into the source
 * tree.
 *
 * ## Where this runs
 *
 * Three layers, because the two failure modes are different. An example broken by
 * *its own* edit is caught before the commit; an example broken by a change to the
 * library it calls needs the whole set, which takes over a minute and therefore
 * does not belong in a hook.
 *
 * | Layer               | Scope                                     |
 * | ------------------- | ----------------------------------------- |
 * | `.husky/pre-commit` | `--changed`: what this commit affects      |
 * | `Examples` CI job   | All of them                               |
 *
 * Deliberately **not** in `pnpm test`: CI runs that across four Node versions and
 * three operating systems, so the full set would be re-verified twelve times to
 * catch failures that are neither version- nor platform-specific.
 *
 * Usage:
 *   node scripts/run-examples.ts                 # all examples
 *   node scripts/run-examples.ts --changed       # only what this commit touches
 *   node scripts/run-examples.ts --filter pdf-   # only paths containing "pdf-"
 *   node scripts/run-examples.ts a.ts b.ts       # only these (validated)
 *   node scripts/run-examples.ts --jobs 1        # serial
 *   node scripts/run-examples.ts --timeout 300   # seconds per example
 *   node scripts/run-examples.ts --list          # print what it would run
 *   node scripts/run-examples.ts --root <dir>    # retarget the tree (tests)
 */
import { execFileSync, spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

import { collectExamples } from "./lib/examples.ts";
import { toPosixPath } from "./lib/paths.ts";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/**
 * `parseArgs` rather than hand-rolled scanning, which also closes a hole: an
 * unrecognised flag used to be ignored in silence, so `--jbos 1` ran the whole
 * set as if nothing had been asked for.
 *
 * `--root <dir>` retargets discovery, the git query and each child's working
 * directory. It exists for the tests, following `verify-doc-links.ts` and
 * `verify-public-types.ts`: a gate that cannot be pointed at a tree built to
 * break it on purpose has never been shown to fire.
 */
const { values: options, positionals } = (() => {
  try {
    return parseArgs({
      options: {
        changed: { type: "boolean" },
        list: { type: "boolean" },
        filter: { type: "string" },
        jobs: { type: "string" },
        timeout: { type: "string" },
        root: { type: "string" }
      },
      allowPositionals: true,
      strict: true
    });
  } catch (error) {
    return fail((error as Error).message);
  }
})();

/**
 * A positive integer, or exit.
 *
 * `Number(...)` alone made a typo silently disable the gate: `--jobs nope`
 * produced `NaN` workers, so nothing ran and the script still reported success.
 * A gate that can be turned off by a typo is not a gate.
 */
function intOption(flag: "jobs" | "timeout", fallback: number): number {
  const raw = options[flag];
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    fail(`--${flag} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

const ROOT = path.resolve(options.root ?? path.resolve(import.meta.dirname, ".."));

/**
 * The examples this commit touches, for the pre-commit hook.
 *
 * Lives here rather than in the hook so there is one definition of "which
 * examples does this change affect". A shell one-liner in the hook drifted from
 * {@link collectExamples} in three ways at once: it missed renames
 * (`--diff-filter=ACM` has no `R`), it could not see a nested or top-level
 * example directory, and passing newline-separated paths through `xargs` split
 * any path containing a space.
 *
 * Two kinds of change select an example:
 *
 * - the example itself changed;
 * - anything else inside an `examples/` directory changed, in which case every
 *   example in that directory runs. A helper is imported only by its neighbours
 *   (`hr-stopwatch`, `self-signed-certificate`) and a fixture is read only by
 *   them, so the directory is the dependency edge and no import graph is needed.
 *   Keying on the directory rather than on `utils/` also means a changed
 *   `examples/data/*.xlsx` re-runs the examples that read it, and keeps the name
 *   `utils` in one place — {@link collectExamples} — instead of two.
 */
function changedExamples(all: string[]): string[] {
  let out: string;
  try {
    // `-z` because a path may contain anything except NUL. `ACMR` includes
    // renames: a renamed *and* edited example must still run.
    out = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"], {
      cwd: ROOT,
      encoding: "utf8"
    });
  } catch (error) {
    fail(`--changed needs a git repository: ${(error as Error).message}`);
  }

  const staged = out.split("\0").filter(Boolean);
  const selected = new Set<string>();
  const known = new Set(all);

  for (const file of staged) {
    if (known.has(file)) {
      selected.add(file);
      continue;
    }
    const dir = /^(.*\/examples)\//.exec(file);
    if (dir) {
      const prefix = `${dir[1]}/`;
      for (const example of all) {
        if (example.startsWith(prefix)) {
          selected.add(example);
        }
      }
    }
  }
  return [...selected].sort();
}

const jobs = intOption("jobs", Math.min(4, availableParallelism()));
const timeoutMs = intOption("timeout", 300) * 1000;

interface Result {
  file: string;
  ok: boolean;
  durationMs: number;
  output: string;
  timedOut: boolean;
}

/**
 * oxc-node's register hook, resolved rather than guessed.
 *
 * Passed to `process.execPath` via `--import` as an absolute URL, not spawned from
 * `node_modules/.bin` and not left as a bare specifier: pnpm writes `.cmd` /
 * `.ps1` shims on Windows where the extensionless POSIX shim is not executable,
 * and a bare specifier would be resolved against the child's cwd, which `--root`
 * can point somewhere without a `node_modules`. `import.meta.resolve` is used
 * rather than `createRequire().resolve` because the package exports `./register`
 * under the `import` condition only.
 * `generate-csv-worker-script.ts` already runs rolldown this way, for the same
 * reason. `npx` is avoided too — it can fetch a different version mid-run.
 */
const OXC_REGISTER = import.meta.resolve("@oxc-node/core/register");

function runExample(file: string): Promise<Result> {
  const startedAt = Date.now();
  return new Promise(resolve => {
    const proc = spawn(process.execPath, ["--import", OXC_REGISTER, file], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      // The example's own `process.argv[2]` must stay empty — see the header.
      env: { ...process.env, NODE_ENV: process.env.NODE_ENV ?? "development" }
    });

    let output = "";
    const capture = (chunk: Buffer) => {
      output += chunk.toString();
    };
    proc.stdout.on("data", capture);
    proc.stderr.on("data", capture);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, timeoutMs);

    const finish = (ok: boolean) => {
      clearTimeout(timer);
      resolve({ file, ok, durationMs: Date.now() - startedAt, output, timedOut });
    };

    proc.on("close", code => finish(!timedOut && code === 0));
    proc.on("error", error => {
      output += `\nspawn failed: ${error.message}`;
      finish(false);
    });
  });
}

async function main(): Promise<void> {
  const all = await collectExamples(ROOT);
  const requested = positionals.map(arg =>
    toPosixPath(path.relative(ROOT, path.resolve(ROOT, arg)))
  );

  if (options.changed && requested.length > 0) {
    fail("--changed takes no explicit paths");
  }

  let examples: string[];
  if (options.changed) {
    examples = changedExamples(all);
    if (examples.length === 0) {
      // Not a failure: most commits touch no example.
      console.log("No example touched by this commit");
      return;
    }
  } else if (requested.length > 0) {
    // Validate rather than silently skip: a caller that names a file this script
    // does not consider an example (a helper under `examples/utils/`, a typo, a
    // path outside the tree) has to hear about it, or it would quietly verify
    // nothing.
    const known = new Set(all);
    const unknown = requested.filter(f => !known.has(f));
    if (unknown.length > 0) {
      fail(`Not runnable examples:\n${unknown.map(f => `  ${f}`).join("\n")}`);
    }
    examples = requested;
  } else {
    const { filter } = options;
    examples = filter === undefined ? all : all.filter(f => f.includes(filter));
    if (examples.length === 0) {
      fail(filter === undefined ? "No examples found" : `No examples match --filter ${filter}`);
    }
  }

  if (options.list) {
    // Print the selection and stop. Exists so the discovery and `--changed` rules
    // can be asserted directly, and because "which files does it think are
    // examples" is the first question when something looks wrong.
    console.log(examples.join("\n"));
    return;
  }

  console.log(
    `Running ${examples.length} example(s) with ${jobs} parallel job(s), ` +
      `${timeoutMs / 1000}s timeout each\n`
  );

  const results: Result[] = [];
  const queue = [...examples];
  let done = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const file = queue.shift();
      if (file === undefined) {
        return;
      }
      const result = await runExample(file);
      results.push(result);
      done++;
      const mark = result.ok ? "ok  " : result.timedOut ? "TIME" : "FAIL";
      const width = String(examples.length).length;
      console.log(
        `[${String(done).padStart(width)}/${examples.length}] ${mark} ` +
          `${result.file} (${(result.durationMs / 1000).toFixed(1)}s)`
      );
    }
  };

  await Promise.all(Array.from({ length: Math.min(jobs, examples.length) }, worker));

  const failed = results.filter(r => !r.ok).sort((a, b) => a.file.localeCompare(b.file));
  console.log(`\n${results.length - failed.length}/${results.length} passed`);

  if (failed.length > 0) {
    for (const result of failed) {
      console.log(`\n${"─".repeat(72)}\n${result.file}${result.timedOut ? " (timed out)" : ""}`);
      // The tail, not the head: the failure is at the end of a script's output.
      const lines = result.output.trimEnd().split("\n");
      console.log(lines.slice(-25).join("\n"));
    }
    console.log(`\n${failed.length} example(s) failed`);
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
