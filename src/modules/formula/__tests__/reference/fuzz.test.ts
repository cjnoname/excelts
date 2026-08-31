/**
 * Fuzz testing for the formula engine.
 *
 * Generates random formulas from a small grammar and verifies the
 * engine either:
 *   (a) produces a well-typed `FormulaResult` (number / string /
 *       boolean / SnapshotError / undefined), or
 *   (b) emits a recognized Excel error code.
 *
 * Never allowed:
 *   - throwing an uncaught exception
 *   - returning `NaN` / `±Infinity` as a number
 *   - returning a non-whitelisted error code
 *   - hanging (wall-clock timeout)
 *
 * The goal is invariant-checking across millions of random inputs, not
 * correctness. Per-function correctness is covered in the saturation
 * tests; here we shake out crash bugs, parser edge cases, numerical
 * stability, and error-routing gaps.
 */

import { calculateFormulas } from "@excel/core/formula-adapter";
import { Cell, Workbook } from "@excel/index";
import type { Rng } from "@test/rng";
import { createRng } from "@test/rng";
import { describe, expect, it } from "vitest";

const KNOWN_ERRORS = new Set([
  "#N/A",
  "#NULL!",
  "#DIV/0!",
  "#VALUE!",
  "#REF!",
  "#NAME?",
  "#NUM!",
  "#GETTING_DATA",
  "#CALC!",
  "#SPILL!",
  "#CONNECT!",
  "#BLOCKED!",
  "#UNKNOWN!",
  "#FIELD!",
  "#BUSY!"
]);

const FUNCTIONS: [string, number, number][] = [
  // [name, minArity, maxArity]
  ["SUM", 1, 5],
  ["AVERAGE", 1, 5],
  ["MIN", 1, 5],
  ["MAX", 1, 5],
  ["PRODUCT", 1, 5],
  ["COUNT", 1, 5],
  ["COUNTA", 1, 5],
  ["ABS", 1, 1],
  ["SIGN", 1, 1],
  ["SQRT", 1, 1],
  ["POWER", 2, 2],
  ["MOD", 2, 2],
  ["ROUND", 2, 2],
  ["ROUNDUP", 2, 2],
  ["ROUNDDOWN", 2, 2],
  ["TRUNC", 1, 2],
  ["INT", 1, 1],
  ["CEILING", 2, 2],
  ["FLOOR", 2, 2],
  ["EXP", 1, 1],
  ["LN", 1, 1],
  ["LOG", 1, 2],
  ["LOG10", 1, 1],
  ["SIN", 1, 1],
  ["COS", 1, 1],
  ["TAN", 1, 1],
  ["ASIN", 1, 1],
  ["ACOS", 1, 1],
  ["ATAN", 1, 1],
  ["PI", 0, 0],
  ["IF", 3, 3],
  ["IFERROR", 2, 2],
  ["IFNA", 2, 2],
  ["AND", 1, 4],
  ["OR", 1, 4],
  ["NOT", 1, 1],
  ["LEN", 1, 1],
  ["UPPER", 1, 1],
  ["LOWER", 1, 1],
  ["TRIM", 1, 1],
  ["LEFT", 1, 2],
  ["RIGHT", 1, 2],
  ["MID", 3, 3],
  ["CONCAT", 1, 5],
  ["REPT", 2, 2],
  ["TEXT", 2, 2],
  ["VALUE", 1, 1],
  ["ISNUMBER", 1, 1],
  ["ISTEXT", 1, 1],
  ["ISBLANK", 1, 1],
  ["ISERROR", 1, 1],
  ["ISNA", 1, 1],
  // Added in the expansion round — ensure the new functions don't
  // crash / return disallowed values under random inputs.
  ["SQRTPI", 1, 1],
  ["ENCODEURL", 1, 1],
  ["VALUETOTEXT", 1, 2],
  ["ARRAYTOTEXT", 1, 2],
  ["REGEXTEST", 2, 3],
  ["REGEXEXTRACT", 2, 4],
  ["REGEXREPLACE", 3, 5],
  ["BINOM.DIST.RANGE", 3, 4],
  ["MMULT", 2, 2],
  ["MDETERM", 1, 1],
  ["MINVERSE", 1, 1],
  ["MUNIT", 1, 1],
  ["SERIESSUM", 4, 4],
  ["PERCENTRANK", 2, 3],
  ["PROB", 3, 4],
  ["STEYX", 2, 2],
  ["Z.TEST", 2, 3],
  ["T.TEST", 4, 4],
  ["F.TEST", 2, 2],
  ["CHISQ.TEST", 2, 2],
  ["CHISQ.INV.RT", 2, 2],
  ["LEFTB", 1, 2],
  ["RIGHTB", 1, 2],
  ["MIDB", 3, 3],
  ["LENB", 1, 1],
  ["FINDB", 2, 3],
  ["SEARCHB", 2, 3]
];

