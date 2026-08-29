import type { NoteModel, NoteText } from "@excel/core/cell";
import { cellSetComment } from "@excel/core/cell";
import type { WorksheetModel } from "@excel/core/worksheet";
import type { WorksheetData } from "@excel/core/worksheet-core";
import { getCell } from "@excel/core/worksheet-core";
import { ExcelNotSupportedError, XlsbParseError } from "@excel/errors";
import { colCache } from "@excel/utils/col-cache";
import {
  createBinaryWriter,
  createPayload,
  encodeWideString,
  finishBinaryWriter,
  iterateBiffRecords,
  writeRecord,
  XlsbBinaryReader
} from "@excel/xlsb/binary";
import { XlsbRecordType } from "@excel/xlsb/record-types";
import { parseXlsbRichString, writeXlsbRichString } from "@excel/xlsb/rich-string";
import type { XlsbStyleRegistry, XlsbStyleTable } from "@excel/xlsb/styles";
import { VmlDrawingXform } from "@excel/xlsx/xform/drawing/vml-drawing-xform";
import { decodeBytesToString } from "@utils/binary";
import { XmlWriter } from "@xml/writer";

export interface XlsbComment {
  row: number;
  column: number;
  ref: string;
  comment: NoteModel;
}

export interface XlsbCommentTable {
  comments: XlsbComment[];
  unsupportedRecordTypes: number[];
}

interface PendingComment {
  authorId: number;
  row: number;
  column: number;
  texts: NoteText[];
}

interface ParsedVmlComment {
  row?: number;
  col?: number;
  margins?: NoteModel["note"]["margins"];
  protection?: NoteModel["note"]["protection"];
  editAs?: string;
  anchor?: string;
  width?: number;
  height?: number;
}

export function parseCommentsPart(bytes: Uint8Array, styles: XlsbStyleTable): XlsbCommentTable {
  const authors: string[] = [];
  const comments: XlsbComment[] = [];
  const unsupportedRecordTypes = new Set<number>();
  let pending: PendingComment | undefined;

  for (const record of iterateBiffRecords(bytes, "XLSB comments")) {
    switch (record.type) {
      case XlsbRecordType.CommentAuthor: {
        const reader = new XlsbBinaryReader(record.data, "BrtCommentAuthor");
        const author = reader.wideString();
        if (!author || author.length > 54 || reader.remaining !== 0) {
          throw new XlsbParseError("BrtCommentAuthor", "invalid comment author string");
        }
        authors.push(author);
        break;
      }
      case XlsbRecordType.BeginComment:
        if (pending) {
          throw new XlsbParseError("XLSB comments", "nested BrtBeginComment records");
        }
        pending = parseCommentHeader(record.data);
        break;
      case XlsbRecordType.CommentText:
        if (!pending) {
          throw new XlsbParseError("XLSB comments", "BrtCommentText without BrtBeginComment");
        }
        pending.texts = parseRichString(record.data, styles);
        break;
      case XlsbRecordType.EndComment: {
        if (!pending) {
          throw new XlsbParseError("XLSB comments", "BrtEndComment without BrtBeginComment");
        }
        const author = authors[pending.authorId];
        if (author === undefined) {
          throw new XlsbParseError(
            "BrtBeginComment",
            `author index ${pending.authorId} is outside the comment author table`
          );
        }
        const ref = `${colCache.n2l(pending.column)}${pending.row}`;
        comments.push({
          row: pending.row,
          column: pending.column,
          ref,
          comment: {
            type: "note",
            author,
            note: { texts: pending.texts }
          }
        });
        pending = undefined;
        break;
      }
      default:
        if (!isCommentsContainerRecord(record.type)) {
          unsupportedRecordTypes.add(record.type);
        }
    }
  }
  if (pending) {
    throw new XlsbParseError("XLSB comments", "unterminated BrtBeginComment record");
  }
  return {
    comments,
    unsupportedRecordTypes: [...unsupportedRecordTypes].sort((left, right) => left - right)
  };
}

export async function applyCommentsToWorksheet(
  worksheet: WorksheetData,
  table: XlsbCommentTable,
  vmlBytes?: Uint8Array
): Promise<void> {
  if (vmlBytes) {
    const vmlComments = await parseVmlComments(vmlBytes);
    for (const comment of table.comments) {
      const shape = vmlComments.find(
        candidate => candidate.row === comment.row && candidate.col === comment.column
      );
      if (shape) {
        mergeVmlNoteSettings(comment.comment, shape);
      }
    }
  }
  for (const entry of table.comments) {
    cellSetComment(getCell(worksheet, entry.row, entry.column), {
      note: entry.comment.note,
      author: entry.comment.author
    });
  }
}

export function collectWorksheetComments(model: WorksheetModel): XlsbComment[] {
  const comments: XlsbComment[] = [];
  for (const row of model.rows ?? []) {
    for (const cell of row.cells) {
      if (!cell.comment) {
        continue;
      }
      const address = colCache.decodeAddress(cell.address);
      comments.push({
        row: address.row,
        column: address.col,
        ref: cell.address,
        comment: cell.comment
      });
    }
  }
  return comments;
}

