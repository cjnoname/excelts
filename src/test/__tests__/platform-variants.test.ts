/**
 * The platform-variant machinery has to actually fire.
 *
 * `link-platform-variants.ts` is what makes `dist/browser` unnecessary: it rewrites every
 * emitted import of a module with a `*.browser` sibling to `#platform/<path>`, and the
 * manifest's `imports` field picks the variant per condition. `verify-browser-stubs.ts` is
 * the invariant that keeps it honest — a relative import left behind means the browser
 * condition cannot fire for it, so a browser consumer silently receives the Node module.
 *
 * Both were demonstrated by hand when they were written (rebuilding without the linker made
 * the gate report all 158 specifiers). A hand demonstration is exactly what this repository
 * says is not enough: it is not repeatable and it is not in CI. So both run here as
 * subprocesses against fixture trees built to break them, via the `--dist`/`--types` and
 * `--root` flags they take for the purpose.
 *
 * `scripts/` is outside the typed project on purpose — `tsconfig.json` excludes it — so
 * importing the scripts would be neither type-checked nor resolvable. Running the real CLI
 * also covers argument handling and the exit code that makes `pnpm check` fail.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPTS = path.resolve(import.meta.dirname, "../../../scripts");

/** The two modules `verify-browser-stubs.ts` requires a variant for, by policy. */
const POLICY_MODULES = [
  "src/modules/pdf/font/system-fonts",
  "src/modules/draw/raster/system-raster-font"
];

let root: string;

function write(relative: string, contents: string): void {
  const full = path.join(root, relative);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, contents);
}

interface Run {
  readonly status: number;
  readonly output: string;
}

function run(script: string, args: readonly string[]): Run {
  try {
    const stdout = execFileSync(process.execPath, [path.join(SCRIPTS, script), ...args], {
      cwd: root,
      encoding: "utf8",
      stdio: "pipe"
    });
    return { status: 0, output: stdout };
  } catch (error) {
    const failed = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failed.status ?? 1,
      output: `${failed.stdout ?? ""}${failed.stderr ?? ""}`
    };
  }
}

const link = (): Run =>
  run("link-platform-variants.ts", ["--dist", "dist/esm", "--types", "dist/types"]);
const verify = (): Run => run("verify-browser-stubs.ts", ["--root", root]);

/**
 * A tree with one variant pair and one importer of it, in both the JS and the
 * declaration tree. Mirrors the real shape: `utils/fs.js` has a `.browser.js` sibling,
 * and a module two directories down imports it relatively.
 */
function writeTreeWithVariant(): void {
  write("dist/esm/utils/fs.js", "export const readFileIfExists = () => undefined;\n");
  write("dist/esm/utils/fs.browser.js", "export const readFileIfExists = () => undefined;\n");
  write(
    "dist/esm/modules/archive/zip.js",
    'import { readFileIfExists } from "../../utils/fs.js";\nexport { readFileIfExists };\n'
  );
  write("dist/types/utils/fs.d.ts", "export declare const readFileIfExists: () => undefined;\n");
  write(
    "dist/types/utils/fs.browser.d.ts",
    "export declare const readFileIfExists: () => undefined;\n"
  );
  write(
    "dist/types/modules/archive/zip.d.ts",
    'export { readFileIfExists } from "../../utils/fs.js";\n'
  );
  // The policy list checks source files, not artifacts.
  for (const module of POLICY_MODULES) {
    write(`${module}.ts`, "export const load = () => undefined;\n");
    write(`${module}.browser.ts`, "export const load = () => undefined;\n");
  }
}

