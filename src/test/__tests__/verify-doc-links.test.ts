/** The local-link gate must fail on the exact claims it is responsible for. */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(import.meta.dirname, "../../../scripts/verify-doc-links.ts");
let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "verify-doc-links-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function file(relative: string, contents: string): void {
  const full = path.join(root, relative);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, contents);
}

function run(): { code: number; output: string } {
  try {
    return {
      code: 0,
      output: execFileSync("node", [SCRIPT, "--root", root], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      })
    };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failure.status ?? 1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}

describe("the local Markdown link gate", () => {
  it("accepts files, directories, images, reference links and external URLs", () => {
    file(
      "README.md",
      [
        "[guide](docs/guide.md)",
        "[directory](docs/)",
        "![image](assets/pixel.png)",
        "[reference][guide]",
        '[guide]: docs/guide.md "Guide"',
        "[external](https://example.com)",
        "[mail](mailto:docs@example.com)",
        "[site route](/docs/latest)"
      ].join("\n")
    );
    file("docs/guide.md", "# Guide\n");
    file("assets/pixel.png", "not actually decoded");
    const result = run();
    expect(result.code).toBe(0);
    expect(result.output).toContain("4 local link(s)");
  });

  it("fails a missing relative target", () => {
    file("README.md", "[roadmap](ROADMAP.md)\n");
    const result = run();
    expect(result.code).toBe(1);
    expect(result.output).toContain('local target "ROADMAP.md" does not exist');
  });

  it("checks same-file, cross-file, duplicate and Unicode heading anchors", () => {
    file(
      "README.md",
      "# Intro\n\n## 重复 标题\n\n## 重复 标题\n\n[self](#intro) [first](#重复-标题) [second](#重复-标题-1) [cross](docs/guide.md#api-reference)\n"
    );
    file("docs/guide.md", "API Reference\n=============\n");
    expect(run().code).toBe(0);
  });

  it("fails a missing heading with the physical source line", () => {
    file("README.md", "# Intro\n\n[bad](#missing)\n");
    const result = run();
    expect(result.code).toBe(1);
    expect(result.output).toContain("README.md:3");
    expect(result.output).toContain('heading "#missing" does not exist');
  });

  it("ignores link syntax inside ordinary and blockquote fences", () => {
    file(
      "README.md",
      "```md\n[not a link](missing.md)\n```\n\n> ~~~md\n> [also not](missing.md)\n> ~~~\n"
    );
    expect(run().code).toBe(0);
  });

  it("honours an explicit HTML anchor, which is not a heading", () => {
    file("README.md", '<a id="legacy-target"></a>\n\n[jump](#legacy-target)\n');
    expect(run().code).toBe(0);
  });

  it("fails malformed percent encoding rather than crashing", () => {
    file("README.md", "[bad](docs/%ZZ.md)\n");
    const result = run();
    expect(result.code).toBe(1);
    expect(result.output).toContain("malformed percent-encoding");
  });

  it("fails a fragment on a target that cannot have headings", () => {
    file("README.md", "[bad](assets/pixel.png#section)\n");
    file("assets/pixel.png", "not actually decoded");
    const result = run();
    expect(result.code).toBe(1);
    expect(result.output).toContain("has a fragment on a non-Markdown target");
  });

  it("fails a directory that is named like a Markdown file", () => {
    // The anchors of a `.md` target come from reading it, so the read is what reports this
    // — there is no `statSync().isFile()` standing in front of it to race with.
    file("README.md", "[bad](docs/notes.md#section)\n");
    mkdirSync(path.join(root, "docs/notes.md"), { recursive: true });
    const result = run();
    expect(result.code).toBe(1);
    expect(result.output).toContain('local target "docs/notes.md" is a directory');
  });
});

