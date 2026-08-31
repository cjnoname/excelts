/**
 * Printing an AST back to formula text.
 *
 * The assertions are structural, not textual, and that distinction is the whole design.
 * Parentheses are emitted only where precedence requires them, so `(A1)` prints as `A1` —
 * meaning a textual round trip is *not* the invariant. What must hold is that the tree
 * survives: `parse(print(ast))` is the same tree, and printing twice changes nothing.
 *
 * Expressed that way, the test also pins something a string comparison could not — that
 * the printer's precedence table agrees with the parser's. If the two ever diverge the
 * round trip fails, which is why the binding powers are not asserted directly.
 */

import { NodeType, type AstNode } from "@formula/syntax/ast";
import { parse } from "@formula/syntax/parser";
import { printAst } from "@formula/syntax/print";
import { tokenize } from "@formula/syntax/tokenizer";
import { createRng } from "@test/rng";
import { describe, expect, it } from "vitest";

const roundTrip = (source: string): { printed: string; structural: boolean; stable: boolean } => {
  const ast = parse(tokenize(source));
  const printed = printAst(ast);
  const reparsed = parse(tokenize(printed));
  return {
    printed,
    structural: JSON.stringify(ast) === JSON.stringify(reparsed),
    stable: printAst(reparsed) === printed
  };
};

/** Assert the tree survives printing, and report the text when it does not. */
function expectRoundTrip(source: string): string {
  const result = roundTrip(source);
  expect(result.structural, `${source} → ${result.printed} changed the tree`).toBe(true);
  expect(result.stable, `${source} → ${result.printed} is not idempotent`).toBe(true);
  return result.printed;
}

describe("operators", () => {
  it("keeps precedence without redundant parentheses", () => {
    expect(expectRoundTrip("1+2*3")).toBe("1+2*3");
    expect(expectRoundTrip("(1+2)*3")).toBe("(1+2)*3");
    expect(expectRoundTrip("1&2&3")).toBe("1&2&3");
    expect(expectRoundTrip("A1>=1")).toBe("A1>=1");
  });

  it("respects Excel's left-associative exponentiation", () => {
    // `=2^3^2` is `(2^3)^2 = 64` in Excel, not `2^(3^2) = 512`. Printing it right-
    // associatively would produce text that computes something else.
    expect(expectRoundTrip("2^3^2")).toBe("2^3^2");
    expect(expectRoundTrip("2^(3^2)")).toBe("2^(3^2)");
  });

  it("respects unary minus binding tighter than exponentiation", () => {
    // Excel is alone in this: `=-2^2` is `(-2)^2 = 4`, not `-(2^2) = -4`.
    expect(expectRoundTrip("-2^2")).toBe("-2^2");
    expect(expectRoundTrip("-(2+3)")).toBe("-(2+3)");
    expect(expectRoundTrip("--A1")).toBe("--A1");
  });

  it("distinguishes left from right at equal precedence", () => {
    // The case a single "wrap when looser" rule has to get right: subtraction is
    // left-associative, so the left operand needs no parentheses and the right one does.
    expect(expectRoundTrip("1-2-3")).toBe("1-2-3");
    expect(expectRoundTrip("1-(2-3)")).toBe("1-(2-3)");
    expect(expectRoundTrip("2/3/4")).toBe("2/3/4");
    expect(expectRoundTrip("2/(3/4)")).toBe("2/(3/4)");
  });

  it("parenthesises a percent operand when it is not an atom", () => {
    expect(expectRoundTrip("A1%")).toBe("A1%");
    expect(expectRoundTrip("(A1+A2)%")).toBe("(A1+A2)%");
  });

  it("prints the intersection operator as a space", () => {
    expect(expectRoundTrip("A1:B2 B1:C3")).toBe("A1:B2 B1:C3");
  });
});

