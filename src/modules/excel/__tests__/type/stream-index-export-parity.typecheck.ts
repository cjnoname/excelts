// This file is typechecked by `npm run type` (tsgo) but is NOT executed by Vitest.
// It enforces that Node and browser stream index modules keep compatible export surfaces.

type Assert<T extends true> = T;

type IsNever<T> = [T] extends [never] ? true : false;

type IsAny<T> = 0 extends 1 & T ? true : false;

type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type IsEqualStrict<A, B> =
  IsAny<A> extends true ? false : IsAny<B> extends true ? false : IsEqual<A, B>;

import type * as NodeIndexModule from "@stream";
import type * as BrowserIndexModule from "@stream/index.browser";

type NodeRuntime = typeof NodeIndexModule;
type BrowserRuntime = typeof BrowserIndexModule;

type ClassKeys<T> = {
  [K in keyof T]-?: T[K] extends abstract new (...args: any[]) => any ? K : never;
}[keyof T];

type NonClassKeys<T> = Exclude<keyof T, ClassKeys<T>>;

type NodeRuntimeNonClass = Pick<NodeRuntime, NonClassKeys<NodeRuntime>>;
type BrowserRuntimeNonClass = Pick<BrowserRuntime, NonClassKeys<BrowserRuntime>>;

// Export name parity

type _ClassExportNames_NodeExtra = Assert<
  IsNever<Exclude<ClassKeys<NodeRuntime>, ClassKeys<BrowserRuntime>>>
>;

type _ClassExportNames_BrowserExtra = Assert<
  IsNever<Exclude<ClassKeys<BrowserRuntime>, ClassKeys<NodeRuntime>>>
>;

type _NonClassExportNames_NodeExtra = Assert<
  IsNever<Exclude<keyof NodeRuntimeNonClass, keyof BrowserRuntimeNonClass>>
>;

type _NonClassExportNames_BrowserExtra = Assert<
  IsNever<Exclude<keyof BrowserRuntimeNonClass, keyof NodeRuntimeNonClass>>
>;

// Non-class export type parity (the bulk of the public API)
// Note: native stream classes differ across environments, so we do not require
// class structural parity here.

type _NonClass_pipeline = Assert<
  IsEqualStrict<NodeRuntimeNonClass["pipeline"], BrowserRuntimeNonClass["pipeline"]>
>;

type _NonClass_finished = Assert<
  IsEqualStrict<NodeRuntimeNonClass["finished"], BrowserRuntimeNonClass["finished"]>
>;

type _NonClass_createReadable = Assert<
  // @ts-expect-error Node vs browser `read()` callback signature differs
  IsEqualStrict<NodeRuntimeNonClass["createReadable"], BrowserRuntimeNonClass["createReadable"]>
>;

type _NonClass_createWritable = Assert<
  IsEqualStrict<NodeRuntimeNonClass["createWritable"], BrowserRuntimeNonClass["createWritable"]>
>;

type _NonClass_createTransform = Assert<
  IsEqualStrict<NodeRuntimeNonClass["createTransform"], BrowserRuntimeNonClass["createTransform"]>
>;

type _NonClass_createDuplex = Assert<
  IsEqualStrict<NodeRuntimeNonClass["createDuplex"], BrowserRuntimeNonClass["createDuplex"]>
>;

type _NonClass_createPassThrough = Assert<
  IsEqualStrict<
    NodeRuntimeNonClass["createPassThrough"],
    BrowserRuntimeNonClass["createPassThrough"]
  >
>;

type _NonClass_createCollector = Assert<
  IsEqualStrict<NodeRuntimeNonClass["createCollector"], BrowserRuntimeNonClass["createCollector"]>
>;

// Shared classes exported from the same files should remain identical.

type _Class_ChunkedBuilder = Assert<
  IsEqual<NodeRuntime["ChunkedBuilder"], BrowserRuntime["ChunkedBuilder"]>
>;

type _Class_TransactionalChunkedBuilder = Assert<
  IsEqual<NodeRuntime["TransactionalChunkedBuilder"], BrowserRuntime["TransactionalChunkedBuilder"]>
>;
