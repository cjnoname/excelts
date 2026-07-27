import { loadIife } from "@test/browser/load-iife";
import { describe, it, expect, beforeAll } from "vitest";

/**
 * Smoke test for the shipped `documonster.formula.iife.min.js` bundle: asserts
 * the `Documonster.Formula` surface and that the tokenizer runs in a browser.
 */
describe("Documonster.Formula IIFE bundle", () => {
  let Formula: any;

  beforeAll(async () => {
    ({ Formula } = await loadIife<{ Formula: any }>("formula", "Formula"));
  }, 60000);

  it("exposes the Formula syntax namespace", () => {
    expect(typeof Formula.tokenize).toBe("function");
    expect(typeof Formula.parse).toBe("function");
    expect(Formula.calculate).toBeUndefined();
  });

  it("tokenizes an arithmetic expression", () => {
    const tokens = Formula.tokenize("1+2*3");
    expect(Array.isArray(tokens)).toBe(true);
    // 1, +, 2, *, 3 → five tokens.
    expect(tokens.length).toBe(5);
    expect(tokens[0].value).toBe("1");
  });
});
