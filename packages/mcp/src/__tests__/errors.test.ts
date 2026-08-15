/**
 * Error-formatting tests.
 *
 * The text produced here is what the model reads and acts on, so it is part of
 * the interface. The `cause` chain matters most: documonster's own errors chain
 * via `{ cause }`, and the innermost message is usually the one naming the cell,
 * OOXML part or ZIP entry that actually failed.
 */

import { formatToolError, McpToolError, toolError } from "../errors.js";

describe("formatToolError", () => {
  it("leads with the machine-readable code", () => {
    const text = formatToolError(toolError.notFound("no such file: a.xlsx"));
    expect(text.startsWith("[not_found] no such file: a.xlsx")).toBe(true);
  });

  it("includes the hint when there is one", () => {
    const text = formatToolError(toolError.invalidInput("bad range", "Use A1:B10 notation."));
    expect(text).toContain("Hint: Use A1:B10 notation.");
  });

  it("omits the hint line when there is none", () => {
    expect(formatToolError(toolError.invalidInput("bad range"))).not.toContain("Hint:");
  });

  it("flattens a cause chain so the innermost failure survives", () => {
    const innermost = new Error("zip entry xl/worksheets/sheet1.xml is corrupt");
    innermost.name = "ZipParseError";
    const middle = new Error("failed to read workbook", { cause: innermost });
    middle.name = "XlsxReadError";
    const outer = new McpToolError("internal", "sheet_read failed", { cause: middle });

    const text = formatToolError(outer);
    expect(text).toContain("[internal] sheet_read failed");
    expect(text).toContain("XlsxReadError: failed to read workbook");
    expect(text).toContain("ZipParseError: zip entry xl/worksheets/sheet1.xml is corrupt");
    expect(text.indexOf("XlsxReadError")).toBeLessThan(text.indexOf("ZipParseError"));
  });

  it("stops walking a self-referential cause chain", () => {
    // A cyclic chain must not hang the server.
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as { cause?: unknown }).cause = b;

    const text = formatToolError(new McpToolError("internal", "boom", { cause: a }));
    expect(text).toContain("[internal] boom");
    expect(text.length).toBeLessThan(500);
  });

  it("reports a non-McpToolError as internal, never as a designed message", () => {
    // Prevents an unmapped library error from masquerading as a model-facing
    // code the model might act on.
    const text = formatToolError(new TypeError("cannot read properties of undefined"));
    expect(text.startsWith("[internal] TypeError:")).toBe(true);
  });

  it("handles a thrown non-Error value", () => {
    expect(formatToolError("just a string")).toBe("[internal] just a string");
    expect(formatToolError(undefined)).toBe("[internal] undefined");
  });

  it("renders a non-Error cause", () => {
    const text = formatToolError(new McpToolError("internal", "boom", { cause: "plain string" }));
    expect(text).toContain("Caused by: plain string");
  });
});

describe("McpToolError", () => {
  it("carries the code and hint", () => {
    const error = toolError.tooLarge("too big", "narrow the range");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("McpToolError");
    expect(error.code).toBe("too_large");
    expect(error.hint).toBe("narrow the range");
  });
});