/**
 * The slug rule, case by case.
 *
 * Each case is driven end to end — a heading plus a link to the anchor it is expected to
 * produce — because that is the only thing a reader depends on, and because `scripts/` sits
 * outside the typed project, so the convention here is to run the real CLI rather than
 * import its internals (see `verify-gates.test.ts`).
 *
 * The table exists because the corpus barely exercises this code: the repository has three
 * anchor links and 922 headings, so nothing else would notice the rule drifting. It is
 * GitHub's rule — downcase, drop everything that is not a letter, mark, digit, underscore,
 * hyphen or space, then translate spaces to hyphens one for one.
 */
describe("the heading slug rule", () => {
  const cases: readonly [description: string, heading: string, anchor: string][] = [
    ["lower-cases and hyphenates", "Rendering Scope", "rendering-scope"],
    // Deleting the em dash leaves two spaces, so the anchor has two hyphens. Collapsing
    // them would report ~40 of this repository's own headings as broken.
    [
      "keeps one hyphen per space around an em dash",
      "Excel — XLSX/JSON Manager",
      "excel--xlsxjson-manager"
    ],
    [
      "keeps one hyphen per space around an ampersand",
      "Bug Fixing & Code Changes",
      "bug-fixing--code-changes"
    ],
    // GitHub's well-known quirk: an emoji prefix leaves a leading space, hence a leading hyphen.
    ["leaves a leading hyphen after a dropped emoji", "⚠ BREAKING CHANGES", "-breaking-changes"],
    ["drops slashes and dots", "v1.2 SAX/DOM Parser", "v12-saxdom-parser"],
    ["drops plus signs", "C++ Interop", "c-interop"],
    ["keeps digits", "4.10 Pivot", "410-pivot"],
    ["keeps code-span content without the backticks", "The `draw` module", "the-draw-module"],
    ["keeps a link label and drops its destination", "See [the guide](docs/g.md)", "see-the-guide"],
    ["strips bold markers", "**Deliberately** absent", "deliberately-absent"],
    ["strips underscore emphasis", "_Draft_ notes", "draft-notes"],
    ["keeps an intra-word underscore", "do_something twice", "do_something-twice"],
    ["keeps CJK letters and drops CJK punctuation", "渲染范围（预览）", "渲染范围预览"],
    ["keeps a hyphen as written", "Zero-Dependency Engine", "zero-dependency-engine"],
    ["ignores a trailing closing sequence", "Options ##", "options"],
    ["strips inline HTML", "A <em>b</em> c", "a-b-c"],
    // A badge is a link wrapping an image, so stripping it needs two passes: one pass
    // leaves `![](https://ci.example)`, whose destination would slug to
    // `httpsciexample-status`. The image contributes no text, hence the leading hyphen.
    [
      "strips a badge, which nests two constructs",
      "[![](img.svg)](https://ci.example) Status",
      "-status"
    ]
  ];

  it.each(cases)("%s", (_description, heading, anchor) => {
    file("README.md", `## ${heading}\n\n[link](#${anchor})\n`);
    // Two cases embed a link in the heading; the gate checks those too, so their targets
    // have to exist for the slug assertion to be the only thing under test.
    file("docs/g.md", "# Guide\n");
    file("img.svg", "<svg/>\n");
    const result = run();
    expect(result.output).not.toContain("does not exist");
    expect(result.code).toBe(0);
  });

  it("numbers duplicate headings in document order", () => {
    file(
      "README.md",
      "## Options\n\n## Options\n\n## Options\n\n[a](#options) [b](#options-1) [c](#options-2)\n"
    );
    expect(run().code).toBe(0);
  });

  it("does not invent a fourth anchor for three duplicate headings", () => {
    file("README.md", "## Options\n\n## Options\n\n## Options\n\n[d](#options-3)\n");
    expect(run().code).toBe(1);
  });

  it("reports a link to a heading that slugs to nothing", () => {
    // `## ⚠` keeps no word characters, so GitHub renders `href="#"` and the heading is not
    // addressable. Reporting a link to it is the correct answer, not a false positive.
    file("README.md", "## ⚠\n\n[warn](#warn)\n");
    const result = run();
    expect(result.code).toBe(1);
    expect(result.output).toContain('heading "#warn" does not exist');
  });
});
