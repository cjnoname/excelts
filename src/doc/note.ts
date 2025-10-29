import { deepMerge } from "../utils/under-dash.js";

interface NoteText {
  text: string;
  [key: string]: any;
}

interface NoteConfig {
  margins?: {
    insetmode?: string;
    inset?: number[];
  };
  protection?: {
    locked?: string;
    lockText?: string;
  };
  editAs?: string;
  texts?: NoteText[];
}

interface NoteModel {
  type: string;
  note: NoteConfig;
}

class Note {
  note: string | NoteConfig;

  static DEFAULT_CONFIGS: NoteModel = {
    note: {
      margins: {
        insetmode: "auto",
        inset: [0.13, 0.13, 0.25, 0.25]
      },
      protection: {
        locked: "True",
        lockText: "True"
      },
      editAs: "absolute"
    },
    type: "note"
  };

  constructor(note?: string | NoteConfig) {
    this.note = note!;
  }

  get model(): NoteModel {
    let value: NoteModel | null = null;
    switch (typeof this.note) {
      case "string":
        value = {
          type: "note",
          note: {
            texts: [
              {
                text: this.note
              }
            ]
          }
        };
        break;
      default:
        value = {
          type: "note",
          note: this.note as NoteConfig
        };
        break;
    }
    // Suitable for all cell comments
    return deepMerge<NoteModel>({}, Note.DEFAULT_CONFIGS, value);
  }

  set model(value: NoteModel) {
    const { note } = value;
    const { texts } = note;
    if (texts && texts.length === 1 && Object.keys(texts[0]).length === 1) {
      this.note = texts[0].text;
    } else {
      this.note = note;
    }
  }

  static fromModel(model: NoteModel): Note {
    const note = new Note();
    note.model = model;
    return note;
  }
}

export { Note };