describe("references", () => {
  it("prints absolute markers where they were", () => {
    for (const source of ["A1", "$A1", "A$1", "$A$1", "$A$1:$B$2", "A1:$B2"]) {
      expect(expectRoundTrip(source)).toBe(source);
    }
  });

  it("prints sheet-qualified and 3D references", () => {
    expect(expectRoundTrip("Sheet1!A1")).toBe("Sheet1!A1");
    expect(expectRoundTrip("Sheet1!A1:B2")).toBe("Sheet1!A1:B2");
    expect(expectRoundTrip("Sheet1:Sheet3!A1:B2")).toBe("Sheet1:Sheet3!A1:B2");
  });

  it("quotes a sheet name that needs it, and only then", () => {
    // A name with a space must be quoted or the tokenizer reads it as an intersection.
    expect(expectRoundTrip("'My Sheet'!A1")).toBe("'My Sheet'!A1");
    expect(expectRoundTrip("Sheet_1.2!A1")).toBe("Sheet_1.2!A1");
  });

  it("prints whole-column and whole-row ranges", () => {
    expect(expectRoundTrip("A:B")).toBe("A:B");
    expect(expectRoundTrip("1:3")).toBe("1:3");
    expect(expectRoundTrip("Sheet1!A:B")).toBe("Sheet1!A:B");
  });

  it("prints a reference union with the parentheses that make it one", () => {
    // Without them the commas would be argument separators and the tree would differ.
    expect(expectRoundTrip("SUM((A1:B2,D4:E5))")).toBe("SUM((A1:B2,D4:E5))");
  });

  it("prints structured references in the bracket form the parser accepts", () => {
    expect(expectRoundTrip("Table1[Column]")).toBe("Table1[Column]");
    expect(expectRoundTrip("Table1[[#Data],[Column]]")).toBe("Table1[[#Data],[Column]]");
  });
});

describe("literals", () => {
  it("doubles a quote inside a string", () => {
    expect(expectRoundTrip('"quo""te"')).toBe('"quo""te"');
    expect(expectRoundTrip('""')).toBe('""');
  });

  it("prints the exponent form the way the tokenizer reads it back", () => {
    // JavaScript writes `1e+21`; Excel writes `1E+21`. The lower-case form is the one case
    // where `String(x)` produces text that does not survive re-tokenising.
    expect(expectRoundTrip("1E+21")).toBe("1E+21");
    expect(expectRoundTrip("1.5E-10")).toBe("1.5E-10");
  });

  it("prints numbers, booleans and errors", () => {
    for (const source of ["0", "42", "-1", "3.5", "TRUE", "FALSE", "#DIV/0!", "#N/A", "#REF!"]) {
      expect(expectRoundTrip(source)).toBe(source);
    }
  });

  it("prints array literals with row and column separators", () => {
    expect(expectRoundTrip("{1,2;3,4}")).toBe("{1,2;3,4}");
    expect(expectRoundTrip("MATCH(A1,{1,2,3},0)")).toBe("MATCH(A1,{1,2,3},0)");
  });
});

describe("function calls", () => {
  it("prints an omitted argument as nothing", () => {
    expect(expectRoundTrip("IF(A1,,0)")).toBe("IF(A1,,0)");
  });

  it("prints nested calls and a zero-argument call", () => {
    expect(expectRoundTrip("SUM(IF(A1>0,A1,0),B1)")).toBe("SUM(IF(A1>0,A1,0),B1)");
    expect(expectRoundTrip("TODAY()")).toBe("TODAY()");
  });
});

describe("normalisation", () => {
  it("drops redundant parentheses", () => {
    // The AST does not record them, so this is what a round trip through it can preserve —
    // and it is what Excel does when a formula is edited. Documented rather than worked
    // around, because pretending otherwise would mean adding a node with no meaning.
    expect(expectRoundTrip("(A1)")).toBe("A1");
    expect(expectRoundTrip("((A1+A2))")).toBe("A1+A2");
    expect(expectRoundTrip("SUM((A1))")).toBe("SUM(A1)");
  });

  it("is idempotent on already-normal text", () => {
    for (const source of ["A1+A2*A3", "SUM(A1:A10)/COUNT(A1:A10)", "-A1%"]) {
      const once = printAst(parse(tokenize(source)));
      expect(printAst(parse(tokenize(once)))).toBe(once);
    }
  });
});

