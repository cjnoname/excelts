/**
 * `doc_inspect` content-detection tests.
 *
 * Calls the tool handler directly rather than going through a transport: the
 * protocol path is covered in `server.test.ts`, and these cases are about
 * format detection, of which there are many.
 */

import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Workbook, Worksheet } from "documonster/excel";
import { Pdf } from "documonster/pdf";

import { resolveConfig, type ServerConfig } from "../config.js";
import { inspectTool } from "../tools/inspect.js";

interface Fixture {
  readonly config: ServerConfig;
  readonly root: string;
}

async function fixture(args: readonly string[] = []): Promise<Fixture> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "documonster-mcp-inspect-")));
  const base = resolveConfig(args, { cwd: root });
  // Business-behaviour tests use the explicit compatibility layout; dedicated
  // sandbox regressions below cover the secure dual-root default.
  return {
    config: { ...base, outputRoot: root, allowInPlace: true },
    root
  };
}

async function inspect(fx: Fixture, target: string): Promise<string> {
  const result = await inspectTool.handler({ path: target }, { config: fx.config });
  return result.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map(block => block.text)
    .join("\n");
}

/** Magic byte prefixes, as the real files begin. */
const MAGIC = {
  zip: [0x50, 0x4b, 0x03, 0x04],
  pdf: [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37],
  cfb: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
  gzip: [0x1f, 0x8b, 0x08]
} as const;

async function writeMagic(fx: Fixture, name: string, magic: readonly number[]): Promise<void> {
  // Pad past the magic so size formatting has something to report.
  const bytes = new Uint8Array([...magic, ...new Array<number>(32).fill(0x41)]);
  await writeFile(path.join(fx.root, name), bytes);
}

