/**
 * `doc_convert` — convert a document between formats.
 *
 * The highest-leverage tool per line of code: "this is the wrong format" is the
 * most common friction a user hits, and one call with two paths solves it. The
 * routing table below is the whole tool.
 *
 * Deliberately excluded: anything lossy in a way the caller cannot see. PDF is
 * a terminal format here — there is no PDF-to-Word, because a faithful one does
 * not exist and a bad one silently destroys the document.
 */

import { readFile, stat } from "node:fs/promises";

import { ExcelNotSupportedError, Workbook, Worksheet } from "documonster/excel";
import { readCsvFile, writeCsvFile } from "documonster/excel/csv";
import { calculateFormulas } from "documonster/excel/formula";
import { Pdf } from "documonster/pdf";
import { Convert, Io } from "documonster/word";
import { renderToHtml } from "documonster/word/html";
import { markdownToDocx, renderToMarkdown } from "documonster/word/markdown";
import { z } from "zod";

import { toolError } from "../errors.js";
import { assertWritable, outputDisplay, resolveInRoot, resolveOutputPath } from "../sandbox.js";
import { prepareMarkdownDiagrams } from "./diagram-markdown.js";
import { assertNonMacroOutput, requireFormat, type DocFormat } from "./document.js";
import {
  assertReadableSize,
  replaceAtomically,
  writeFileAtomic,
  writeWithPolicy
} from "./fs-helpers.js";
import { formatBytes, textResult } from "./result.js";
import { requireSheet, sheetName } from "./spreadsheet.js";
import { defineTool } from "./types.js";

/**
 * Supported conversions, as `from -> to[]`.
 *
 * Published to the model in the tool description and used to reject the rest
 * with a message that lists what *is* possible — so an unsupported request
 * costs one turn, not a retry loop.
 */
const ROUTES: Readonly<Record<string, readonly DocFormat[]>> = {
  docx: ["md", "html", "pdf", "txt", "odt"],
  odt: ["docx", "md", "pdf"],
  md: ["docx", "pdf"],
  xlsx: ["csv", "pdf", "xlsb"],
  // Same routes as XLSX, because the two are the same model in different containers — plus the
  // conversion between them, which is the one a caller reaches for when a workbook is too slow to open.
  xlsb: ["csv", "pdf", "xlsx"],
  csv: ["xlsx", "xlsb"]
};

/**
 * What a container cannot carry, as the writer itself reports it.
 *
 * Obtained by attempting the write under the default `unsupported: "error"` and reading `items` off the
 * error — the writer's own list, rather than a second one maintained here that would drift from it. The
 * *real* write then runs with `"ignore"`.
 *
 * Two attempts rather than one is the cost. It is worth paying: a caller converting a real workbook to
 * XLSB needs to be told what was dropped, and the alternative is a public "what would be lost" API that
 * exists only for this tool.
 */
async function workbookLossReport(
  workbook: ReturnType<typeof Workbook.create>,
  format: "xlsx" | "xlsb"
): Promise<readonly string[]> {
  try {
    await Workbook.toBuffer(workbook, { format });
    return [];
  } catch (cause) {
    return cause instanceof ExcelNotSupportedError ? cause.items : [];
  }
}