describe("every node type is printable", () => {
  it("covers the AST union", () => {
    // A new node type without a printer branch is a compile error, but a node type the
    // parser can produce and no test exercises would go unnoticed — so the coverage is
    // asserted rather than assumed.
    const covered = new Set<NodeType>();
    const collect = (node: AstNode): void => {
      covered.add(node.type);
      switch (node.type) {
        case NodeType.BinaryOp:
          collect(node.left);
          collect(node.right);
          break;
        case NodeType.UnaryOp:
        case NodeType.Percent:
          collect(node.operand);
          break;
        case NodeType.FunctionCall:
          node.args.forEach(collect);
          break;
        case NodeType.UnionRef:
          node.areas.forEach(collect);
          break;
        case NodeType.Array:
          node.rows.forEach(row => row.forEach(collect));
          break;
        case NodeType.RangeRef:
          collect(node.start);
          collect(node.end);
          break;
        default:
          break;
      }
    };

    for (const source of [
      "1",
      '"s"',
      "TRUE",
      "#REF!",
      "A1",
      "A1:B2",
      "1+1",
      "-1",
      "SUM(A1)",
      "{1}",
      "A1%",
      "MyName",
      "A:B",
      "1:3",
      "Table1[Col]",
      "IF(A1,,0)",
      "SUM((A1,B1))"
    ]) {
      collect(parse(tokenize(source)));
      expectRoundTrip(source);
    }

    const allTypes = Object.values(NodeType).filter(value => typeof value === "number");
    expect([...covered].sort((a, b) => a - b)).toEqual(allTypes.sort((a, b) => a - b));
  });
});

describe("fuzz", () => {
  it("survives a printing round trip for generated formulas", () => {
    // The invariant across many inputs rather than a longer list of cases: whatever the
    // generator produces, printing must not change the tree. Fixed seeds so a failure names
    // the input and re-running reproduces it.
    const atoms = [
      "A1",
      "$B$2",
      "Sheet1!C3",
      "'My Sheet'!D4",
      "A1:B2",
      "A:A",
      "2:2",
      "1",
      "3.5",
      "-7",
      '"txt"',
      "TRUE",
      "#N/A",
      "MyName",
      "Table1[Col]"
    ];
    const binary = ["+", "-", "*", "/", "^", "&", "=", "<>", "<", ">", "<=", ">="];
    const functions = ["SUM", "IF", "MAX", "ROUND", "CONCATENATE"];

    for (const seed of [1, 2, 3, 42, 1337, 99_999]) {
      const rng = createRng(seed);
      const build = (depth: number): string => {
        if (depth <= 0 || rng.bool(0.3)) {
          return rng.pick(atoms);
        }
        switch (rng.int(0, 4)) {
          case 0:
            return `${build(depth - 1)}${rng.pick(binary)}${build(depth - 1)}`;
          case 1:
            return `${rng.pick(["-", "+"])}${build(depth - 1)}`;
          case 2:
            return `${build(depth - 1)}%`;
          case 3:
            return `(${build(depth - 1)})`;
          default: {
            const arity = rng.int(1, 3);
            const args = Array.from({ length: arity }, () => build(depth - 1));
            return `${rng.pick(functions)}(${args.join(",")})`;
          }
        }
      };

      for (let iteration = 0; iteration < 120; iteration++) {
        const source = build(rng.int(1, 4));
        let ast: AstNode;
        try {
          ast = parse(tokenize(source));
        } catch {
          // The generator is allowed to produce text the parser rejects; only what parses
          // has to print.
          continue;
        }
        const printed = printAst(ast);
        const reparsed = parse(tokenize(printed));
        expect(
          JSON.stringify(reparsed),
          `seed ${seed}, iteration ${iteration}: ${source} → ${printed}`
        ).toBe(JSON.stringify(ast));
      }
    }
  });
});