describe("doc_inspect content detection", () => {
  it("does not mistake an arbitrary ZIP for OOXML just because of its extension", async () => {
    const fx = await fixture();
    await writeMagic(fx, "book.xlsx", MAGIC.zip);
    await writeMagic(fx, "letter.docx", MAGIC.zip);
    await writeMagic(fx, "bundle.zip", MAGIC.zip);

    expect(await inspect(fx, "book.xlsx")).toContain("kind: **zip**");
    expect(await inspect(fx, "book.xlsx")).toContain("Extension mismatch");
    expect(await inspect(fx, "letter.docx")).toContain("kind: **zip**");
    expect(await inspect(fx, "bundle.zip")).toContain("kind: **zip**");
  });

  it("lists a real workbook's sheets with their used ranges", async () => {
    // This is what makes "inspect first" worth the call: the next tool call can
    // name a real sheet and a sensible range.
    const fx = await fixture();
    const wb = Workbook.create();
    const data = Workbook.addWorksheet(wb, "Data");
    Worksheet.addAoa(data, [
      ["a", "b", "c"],
      [1, 2, 3],
      [4, 5, 6]
    ]);
    Workbook.addWorksheet(wb, "Empty");
    await Workbook.writeFile(wb, path.join(fx.root, "real.xlsx"));

    const text = await inspect(fx, "real.xlsx");
    expect(text).toContain("kind: **excel**");
    expect(text).toContain("## Sheets");
    expect(text).toContain("| `Data` | A1:C3 | 3 | 3 |");
    expect(text).toContain("| `Empty` | (empty) | 0 | 0 |");
    expect(text).toContain("Read one with `sheet_read`");
  });

  it("recognises XLSB package parts and lists their sheets", async () => {
    const fx = await fixture();
    const wb = Workbook.create();
    Worksheet.addAoa(Workbook.addWorksheet(wb, "Binary Data"), [["value"], [42]]);
    await Workbook.writeFile(wb, path.join(fx.root, "real.xlsb"));

    const text = await inspect(fx, "real.xlsb");
    expect(text).toContain("kind: **excel**");
    expect(text).toContain("| `Binary Data` | A1:A2 | 2 | 1 |");
    expect(text).not.toContain("Extension mismatch");
  });

  it("classifies a zip-shaped .xlsx without workbook parts as zip", async () => {
    const fx = await fixture();
    await writeMagic(fx, "fake.xlsx", MAGIC.zip);
    const text = await inspect(fx, "fake.xlsx");
    expect(text).toContain("kind: **zip**");
    expect(text).toContain("Extension mismatch");
  });

  it("skips listing sheets for a workbook over the size limit", async () => {
    const fx = await fixture(["--max-file-size", "32"]);
    const wb = Workbook.create();
    Worksheet.addAoa(Workbook.addWorksheet(wb, "S"), [["x"]]);
    await Workbook.writeFile(wb, path.join(fx.root, "big.xlsx"));

    const text = await inspect(fx, "big.xlsx");
    expect(text).toContain("over the size limit");
    expect(text).not.toContain("## Sheets");
  });

  it("identifies a PDF", async () => {
    const fx = await fixture();
    await writeMagic(fx, "spec.pdf", MAGIC.pdf);
    expect(await inspect(fx, "spec.pdf")).toContain("kind: **pdf**");
  });

  it("describes a real PDF's pages", async () => {
    const fx = await fixture();
    const builder = new Pdf.Builder();
    builder.addPage().drawText("hello", { x: 60, y: 700 });
    await writeFile(path.join(fx.root, "one.pdf"), await builder.build());

    const text = await inspect(fx, "one.pdf");
    expect(text).toContain("## PDF");
    expect(text).toContain("- pages: 1");
  });

  it("skips opening a PDF over the size limit", async () => {
    // The guard measures and reads through one descriptor; the early return has
    // to leave the file closed and the parse unattempted.
    const fx = await fixture(["--max-file-size", "32"]);
    const builder = new Pdf.Builder();
    builder.addPage().drawText("hello", { x: 60, y: 700 });
    await writeFile(path.join(fx.root, "big.pdf"), await builder.build());

    const text = await inspect(fx, "big.pdf");
    expect(text).toContain("over the size limit");
    expect(text).not.toContain("## PDF");
  });

  it("identifies a CFB container and explains the ambiguity", async () => {
    // CFB means either a legacy binary Office file or an encrypted OOXML one.
    // Guessing between them wastes a turn, so the tool must say so.
    const fx = await fixture();
    await writeMagic(fx, "old.doc", MAGIC.cfb);
    const text = await inspect(fx, "old.doc");
    expect(text).toContain("kind: **cfb**");
    expect(text).toContain("password-encrypted");
  });

  it("identifies gzip", async () => {
    const fx = await fixture();
    await writeMagic(fx, "logs.tar.gz", MAGIC.gzip);
    expect(await inspect(fx, "logs.tar.gz")).toContain("kind: **tar**");
  });

  it("flags a file whose extension contradicts its content", async () => {
    // The routine real-world case: a CSV export named .xlsx.
    const fx = await fixture();
    await writeFile(path.join(fx.root, "export.xlsx"), "a,b,c\n1,2,3\n", "utf8");

    const text = await inspect(fx, "export.xlsx");
    expect(text).toContain("Extension mismatch");
    expect(text).toContain("claims `excel`");
  });

  it("does not flag a mismatch when extension and content agree", async () => {
    const fx = await fixture();
    const wb = Workbook.create();
    Worksheet.addAoa(Workbook.addWorksheet(wb, "S"), [["x"]]);
    await Workbook.writeFile(wb, path.join(fx.root, "book.xlsx"));
    expect(await inspect(fx, "book.xlsx")).not.toContain("Extension mismatch");
  });

  it("recognises real OOXML even when its extension says zip", async () => {
    const fx = await fixture();
    const wb = Workbook.create();
    Worksheet.addAoa(Workbook.addWorksheet(wb, "S"), [["x"]]);
    await Workbook.writeFile(wb, path.join(fx.root, "book.zip"));

    const text = await inspect(fx, "book.zip");
    expect(text).toContain("kind: **excel**");
    expect(text).toContain("Extension mismatch");
  });

  it("reports a file over the configured size limit", async () => {
    const fx = await fixture(["--max-file-size", "16"]);
    await writeFile(path.join(fx.root, "big.txt"), "x".repeat(64), "utf8");
    expect(await inspect(fx, "big.txt")).toContain("over the server's");
  });

  it("recognises tsv as csv and reports the tab delimiter", async () => {
    const fx = await fixture();
    await writeFile(path.join(fx.root, "data.tsv"), "a\tb\n1\t2\n", "utf8");
    const text = await inspect(fx, "data.tsv");
    expect(text).toContain("kind: **csv**");
    expect(text).toContain("delimiter: `\\t`");
  });

  it("reports no BOM when there is none", async () => {
    const fx = await fixture();
    await writeFile(path.join(fx.root, "plain.csv"), "a,b\n1,2\n", "utf8");
    expect(await inspect(fx, "plain.csv")).toContain("UTF-8 BOM: no");
  });
});

describe("doc_inspect directory listing", () => {
  it("marks subdirectories and reports sizes for files", async () => {
    const fx = await fixture();
    await mkdir(path.join(fx.root, "reports"));
    await writeFile(path.join(fx.root, "a.csv"), "xyz", "utf8");

    const text = await inspect(fx, ".");
    expect(text).toContain("`reports/`");
    expect(text).toContain("`a.csv` — 3 B");
    expect(text).toContain("2 entries");
  });

  it("caps the listing and says how many were omitted", async () => {
    const fx = await fixture();
    await Promise.all(
      Array.from({ length: 205 }, (_, index) =>
        writeFile(path.join(fx.root, `f${String(index).padStart(3, "0")}.txt`), "x", "utf8")
      )
    );

    const text = await inspect(fx, ".");
    expect(text).toContain("205 entries");
    // Truncation must be explicit, or the model treats the listing as complete.
    expect(text).toContain("5 more entries not listed");
  });
});