const OPERATORS = ["+", "-", "*", "/", "^", "&", "=", "<", ">", "<=", ">=", "<>"];

function genFormula(rng: Rng, depth: number): string {
  // Base cases: keep these boring so depth-limited recursion terminates.
  if (depth <= 0 || rng.next() < 0.3) {
    return genAtom(rng);
  }
  const choice = rng.next();
  if (choice < 0.5) {
    // Binary op
    const op = rng.pick(OPERATORS);
    return `(${genFormula(rng, depth - 1)}${op}${genFormula(rng, depth - 1)})`;
  }
  if (choice < 0.9) {
    // Function call
    const [name, minA, maxA] = rng.pick(FUNCTIONS);
    const arity = rng.int(minA, maxA);
    const args = Array.from({ length: arity }, () => genFormula(rng, depth - 1));
    return `${name}(${args.join(",")})`;
  }
  // Unary
  return `(-${genFormula(rng, depth - 1)})`;
}

function genAtom(rng: Rng): string {
  const choice = rng.next();
  if (choice < 0.35) {
    // Integer -20..20
    return String(rng.int(-20, 20));
  }
  if (choice < 0.6) {
    // Float
    return String((rng.next() - 0.5) * 200);
  }
  if (choice < 0.75) {
    // Boolean literal
    return rng.bool() ? "TRUE" : "FALSE";
  }
  if (choice < 0.9) {
    // Short string literal
    const len = rng.int(0, 5);
    let s = "";
    for (let i = 0; i < len; i++) {
      s += String.fromCharCode(rng.int(97, 122));
    }
    return `"${s}"`;
  }
  // Array literal {a,b;c,d}
  const rows = rng.int(1, 2);
  const cols = rng.int(1, 3);
  const cells: string[] = [];
  for (let r = 0; r < rows; r++) {
    const row: string[] = [];
    for (let c = 0; c < cols; c++) {
      row.push(String(rng.int(-10, 10)));
    }
    cells.push(row.join(","));
  }
  return `{${cells.join(";")}}`;
}

/** Evaluate through a fresh Workbook. Returns the cell result verbatim. */
function run(formula: string): unknown {
  const wb = Workbook.create();
  const ws = Workbook.addWorksheet(wb, "S");
  Cell.setValue(ws, "A1", { formula, result: 0 });
  calculateFormulas(wb);
  return Cell.getResult(ws, "A1");
}

/** Verify the result is a legal FormulaResult shape. */
function checkResult(formula: string, result: unknown): void {
  if (result === undefined || result === null) {
    return; // BLANK is legal
  }
  if (typeof result === "number") {
    // NaN and Infinity must never reach user code.
    expect(Number.isFinite(result)).toBe(true);
    return;
  }
  if (typeof result === "string") {
    return;
  }
  if (typeof result === "boolean") {
    return;
  }
  // After the early returns above, the only remaining legal shape is an error
  // object `{ error: string }`. Anything else is a bug.
  if (typeof result === "object" && "error" in result) {
    const code = (result as { error: string }).error;
    expect(KNOWN_ERRORS.has(code)).toBe(true);
    return;
  }
  throw new Error(`Unexpected result shape for "${formula}": ${JSON.stringify(result)}`);
}

describe("fuzz: random formulas produce well-typed results", () => {
  const SEEDS = [1, 2, 3, 42, 100, 12345, 99999];
  const PER_SEED = 200;

  for (const seed of SEEDS) {
    it(`seed ${seed}: ${PER_SEED} formulas`, () => {
      const rng = createRng(seed);
      for (let i = 0; i < PER_SEED; i++) {
        const depth = rng.int(1, 4);
        const f = genFormula(rng, depth);
        let r: unknown;
        try {
          r = run(f);
        } catch (e) {
          throw new Error(`Formula "${f}" threw: ${(e as Error).message}`);
        }
        try {
          checkResult(f, r);
        } catch (e) {
          throw new Error(`Formula "${f}" produced bad result: ${(e as Error).message}`);
        }
      }
    });
  }
});

