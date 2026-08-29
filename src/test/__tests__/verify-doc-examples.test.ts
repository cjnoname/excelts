/**
 * The documented-import gate has to actually fire.
 *
 * `verify-doc-examples.ts` exists because seventeen `@example` blocks in the PDF and Word
 * modules told readers to import functions the exports map does not publish, and nothing
 * noticed for as long as those comments existed. Its second round found the same class of
 * error in the READMEs, which carry five times as many imports and are read far more often.
 * A gate introduced to catch that drift is worth exactly as much as its ability to fail, so
 * every way documentation can lie is driven here against a fixture tree via `--root`.
 *
 * The fixture carries its own `package.json` and its own hand-written declaration file, so
 * the cases are hermetic: they do not depend on this repository having been built, and they
 * do not change meaning when the real public surface does.
 *
 * Run as a subprocess rather than imported, for the same reason as `verify-gates.test.ts`:
 * `scripts/` is outside the typed project, and running the real CLI also covers argument
 * handling and the exit code that makes `pnpm check` fail.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(import.meta.dirname, "../../../scripts/verify-doc-examples.ts");

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "verify-doc-examples-"));
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

/**
 * Give the fixture a public surface: one entry, publishing one value and one type.
 *
 * `built` controls whether the declaration exists, which is the difference between the full
 * check and the "nothing to resolve against" path.
 */
function publicSurface(built = true): void {
  file(
    "package.json",
    JSON.stringify({
      name: "fixture",
      exports: {
        "./excel": { import: { types: "./types/excel.d.ts", default: "./esm/excel.js" } },
        "./package.json": "./package.json"
      }
    })
  );
  if (built) {
    file(
      "types/excel.d.ts",
      "export declare const Workbook: { create(): number };\n" +
        "export declare const Cell: { getValue(): unknown };\n" +
        "export declare namespace Style {\n  type Handle = { bold?: boolean };\n}\n" +
        "export type Style = { bold?: boolean };\n"
    );
  }
}

