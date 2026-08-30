// This file is typechecked by `pnpm type` but is NOT executed by Vitest.
//
// It pins the XLSX option bags as *closed* object types.
//
// Both interfaces used to carry an `[key: string]: unknown` index signature,
// justified in a comment as "forward compatibility / for callers who subclass
// `XLSX` to pass through private flags". What it actually bought was that any
// unknown key — a typo, an option from a different serializer, an option that
// was renamed two versions ago — type-checked at the call site and was then
// dropped on the floor. For a write option that means producing a file which
// differs from the one the caller asked for, with nothing reporting it.
//
// Removing the signature broke nothing in this repository, which is the whole
// point: nothing was using the escape hatch, and it was only ever load-bearing
// for mistakes. These assertions keep it from coming back, because a
// reintroduced index signature makes every `@ts-expect-error` below unused and
// therefore an error in its own right.

import type { XlsxReadOptions, XlsxWriteOptions } from "@excel/xlsx/xlsx.browser";

// --- Declared options still compile, with their declared types. ---------------

const read: XlsxReadOptions = {
  base64: true,
  maxRows: 100,
  maxCols: 50,
  ignoreNodes: ["dataValidations"]
};
void read;

const write: XlsxWriteOptions = {
  zip: { level: 6, timestamps: "dos" },
  useSharedStrings: true,
  useStyles: false,
  templateMode: "strict",
  strictTemplateMode: true,
  validate: false
};
void write;

// --- An unknown key is a compile error, not a silent no-op. -------------------

const misspelledReadOption: XlsxReadOptions = {
  // @ts-expect-error `maxRow` is not an option; the correct name is `maxRows`.
  maxRow: 100
};
void misspelledReadOption;

const unsupportedFormatSelector: XlsxWriteOptions = {
  // @ts-expect-error This serializer writes XLSX. A `format` option here used to
  // type-check and be ignored, which is how a caller could ask for a different
  // container and silently receive an XLSX one instead.
  format: "xlsb"
};
void unsupportedFormatSelector;

const misspelledWriteOption: XlsxWriteOptions = {
  // @ts-expect-error `useSharedString` is missing its plural.
  useSharedString: true
};
void misspelledWriteOption;

// --- A wrong type for a declared key is still a compile error. ---------------

const wronglyTypedOption: XlsxWriteOptions = {
  // @ts-expect-error `templateMode` is a two-member union, not an arbitrary string.
  templateMode: "lenient"
};
void wronglyTypedOption;