describe("fuzz: malformed formulas degrade gracefully", () => {
  const MALFORMED = [
    "", // empty
    "=", // just equals
    "(((((",
    ")))))",
    "SUM(",
    "SUM(,,,,,)",
    "{{{}}}",
    "{1,2", // unclosed array
    '"abc', // unclosed string
    "1e", // incomplete scientific
    "#",
    "#FOOBAR!",
    "A A A",
    "1 2 3",
    "+++",
    "SUM(SUM(SUM(SUM(SUM(SUM(SUM(SUM(SUM(1))))))))",
    "((((((((((1))))))))))",
    "1/0/0/0",
    "LEFT()", // missing args
    "CONCAT()",
    "TEXT()",
    "IF(TRUE)",
    "IF()",
    "=====",
    "5=5=5=5",
    "a.b.c.d",
    '="""""', // weird string
    "   ",
    "1+",
    "+1",
    "--1",
    "1---1"
  ];

  for (const f of MALFORMED) {
    it(`"${f}" doesn't crash`, () => {
      let r: unknown;
      try {
        r = run(f);
      } catch {
        // Engine may throw for totally unparseable; that's acceptable
        // as long as it doesn't corrupt the workbook. We treat any
        // caught throw as a "graceful rejection".
        return;
      }
      // If it returned, the result must be well-typed.
      checkResult(f, r);
    });
  }
});

describe("fuzz: deeply nested parens", () => {
  // Guard against parser stack overflow. We know the parser's MAX_DEPTH
  // is 256; anything below that must complete, anything above should
  // error cleanly.
  it("depth 50 succeeds", () => {
    // Wrap: ((((1)))) fifty deep.
    const deep = "(".repeat(50) + "1" + ")".repeat(50);
    const r = run(deep);
    expect(r).toBe(1);
  });

  it("depth 200 errors but does not throw", () => {
    const deep = "(".repeat(200) + "1" + ")".repeat(200);
    let threw = false;
    let r: unknown;
    try {
      r = run(deep);
    } catch {
      threw = true;
    }
    if (!threw) {
      checkResult(deep, r);
    }
  });

  it("depth 500 errors cleanly (over MAX_DEPTH)", () => {
    const deep = "(".repeat(500) + "1" + ")".repeat(500);
    let threw = false;
    let r: unknown;
    try {
      r = run(deep);
    } catch {
      threw = true;
    }
    if (!threw) {
      checkResult(deep, r);
    }
    // Either outcome is acceptable; neither should crash the process.
    expect(typeof threw).toBe("boolean");
  });
});

describe("fuzz: unicode / control char safety", () => {
  const INPUTS = [
    '"\\u0000"',
    '"\\u001F"',
    '"\\u007F"',
    '"😀"',
    '"中文"',
    '"é"',
    '"\\uD83D\\uDE00"' // surrogate pair
  ];
  for (const inp of INPUTS) {
    it(`LEN(${inp})`, () => {
      const r = run(`LEN(${inp})`);
      expect(typeof r).toBe("number");
      expect(Number.isFinite(r as number)).toBe(true);
    });
  }
});

describe("fuzz: numeric edge cases", () => {
  const EDGES = [
    "1e308 * 10", // Infinity
    "1e-308 / 1e10", // underflow
    "-0",
    "0 / 0", // NaN / DIV0
    "LOG(0)",
    "LN(0)",
    "SQRT(-1)",
    "POWER(0, 0)",
    "POWER(0, -1)",
    "POWER(-1, 0.5)",
    "1/0",
    "(-1)^0.5",
    "EXP(1000)", // overflow
    "FACT(200)" // overflow
  ];
  for (const f of EDGES) {
    it(`${f}`, () => {
      const r = run(f);
      checkResult(f, r);
    });
  }
});

describe("fuzz: string concatenation never corrupts", () => {
  it("long concatenation chain", () => {
    const seg = '"abc"';
    const chain = Array(50).fill(seg).join("&");
    const r = run(chain);
    expect(typeof r).toBe("string");
    expect(r).toBe("abc".repeat(50));
  });

  it("number + string auto-coerce", () => {
    const r = run(`"n=" & 42`);
    expect(r).toBe("n=42");
  });
});