export const docConvertTool = defineTool({
  name: "doc_convert",
  group: ["word", "pdf", "excel"],
  title: "Convert a document",
  description:
    "Convert a document between formats: docx→md/html/pdf/txt/odt, odt→docx/md/pdf, md→docx/pdf, xlsx→csv/pdf/xlsb, xlsb→csv/pdf/xlsx, csv→xlsx/xlsb. The output extension chooses the target. PDF is a terminal format — there is no PDF→Word, because no faithful conversion exists.",
  inputSchema: {
    from: z.string().min(1).describe("Source path, relative to the server root."),
    to: z
      .string()
      .min(1)
      .describe(
        "Destination path below --output-root. Its extension selects the target format; the result is returned as @output/<path>."
      ),
    sheet: z
      .union([z.string(), z.number().int().positive()])
      .optional()
      .describe("xlsx→csv only: which sheet to export. Defaults to the first."),
    diagrams: z
      .boolean()
      .optional()
      .describe(
        "md→docx/pdf only: render ```mermaid fences as embedded diagrams. Defaults to true when the diagram tool group is enabled."
      ),
    overwrite: z
      .boolean()
      .optional()
      .describe("Replace the destination if it exists. Defaults to false.")
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  },
  mutates: true,
  handler: async (args, context) => {
    const { config } = context;
    assertWritable(config);

    const source = await resolveInRoot(config, args.from, { mustExist: true });
    await assertReadableSize(config, source, args.from);
    const target = await resolveOutputPath(config, args.to);
    const fromFormat = requireFormat(args.from, "from");
    const toFormat = requireFormat(args.to, "to");
    assertNonMacroOutput(args.to);

    const allowed = ROUTES[fromFormat];
    if (allowed === undefined || !allowed.includes(toFormat)) {
      // A diagram is drawn, not converted, and saying "nothing converts from
      // mermaid" would be true of this tool and false of the server.
      if (fromFormat === "mermaid" || toFormat === "mermaid") {
        throw toolError.unsupported(
          `doc_convert does not handle Mermaid diagrams`,
          fromFormat === "mermaid"
            ? "Use diagram_render to draw a .mmd file as .svg / .png / .pdf."
            : "Nothing produces a .mmd file — a diagram is written, not derived from a document."
        );
      }
      throw toolError.unsupported(
        `cannot convert ${fromFormat} to ${toFormat}`,
        allowed === undefined
          ? `Nothing converts from ${fromFormat}. Supported sources: ${Object.keys(ROUTES).join(", ")}.`
          : `From ${fromFormat} you can produce: ${allowed.join(", ")}.`
      );
    }

    let note: string[] = [];
    await writeWithPolicy(target, args.overwrite === true, async temporary => {
      note = await convert(fromFormat, toFormat, source, temporary, {
        ...args,
        renderDiagrams: args.diagrams ?? config.groups.has("diagram")
      });
    });
    const size = (await stat(target)).size;

    return textResult(
      config,
      [
        `Converted **${args.from}** → **${outputDisplay(args.to)}** (${fromFormat} → ${toFormat}, ${formatBytes(size)}).`,
        ...note,
        "",
        toFormat === "pdf" || toFormat === "html"
          ? "Verify by opening it, or read the source back — this tool cannot read its own PDF output structurally."
          : "Read it back with doc_read or sheet_read to verify."
      ].join("\n")
    );
  }
});