const read = (relative: string): string => readFileSync(path.join(root, relative), "utf8");

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "platform-variants-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("link-platform-variants", () => {
  it("rewrites an import whose target has a browser sibling, in both trees", () => {
    writeTreeWithVariant();
    const result = link();

    expect(result.status, result.output).toBe(0);
    expect(read("dist/esm/modules/archive/zip.js")).toContain('"#platform/utils/fs"');
    expect(read("dist/esm/modules/archive/zip.js")).not.toContain("../../utils/fs.js");
    // The declaration tree keys off the same path, so one `imports` entry serves both.
    expect(read("dist/types/modules/archive/zip.d.ts")).toContain('"#platform/utils/fs"');
  });

  it("leaves an import with no browser sibling relative", () => {
    writeTreeWithVariant();
    write("dist/esm/utils/errors.js", "export class BaseError extends Error {}\n");
    write(
      "dist/esm/modules/archive/tar.js",
      'import { BaseError } from "../../utils/errors.js";\nexport { BaseError };\n'
    );

    expect(link().status).toBe(0);
    expect(read("dist/esm/modules/archive/tar.js")).toContain("../../utils/errors.js");
    expect(read("dist/esm/modules/archive/tar.js")).not.toContain("#platform/");
  });

  it("leaves a deliberate direct reference to the browser variant alone", () => {
    // `surface/workbook.browser.ts` imports `core/workbook.browser` because it is only
    // reachable from the browser entry; routing that through a condition would be a lie.
    writeTreeWithVariant();
    write(
      "dist/esm/modules/archive/index.browser.js",
      'export { readFileIfExists } from "../../utils/fs.browser.js";\n'
    );

    expect(link().status).toBe(0);
    expect(read("dist/esm/modules/archive/index.browser.js")).toContain("fs.browser.js");
    expect(read("dist/esm/modules/archive/index.browser.js")).not.toContain("#platform/");
  });

  it("rewrites a dynamic import too", () => {
    writeTreeWithVariant();
    write(
      "dist/esm/modules/archive/lazy.js",
      'export const load = () => import("../../utils/fs.js");\n'
    );

    expect(link().status).toBe(0);
    expect(read("dist/esm/modules/archive/lazy.js")).toContain('import("#platform/utils/fs")');
  });

  it("is safe to run twice", () => {
    // A build step that cannot be run twice breaks the moment `tsc` emits incrementally.
    // The second run rewrites nothing, which must not be mistaken for the mechanism
    // having failed to fire.
    writeTreeWithVariant();
    expect(link().status).toBe(0);
    const before = read("dist/esm/modules/archive/zip.js");

    const second = link();
    expect(second.status, second.output).toBe(0);
    expect(read("dist/esm/modules/archive/zip.js")).toBe(before);
  });

  it("fails rather than succeeding silently when it rewrites nothing", () => {
    // The dangerous outcome: no `#platform/*` anywhere, so the browser condition never
    // fires and browser consumers receive the Node variants with nothing reporting it.
    write("dist/esm/utils/errors.js", "export class BaseError extends Error {}\n");
    write("dist/types/utils/errors.d.ts", "export declare class BaseError extends Error {}\n");
    const result = link();

    expect(result.status).toBe(1);
    expect(result.output).toContain("No platform specifiers rewritten");
  });

  it("resolves a relative --dist against the cwd, not the repository", () => {
    // Resolving it against the repository root — as the older `fix-*-imports.ts` scripts
    // do — would silently retarget this at the real `dist/esm` from any other directory,
    // which is how the first version of this test passed while doing nothing.
    writeTreeWithVariant();
    const result = link();

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain(path.join(root, "dist/esm").replaceAll("\\", "/"));
  });
});

describe("verify-browser-stubs", () => {
  it("passes on a tree the linker has processed", () => {
    writeTreeWithVariant();
    expect(link().status).toBe(0);

    const result = verify();
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("linked through");
  });

  it("fails on the same tree before the linker runs", () => {
    writeTreeWithVariant();
    const result = verify();

    expect(result.status).toBe(1);
    expect(result.output).toContain("#platform/utils/fs");
    // Both trees are scanned: the JS because it runs, the declarations because a
    // consumer's compiler follows them.
    expect(result.output).toContain("dist/esm/modules/archive/zip.js");
    expect(result.output).toContain("dist/types/modules/archive/zip.d.ts");
  });

  it("fails when a module on the policy list has lost its variant", () => {
    // The structural check cannot notice a *deleted* variant: with no sibling to redirect
    // to there is nothing to call a violation, so it would report success while the Node
    // module shipped again.
    writeTreeWithVariant();
    expect(link().status).toBe(0);
    rmSync(path.join(root, `${POLICY_MODULES[0]}.browser.ts`));

    const result = verify();
    expect(result.status).toBe(1);
    expect(result.output).toContain(POLICY_MODULES[0]);
  });

  it("fails when the trees are missing rather than passing vacuously", () => {
    const result = verify();

    expect(result.status).toBe(1);
    expect(result.output).toContain("is missing");
  });
});
