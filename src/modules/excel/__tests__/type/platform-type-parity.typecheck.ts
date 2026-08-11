// This file is typechecked by `pnpm type` but is NOT executed by Vitest.
//
// Node and browser entries are allowed to *refine* a type (Node returns a
// `Buffer`, or a nominal `stream.Readable`) but must never drift out of the
// contract a cross-platform program writes against. `verify-public-types.ts`
// (R3) pins the *names* both entries expose; nothing pinned the *types*, so a
// Node-only refinement could silently have become a Node-only API.
//
// Every assertion below is the same shape: take the platform type and assign it
// to the portable contract. If a future change makes a Node type diverge instead
// of refine — say `toBuffer` starts returning something that is not a
// `Uint8Array` — this file stops compiling.
//
// The browser side is checked through the browser modules directly, because the
// `@stream` / `.browser` specifier swap only happens in the browser build.

import { createCsvReadStream as portableCsvReadStream } from "@excel/bridge/csv";
import { createCsvReadStream as nodeCsvReadStream } from "@excel/bridge/csv.node";
import type { XlsxReadable } from "@excel/core/xlsx-io-types";
import { Workbook } from "@excel/index";
import type { IReadable } from "@stream";
import type { Readable as BrowserReadable } from "@stream/index.browser";

declare const wb: Workbook.Handle;

// --- `XlsxReadable` must be IDENTICAL, not merely compatible ----------------
// This is the name cross-platform code writes against, so both builds have to
// mean the same thing by it. A revision that intersected it with the platform
// `Readable` made the two definitions mutually unassignable, which turned every
// isomorphic helper typed `XlsxReadable` into a platform-specific one. Assigning
// in *both* directions is what pins identity; a one-way check would let one side
// silently gain members again.
type NodeXlsxReadable = XlsxReadable;
type BrowserXlsxReadable = IReadable<Uint8Array>;
declare const nodeAlias: NodeXlsxReadable;
declare const browserAlias: BrowserXlsxReadable;
const nodeToBrowser: BrowserXlsxReadable = nodeAlias;
const browserToNode: NodeXlsxReadable = browserAlias;

// --- `Workbook.toStream` ----------------------------------------------------
// Node refines the *return type* (nominal `stream.Readable`) rather than the
// shared alias. A refinement must still satisfy the portable contract.
const portableSource: XlsxReadable = Workbook.toStream(wb);
const stillIterablesBytes: AsyncIterable<Uint8Array> = Workbook.toStream(wb);
// The browser `Readable` must NOT be reachable through the shared alias — that
// would mean the alias had drifted back to a platform type.
declare const browserReadable: BrowserReadable<Uint8Array>;
const browserReadableIsPortable: XlsxReadable = browserReadable;

// --- `Workbook.toBuffer` ----------------------------------------------------
// Node refines `Uint8Array` to `Buffer`. Portable code asks for `Uint8Array`.
export async function toBufferStaysPortable(): Promise<void> {
  const portable: Uint8Array = await Workbook.toBuffer(wb);
  void portable;
}

// --- `createCsvReadStream` --------------------------------------------------
// The Node entry adds nominal `stream.Readable`; the cross-platform entry does
// not. Both must satisfy the portable contract, so code written against the
// portable type keeps compiling under either resolution.
const nodeCsvStaysPortable: IReadable<Uint8Array> = nodeCsvReadStream(wb);
const portableCsv: IReadable<Uint8Array> = portableCsvReadStream(wb);

// A refinement must be strictly *more* than the portable type, never different:
// the Node CSV stream has to be usable everywhere the portable one is.
const nodeCsvSubstitutesForPortable: typeof portableCsv = nodeCsvReadStream(wb);

void nodeToBrowser;
void browserToNode;
void portableSource;
void stillIterablesBytes;
void browserReadableIsPortable;
void nodeCsvStaysPortable;
void portableCsv;
void nodeCsvSubstitutesForPortable;