/** Perform one conversion, returning notes worth telling the caller. */
async function convert(
  from: DocFormat,
  to: DocFormat,
  source: string,
  target: string,
  args: { readonly sheet?: string | number; readonly renderDiagrams?: boolean }
): Promise<string[]> {
  if (from === "docx") {
    const doc = await readWord(source);
    switch (to) {
      case "md":
        await writeFileAtomic(target, renderToMarkdown(doc));
        return ["- headings, lists and tables preserved as Markdown"];
      case "html": {
        // renderToHtml returns { html, warnings, images } — not a string.
        const rendered = renderToHtml(doc);
        await writeFileAtomic(target, rendered.html);
        return rendered.warnings.length > 0
          ? [
              `- ${rendered.warnings.length} rendering warning(s): ${rendered.warnings.slice(0, 3).join("; ")}`
            ]
          : ["- semantic HTML5 with inline styles"];
      }
      case "txt": {
        const { Query } = await import("documonster/word");
        await writeFileAtomic(target, Query.extractText(doc));
        return ["- **formatting discarded** — plain text only"];
      }
      case "pdf": {
        await writeFileAtomic(target, await Pdf.fromDocx(doc));
        return ["- paginated by the Word layout engine, so page breaks are real"];
      }
      case "odt": {
        await writeFileAtomic(target, await Convert.writeOdt(doc));
        return ["- OpenDocument Text, readable by LibreOffice and Word"];
      }
      default:
        throw unreachable(from, to);
    }
  }

  if (from === "odt") {
    const doc = await Convert.readOdt(new Uint8Array(await readFile(source))).catch(
      (cause: unknown) => {
        throw toolError.unsupported(
          "could not read the source as an OpenDocument Text file",
          "Run doc_inspect to confirm the file type.",
          { cause }
        );
      }
    );
    if (to === "docx") {
      await replaceAtomically(target, temporary => Io.writeFile(doc, temporary));
      return ["- OpenDocument mapped to WordprocessingML"];
    }
    if (to === "md") {
      await writeFileAtomic(target, renderToMarkdown(doc));
      return ["- structure preserved as Markdown"];
    }
    if (to === "pdf") {
      await writeFileAtomic(target, await Pdf.fromDocx(doc));
      return ["- rendered via the Word layout engine"];
    }
    throw unreachable(from, to);
  }

  if (from === "md") {
    const markdown = await readFile(source, "utf8");
    const prepared =
      args.renderDiagrams === true
        ? await prepareMarkdownDiagrams(markdown)
        : { markdown, count: 0, notes: [] as readonly string[] };
    const doc = await markdownToDocx(prepared.markdown, {
      ...("resolveImage" in prepared && prepared.resolveImage !== undefined
        ? { resolveImage: prepared.resolveImage }
        : {})
    });
    if (to === "docx") {
      await replaceAtomically(target, temporary => Io.writeFile(doc, temporary));
      return ["- Markdown structure mapped to Word styles", ...prepared.notes];
    }
    if (to === "pdf") {
      await writeFileAtomic(target, await Pdf.fromDocx(doc));
      return ["- rendered via Word layout, so pagination is real", ...prepared.notes];
    }
    throw unreachable(from, to);
  }

  if (from === "xlsx" || from === "xlsb") {
    const wb = Workbook.create();
    // `readWithDiagnostics` rather than `readFile`, so what the *reader* could not recover is available to report. The
    // plain read discards it, which is why a conversion could call itself lossless while content had already gone.
    let readLosses: readonly string[] = [];
    const bytes = await readFile(source).catch((cause: unknown) => {
      throw toolError.unsupported(
        `could not read the source as a workbook`,
        "Run doc_inspect to confirm the file type.",
        { cause }
      );
    });
    readLosses = await Workbook.readWithDiagnostics(wb, new Uint8Array(bytes))
      .then(report => report.lost)
      .catch((cause: unknown) => {
        throw toolError.unsupported(
          `could not read the source as a workbook`,
          "Run doc_inspect to confirm the file type.",
          { cause }
        );
      });

    if (to === "csv") {
      // writeCsvFile takes the workbook and selects the sheet by name — passing
      // a worksheet handle does not type-check and would not work.
      const ws = requireSheet(wb, args.sheet);
      await replaceAtomically(target, temporary =>
        writeCsvFile(wb, temporary, { sheetName: sheetName(ws) })
      );
      return [
        `- exported sheet ${JSON.stringify(sheetName(ws))} of ${Workbook.getWorksheets(wb).length}`,
        "- **only one sheet** — CSV has no concept of multiple sheets",
        "- formulas exported as their cached values"
      ];
    }
    if (to === "pdf") {
      // Inject the calculation engine so stale cached values are not printed.
      await writeFileAtomic(target, await Pdf.fromExcel(wb, { recalculate: calculateFormulas }));
      return [
        `- all ${Workbook.getWorksheets(wb).length} sheet(s) rendered, honouring each sheet's print setup`,
        "- formulas recalculated before rendering"
      ];
    }
    if (to === "xlsx" || to === "xlsb") {
      // Container to container. The loss report is the point of surfacing this at all: XLSB cannot carry
      // everything XLSX can, so a caller converting a real workbook needs to be told what was dropped
      // rather than discovering it in Excel.
      const written = await workbookLossReport(wb, to);
      await replaceAtomically(target, temporary =>
        Workbook.writeFile(wb, temporary, { format: to, unsupported: "ignore" })
      );
      // **Both ends, because "nothing was dropped" was only ever about the writer.**
      //
      // Reading an XLSB can lose content of its own — a chartsheet, a record whose layout is unestablished, a defined
      // name with no definition — and those losses happen before the target writer is asked anything. So a conversion
      // whose *writer* dropped nothing was reported as lossless while the reader had already dropped something, which
      // for a conversion tool is the one claim that must not be wrong. `readLosses` is captured where the file is read.
      const dropped = [
        ...readLosses.map(entry => `read: ${entry}`),
        ...written.map(entry => `write: ${entry}`)
      ];
      return [
        `- rewritten as ${to.toUpperCase()}`,
        ...(dropped.length === 0
          ? ["- nothing was dropped, reading or writing"]
          : [
              `- **dropped**: ${dropped.slice(0, 10).join(", ")}${dropped.length > 10 ? ", …" : ""}`
            ])
      ];
    }
    throw unreachable(from, to);
  }

  if (from === "csv" && (to === "xlsx" || to === "xlsb")) {
    const wb = Workbook.create();
    const ws = await readCsvFile(wb, source);
    Worksheet.setModel(ws, { ...Worksheet.getModel(ws), name: "Sheet1" });
    await replaceAtomically(target, temporary => Workbook.writeFile(wb, temporary, { format: to }));
    return [
      `- ${Worksheet.actualRowCount(ws)} row(s) imported into sheet "Sheet1"`,
      ...(to === "xlsb" ? ["- written as XLSB, which opens faster for large sheets"] : [])
    ];
  }

  throw unreachable(from, to);
}

async function readWord(source: string) {
  return await Io.readFile(source).catch((cause: unknown) => {
    throw toolError.unsupported(
      "could not read the source as a Word document",
      "A CFB container is either a legacy .doc or an encrypted .docx; neither is supported here. Run doc_inspect.",
      { cause }
    );
  });
}

/** The route table and the switch cannot disagree, but say so if they do. */
function unreachable(from: DocFormat, to: DocFormat): Error {
  return toolError.unsupported(
    `conversion ${from} → ${to} is listed as supported but not implemented`,
    "This is a server bug; report it."
  );
}
