import { loadIife } from "@test/browser/load-iife";
import { describe, it, expect, beforeAll } from "vitest";

/**
 * Smoke test for the shipped `documonster.csv.iife.min.js` bundle: asserts the
 * `Documonster.Csv` surface and a parse → format round-trip run in a browser.
 */
describe("Documonster.Csv IIFE bundle", () => {
  let Csv: any;

  beforeAll(async () => {
    ({ Csv } = await loadIife<{ Csv: any }>("csv", "Csv"));
  }, 60000);

  it("exposes the Csv namespace with parse/format", () => {
    expect(typeof Csv.parse).toBe("function");
    expect(typeof Csv.format).toBe("function");
  });

  it("parses CSV text into rows", () => {
    const rows = Csv.parse("a,b\n1,2");
    expect(rows).toEqual([
      ["a", "b"],
      ["1", "2"]
    ]);
  });

  it("formats rows back to CSV text (round-trip)", () => {
    const text = Csv.format([
      ["a", "b"],
      ["1", "2"]
    ]);
    expect(text).toBe("a,b\n1,2");
    expect(Csv.parse(text)).toEqual([
      ["a", "b"],
      ["1", "2"]
    ]);
  });

  it("streams rows across one-character chunk boundaries", async () => {
    const parser = new Csv.ParserStream();
    const rows: string[][] = [];
    parser.on("data", (row: string[]) => rows.push(row));
    const ended = new Promise<void>((resolve, reject) => {
      parser.on("end", resolve);
      parser.on("error", reject);
    });

    for (const char of 'a,"b\nc",d\ne,"f""g",h\n') {
      parser.write(char);
    }
    parser.end();
    await ended;

    expect(rows).toEqual([
      ["a", "b\nc", "d"],
      ["e", 'f"g', "h"]
    ]);
  });
});
