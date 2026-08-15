/**
 * `form_fill` — list and fill form fields in Word documents and PDFs.
 *
 * Another well-shaped task, for the same reason as templates: the document
 * declares what it needs, so listing the fields *is* the schema and the model
 * supplies only values. "Fill in this form" is also one of the most concrete
 * requests a user can make, which makes it hard to get subtly wrong.
 *
 * One implementation detail is load-bearing. A PDF must be saved with
 * `saveIncremental()`, not `save()`: the full rebuild path drops AcroForm
 * values, so `save()` produces a document that looks fine and contains none of
 * the answers. Verified empirically — do not "simplify" this.
 *
 * The corollary is that a PDF whose format cannot take an incremental update
 * (a cross-reference stream file) cannot be filled correctly at all here. Such a
 * file is refused rather than written, because the failure is invisible: the
 * output opens, looks like the right form, and is blank.
 */

import { readFile } from "node:fs/promises";

import { Pdf } from "documonster/pdf";
import { Io, Query } from "documonster/word";
import { z } from "zod";

import { toolError } from "../errors.js";
import { assertWritable, resolveEditTarget, resolveInRoot, type WriteTarget } from "../sandbox.js";
import { requireFormat, supportsIncrementalUpdate } from "./document.js";
import {
  assertReadableSize,
  assertUnchanged,
  backupOnce,
  describeBackup,
  exists,
  fingerprint,
  isSameFile,
  replaceAtomically,
  writeFileAtomic
} from "./fs-helpers.js";
import { textResult } from "./result.js";
import { defineTool } from "./types.js";

/** Where a fill writes, and what was preserved. */
interface WriteContext {
  readonly target: WriteTarget;
  readonly inPlace: boolean;
  readonly takeBackup: boolean;
}

/** Fields listed in one call. */
const MAX_FIELDS = 200;

export const formFillTool = defineTool({
  name: "form_fill",
  group: "forms",
  title: "List or fill form fields",
  description:
    "List the fillable fields in a .docx or .pdf form, or fill them from supplied values. Call it without `values` first: the field list tells you exactly what names and types the form expects, so there is nothing to guess. Works with Word legacy form fields and PDF AcroForms.",
  inputSchema: {
    path: z.string().min(1).describe("Form path (.docx or .pdf), relative to the server root."),
    values: z
      .record(z.string(), z.union([z.string(), z.boolean(), z.number()]))
      .optional()
      .describe(
        'Values keyed by field name, e.g. { "fullName": "Jane Doe", "agree": true }. Omit to list the fields without changing anything.'
      ),
    out: z
      .string()
      .optional()
      .describe(
        "Write the filled form below @output/. Required for input files unless --allow-in-place is enabled."
      ),
    backup: z
      .boolean()
      .optional()
      .describe("When filling in place, copy the original to <name>.bak first. Defaults to true."),
    overwrite: z
      .boolean()
      .optional()
      .describe("Replace an existing `out` file. Defaults to false. Does not apply in place.")
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false
  },
  // Listing is read-only; only filling writes. Declared non-mutating so the
  // tool stays visible under --readonly — a read-only server should still be
  // able to report what fields a form has — and the write path calls
  // assertWritable itself.
  mutates: false,
  handler: async (args, context) => {
    const { config } = context;
    const resolved = await resolveInRoot(config, args.path, { mustExist: true });
    await assertReadableSize(config, resolved, args.path);
    const inputVersion = await fingerprint(resolved);
    const format = requireFormat(args.path, "path");

    if (format !== "docx" && format !== "pdf") {
      throw toolError.unsupported(
        `form_fill works with .docx and .pdf, not .${format}`,
        "For spreadsheets use sheet_edit; for Word templates with {{placeholders}} use template_fill."
      );
    }

    if (args.values === undefined) {
      return textResult(
        config,
        format === "docx"
          ? await listWordFields(resolved, args.path)
          : await listPdfFields(resolved, args.path)
      );
    }

    assertWritable(config);

    if (args.out !== undefined && requireFormat(args.out, "out") !== format) {
      throw toolError.invalidInput(
        `out must have the same format as the source (.${format})`,
        "form_fill fills a form; use doc_convert afterwards to change format."
      );
    }

    await assertUnchanged(resolved, inputVersion);
    const writeTarget = await resolveEditTarget(config, args.path, args.out);
    const inPlace = isSameFile(writeTarget.path, resolved);
    if (!inPlace && args.overwrite !== true && (await exists(writeTarget.path))) {
      throw toolError.invalidInput(
        `${writeTarget.display} already exists`,
        "Pass overwrite: true to replace it, or choose a different output."
      );
    }
    const write = { target: writeTarget, inPlace, takeBackup: inPlace && (args.backup ?? true) };

    return textResult(
      config,
      format === "docx"
        ? await fillWordFields(resolved, write, args)
        : await fillPdfFields(resolved, write, args)
    );
  }
});

