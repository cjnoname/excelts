/**
 * `formula_evaluate` tests.
 *
 * This tool exists so a model does not have to reason about Excel semantics
 * from memory, so the tests assert real engine behaviour: match modes, error
 * values, dynamic-array spill, and the `=` normalization without which every
 * formula silently becomes `#NAME?`.
 */

import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveConfig, type ServerConfig } from "../config.js";
import { formulaEvaluateTool } from "../tools/formula-evaluate.js";

async function makeConfig(args: readonly string[] = []): Promise<ServerConfig> {
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "documonster-mcp-formula-")));
  return resolveConfig(args, { cwd });
}

async function evaluate(config: ServerConfig, args: Record<string, unknown>): Promise<string> {
  const result = await formulaEvaluateTool.handler(args, { config });
  const text = result.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map(block => block.text)
    .join("\n");
  if (result.isError === true) {
    throw new Error(text);
  }
  return text;
}

describe("formula_evaluate", () => {
  it("evaluates a self-contained formula", async () => {
    const config = await makeConfig();
    expect(await evaluate(config, { formula: "=1+2*3" })).toContain("result: **7**");
  });

  it("normalizes a leading = — without which everything is #NAME?", async () => {
    const config = await makeConfig();
    const withEquals = await evaluate(config, { formula: "=SUM(1,2,3)" });
    const without = await evaluate(config, { formula: "SUM(1,2,3)" });
    expect(withEquals).toContain("result: **6**");
    expect(without).toContain("result: **6**");
  });

  it("uses the supplied cell context", async () => {
    const config = await makeConfig();
    const text = await evaluate(config, {
      formula: "=SUM(A1:A3)",
      context: { A1: 10, A2: 20, A3: 12.5 }
    });
    expect(text).toContain("result: **42.5**");
    expect(text).toContain("Evaluated with 3 context cell(s)");
  });

  it("answers a real XLOOKUP match-mode question", async () => {
    // The kind of thing a model gets wrong from memory: reverse search returns
    // the LAST duplicate, not the first.
    const config = await makeConfig();
    const context = {
      A1: "widget-a",
      A2: "widget-b",
      A3: "widget-b",
      A4: "widget-c",
      C1: 10,
      C2: 20,
      C3: 30,
      C4: 40
    };
    const forward = await evaluate(config, {
      formula: '=XLOOKUP("widget-b",A1:A4,C1:C4,"NA",0,1)',
      context
    });
    const reverse = await evaluate(config, {
      formula: '=XLOOKUP("widget-b",A1:A4,C1:C4,"NA",0,-1)',
      context
    });
    expect(forward).toContain("result: **20**");
    expect(reverse).toContain("result: **30**");
  });

  it("reports an Excel error value as a result, not a tool failure", async () => {
    const config = await makeConfig();
    const text = await evaluate(config, { formula: "=1/0" });
    expect(text).toContain("#DIV/0!");
    expect(text).toContain("not a tool failure");
  });

  it("reports #NAME? for a function that does not exist", async () => {
    const config = await makeConfig();
    expect(await evaluate(config, { formula: "=NOSUCHFUNC(1)" })).toContain("#NAME?");
  });

  it("detects a dynamic array and lists the spilled cells", async () => {
    const config = await makeConfig();
    const text = await evaluate(config, { formula: "=SEQUENCE(3)" });
    expect(text).toContain("dynamic array");
    expect(text).toContain("spills over 3 cells");
    expect(text).toContain("r+1,c+0");
    expect(text).toContain("r+2,c+0");
  });

  it("handles a horizontal spill", async () => {
    const config = await makeConfig();
    const text = await evaluate(config, { formula: "=SEQUENCE(1,4)" });
    expect(text).toContain("spills over 4 cells");
    expect(text).toContain("r+0,c+3");
  });

  it("evaluates dependency chains through contextFormulas", async () => {
    const config = await makeConfig();
    const text = await evaluate(config, {
      formula: "=B1*2",
      context: { A1: 5, A2: 7 },
      contextFormulas: { B1: "=SUM(A1:A2)" }
    });
    expect(text).toContain("result: **24**");
    expect(text).toContain("`B1` = 12");
  });

  it("evaluates a financial function", async () => {
    const config = await makeConfig();
    const text = await evaluate(config, {
      formula: "=ROUND(XIRR(A1:A4,B1:B4)*100,2)",
      context: { A1: -1000, A2: 300, A3: 400, A4: 500 },
      contextFormulas: {
        B1: "=DATE(2024,1,1)",
        B2: "=DATE(2024,6,1)",
        B3: "=DATE(2025,1,1)",
        B4: "=DATE(2025,6,1)"
      }
    });
    expect(text).toContain("result: **19.69**");
  });

  it("evaluates LET, and LAMBDA bound through LET or a higher-order function", async () => {
    const config = await makeConfig();
    expect(await evaluate(config, { formula: "=LET(x,5,y,3,x*y)" })).toContain("result: **15**");
    expect(await evaluate(config, { formula: "=LET(f,LAMBDA(a,b,a+b),f(2,3))" })).toContain(
      "result: **5**"
    );
    expect(await evaluate(config, { formula: "=REDUCE(0,{1,2,3},LAMBDA(acc,x,acc+x))" })).toContain(
      "result: **6**"
    );
  });

  it("pins the engine's LAMBDA limitation: the immediately-invoked form is unsupported", async () => {
    // Excel accepts `LAMBDA(a,b,a+b)(2,3)`; this engine returns #NAME?. Pinned
    // rather than hidden so the limitation is documented, and so improving the
    // engine surfaces here as a failing test that prompts a docs update.
    const config = await makeConfig();
    expect(await evaluate(config, { formula: "=LAMBDA(a,b,a+b)(2,3)" })).toContain("#NAME?");
  });

  it("shows the formatted text alongside the raw result", async () => {
    const config = await makeConfig();
    const text = await evaluate(config, { formula: '=TEXT(0.1234,"0.0%")' });
    expect(text).toContain("12.3%");
  });

  it("rejects a malformed context address", async () => {
    const config = await makeConfig();
    await expect(
      formulaEvaluateTool.handler({ formula: "=A1", context: { A: 1 } }, { config })
    ).rejects.toThrow(/is not a cell address/);
  });

  it("works under --readonly, since it touches no files", async () => {
    const config = await makeConfig(["--readonly"]);
    expect(await evaluate(config, { formula: "=2+2" })).toContain("result: **4**");
  });
});