/** Run the gate against the fixture tree. */
function run(...args: string[]): { code: number; output: string } {
  try {
    const output = execFileSync("node", [SCRIPT, "--root", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    return { code: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failure.status ?? 1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}

describe("the documented-import gate, on TypeScript comments", () => {
  it("passes an example that names a published export", () => {
    publicSurface();
    file(
      "src/modules/excel/index.ts",
      `/**\n * @example\n * \`\`\`ts\n * import { Workbook } from "documonster/excel";\n * \`\`\`\n */\nexport const x = 1;\n`
    );
    const { code, output } = run();
    expect(code).toBe(0);
    expect(output).toContain("1 documented import(s)");
  });

  it("accepts a type-only name, because existence is the question", () => {
    publicSurface();
    file(
      "src/modules/excel/index.ts",
      `// import { type Style } from "documonster/excel";\nexport const x = 1;\n`
    );
    expect(run().code).toBe(0);
  });

  it("fails an example that names a member the entry does not export", () => {
    publicSurface();
    file(
      "src/modules/excel/index.ts",
      `/**\n * @example\n * import { readWorkbook } from "documonster/excel";\n */\nexport const x = 1;\n`
    );
    const { code, output } = run();
    expect(code).toBe(1);
    // Reported against the comment's own line, not the throwaway module tsc saw.
    expect(output).toContain("src/modules/excel/index.ts:3");
    expect(output).toContain("readWorkbook");
  });

  it("fails an example importing from a specifier the exports map does not publish", () => {
    publicSurface();
    file(
      "src/modules/excel/index.ts",
      `// import { Workbook } from "documonster";\nexport const x = 1;\n`
    );
    const { code, output } = run();
    expect(code).toBe(1);
    expect(output).toContain("does not publish");
  });

  it("reads an import split over several comment lines", () => {
    publicSurface();
    file(
      "src/modules/excel/index.ts",
      `/**\n * import {\n *   Workbook,\n *   readWorkbook\n * } from "documonster/excel";\n */\nexport const x = 1;\n`
    );
    const { code, output } = run();
    expect(code).toBe(1);
    // Parsed, not waved through as unreadable — and blamed on the line it starts on.
    expect(output).toContain("src/modules/excel/index.ts:2");
    expect(output).toContain("readWorkbook");
  });

  it("fails a namespace import, which the parser cannot read", () => {
    publicSurface();
    file(
      "src/modules/excel/index.ts",
      `// import * as Excel from "documonster/excel";\nexport const x = 1;\n`
    );
    const { code, output } = run();
    expect(code).toBe(1);
    expect(output).toContain("cannot parse");
  });

  it("ignores prose that mentions a specifier without importing from it", () => {
    publicSurface();
    file(
      "src/modules/excel/index.ts",
      `/**\n * Call \`decryptDocx()\` from \`documonster/excel\` for lower-level access.\n */\nexport const x = 1;\n`
    );
    const { code, output } = run();
    expect(code).toBe(0);
    expect(output).toContain("0 documented import(s)");
  });

  it("ignores a real import statement, which the compiler already checks", () => {
    publicSurface();
    file(
      "src/modules/excel/index.ts",
      `import { readWorkbook } from "documonster/excel";\nvoid readWorkbook;\n`
    );
    expect(run().code).toBe(0);
  });

  it("fails closed when there is no build to read", () => {
    publicSurface(false);
    file(
      "src/modules/excel/index.ts",
      `// import { readWorkbook } from "documonster/excel";\nexport const x = 1;\n`
    );
    const { code, output } = run();
    expect(code).toBe(1);
    expect(output).toContain("dist/types is absent");
  });
});

describe("the documented-import gate, on Markdown", () => {
  it("passes a fenced example that names a published export", () => {
    publicSurface();
    file(
      "README.md",
      `# Fixture\n\n\`\`\`typescript\nimport { Workbook } from "documonster/excel";\n\`\`\`\n`
    );
    const { code, output } = run();
    expect(code).toBe(0);
    expect(output).toContain("1 documented import(s)");
  });

  it("fails a fenced example that names a missing member", () => {
    publicSurface();
    file(
      "src/modules/excel/README.md",
      `## Handles\n\n\`\`\`typescript\nimport type { WorkbookData } from "documonster/excel";\n\`\`\`\n`
    );
    const { code, output } = run();
    expect(code).toBe(1);
    expect(output).toContain("src/modules/excel/README.md:4");
    expect(output).toContain("WorkbookData");
  });

  it("reads a multi-line fenced import with comments between the names", () => {
    publicSurface();
    file(
      "README.md",
      '# Fixture\n\n```typescript\nimport {\n  Workbook, // the workbook namespace\n  readWorkbook // not a real export\n} from "documonster/excel";\n```\n'
    );
    const { code, output } = run();
    expect(code).toBe(1);
    // The trailing `// comment` must not be mistaken for an imported name.
    expect(output).toContain("readWorkbook");
    expect(output).not.toContain("the workbook namespace");
  });

  it("ignores an import quoted inline in prose, not in a fence", () => {
    publicSurface();
    file(
      "docs/notes.md",
      "# Notes\n\nAn earlier draft told readers to write\n" +
        '`import { readWorkbook } from "documonster/excel"`, which never resolved.\n'
    );
    const { code, output } = run();
    expect(code).toBe(0);
    // This is what lets a document *about* a broken import exist without an exception list.
    expect(output).toContain("0 documented import(s)");
  });

  it("checks every fence in a file, not just the first", () => {
    publicSurface();
    file(
      "README.md",
      '```ts\nimport { Workbook } from "documonster/excel";\n```\n\ntext\n\n```ts\nimport { Cell } from "documonster/excel";\n```\n\n```ts\nimport { nope } from "documonster/excel";\n```\n'
    );
    const { code, output } = run();
    expect(code).toBe(1);
    // The third fence opens on line 11, so its import is line 12.
    expect(output).toContain("README.md:12");
    expect(output).toContain("nope");
  });
});

describe("the documented-import gate, on member references", () => {
  it("passes a member the namespace really has", () => {
    publicSurface();
    file(
      "README.md",
      '```ts\nimport { Workbook } from "documonster/excel";\nconst wb = Workbook.create();\n```\n'
    );
    const { code, output } = run();
    expect(code).toBe(0);
    expect(output).toContain("member reference(s)");
  });

  it("fails a member the namespace does not have", () => {
    publicSurface();
    file(
      "src/modules/excel/index.ts",
      '/**\n * @example\n * import { Workbook } from "documonster/excel";\n * Workbook.recalculate(wb);\n */\nexport const x = 1;\n'
    );
    const { code, output } = run();
    expect(code).toBe(1);
    expect(output).toContain("src/modules/excel/index.ts:4");
    expect(output).toContain("`Workbook.recalculate` is not a member of `Workbook`");
  });

  it("accepts a type-only member, which `typeof` alone would reject", () => {
    publicSurface();
    file(
      "README.md",
      '```ts\nimport { Style } from "documonster/excel";\nconst s: Style.Handle = { bold: true };\n```\n'
    );
    // `typeof Style.Handle` is an error and `Style.Handle` is not; requiring both to fail is
    // what makes the probe agnostic about which kind a member is.
    expect(run().code).toBe(0);
  });

  it("ignores members of names it did not import, so locals never match", () => {
    publicSurface();
    file(
      "README.md",
      '```ts\nimport { Workbook } from "documonster/excel";\nconst image = load();\nconsole.log(image.format, ws.pageSetup.paperSize);\n```\n'
    );
    expect(run().code).toBe(0);
  });

  it("suppresses a member listed as deliberately absent, in that file only", () => {
    publicSurface();
    // The real entry names `Workbook.calculate` in `excel/bridge/formula.ts`, where a comment
    // explains why it does not exist. The same reference elsewhere must still fail.
    file(
      "src/modules/excel/index.ts",
      '// import { Workbook } from "documonster/excel";\n// Workbook.calculate(wb);\nexport const x = 1;\n'
    );
    const { code, output } = run();
    expect(code).toBe(1);
    expect(output).toContain("Workbook.calculate");
  });

  it("accepts an aliased import and checks the local member name", () => {
    publicSurface();
    file(
      "README.md",
      "```ts\nimport { Workbook as Book } from 'documonster/excel';\nBook.missing();\n```\n"
    );
    const { code, output } = run();
    expect(code).toBe(1);
    expect(output).toContain("Book.missing");
  });

  it("does not mistake a generic type member for a missing member", () => {
    publicSurface();
    file(
      "types/excel.d.ts",
      "export declare namespace Workbook { type Result<T> = { value: T }; }\n"
    );
    file(
      "README.md",
      '```ts\nimport { Workbook } from "documonster/excel";\nconst result: Workbook.Result<string> = { value: "ok" };\n```\n'
    );
    expect(run().code).toBe(0);
  });

  it("checks one-line block comments", () => {
    publicSurface();
    file(
      "src/modules/excel/index.ts",
      '/** import { Workbook } from "documonster/excel"; Workbook.missing(); */\n'
    );
    expect(run().code).toBe(1);
  });

  it("keeps separate @example blocks in separate import scopes", () => {
    publicSurface();
    file(
      "src/modules/excel/index.ts",
      '/**\n * @example\n * import { Workbook as X } from "documonster/excel";\n * X.create();\n * @example\n * import { Cell as X } from "documonster/excel";\n * X.create();\n */\n'
    );
    const { code, output } = run();
    expect(code).toBe(1);
    expect(output).toContain("X.create");
  });

  it("fails closed when the compiler cannot run", () => {
    publicSurface();
    file("README.md", '```ts\nimport { Workbook } from "documonster/excel";\n```\n');
    const { code, output } = run("--tsc", path.join(root, "missing-tsc.js"));
    expect(code).toBe(1);
    expect(output).toContain("TypeScript probe failed");
  });
});

describe("the documented-import gate, on CommonMark fences", () => {
  it("checks a fenced example inside a blockquote", () => {
    publicSurface();
    file(
      "README.md",
      '> ```ts\n> import { Workbook } from "documonster/excel";\n> Workbook.missing();\n> ```\n'
    );
    expect(run().code).toBe(1);
  });

  it("does not close a tilde fence with backticks", () => {
    publicSurface();
    file(
      "README.md",
      '~~~ts\n```\nimport { Workbook } from "documonster/excel";\nWorkbook.missing();\n~~~\n'
    );
    expect(run().code).toBe(1);
  });

  it("fails a TypeScript fence that is not syntactically valid", () => {
    publicSurface();
    file("README.md", "```typescript\ncall({ optional? });\n```\n");
    const { code, output } = run();
    expect(code).toBe(1);
    expect(output).toContain("TypeScript syntax error");
    expect(output).toContain("README.md:2");
  });

  it("does not type-check placeholders in a syntactically valid concise example", () => {
    publicSurface();
    file("README.md", "```typescript\nconst value = unknownFunction(missingVariable);\n```\n");
    expect(run().code).toBe(0);
  });
});