async function listWordFields(resolved: string, displayPath: string): Promise<string> {
  const doc = await readWord(resolved, displayPath);
  const fields = Query.extractFormFields(doc);

  if (fields.length === 0) {
    return [
      `# ${displayPath}`,
      "",
      "This document has no legacy form fields.",
      "",
      "If it uses `{{placeholder}}` syntax instead, use template_inspect and template_fill. If it is an ordinary document, use doc_edit to change text."
    ].join("\n");
  }

  return [
    `# ${displayPath} — ${fields.length} form field(s)`,
    "",
    "| field | type | current value | choices |",
    "| --- | --- | --- | --- |",
    ...fields
      .slice(0, MAX_FIELDS)
      .map(
        field =>
          `| \`${field.name}\` | ${field.type} | ${JSON.stringify(field.value)} | ${field.entries === undefined ? "—" : field.entries.join(", ")} |`
      ),
    ...(fields.length > MAX_FIELDS ? ["", `[${fields.length - MAX_FIELDS} more not listed]`] : []),
    "",
    "## Values shape",
    "",
    "```json",
    JSON.stringify(
      Object.fromEntries(
        fields.slice(0, 40).map(field => [field.name, field.type === "checkBox" ? true : "…"])
      ),
      null,
      2
    ),
    "```",
    "",
    "Pass that as `values` to fill the form."
  ].join("\n");
}

async function fillWordFields(
  resolved: string,
  write: WriteContext,
  args: { readonly path: string; readonly out?: string; readonly values?: Record<string, unknown> }
): Promise<string> {
  const doc = await readWord(resolved, args.path);
  const before = Query.extractFormFields(doc);

  if (before.length === 0) {
    throw toolError.invalidInput(
      `${args.path} has no form fields to fill`,
      "Call form_fill without `values` to confirm, or use template_fill if the document uses {{placeholders}}."
    );
  }

  const known = new Set(before.map(field => field.name));
  const supplied = Object.entries(args.values ?? {});
  const unknown = supplied.filter(([name]) => !known.has(name)).map(([name]) => name);

  if (unknown.length > 0) {
    // Naming the real fields turns a wrong guess into a one-step correction.
    throw toolError.invalidInput(
      `no such field(s): ${unknown.map(name => JSON.stringify(name)).join(", ")}`,
      `The form's fields are: ${[...known].map(name => JSON.stringify(name)).join(", ")}. Nothing was written.`
    );
  }

  const filled = Query.fillFormFields(
    doc,
    new Map(supplied.map(([name, value]) => [name, value as string | boolean | number]))
  );
  const backupPath = write.takeBackup ? await backupOnce(write.target) : undefined;
  await replaceAtomically(write.target.path, temporary => Io.writeFile(filled, temporary));

  const after = Query.extractFormFields(filled);
  const untouched = after.filter(
    field => !known.has(field.name) || !(field.name in (args.values ?? {}))
  );

  return [
    `Filled **${supplied.length}** of ${before.length} field(s) in ${args.path}.`,
    `- written to ${write.target.display}${write.inPlace ? " (in place)" : ""}`,
    ...describeBackup(write.target.display, backupPath),
    "",
    "| field | value now |",
    "| --- | --- |",
    ...after
      .slice(0, MAX_FIELDS)
      .map(field => `| \`${field.name}\` | ${JSON.stringify(field.value)} |`),
    ...(untouched.length > 0
      ? ["", `${untouched.length} field(s) were left at their existing value.`]
      : []),
    "",
    "Read it back with form_fill (no `values`) to verify."
  ].join("\n");
}

async function listPdfFields(resolved: string, displayPath: string): Promise<string> {
  const bytes = await readFile(resolved);
  const result = await Pdf.read(new Uint8Array(bytes), {
    extractFormFields: true,
    extractText: false,
    extractImages: false
  }).catch((cause: unknown) => {
    throw toolError.unsupported(`could not read ${displayPath} as a PDF`, undefined, { cause });
  });

  const fields = result.formFields ?? [];
  if (fields.length === 0) {
    return [
      `# ${displayPath}`,
      "",
      "This PDF has no AcroForm fields — it is not a fillable form.",
      "",
      "A scanned or flattened form has no fields to fill; there is no OCR here, so say so rather than guessing where the blanks are."
    ].join("\n");
  }

  return [
    `# ${displayPath} — ${fields.length} form field(s)`,
    "",
    "| field | type | current value | choices | required |",
    "| --- | --- | --- | --- | --- |",
    ...fields
      .slice(0, MAX_FIELDS)
      .map(
        field =>
          `| \`${field.name}\` | ${field.type} | ${JSON.stringify(field.value)} | ${field.options !== undefined && field.options.length > 0 ? field.options.join(", ") : "—"} | ${field.required ? "yes" : "no"} |`
      ),
    ...(fields.length > MAX_FIELDS ? ["", `[${fields.length - MAX_FIELDS} more not listed]`] : []),
    "",
    "Checkbox fields take their export value (often `Yes`) to tick and `Off` to clear.",
    "",
    "Pass `values` keyed by these names to fill the form."
  ].join("\n");
}

