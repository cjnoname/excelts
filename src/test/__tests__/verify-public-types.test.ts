/**
 * The public type surface gate has to actually fire.
 *
 * `verify-public-types.ts` holds four rules that nothing else in the build can see. A
 * `.d.ts` compiles perfectly well while exposing a type a consumer has no way to name;
 * `build:verify` proves the declarations parse, not that they are usable. So the only
 * evidence this check works is a tree that breaks each rule on purpose.
 *
 * That evidence was hard to produce before the refactor, and the difficulty was hiding
 * two real defects: R1 and R3 read their entry points out of the map by literal label
 * (`ENTRIES["documonster/excel"]`), so R3 threw on any other config and R1 skipped
 * itself in silence — the worst way for a rule not to apply. Which entries own the
 * vocabulary, and which pair must match, are policy; they now come from the config
 * alongside everything else.
 *
 * Run as a subprocess against a fixture tree, for the same reason as the other gates:
 * `scripts/` is outside the typed project on purpose.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(import.meta.dirname, "../../../scripts/verify-public-types.ts");

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "public-types-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function file(relative: string, contents: string): void {
  const full = path.join(root, relative);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, contents);
}

/** The config every test starts from: one `demo` module standing in for the library. */
function config(override: Record<string, unknown> = {}): string {
  const merged = {
    entries: { demo: { file: "src/modules/demo/index.ts", platform: "both" } },
    vocabularyFile: "src/modules/demo/types.ts",
    vocabularyEntries: ["demo"],
    platformPair: null,
    unexposedUtilsTypes: [],
    privateMemberTypes: [],
    nodeOnlyNamespaceMembers: [],
    aliases: { "@demo": "src/modules/demo", "@utils": "src/utils" },
    ...override
  };
  const target = path.join(root, `config-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(target, JSON.stringify(merged));
  return target;
}

function run(configFile: string): { code: number; output: string } {
  try {
    const output = execFileSync("node", [SCRIPT, "--root", root, "--config", configFile], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    return { code: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failure.status ?? 1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}

/** A tree where every rule is satisfied. */
function soundTree(): void {
  file("src/modules/demo/types.ts", "export interface Widget {\n  id: string;\n}\n");
  file("src/modules/demo/internal.ts", "export interface Detail {\n  n: number;\n}\n");
  file(
    "src/modules/demo/index.ts",
    [
      'export type { Widget } from "@demo/types";',
      'export type { Detail } from "@demo/internal";',
      'import type { Widget } from "@demo/types";',
      'import type { Detail } from "@demo/internal";',
      "export function make(detail: Detail): Widget {",
      "  return { id: String(detail.n) };",
      "}"
    ].join("\n")
  );
}

describe("the public type surface gate", () => {
  it("passes a surface with no holes", () => {
    soundTree();
    const { code, output } = run(config());
    expect(code).toBe(0);
    expect(output).toContain("passed");
  });

  it("R2 — catches a type in a signature that no entry exports", () => {
    // The rule the whole script exists for: `make` takes a `Detail`, so a consumer needs
    // to be able to name one.
    soundTree();
    file(
      "src/modules/demo/index.ts",
      [
        'export type { Widget } from "@demo/types";',
        'import type { Widget } from "@demo/types";',
        'import type { Detail } from "@demo/internal";',
        "export function make(detail: Detail): Widget {",
        "  return { id: String(detail.n) };",
        "}"
      ].join("\n")
    );
    const { code, output } = run(config());
    expect(code).toBe(1);
    expect(output).toContain("R2");
    expect(output).toContain("Detail");
  });

  it("R2 — accepts a type re-exported under a different name", () => {
    // The check matches declarations, not spellings: an established alias is fine.
    soundTree();
    file(
      "src/modules/demo/index.ts",
      [
        'export type { Widget } from "@demo/types";',
        'export type { Detail as Info } from "@demo/internal";',
        'import type { Widget } from "@demo/types";',
        'import type { Detail } from "@demo/internal";',
        "export function make(detail: Detail): Widget {",
        "  return { id: String(detail.n) };",
        "}"
      ].join("\n")
    );
    expect(run(config()).code).toBe(0);
  });

  it("R2 — allows a type listed as appearing only on a private member", () => {
    soundTree();
    file(
      "src/modules/demo/index.ts",
      [
        'export type { Widget } from "@demo/types";',
        'import type { Widget } from "@demo/types";',
        'import type { Detail } from "@demo/internal";',
        "export function make(detail: Detail): Widget {",
        "  return { id: String(detail.n) };",
        "}"
      ].join("\n")
    );
    const allowed = config({ privateMemberTypes: ["Detail @ modules/demo/internal.ts"] });
    expect(run(allowed).code).toBe(0);
  });

  it("R2 — follows a re-export chain of any length", () => {
    // A hop count used to bound this walk, so a type re-exported one level further than
    // the cap allowed was reported unreachable when it was not. A false alarm rather
    // than a hole, but a check that cries wolf gets switched off.
    file("src/modules/demo/types.ts", "export interface Widget {\n  id: string;\n}\n");
    file("src/modules/demo/internal.ts", "export interface Detail {\n  n: number;\n}\n");
    for (const [from, to] of [
      ["a", "@demo/internal"],
      ["b", "@demo/a"],
      ["c", "@demo/b"],
      ["d", "@demo/c"],
      ["e", "@demo/d"]
    ]) {
      file(`src/modules/demo/${from}.ts`, `export * from "${to}";\n`);
    }
    file(
      "src/modules/demo/index.ts",
      [
        'export type { Widget } from "@demo/types";',
        'export * from "@demo/e";',
        'import type { Widget } from "@demo/types";',
        'import type { Detail } from "@demo/internal";',
        "export function make(detail: Detail): Widget {",
        "  return { id: String(detail.n) };",
        "}"
      ].join("\n")
    );
    expect(run(config()).code).toBe(0);
  });

  it("R2 — terminates on a cyclic re-export instead of looping", () => {
    // The hop count was also the only thing stopping a cycle. A visited set does that
    // job without capping legitimate depth.
    soundTree();
    file("src/modules/demo/loop-a.ts", 'export * from "@demo/loop-b";\n');
    file("src/modules/demo/loop-b.ts", 'export * from "@demo/loop-a";\n');
    file(
      "src/modules/demo/index.ts",
      [
        'export type { Widget } from "@demo/types";',
        'export type { Detail } from "@demo/internal";',
        'export * from "@demo/loop-a";',
        'import type { Widget } from "@demo/types";',
        'import type { Detail } from "@demo/internal";',
        "export function make(detail: Detail): Widget {",
        "  return { id: String(detail.n) };",
        "}"
      ].join("\n")
    );
    expect(run(config()).code).toBe(0);
  });

  it("R1 — catches a vocabulary type the entry does not export", () => {
    // R1 read its entry labels from the map literally, so a config that named its entry
    // anything else skipped the rule without a word.
    file(
      "src/modules/demo/types.ts",
      "export interface Widget {\n  id: string;\n}\nexport type Gadget = { size: number };\n"
    );
    file(
      "src/modules/demo/index.ts",
      ['export type { Widget } from "@demo/types";', "export const version = 1;"].join("\n")
    );
    const { code, output } = run(config());
    expect(code).toBe(1);
    expect(output).toContain("R1");
    expect(output).toContain("Gadget");
  });

  it("R4 — catches a vocabulary type referencing something unexported", () => {
    file("src/modules/demo/internal.ts", "export interface Detail {\n  n: number;\n}\n");
    file(
      "src/modules/demo/types.ts",
      [
        'import type { Detail } from "@demo/internal";',
        "export interface Widget {",
        "  id: string;",
        "  detail: Detail;",
        "}"
      ].join("\n")
    );
    file(
      "src/modules/demo/index.ts",
      ['export type { Widget } from "@demo/types";', "export const version = 1;"].join("\n")
    );
    const { code, output } = run(config());
    expect(code).toBe(1);
    expect(output).toContain("R4");
    expect(output).toContain("Detail");
  });

  it("R3 — catches a name on one platform entry and not the other", () => {
    file("src/modules/demo/types.ts", "export interface Widget {\n  id: string;\n}\n");
    file(
      "src/modules/demo/index.ts",
      ['export type { Widget } from "@demo/types";', "export const nodeOnly = 1;"].join("\n")
    );
    file("src/modules/demo/index.browser.ts", 'export type { Widget } from "@demo/types";\n');
    const paired = config({
      entries: {
        demo: { file: "src/modules/demo/index.ts", platform: "node" },
        "demo (browser)": { file: "src/modules/demo/index.browser.ts", platform: "browser" }
      },
      vocabularyEntries: ["demo", "demo (browser)"],
      platformPair: ["demo", "demo (browser)"]
    });
    const { code, output } = run(paired);
    expect(code).toBe(1);
    expect(output).toContain("R3");
    expect(output).toContain("nodeOnly");
  });

  it("R3 — passes when the two platform entries match", () => {
    file("src/modules/demo/types.ts", "export interface Widget {\n  id: string;\n}\n");
    file("src/modules/demo/index.ts", 'export type { Widget } from "@demo/types";\n');
    file("src/modules/demo/index.browser.ts", 'export type { Widget } from "@demo/types";\n');
    const paired = config({
      entries: {
        demo: { file: "src/modules/demo/index.ts", platform: "node" },
        "demo (browser)": { file: "src/modules/demo/index.browser.ts", platform: "browser" }
      },
      vocabularyEntries: ["demo", "demo (browser)"],
      platformPair: ["demo", "demo (browser)"]
    });
    expect(run(paired).code).toBe(0);
  });

  it("R3 — does not throw when the config names no pair", () => {
    // Reading `ENTRIES["documonster/excel"]` unconditionally meant any other config
    // crashed here rather than skipping a rule that did not apply to it.
    soundTree();
    expect(run(config({ platformPair: null })).code).toBe(0);
  });

  it("R2 — separates the platforms, so a node export cannot cover a browser hole", () => {
    // The reason `platform` exists on an entry: a type reachable only from the Node
    // build is not reachable from a browser program.
    file("src/modules/demo/types.ts", "export interface Widget {\n  id: string;\n}\n");
    file("src/modules/demo/internal.ts", "export interface Detail {\n  n: number;\n}\n");
    file("src/modules/demo/node-only.ts", 'export type { Detail } from "@demo/internal";\n');
    file(
      "src/modules/demo/index.browser.ts",
      [
        'export type { Widget } from "@demo/types";',
        'import type { Widget } from "@demo/types";',
        'import type { Detail } from "@demo/internal";',
        "export function make(detail: Detail): Widget {",
        "  return { id: String(detail.n) };",
        "}"
      ].join("\n")
    );
    const split = config({
      entries: {
        "demo/node": { file: "src/modules/demo/node-only.ts", platform: "node" },
        "demo (browser)": { file: "src/modules/demo/index.browser.ts", platform: "browser" }
      },
      vocabularyEntries: [],
      platformPair: null
    });
    const { code, output } = run(split);
    expect(code).toBe(1);
    expect(output).toContain("no browser entry exports it");
  });

  it("guards this repository's own surface", () => {
    const output = execFileSync("node", [SCRIPT], { encoding: "utf8" });
    expect(output).toContain("passed");
  });
});
