/**
 * `doc_write` — create a Word or PDF document from Markdown.
 *
 * Markdown as the input language is a deliberate choice: a model already writes
 * it fluently and correctly, whereas a JSON description of runs and paragraph
 * properties is something it has to be taught, gets wrong, and which would cost
 * a large schema in every request. Headings, lists, tables, emphasis, code
 * blocks and links all survive the conversion.
 */

import { stat, writeFile } from "node:fs/promises";

import { Pdf } from "documonster/pdf";
import { Io } from "documonster/word";
import { markdownToDocx } from "documonster/word/markdown";
import { z } from "zod";

import { toolError } from "../errors.js";
import { assertWritable, outputDisplay, resolveOutputPath } from "../sandbox.js";
import { prepareMarkdownDiagrams } from "./diagram-markdown.js";
import { assertNonMacroOutput, requireFormat } from "./document.js";
import { writeWithPolicy } from "./fs-helpers.js";
import { pdfFontOptions } from "./pdf-fonts.js";
import { formatBytes, textResult } from "./result.js";
import { defineTool } from "./types.js";

export const docWriteTool = defineTool({
  name: "doc_write",
  group: "word",
  title: "Write a Word or PDF document",
  description:
    "Create a .docx or .pdf from Markdown. Headings, lists, tables, bold/italic, code blocks and links are all converted, and a ```mermaid fence becomes a real embedded diagram. Write the content as Markdown — that is the input language for this tool.",
  inputSchema: {
    path: z
      .string()
      .min(1)
      .describe(
        "Output path below --output-root. The extension chooses .docx or .pdf; the result is returned as @output/<path>."
      ),
    markdown: z
      .string()
      .min(1)
      .describe("Document content as Markdown. Use # for headings, - for lists, | for tables."),
    diagrams: z
      .boolean()
      .optional()
      .describe(
        "Render ```mermaid fences as embedded diagrams. Defaults to true when the diagram tool group is enabled; set false to keep them as code blocks."
      ),
    overwrite: z
      .boolean()
      .optional()
      .describe(
        "Replace the file if it exists. Defaults to false so existing work is never lost silently."
      )
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false
  },
  mutates: true,
  handler: async (args, context) => {
    const { config } = context;
    assertWritable(config);

    const format = requireFormat(args.path, "path");
    assertNonMacroOutput(args.path);
    if (format !== "docx" && format !== "pdf") {
      throw toolError.invalidInput(
        `doc_write cannot produce a ${format} file`,
        format === "mermaid"
          ? "A diagram is written, not generated from prose. Use diagram_render with Mermaid source, or put a ```mermaid fence in this tool's Markdown to embed one in the document."
          : "Use .docx or .pdf. For spreadsheets use sheet_write; to change an existing document's format use doc_convert."
      );
    }

    const target = await resolveOutputPath(config, args.path);
    // Diagrams first: the fences have to become image references before the
    // Markdown reaches the converter, and the resolver it returns is what embeds
    // the bytes.
    const prepared =
      (args.diagrams ?? config.groups.has("diagram"))
        ? await prepareMarkdownDiagrams(args.markdown)
        : { markdown: args.markdown, count: 0, notes: [] as readonly string[] };

    // markdownToDocx is async — verified; treating it as synchronous yields an
    // empty object that fails much later inside the packager.
    const doc = await markdownToDocx(prepared.markdown, {
      ...("resolveImage" in prepared && prepared.resolveImage !== undefined
        ? { resolveImage: prepared.resolveImage }
        : {})
    }).catch((cause: unknown) => {
      throw toolError.invalidInput(
        `the Markdown could not be converted: ${cause instanceof Error ? cause.message : String(cause)}`,
        "Check for an unclosed code fence or a malformed table.",
        { cause }
      );
    });

    const fonts = pdfFontOptions(config);
    let size: number;
    if (format === "docx") {
      await writeWithPolicy(target, args.overwrite === true, temporary =>
        Io.writeFile(doc, temporary)
      );
      size = (await stat(target)).size;
    } else {
      const bytes = await Pdf.fromDocx(doc, fonts.options);
      await writeWithPolicy(target, args.overwrite === true, temporary =>
        writeFile(temporary, bytes)
      );
      size = bytes.byteLength;
    }

    return textResult(
      config,
      [
        `Wrote **${outputDisplay(args.path)}** (${format}, ${formatBytes(size)}).`,
        format === "pdf"
          ? "- rendered through the Word layout engine, so pagination and line breaking are real"
          : "- Markdown structure preserved as Word styles",
        ...prepared.notes,
        ...fonts.notes(),
        "",
        "Read the returned @output path with doc_read to verify before reporting success."
      ].join("\n")
    );
  }
});
