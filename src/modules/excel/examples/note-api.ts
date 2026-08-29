/**
 * Note namespace API — building, inspecting and round-tripping notes.
 *
 * Most examples only use `Note.create`. This one covers the rest of the
 * `Note` namespace:
 * - Note.create     — build a NoteData handle (text + author)
 * - Note.model      — convert a NoteData into its serialisable NoteModel
 * - Note.fromModel  — rebuild a NoteData from a NoteModel
 * - Note.isNote     — type-guard a value as NoteData
 *
 * It then attaches a note to a cell and writes a workbook so the round-trip
 * is observable.
 *
 * Usage:
 *   pnpm example --filter note-api
 *
 * Output:
 *   tmp/excel-examples/note-api.xlsx
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Cell, Note, Workbook } from "@excel/index";

const outDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tmp/excel-examples"
);
fs.mkdirSync(outDir, { recursive: true });
const filename = process.argv[2] ?? path.join(outDir, "note-api.xlsx");

// 1. create — a plain-text note with an author
const note = Note.create("Reviewed and approved.", "Alice");
console.log("created note:", note);

// 2. isNote — type guard
console.log("isNote(note):", Note.isNote(note)); // true
console.log("isNote({}):", Note.isNote({})); // false
console.log("isNote('text'):", Note.isNote("text")); // false

// 3. model — serialisable NoteModel (texts + author + display config)
const model = Note.model(note);
console.log("note model author:", model.author);
console.log("note model texts:", JSON.stringify(model.note.texts));

// 4. fromModel — rebuild a NoteData from a NoteModel
const rebuilt = Note.fromModel(model);
console.log("rebuilt isNote:", Note.isNote(rebuilt)); // true

// 5. Attach to a cell and persist
const wb = Workbook.create();
const ws = Workbook.addWorksheet(wb, "Notes");
Cell.setValue(ws, "B2", 42);
Cell.setNote(ws, "B2", note.note ?? "");
console.log("readback note:", Cell.getNote(ws, "B2"));

await Workbook.writeFile(wb, filename);
console.log(`Done. Wrote ${filename}`);