export function writeCommentsPart(
  comments: readonly XlsbComment[],
  styles: XlsbStyleRegistry,
  unsupported: "error" | "ignore" = "error"
): Uint8Array {
  const writer = createBinaryWriter();
  const authors: string[] = [];
  const authorIndexes = new Map<string, number>();
  for (const entry of comments) {
    const author = normalizeAuthor(entry.comment.author, unsupported);
    if (!authorIndexes.has(author)) {
      authorIndexes.set(author, authors.length);
      authors.push(author);
    }
  }

  writeRecord(writer, XlsbRecordType.BeginComments);
  writeRecord(writer, XlsbRecordType.BeginCommentAuthors);
  for (const author of authors) {
    writeRecord(writer, XlsbRecordType.CommentAuthor, encodeWideString(author));
  }
  writeRecord(writer, XlsbRecordType.EndCommentAuthors);
  writeRecord(writer, XlsbRecordType.BeginCommentList);
  for (const entry of comments) {
    const author = normalizeAuthor(entry.comment.author, unsupported);
    writeRecord(
      writer,
      XlsbRecordType.BeginComment,
      commentHeaderPayload(entry, authorIndexes.get(author)!)
    );
    if (entry.comment.note.texts) {
      writeRecord(
        writer,
        XlsbRecordType.CommentText,
        richStringPayload(entry.comment.note.texts, styles)
      );
    }
    writeRecord(writer, XlsbRecordType.EndComment);
  }
  writeRecord(writer, XlsbRecordType.EndCommentList);
  writeRecord(writer, XlsbRecordType.EndComments);
  return finishBinaryWriter(writer);
}

export function writeCommentsVml(comments: readonly XlsbComment[]): Uint8Array {
  const writer = new XmlWriter();
  new VmlDrawingXform().render(writer, {
    comments: comments.map(entry => ({
      note: entry.comment.note,
      refAddress: { row: entry.row, col: entry.column }
    }))
  });
  return new TextEncoder().encode(writer.toString());
}

function parseCommentHeader(data: Uint8Array): PendingComment {
  const reader = new XlsbBinaryReader(data, "BrtBeginComment");
  const authorId = reader.i32();
  const rowFirst = reader.u32();
  const rowLast = reader.u32();
  const columnFirst = reader.u32();
  const columnLast = reader.u32();
  reader.skip(16);
  if (
    authorId < 0 ||
    rowFirst !== rowLast ||
    columnFirst !== columnLast ||
    rowFirst >= 1_048_576 ||
    columnFirst >= 16_384 ||
    reader.remaining !== 0
  ) {
    throw new XlsbParseError("BrtBeginComment", "invalid author or cell reference");
  }
  return {
    authorId,
    row: rowFirst + 1,
    column: columnFirst + 1,
    texts: []
  };
}

function parseRichString(data: Uint8Array, styles: XlsbStyleTable): NoteText[] {
  const parsed = parseXlsbRichString(
    new XlsbBinaryReader(data, "BrtCommentText"),
    "BrtCommentText",
    styles.fonts
  );
  if (parsed.hasPhoneticData) {
    throw new XlsbParseError("BrtCommentText", "unsupported rich-string flags");
  }
  return parsed.richText ?? (parsed.text ? [{ text: parsed.text }] : []);
}

function commentHeaderPayload(comment: XlsbComment, authorId: number): Uint8Array {
  const payload = createPayload(36);
  payload.view.setInt32(0, authorId, true);
  payload.view.setUint32(4, comment.row - 1, true);
  payload.view.setUint32(8, comment.row - 1, true);
  payload.view.setUint32(12, comment.column - 1, true);
  payload.view.setUint32(16, comment.column - 1, true);
  return payload.bytes;
}

function richStringPayload(texts: readonly NoteText[], styles: XlsbStyleRegistry): Uint8Array {
  return writeXlsbRichString(texts, styles, "Write XLSB comments");
}

async function parseVmlComments(bytes: Uint8Array): Promise<ParsedVmlComment[]> {
  async function* input(): AsyncGenerator<string> {
    yield decodeBytesToString(bytes);
  }
  const model = await new VmlDrawingXform().parseStream(input());
  return (model?.comments ?? []) as ParsedVmlComment[];
}

function mergeVmlNoteSettings(comment: NoteModel, shape: ParsedVmlComment): void {
  const note = comment.note;
  if (shape.margins) {
    note.margins = shape.margins;
  }
  if (shape.protection) {
    note.protection = shape.protection;
  }
  if (shape.editAs) {
    note.editAs = shape.editAs;
  }
  if (shape.anchor) {
    note.anchor = shape.anchor;
  }
  if (shape.width !== undefined) {
    note.width = shape.width;
  }
  if (shape.height !== undefined) {
    note.height = shape.height;
  }
}

function normalizeAuthor(value: string | undefined, unsupported: "error" | "ignore"): string {
  const author = value || "Author";
  if (author.length <= 54) {
    return author;
  }
  if (unsupported === "ignore") {
    return author.slice(0, 54);
  }
  throw new ExcelNotSupportedError(
    "Write XLSB comments",
    `comment author exceeds the BIFF12 limit of 54 characters: ${author}`
  );
}

function isCommentsContainerRecord(type: number): boolean {
  return (
    type === XlsbRecordType.BeginComments ||
    type === XlsbRecordType.EndComments ||
    type === XlsbRecordType.BeginCommentAuthors ||
    type === XlsbRecordType.EndCommentAuthors ||
    type === XlsbRecordType.BeginCommentList ||
    type === XlsbRecordType.EndCommentList ||
    type === XlsbRecordType.FutureRecordBegin ||
    type === XlsbRecordType.FutureRecordEnd ||
    type === XlsbRecordType.AlternateContentBegin ||
    type === XlsbRecordType.AlternateContentEnd
  );
}
