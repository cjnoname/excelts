/**
 * `Formula` namespace surface — the formula engine's value API.
 *
 * `import { Formula } from "documonster/formula"` →
 *   `Formula.tokenize(src)`, `Formula.parse(tokens)`, `Formula.print(ast)`.
 *
 * Everything is used directly — there is no install / registration step.
 * Single flat namespace (formula is a single-purpose module). Re-exported
 * via `export * as Formula`, tree-shaken per-member on rolldown / rspack.
 */
export { tokenize } from "@formula/syntax/tokenizer";
export { parse } from "@formula/syntax/parser";
// The inverse of `parse`, so the syntax layer is symmetric: anything that transforms,
// normalises or reconstructs a formula can hand back text instead of assembling it.
// Parentheses are minimal, so printing normalises redundant ones away.
export { printAst as print } from "@formula/syntax/print";
