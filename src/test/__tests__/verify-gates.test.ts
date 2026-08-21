/**
 * The layer and satellite gates have to actually fire.
 *
 * `verify-layers.ts` holds the one architectural constraint this repository states as a
 * hard rule — a module may only import from lower layers — and `verify-package-imports.ts`
 * holds the rule that a satellite consumes the core through its published entry points.
 * Neither had a test, and both had a way through:
 *
 * - A bare `import "@excel/…"` has no `from` clause, so a pattern anchored on `from`
 *   never saw it. Importing a module for its side effects crosses a boundary exactly as
 *   much as a named import does.
 * - `verify-layers` only looked at `@alias` specifiers, so `../../excel/index` compiled
 *   and passed. That is not a corner case: it is a door straight through the rule.
 *
 * Both scripts are run as subprocesses against a fixture tree via `--root`. `scripts/` is
 * outside the typed project on purpose — `tsconfig.json` excludes it, and pulling it in
 * raises 237 type errors from the existing scripts — so importing them would be neither
 * type-checked nor resolvable. Running the real CLI also covers argument handling and the
 * exit code that makes `pnpm check` fail.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPTS = path.resolve(import.meta.dirname, "../../../scripts");

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "verify-gates-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Write a file into the fixture tree, creating directories as needed. */
function file(relative: string, contents: string): void {
  const full = path.join(root, relative);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, contents);
}

