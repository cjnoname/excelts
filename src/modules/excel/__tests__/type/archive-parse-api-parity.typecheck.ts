// This file is typechecked by `npm run type` (tsgo) but is NOT executed by Vitest.
// It enforces that Node and browser Parse classes keep compatible public surface.

type Assert<T extends true> = T;

type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

import type { Parse as NodeParse } from "@archive/unzip/stream";
import type * as NodeParseModule from "@archive/unzip/stream";
import type { Parse as BrowserParse } from "@archive/unzip/stream.browser";
import type * as BrowserParseModule from "@archive/unzip/stream.browser";

// Strict export type parity: ParseStream must be identical across Node and browser.
type _ParseStreamExportedTypeParity = Assert<
  IsEqual<NodeParseModule.ParseStream, BrowserParseModule.ParseStream>
>;

type NodeInstance = InstanceType<typeof NodeParse>;
type BrowserInstance = InstanceType<typeof BrowserParse>;

// We intentionally compare the PullStream-style API surface (and a couple of
// Parse-visible fields). We do NOT attempt to make the entire class structurally
// identical (Duplex internals differ across Node vs browser).
type NodeParsePublicSurface = Pick<
  NodeInstance,
  "buffer" | "cb" | "finished" | "match" | "pull" | "pullUntil" | "stream" | "promise" | "crxHeader"
>;

type BrowserParsePublicSurface = Pick<
  BrowserInstance,
  "buffer" | "cb" | "finished" | "match" | "pull" | "pullUntil" | "stream" | "promise" | "crxHeader"
>;

type _ParsePublicSurface = Assert<IsEqual<NodeParsePublicSurface, BrowserParsePublicSurface>>;

// Ensure `createParse()` returns the same type as `new Parse()` in each environment.
type _Node_createParse_matches_ParseStream = Assert<
  IsEqual<ReturnType<typeof NodeParseModule.createParse>, NodeParseModule.ParseStream>
>;
type _Node_createParse_matches_new_Parse = Assert<
  IsEqual<ReturnType<typeof NodeParseModule.createParse>, InstanceType<typeof NodeParse>>
>;

type _Browser_createParse_matches_ParseStream = Assert<
  IsEqual<ReturnType<typeof BrowserParseModule.createParse>, BrowserParseModule.ParseStream>
>;
type _Browser_createParse_matches_new_Parse = Assert<
  IsEqual<ReturnType<typeof BrowserParseModule.createParse>, InstanceType<typeof BrowserParse>>
>;
