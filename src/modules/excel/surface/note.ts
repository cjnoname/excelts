/**
 * `Note` namespace surface — cell note / comment values.
 *
 * `import { Note } from "documonster/excel"` →
 *   `Note.create("text", "author")`, `Note.isNote(v)`, `Note.model(n)`,
 *   `Note.fromModel(model)`.
 *
 * Attaching a note to a cell (`Cell.getNote` / `Cell.setNote` /
 * `Cell.setComment`) lives on the `Cell` namespace.
 */
export {
  noteCreate as create,
  isNoteData as isNote,
  noteModel as model,
  noteFromModel as fromModel
} from "@excel/core/note";

/** A note handle. */
export type { NoteData as Handle } from "@excel/core/note";