/** Run a gate against the fixture tree. */
function run(script: string): { code: number; output: string } {
  try {
    const output = execFileSync("node", [path.join(SCRIPTS, script), "--root", root], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    return { code: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failure.status ?? 1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}

describe("the module layer gate", () => {
  /** `xml` is Layer 1 and `excel` is Layer 4, so this direction is always forbidden. */
  const forbidden = (statement: string): { code: number; output: string } => {
    file("src/modules/xml/index.ts", `${statement}\n`);
    return run("verify-layers.ts");
  };

  it("passes a tree that respects the layers", () => {
    file("src/modules/xml/index.ts", `import { x } from "@utils/binary";\nvoid x;\n`);
    file("src/modules/excel/index.ts", `import { y } from "@xml/index";\nvoid y;\n`);
    const { code, output } = run("verify-layers.ts");
    expect(code).toBe(0);
    expect(output).toContain("passed");
  });

  it("catches an aliased import that climbs a layer", () => {
    const { code, output } = forbidden(`import { Workbook } from "@excel/index";\nvoid Workbook;`);
    expect(code).toBe(1);
    expect(output).toContain("xml may not import from @excel");
  });

  it("catches a side-effect import with no bindings", () => {
    // No `from`, so the original pattern could not see it at all.
    const { code, output } = forbidden(`import "@excel/index";`);
    expect(code).toBe(1);
    expect(output).toContain("@excel");
  });

  it("catches a dynamic import", () => {
    const { code } = forbidden(`await import("@excel/index");`);
    expect(code).toBe(1);
  });

  it("catches a dynamic import that carries import attributes", () => {
    // A second argument is legal and increasingly common. The pattern required the
    // closing paren straight after the specifier, so this form went unseen — a real way
    // through the rule.
    const { code } = forbidden(
      `const d = await import("@excel/data.json", { with: { type: "json" } });\nvoid d;`
    );
    expect(code).toBe(1);
  });

  it("catches a re-export", () => {
    const { code } = forbidden(`export { Workbook } from "@excel/index";`);
    expect(code).toBe(1);
  });

  it("catches a relative path that climbs out of its own module", () => {
    // The door the alias-only check left open: this compiles, and reaches exactly as
    // far as the aliased form.
    const { code, output } = forbidden(
      `import { Workbook } from "../excel/index";\nvoid Workbook;`
    );
    expect(code).toBe(1);
    expect(output).toContain("@excel");
  });

  it("catches a relative path that climbs out via a deeper route", () => {
    file(
      "src/modules/xml/parse/reader.ts",
      `import { Workbook } from "../../excel/core/workbook";\nvoid Workbook;\n`
    );
    expect(run("verify-layers.ts").code).toBe(1);
  });

  it("allows a relative import inside the same module", () => {
    file("src/modules/xml/index.ts", `import { read } from "./parse/reader";\nvoid read;\n`);
    file("src/modules/xml/parse/reader.ts", `export const read = 1;\n`);
    expect(run("verify-layers.ts").code).toBe(0);
  });

  it("allows a relative import of utils, which every layer may use", () => {
    file("src/modules/xml/index.ts", `import { parse } from "../../utils/svg-lex";\nvoid parse;\n`);
    expect(run("verify-layers.ts").code).toBe(0);
  });

  it("allows an external package", () => {
    file(
      "src/modules/xml/index.ts",
      `import { readFileSync } from "node:fs";\nvoid readFileSync;\n`
    );
    expect(run("verify-layers.ts").code).toBe(0);
  });

  it("holds utils to importing nothing", () => {
    file("src/utils/errors.ts", `import { x } from "@xml/index";\nvoid x;\n`);
    const { code, output } = run("verify-layers.ts");
    expect(code).toBe(1);
    expect(output).toContain("utils must not import from any module");
  });

  it("does not read a commented-out import as an import", () => {
    // Ordinary while refactoring, and this repository's doc comments quote specifiers
    // constantly — including to say a file must not import them. Reporting those blocks
    // CI over source that compiles and complies.
    file(
      "src/modules/xml/index.ts",
      ['// import { Workbook } from "@excel/index";', "export const x = 1;"].join("\n")
    );
    expect(run("verify-layers.ts").code).toBe(0);
  });

  it("does not read an alias inside a block comment as an import", () => {
    file(
      "src/modules/xml/index.ts",
      ["/*", " * See @excel/core for the counterpart.", " */", "export const x = 1;"].join("\n")
    );
    expect(run("verify-layers.ts").code).toBe(0);
  });

  it("does not read an alias mentioned in a comment as an import", () => {
    // The doc comments in this repository discuss `@excel/…` constantly, including to
    // say that a given file must not import it.
    file(
      "src/modules/xml/index.ts",
      ["/** This module must never import from `@excel/core`. */", "export const x = 1;"].join("\n")
    );
    expect(run("verify-layers.ts").code).toBe(0);
  });

  it("reads a multi-line import statement", () => {
    file(
      "src/modules/xml/index.ts",
      ["import {", "  Workbook,", "  Worksheet", '} from "@excel/index";', "void Workbook;"].join(
        "\n"
      )
    );
    expect(run("verify-layers.ts").code).toBe(1);
  });

  it("skips tests and examples, which are not production code", () => {
    file(
      "src/modules/xml/__tests__/reader.test.ts",
      `import { W } from "@excel/index";\nvoid W;\n`
    );
    file("src/modules/xml/examples/demo.ts", `import { W } from "@excel/index";\nvoid W;\n`);
    expect(run("verify-layers.ts").code).toBe(0);
  });

  it("guards this repository's own tree", () => {
    const output = execFileSync("node", [path.join(SCRIPTS, "verify-layers.ts")], {
      encoding: "utf8"
    });
    expect(output).toContain("passed");
  });
});

describe("the satellite import gate", () => {
  const satellite = (statement: string): { code: number; output: string } => {
    file("packages/mcp/src/tool.ts", `${statement}\n`);
    return run("verify-package-imports.ts");
  };

  it("passes a satellite that uses the published entry points", () => {
    const { code, output } = satellite(
      `import { Workbook } from "documonster/excel";\nvoid Workbook;`
    );
    expect(code).toBe(0);
    expect(output).toContain("public API only");
  });

  it("catches an internal alias", () => {
    const { code, output } = satellite(`import { Workbook } from "@excel/index";\nvoid Workbook;`);
    expect(code).toBe(1);
    expect(output).toContain("internal path alias");
  });

  it("catches a side-effect import of an internal alias", () => {
    const { code, output } = satellite(`import "@excel/index";`);
    expect(code).toBe(1);
    expect(output).toContain("internal path alias");
  });

  it("catches the draw module's internal alias", () => {
    // `@draw` was missing from the alias list, so a satellite could reach the drawing
    // engine's internals while every other module was blocked.
    const { code, output } = satellite(`import { toSvg } from "@draw/index";\nvoid toSvg;`);
    expect(code).toBe(1);
    expect(output).toContain("internal path alias");
  });

  it("catches a relative path that escapes the package", () => {
    const { code, output } = satellite(
      `import { Workbook } from "../../../src/modules/excel/index";\nvoid Workbook;`
    );
    expect(code).toBe(1);
    expect(output).toContain("escapes the package");
  });

  it("allows a relative path inside the package", () => {
    file("packages/mcp/src/tool.ts", `import { helper } from "./helper";\nvoid helper;\n`);
    file("packages/mcp/src/helper.ts", `export const helper = 1;\n`);
    expect(run("verify-package-imports.ts").code).toBe(0);
  });

  it("catches a dynamic import with attributes in a satellite too", () => {
    const { code } = satellite(
      `const d = await import("@excel/index", { with: { type: "json" } });\nvoid d;`
    );
    expect(code).toBe(1);
  });

  it("catches a require, which resolves the same way", () => {
    const { code } = satellite(`const { Workbook } = require("@excel/index");\nvoid Workbook;`);
    expect(code).toBe(1);
  });

  it("says so when there is no packages directory rather than failing", () => {
    const { code, output } = run("verify-package-imports.ts");
    expect(code).toBe(0);
    expect(output).toContain("nothing to check");
  });

  it("guards this repository's own satellites", () => {
    const output = execFileSync("node", [path.join(SCRIPTS, "verify-package-imports.ts")], {
      encoding: "utf8"
    });
    expect(output).toContain("public API only");
  });
});