async function fillPdfFields(
  resolved: string,
  write: WriteContext,
  args: { readonly path: string; readonly out?: string; readonly values?: Record<string, unknown> }
): Promise<string> {
  const bytes = new Uint8Array(await readFile(resolved));

  // Refuse rather than write a blank form: filling depends on the incremental
  // save path, and this format cannot take one.
  if (!supportsIncrementalUpdate(bytes)) {
    throw toolError.unsupported(
      `${args.path} uses a cross-reference stream, which cannot be filled without discarding the values`,
      "Saving such a file rebuilds it, and the rebuild drops AcroForm values — the result would open as an empty form. Nothing was written. Ask the user for a form saved in the classic format, or fill it in a PDF viewer."
    );
  }
  // Editor.load is synchronous.
  let editor: ReturnType<typeof Pdf.Editor.load>;
  try {
    editor = Pdf.Editor.load(bytes);
  } catch (cause) {
    throw toolError.unsupported(
      `could not open ${args.path} for editing`,
      "A password-protected PDF cannot be filled here.",
      { cause }
    );
  }

  const existing = editor.getFormFields();
  if (existing.length === 0) {
    throw toolError.invalidInput(
      `${args.path} has no AcroForm fields to fill`,
      "Call form_fill without `values` to confirm. A flattened or scanned form has no fields."
    );
  }

  const known = new Set(existing.map(field => field.name));
  const supplied = Object.entries(args.values ?? {});
  const unknown = supplied.filter(([name]) => !known.has(name)).map(([name]) => name);

  if (unknown.length > 0) {
    throw toolError.invalidInput(
      `no such field(s): ${unknown.map(name => JSON.stringify(name)).join(", ")}`,
      `The form's fields are: ${[...known].map(name => JSON.stringify(name)).join(", ")}. Nothing was written.`
    );
  }

  editor.setFormFields(
    Object.fromEntries(supplied.map(([name, value]) => [name, stringifyPdfValue(value)]))
  );

  // saveIncremental, never save: the full rebuild drops AcroForm values, so
  // save() would write a form that still contains none of the answers.
  const out = await editor.saveIncremental();

  // Verify in memory before either backing up or writing. A silently unfilled
  // form is the failure this path exists to avoid, and a failed verification
  // must have no filesystem side effects.
  const verified = await Pdf.read(new Uint8Array(out), {
    extractFormFields: true,
    extractText: false,
    extractImages: false
  });
  const after = verified.formFields ?? [];
  const missed = supplied.filter(([name, value]) => {
    const field = after.find(candidate => candidate.name === name);
    return field === undefined || field.value !== stringifyPdfValue(value);
  });

  if (missed.length > 0) {
    throw toolError.unsupported(
      `the saved PDF did not retain ${missed.length} supplied field value(s): ${missed.map(([name]) => JSON.stringify(name)).join(", ")}`,
      "Nothing was written. For a checkbox, supply true/false or its export value."
    );
  }

  const backupPath = write.takeBackup ? await backupOnce(write.target) : undefined;
  await writeFileAtomic(write.target.path, out);

  return [
    `Filled **${supplied.length - missed.length}** of ${supplied.length} supplied field(s) in ${args.path}.`,
    `- written to ${write.target.display}${write.inPlace ? " (in place)" : ""}`,
    ...describeBackup(write.target.display, backupPath),
    "- saved as an incremental update, so original signature bytes are preserved; a certified signature may still report the form as modified if its DocMDP permissions forbid filling fields",
    "",
    "| field | value now |",
    "| --- | --- |",
    ...after
      .slice(0, MAX_FIELDS)
      .map(field => `| \`${field.name}\` | ${JSON.stringify(field.value)} |`),
    "",
    "Verified by re-reading the saved file."
  ].join("\n");
}

/** PDF field values are strings; booleans map to a checkbox's on/off states. */
function stringifyPdfValue(value: unknown): string {
  if (typeof value === "boolean") {
    return value ? "Yes" : "Off";
  }
  return String(value);
}

async function readWord(resolved: string, displayPath: string) {
  return await Io.readFile(resolved).catch((cause: unknown) => {
    throw toolError.unsupported(
      `could not read ${displayPath} as a Word document`,
      "Run doc_inspect to check the real file type.",
      { cause }
    );
  });
}
