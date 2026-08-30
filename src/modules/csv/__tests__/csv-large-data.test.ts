/**
 * CSV Large Data & Performance Edge Case Tests
 *
 * Tests for:
 * - Large number of columns (wide data)
 * - Large number of rows (deep data)
 * - Large field content
 * - Memory efficiency in streaming
 * - Performance boundaries
 */

import { Csv } from "@csv/index";
import { CsvParserStream } from "@csv/stream";
import { describe, it, expect } from "vitest";

import {
  generateLargeCsv,
  generateEdgeCaseCsv,
  measureTime,
  parseStreamCsv
} from "./csv-test-utils";

// =============================================================================
// Wide Data (Many Columns) Tests
// =============================================================================
describe("wide data", () => {
  it("parses 100 columns", () => {
    const cols = 100;
    const headers = Array.from({ length: cols }, (_, i) => `col${i}`);
    const values = Array.from({ length: cols }, (_, i) => `val${i}`);
    const csv = headers.join(",") + "\n" + values.join(",");

    const result = Csv.parse(csv, { headers: true }) as { rows: Record<string, string>[] };

    expect(result.rows).toHaveLength(1);
    expect(Object.keys(result.rows[0])).toHaveLength(cols);
    expect(result.rows[0].col0).toBe("val0");
    expect(result.rows[0].col99).toBe("val99");
  });

  it("parses 1000 columns", () => {
    const csv = generateEdgeCaseCsv("wide");
    const result = Csv.parse(csv, { headers: true }) as { rows: Record<string, string>[] };

    expect(result.rows).toHaveLength(1);
    expect(Object.keys(result.rows[0])).toHaveLength(1000);
  });

  it("streams 1000 columns", async () => {
    const csv = generateEdgeCaseCsv("wide");
    const parser = new CsvParserStream({ headers: true });
    const rows = await parseStreamCsv<Record<string, string>>(csv, parser);

    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0])).toHaveLength(1000);
  });

  it("formats 500 columns", () => {
    const cols = 500;
    const data = [Array.from({ length: cols }, (_, i) => `val${i}`)];
    const result = Csv.format(data, { trailingNewline: false });
    const parsed = Csv.parse(result) as string[][];

    expect(parsed[0]).toHaveLength(cols);
    expect(parsed[0][0]).toBe("val0");
    expect(parsed[0][499]).toBe("val499");
  });
});

// =============================================================================
// Deep Data (Many Rows) Tests
// =============================================================================
describe("deep data", () => {
  it("parses 1000 rows", () => {
    const csv = generateLargeCsv(1000, 3);
    const result = Csv.parse(csv) as string[][];

    expect(result).toHaveLength(1001); // 1 header + 1000 data rows
  });

  it("streams 10000 rows", async () => {
    const csv = generateEdgeCaseCsv("deep");
    const parser = new CsvParserStream();

    const rows: string[][] = [];
    parser.on("data", row => rows.push(row as string[]));

    const done = new Promise<void>((resolve, reject) => {
      parser.on("end", resolve);
      parser.on("error", reject);
    });

    // Feed CSV to parser
    parser.end(csv);

    await done;

    expect(rows.length).toBeGreaterThan(9000);
  }, 60000); // 60s timeout for large data

  it("respects maxRows limit", () => {
    const csv = generateLargeCsv(10000, 3);
    const result = Csv.parse(csv, { maxRows: 100 }) as string[][];

    expect(result).toHaveLength(100);
  });

  it("streams with skipRows", async () => {
    const csv = generateLargeCsv(1000, 3);
    const parser = new CsvParserStream({ skipRows: 500 });
    const rows = await parseStreamCsv<string[]>(csv, parser);

    // 1001 total rows (1 header + 1000 data), skip first 500 data rows
    expect(rows.length).toBeLessThanOrEqual(502); // header + ~500 remaining
  });

  it("iterates with Csv.parseRows and early exit", async () => {
    const csv = generateLargeCsv(5000, 3);
    let count = 0;

    for await (const _row of Csv.parseRows(csv)) {
      count++;
      if (count >= 1000) {
        break;
      }
    }

    expect(count).toBe(1000);
  });
});

