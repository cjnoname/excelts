/**
 * The example gate must fail on the exact claims it is responsible for.
 *
 * `scripts/run-examples.ts` replaced a hand-written list of 26 files with
 * discovery, and the pre-commit hook's own shell pattern with `--changed`. Both
 * are now the only thing standing between a broken example and `main`, so the
 * ways they could silently pass are worth pinning:
 *
 * - discovery must not treat an unreadable directory as an empty one;
 * - a helper edit must select the examples that import it;
 * - a rename must not be skipped;
 * - a bad `--jobs` / `--timeout` must not disable the run.
 *
 * The last one is not hypothetical: `--jobs nope` produced `NaN` workers, ran
 * nothing, and exited 0.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const RUNNER = path.resolve(import.meta.dirname, "../../../scripts/run-examples.ts");
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "run-examples-"));
  scaffold();
});

afterEach(() => {
  // Restore any permission the tests dropped, or the cleanup itself fails.
  try {
    chmodSync(path.join(root, "src/modules/excel/examples"), 0o755);
  } catch {
    // Directory may not exist in a given test.
  }
  rmSync(root, { recursive: true, force: true });
});

function file(relative: string, contents = ""): void {
  const full = path.join(root, relative);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, contents);
}

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

/**
 * The fixture must declare `"type": "module"`, or Node treats a `.ts` file as
 * CommonJS and the transform rejects top-level await — which most real examples
 * use. This is a property of the tree being run, not of the runner.
 */
function scaffold(): void {
  file("package.json", JSON.stringify({ name: "fixture", type: "module" }));
}

/** A repo whose staged state the runner's `--changed` can be pointed at. */
function initRepo(): void {
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
}

interface Run {
  code: number;
  output: string;
}

/** The selection the runner would make, one path per line. */
function list(args: string[] = []): Run {
  return run([...args, "--list"]);
}

function lines(result: Run): string[] {
  return result.output.split("\n").filter(Boolean);
}

/** Run the real runner against `tree`. */
function runIn(tree: string, args: string[]): Run {
  try {
    return {
      code: 0,
      output: execFileSync(process.execPath, [RUNNER, "--root", tree, ...args], {
        cwd: tree,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      })
    };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failure.status ?? 1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}

/** Run the runner inside the fixture repo. */
function run(args: string[]): Run {
  return runIn(root, args);
}

describe("example discovery", () => {
  it("finds examples per module and ignores helpers under utils/", () => {
    file("src/modules/excel/examples/a.ts");
    file("src/modules/excel/examples/utils/hr-stopwatch.ts");
    file("src/modules/pdf/examples/b.ts");
    file("src/modules/pdf/not-examples/c.ts");

    expect(lines(list())).toEqual([
      "src/modules/excel/examples/a.ts",
      "src/modules/pdf/examples/b.ts"
    ]);
  });

  it("recurses into non-helper subdirectories and honours a top-level src/examples", () => {
    file("src/modules/excel/examples/nested/deep.ts");
    file("src/examples/top.ts");

    expect(lines(list())).toEqual([
      "src/examples/top.ts",
      "src/modules/excel/examples/nested/deep.ts"
    ]);
  });

  it("ignores .d.ts and non-TypeScript files", () => {
    file("src/modules/excel/examples/a.ts");
    file("src/modules/excel/examples/a.d.ts");
    file("src/modules/excel/examples/data.json");
    file("src/modules/excel/examples/README.md");

    expect(lines(list())).toEqual(["src/modules/excel/examples/a.ts"]);
  });

  it("fails loudly when there is no example at all", () => {
    const result = list();
    expect(result.code).toBe(1);
    expect(result.output).toContain("No examples found");
  });

  /**
   * The failure this guards against: `readdir` errors were all swallowed, so an
   * unreadable directory looked exactly like an absent one and its examples were
   * skipped with a green result.
   */
  it("propagates a read failure instead of reporting no examples", () => {
    if (process.platform === "win32" || process.getuid?.() === 0) {
      // chmod does not deny the owner on Windows, and root ignores the bit.
      return;
    }
    file("src/modules/excel/examples/a.ts");
    chmodSync(path.join(root, "src/modules/excel/examples"), 0o000);

    const result = list();
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/EACCES|EPERM/);
  });
});

describe("runner argument validation", () => {
  it.each([
    ["--jobs", "nope"],
    ["--jobs", "0"],
    ["--jobs", "2.5"],
    ["--timeout", "nope"],
    ["--timeout", "0"]
  ])("rejects %s %s instead of silently running nothing", (flag, value) => {
    file("src/modules/excel/examples/a.ts", "console.log('ok');\n");

    const result = run([flag, value]);
    expect(result.code).toBe(1);
    expect(result.output).toContain(`${flag} must be a positive integer`);
  });

  it("rejects a flag missing its value", () => {
    const result = run(["--filter"]);
    expect(result.code).toBe(1);
    // Wording comes from `parseArgs`, so assert the flag is named, not the phrasing.
    expect(result.output).toContain("--filter");
  });

  /**
   * An unknown flag used to be ignored in silence, so `--jbos 1` ran the whole set
   * as though nothing had been asked for.
   */
  it("rejects an unknown flag instead of ignoring it", () => {
    file("src/modules/excel/examples/a.ts", "console.log('a');\n");

    const result = run(["--jbos", "1"]);
    expect(result.code).toBe(1);
    expect(result.output).toContain("--jbos");
  });

  it("rejects a path that is not a runnable example", () => {
    file("src/modules/excel/examples/utils/helper.ts");

    const result = run(["src/modules/excel/examples/utils/helper.ts"]);
    expect(result.code).toBe(1);
    expect(result.output).toContain("Not runnable examples");
  });

  it("rejects --changed combined with explicit paths", () => {
    const result = run(["--changed", "src/modules/excel/examples/a.ts"]);
    expect(result.code).toBe(1);
    expect(result.output).toContain("--changed takes no explicit paths");
  });
});

