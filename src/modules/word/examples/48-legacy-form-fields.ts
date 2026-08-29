/**
 * Word Example 48 — Legacy form fields (FORMTEXT / FORMCHECKBOX / FORMDROPDOWN)
 *
 * Covers the classic Word "legacy" form-field controls — the ones inserted
 * from the Developer ribbon's *Legacy Forms* group — and the round-trip query
 * API for reading and writing their values:
 *   - Build.formTextField     → a FORMTEXT field (text input, with maxLength,
 *                               default value, help/status text, format mask)
 *   - Build.formCheckboxField → a FORMCHECKBOX field (boolean checkbox)
 *   - Build.formDropdownField → a FORMDROPDOWN field (a list of entries +
 *                               a default selected index)
 *   - Query.extractFormFields → read back every field's name, type and current
 *                               value (and, for dropdowns, the entry list)
 *   - Query.fillFormFields    → populate fields by name, returning a new doc
 *
 * Each form field is a Run, so it must be placed inside a paragraph. We build a
 * small "registration form", save it, read the fields back, fill them, then
 * write the filled copy. Also demonstrates Document.insertContentAt to splice a
 * heading in at a specific body index.
 *
 * Usage:   pnpm example --filter 48-legacy-form-fields
 * Output:  tmp/word-examples/48-legacy-form-fields.docx
 *          tmp/word-examples/48-legacy-form-fields-filled.docx
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Document, Build, Io, Query } from "../index";

const outDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tmp/word-examples"
);
fs.mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------------------
// 1. Build a document with all three legacy form-field types
// ---------------------------------------------------------------------------
const doc = Document.create();
Document.useDefaultStyles(doc);

Document.addParagraph(doc, "Please complete every field below.");

// FORMTEXT — a free-text input with a default value and a length cap.
Document.addParagraphElement(
  doc,
  Build.paragraph([
    Build.text("Full name: "),
    Build.formTextField({
      name: "FullName",
      default: "Jane Doe",
      maxLength: 60,
      helpText: "Enter your legal full name.",
      statusText: "Full name"
    })
  ])
);

// FORMTEXT — empty default (edge case: an unfilled field round-trips as "").
Document.addParagraphElement(
  doc,
  Build.paragraph([
    Build.text("Email: "),
    Build.formTextField({ name: "Email", default: "", maxLength: 120 })
  ])
);

// FORMCHECKBOX — a boolean, here pre-checked.
Document.addParagraphElement(
  doc,
  Build.paragraph([
    Build.formCheckboxField({ name: "AgreeTos", checked: true }),
    Build.text(" I agree to the terms of service.")
  ])
);

// FORMCHECKBOX — unchecked (default state).
Document.addParagraphElement(
  doc,
  Build.paragraph([
    Build.formCheckboxField({ name: "Newsletter", checked: false }),
    Build.text(" Subscribe me to the newsletter.")
  ])
);

// FORMDROPDOWN — a list of entries with a default selection index (0-based).
Document.addParagraphElement(
  doc,
  Build.paragraph([
    Build.text("Plan: "),
    Build.formDropdownField({
      name: "Plan",
      entries: ["Free", "Pro", "Enterprise"],
      default: 0,
      helpText: "Pick a subscription tier."
    })
  ])
);

// ---------------------------------------------------------------------------
// 2. Document.insertContentAt — splice a heading at the top (index 0)
// ---------------------------------------------------------------------------
// The heading was deliberately omitted above so we can demonstrate inserting
// content at an explicit body index rather than appending.
const before = Document.getContentCount(doc);
Document.insertContentAt(doc, 0, Build.heading("Registration form", 1));
console.log(`  insertContentAt(0): body length ${before} → ${Document.getContentCount(doc)}`);

const built = Document.build(doc);
const buf = await Io.toBuffer(built);
fs.writeFileSync(path.join(outDir, "48-legacy-form-fields.docx"), buf);
console.log(`  → 48-legacy-form-fields.docx (${buf.length} bytes)`);

// ---------------------------------------------------------------------------
// 3. Read the fields back with Query.extractFormFields
// ---------------------------------------------------------------------------
const fields = Query.extractFormFields(built);
console.log(`  extractFormFields() found ${fields.length} field(s):`);
for (const f of fields) {
  const extra = f.type === "dropDown" ? ` entries=[${f.entries?.join(", ")}]` : "";
  console.log(`    • ${f.name} (${f.type}) = ${JSON.stringify(f.value)}${extra}`);
}

// ---------------------------------------------------------------------------
// 4. Fill the fields by name with Query.fillFormFields, then write a copy
// ---------------------------------------------------------------------------
// Text → string, checkBox → boolean, dropDown → selected index (number).
const values = new Map<string, string | boolean | number>([
  ["FullName", "Alice Anderson"],
  ["Email", "alice@example.com"],
  ["AgreeTos", true],
  ["Newsletter", true],
  ["Plan", 2] // select "Enterprise"
]);
const filled = Query.fillFormFields(built, values);

const filledFields = Query.extractFormFields(filled);
console.log("  after fillFormFields():");
for (const f of filledFields) {
  console.log(`    • ${f.name} (${f.type}) = ${JSON.stringify(f.value)}`);
}

const filledBuf = await Io.toBuffer(filled);
fs.writeFileSync(path.join(outDir, "48-legacy-form-fields-filled.docx"), filledBuf);
console.log(`  → 48-legacy-form-fields-filled.docx (${filledBuf.length} bytes)`);