// =============================================================================
// Large Field Content Tests
// =============================================================================
describe("large fields", () => {
  it("parses 10KB field", () => {
    const largeContent = "x".repeat(10 * 1024);
    const csv = `name,content\ntest,"${largeContent}"`;
    const result = Csv.parse(csv, { headers: true }) as { rows: Record<string, string>[] };

    expect(result.rows[0].content).toHaveLength(10 * 1024);
  });

  it("parses 100KB field", () => {
    const csv = generateEdgeCaseCsv("large-field");
    const result = Csv.parse(csv, { headers: true }) as { rows: Record<string, string>[] };

    expect(result.rows[0].content.length).toBeGreaterThanOrEqual(100 * 1024);
  });

  it("parses field with 1000 embedded newlines", () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `line${i}`).join("\n");
    const csv = `content\n"${lines}"`;
    const result = Csv.parse(csv, { headers: true }) as { rows: Record<string, string>[] };

    expect(result.rows[0].content.split("\n")).toHaveLength(1000);
  });

  it("streams 50KB field", async () => {
    const largeContent = "y".repeat(50 * 1024);
    const csv = `a,b\n1,"${largeContent}"`;
    const parser = new CsvParserStream({ headers: true });
    const rows = await parseStreamCsv<Record<string, string>>(csv, parser);

    expect(rows[0].b).toHaveLength(50 * 1024);
  });

  it("formats large field with newlines", () => {
    const largeContent = "content\nwith\nnewlines".repeat(1000);
    const data = [["test", largeContent]];
    const result = Csv.format(data, { trailingNewline: false });
    const parsed = Csv.parse(result) as string[][];

    expect(parsed[0][1]).toBe(largeContent);
  });
});

// =============================================================================
// Performance Boundary Tests
// =============================================================================
describe("performance", () => {
  it("parses 1000x10 within 500ms", async () => {
    const csv = generateLargeCsv(1000, 10);
    const { ms } = await measureTime(() => Csv.parse(csv));

    // Should complete within 500ms (very generous for CI environments)
    expect(ms).toBeLessThan(500);
  });

  it("formats 1000x10 within 500ms", async () => {
    const data: string[][] = [];
    for (let i = 0; i < 1000; i++) {
      data.push(Array.from({ length: 10 }, (_, j) => `val${i}_${j}`));
    }

    const { ms } = await measureTime(() => Csv.format(data));

    expect(ms).toBeLessThan(500);
  });

  it("allows early exit without processing all data", async () => {
    const csv = generateLargeCsv(10000, 5);

    let streamCount = 0;
    for await (const _row of Csv.parseRows(csv)) {
      streamCount++;
      if (streamCount >= 100) {
        break;
      }
    }

    const batchResult = Csv.parse(csv) as string[][];

    expect(streamCount).toBe(100);
    expect(batchResult.length).toBeGreaterThan(10000);
  });

  it("fastMode parses 5000 rows within 500ms", async () => {
    const csv = generateLargeCsv(5000, 5, { seed: 12345 });
    // Modify to ensure no quotes
    const simpleData = csv.replace(/"/g, "");

    const { ms } = await measureTime(() => Csv.parse(simpleData, { fastMode: true }));

    expect(ms).toBeLessThan(500);
  });

  // Regression: the scanner used to run indexOf("\n") and indexOf("\r") separately per
  // field. In a file without "\r" the second call walked to the end of the input on
  // every field, so parse time grew with fields × bytes: ~3 s for this input and
  // ~40 s for 50 000 rows, while the same data with CRLF endings took ~30 ms.
  it("parses 20000x14 LF-only rows within 1000ms (newline scan stays linear)", async () => {
    // generateLargeCsv joins rows with "\n" — no "\r" anywhere in the input.
    const csv = generateLargeCsv(20000, 14);

    const { result, ms } = await measureTime(() => Csv.parse(csv) as string[][]);

    expect(result).toHaveLength(20001);
    expect(ms).toBeLessThan(1000);
  });

  it("parses 20000x14 CR-only rows within 1000ms (newline scan stays linear)", async () => {
    const csv = generateLargeCsv(20000, 14).replace(/\r?\n/g, "\r");

    const { result, ms } = await measureTime(() => Csv.parse(csv) as string[][]);

    expect(result).toHaveLength(20001);
    expect(ms).toBeLessThan(1000);
  });
});

// =============================================================================
// Memory Boundary Tests
// =============================================================================
describe("memory", () => {
  it("handles 100 repeated parses", () => {
    const csv = generateLargeCsv(100, 10);

    // Parse multiple times
    for (let i = 0; i < 100; i++) {
      Csv.parse(csv);
    }

    // If we got here without OOM, test passes
    expect(true).toBe(true);
  });

  it("streams without accumulating rows", async () => {
    const csv = generateLargeCsv(1000, 5);
    let processedCount = 0;

    const parser = new CsvParserStream();
    parser.on("data", () => {
      processedCount++;
    });

    const done = new Promise<void>(resolve => {
      parser.on("end", resolve);
    });

    parser.end(csv);
    await done;

    expect(processedCount).toBeGreaterThan(1000);
  });
});

// =============================================================================
// Reproducibility Tests
// =============================================================================
describe("reproducibility", () => {
  it("same seed produces identical CSV", () => {
    const csv1 = generateLargeCsv(100, 5, { seed: 42 });
    const csv2 = generateLargeCsv(100, 5, { seed: 42 });

    expect(csv1).toBe(csv2);
  });

  it("different seeds produce different CSV", () => {
    const csv1 = generateLargeCsv(100, 5, { seed: 42 });
    const csv2 = generateLargeCsv(100, 5, { seed: 43 });

    expect(csv1).not.toBe(csv2);
  });
});