describe("--changed selection", () => {
  beforeEach(() => {
    initRepo();
  });

  it("selects a staged example and reports success when none is staged", () => {
    file("src/modules/excel/examples/a.ts", "console.log('a');\n");
    file("src/modules/excel/examples/b.ts", "console.log('b');\n");
    file("other.txt", "x");

    git("add", "other.txt");
    expect(run(["--changed"])).toMatchObject({ code: 0 });
    expect(run(["--changed"]).output).toContain("No example touched by this commit");

    git("add", "src/modules/excel/examples/a.ts");
    expect(lines(list(["--changed"]))).toEqual(["src/modules/excel/examples/a.ts"]);
  });

  /**
   * `--diff-filter=ACM` omitted renames, so an example that was moved *and*
   * edited in the same commit was never run.
   */
  it("selects a renamed example", () => {
    file("src/modules/excel/examples/old.ts", "console.log('x');\n");
    git("add", ".");
    git("commit", "-qm", "init");

    git("mv", "src/modules/excel/examples/old.ts", "src/modules/excel/examples/new.ts");

    expect(lines(list(["--changed"]))).toEqual(["src/modules/excel/examples/new.ts"]);
  });

  /**
   * A helper is imported only by its neighbours, so the directory is the
   * dependency edge. Editing one used to verify nothing at all.
   */
  it("selects every example beside a changed helper", () => {
    file("src/modules/pdf/examples/utils/cert.ts", "export const x = 1;\n");
    file("src/modules/pdf/examples/uses-helper.ts", "console.log('p');\n");
    file("src/modules/excel/examples/unrelated.ts", "console.log('e');\n");
    git("add", ".");
    git("commit", "-qm", "init");

    writeFileSync(
      path.join(root, "src/modules/pdf/examples/utils/cert.ts"),
      "export const x = 2;\n"
    );
    git("add", "src/modules/pdf/examples/utils/cert.ts");

    expect(lines(list(["--changed"]))).toEqual(["src/modules/pdf/examples/uses-helper.ts"]);
  });

  /** A fixture is read only by its neighbours, so it is the same dependency edge. */
  it("selects every example beside a changed fixture", () => {
    file("src/modules/excel/examples/data/input.csv", "a,b\n");
    file("src/modules/excel/examples/reads-fixture.ts", "console.log('r');\n");
    file("src/modules/pdf/examples/unrelated.ts", "console.log('p');\n");
    git("add", ".");
    git("commit", "-qm", "init");

    writeFileSync(path.join(root, "src/modules/excel/examples/data/input.csv"), "a,b,c\n");
    git("add", "src/modules/excel/examples/data/input.csv");

    expect(lines(list(["--changed"]))).toEqual(["src/modules/excel/examples/reads-fixture.ts"]);
  });

  it("does not select a deleted example", () => {
    file("src/modules/excel/examples/gone.ts", "console.log('g');\n");
    file("src/modules/excel/examples/stays.ts", "console.log('s');\n");
    git("add", ".");
    git("commit", "-qm", "init");

    git("rm", "-q", "src/modules/excel/examples/gone.ts");

    const output = run(["--changed"]).output;
    expect(output).toContain("No example touched by this commit");
    expect(output).not.toContain("gone.ts");
  });

  /** Newline-separated paths through `xargs` split this one into two arguments. */
  it("handles a path containing a space", () => {
    file("src/modules/excel/examples/with space.ts", "console.log('space');\n");
    git("add", ".");

    expect(lines(list(["--changed"]))).toEqual(["src/modules/excel/examples/with space.ts"]);
    expect(run(["--changed"]).code).toBe(0);
  });
});

describe("runner failure reporting", () => {
  it("fails when an example throws, and names it", () => {
    file("src/modules/excel/examples/bad.ts", "throw new Error('boom');\n");

    const result = run(["--filter", "bad"]);
    expect(result.code).toBe(1);
    expect(result.output).toContain("bad.ts");
    expect(result.output).toContain("boom");
    expect(result.output).toContain("1 example(s) failed");
  });

  it("times out a hanging example rather than blocking forever", () => {
    // Must keep the event loop alive: `new Promise(() => {})` alone lets Node
    // exit cleanly with status 0, which would test nothing.
    file(
      "src/modules/excel/examples/hang.ts",
      "await new Promise(resolve => setTimeout(resolve, 60_000));\n"
    );

    const result = run(["--filter", "hang", "--timeout", "1"]);
    expect(result.code).toBe(1);
    expect(result.output).toContain("timed out");
  });
});

describe("the real repository", () => {
  it("discovers every example, and every one of them is inside an examples directory", () => {
    const examples = lines(runIn(REPO_ROOT, ["--list"]));

    expect(examples.length).toBeGreaterThan(100);
    for (const example of examples) {
      expect(example).toMatch(/\/examples\//);
      expect(example).not.toMatch(/\/examples\/utils\//);
      expect(example.endsWith(".ts")).toBe(true);
    }
  });
});
