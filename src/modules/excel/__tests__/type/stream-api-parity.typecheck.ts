// This file is typechecked by `npm run type` (tsgo) but is NOT executed by Vitest.
// It enforces that Node and browser stream modules keep compatible API parameters/returns.

type Assert<T extends true> = T;

type IsNever<T> = [T] extends [never] ? true : false;

type IsAny<T> = 0 extends 1 & T ? true : false;

type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type IsEqualStrict<A, B> =
  IsAny<A> extends true ? false : IsAny<B> extends true ? false : IsEqual<A, B>;

type ParamsEqual<A extends (...args: any[]) => any, B extends (...args: any[]) => any> = IsEqual<
  Parameters<A>,
  Parameters<B>
>;

type ReturnsEqual<A extends (...args: any[]) => any, B extends (...args: any[]) => any> = IsEqual<
  ReturnType<A>,
  ReturnType<B>
>;

type ReturnExtends<A extends (...args: any[]) => any, Base> =
  ReturnType<A> extends Base ? true : false;

import type * as NodeStreams from "@stream/index";
import type * as BrowserStreams from "@stream/index.browser";
import type { ICollector, IDuplex, IReadable, ITransform, IWritable } from "@stream/types";

type NodeRuntime = typeof NodeStreams;
type BrowserRuntime = typeof BrowserStreams;

type ClassKeys<T> = {
  [K in keyof T]-?: T[K] extends abstract new (...args: any[]) => any ? K : never;
}[keyof T];

type NonClassKeys<T> = Exclude<keyof T, ClassKeys<T>>;

type NodeRuntimeNonClass = Pick<NodeRuntime, NonClassKeys<NodeRuntime>>;
type BrowserRuntimeNonClass = Pick<BrowserRuntime, NonClassKeys<BrowserRuntime>>;

// ============================================================================
// Export surface parity (broad)
//
// We enforce strict parity for:
// - all non-class runtime exports (functions/objects/constants)
// - exported type surface that index.ts exposes (PipelineOptions/FinishedOptions)
//
// We *only* enforce name parity for class exports, because Node's native stream
// classes and browser wrapper classes are not expected to be structurally equal.
// ============================================================================

type _ExportedTypesPipelineOptions = Assert<
  IsEqual<NodeStreams.PipelineOptions, BrowserStreams.PipelineOptions>
>;
type _ExportedTypesFinishedOptions = Assert<
  IsEqual<NodeStreams.FinishedOptions, BrowserStreams.FinishedOptions>
>;

type _ClassExportNames_NodeExtra = Assert<
  IsNever<Exclude<ClassKeys<NodeRuntime>, ClassKeys<BrowserRuntime>>>
>;
type _ClassExportNames_BrowserExtra = Assert<
  IsNever<Exclude<ClassKeys<BrowserRuntime>, ClassKeys<NodeRuntime>>>
>;

// Class external contracts must align with shared interfaces.
type _ClassContract_Readable_Node = Assert<
  InstanceType<NodeRuntime["Readable"]> extends IReadable<any> ? true : false
>;
type _ClassContract_Readable_Browser = Assert<
  InstanceType<BrowserRuntime["Readable"]> extends IReadable<any> ? true : false
>;
type _ClassContract_Writable_Node = Assert<
  InstanceType<NodeRuntime["Writable"]> extends IWritable<any> ? true : false
>;
type _ClassContract_Writable_Browser = Assert<
  InstanceType<BrowserRuntime["Writable"]> extends IWritable<any> ? true : false
>;
type _ClassContract_Transform_Node = Assert<
  InstanceType<NodeRuntime["Transform"]> extends ITransform<any, any> ? true : false
>;
type _ClassContract_Transform_Browser = Assert<
  InstanceType<BrowserRuntime["Transform"]> extends ITransform<any, any> ? true : false
>;
type _ClassContract_Duplex_Node = Assert<
  InstanceType<NodeRuntime["Duplex"]> extends IDuplex<any, any> ? true : false
>;
type _ClassContract_Duplex_Browser = Assert<
  InstanceType<BrowserRuntime["Duplex"]> extends IDuplex<any, any> ? true : false
>;
type _ClassContract_Collector_Node = Assert<
  InstanceType<NodeRuntime["Collector"]> extends ICollector<any> ? true : false
>;
type _ClassContract_Collector_Browser = Assert<
  InstanceType<BrowserRuntime["Collector"]> extends ICollector<any> ? true : false
>;

type _NonClassExportNames_NodeExtra = Assert<
  IsNever<Exclude<keyof NodeRuntimeNonClass, keyof BrowserRuntimeNonClass>>
>;
type _NonClassExportNames_BrowserExtra = Assert<
  IsNever<Exclude<keyof BrowserRuntimeNonClass, keyof NodeRuntimeNonClass>>
>;

// Non-class export types must match 1:1 (explicit list to keep errors actionable).
type _NonClassExport_addAbortSignal = Assert<
  IsEqualStrict<NodeRuntimeNonClass["addAbortSignal"], BrowserRuntimeNonClass["addAbortSignal"]>
>;
type _NonClassExport_compose = Assert<
  IsEqualStrict<NodeRuntimeNonClass["compose"], BrowserRuntimeNonClass["compose"]>
>;
type _NonClassExport_consumers = Assert<
  IsEqualStrict<NodeRuntimeNonClass["consumers"], BrowserRuntimeNonClass["consumers"]>
>;
type _NonClassExport_copyStream = Assert<
  IsEqualStrict<NodeRuntimeNonClass["copyStream"], BrowserRuntimeNonClass["copyStream"]>
>;
type _NonClassExport_createBufferedStream = Assert<
  IsEqualStrict<
    NodeRuntimeNonClass["createBufferedStream"],
    BrowserRuntimeNonClass["createBufferedStream"]
  >
>;
type _NonClassExport_createCollector = Assert<
  IsEqualStrict<NodeRuntimeNonClass["createCollector"], BrowserRuntimeNonClass["createCollector"]>
>;
type _NonClassExport_createDuplex = Assert<
  IsEqualStrict<NodeRuntimeNonClass["createDuplex"], BrowserRuntimeNonClass["createDuplex"]>
>;
type _NonClassExport_createEmptyReadable = Assert<
  IsEqualStrict<
    NodeRuntimeNonClass["createEmptyReadable"],
    BrowserRuntimeNonClass["createEmptyReadable"]
  >
>;
type _NonClassExport_createNullWritable = Assert<
  IsEqualStrict<
    NodeRuntimeNonClass["createNullWritable"],
    BrowserRuntimeNonClass["createNullWritable"]
  >
>;
type _NonClassExport_createPassThrough = Assert<
  IsEqualStrict<
    NodeRuntimeNonClass["createPassThrough"],
    BrowserRuntimeNonClass["createPassThrough"]
  >
>;
type _NonClassExport_createPullStream = Assert<
  IsEqualStrict<NodeRuntimeNonClass["createPullStream"], BrowserRuntimeNonClass["createPullStream"]>
>;
type _NonClassExport_createReadable = Assert<
  // @ts-expect-error Node vs browser `read()` callback signature differs
  IsEqualStrict<NodeRuntimeNonClass["createReadable"], BrowserRuntimeNonClass["createReadable"]>
>;
type _NonClassExport_createReadableFromArray = Assert<
  IsEqualStrict<
    NodeRuntimeNonClass["createReadableFromArray"],
    BrowserRuntimeNonClass["createReadableFromArray"]
  >
>;
type _NonClassExport_createReadableFromAsyncIterable = Assert<
  IsEqualStrict<
    NodeRuntimeNonClass["createReadableFromAsyncIterable"],
    BrowserRuntimeNonClass["createReadableFromAsyncIterable"]
  >
>;
type _NonClassExport_createReadableFromGenerator = Assert<
  IsEqualStrict<
    NodeRuntimeNonClass["createReadableFromGenerator"],
    BrowserRuntimeNonClass["createReadableFromGenerator"]
  >
>;
type _NonClassExport_createReadableFromPromise = Assert<
  IsEqualStrict<
    NodeRuntimeNonClass["createReadableFromPromise"],
    BrowserRuntimeNonClass["createReadableFromPromise"]
  >
>;
type _NonClassExport_createTransform = Assert<
  IsEqualStrict<NodeRuntimeNonClass["createTransform"], BrowserRuntimeNonClass["createTransform"]>
>;
type _NonClassExport_createWritable = Assert<
  IsEqualStrict<NodeRuntimeNonClass["createWritable"], BrowserRuntimeNonClass["createWritable"]>
>;
type _NonClassExport_drainStream = Assert<
  IsEqualStrict<NodeRuntimeNonClass["drainStream"], BrowserRuntimeNonClass["drainStream"]>
>;
type _NonClassExport_duplexPair = Assert<
  IsEqualStrict<NodeRuntimeNonClass["duplexPair"], BrowserRuntimeNonClass["duplexPair"]>
>;
type _NonClassExport_finished = Assert<
  IsEqualStrict<NodeRuntimeNonClass["finished"], BrowserRuntimeNonClass["finished"]>
>;
type _NonClassExport_finishedAll = Assert<
  IsEqualStrict<NodeRuntimeNonClass["finishedAll"], BrowserRuntimeNonClass["finishedAll"]>
>;
type _NonClassExport_getDefaultHighWaterMark = Assert<
  IsEqualStrict<
    NodeRuntimeNonClass["getDefaultHighWaterMark"],
    BrowserRuntimeNonClass["getDefaultHighWaterMark"]
  >
>;
type _NonClassExport_isDestroyed = Assert<
  IsEqualStrict<NodeRuntimeNonClass["isDestroyed"], BrowserRuntimeNonClass["isDestroyed"]>
>;
type _NonClassExport_isDisturbed = Assert<
  IsEqualStrict<NodeRuntimeNonClass["isDisturbed"], BrowserRuntimeNonClass["isDisturbed"]>
>;
type _NonClassExport_isDuplex = Assert<
  IsEqualStrict<NodeRuntimeNonClass["isDuplex"], BrowserRuntimeNonClass["isDuplex"]>
>;
type _NonClassExport_isErrored = Assert<
  IsEqualStrict<NodeRuntimeNonClass["isErrored"], BrowserRuntimeNonClass["isErrored"]>
>;
type _NonClassExport_isReadable = Assert<
  IsEqualStrict<NodeRuntimeNonClass["isReadable"], BrowserRuntimeNonClass["isReadable"]>
>;
type _NonClassExport_isStream = Assert<
  IsEqualStrict<NodeRuntimeNonClass["isStream"], BrowserRuntimeNonClass["isStream"]>
>;
type _NonClassExport_isTransform = Assert<
  IsEqualStrict<NodeRuntimeNonClass["isTransform"], BrowserRuntimeNonClass["isTransform"]>
>;
type _NonClassExport_isWritable = Assert<
  IsEqualStrict<NodeRuntimeNonClass["isWritable"], BrowserRuntimeNonClass["isWritable"]>
>;
type _NonClassExport_toWritable = Assert<
  IsEqualStrict<NodeRuntimeNonClass["toWritable"], BrowserRuntimeNonClass["toWritable"]>
>;
type _NonClassExport_pipeline = Assert<
  IsEqualStrict<NodeRuntimeNonClass["pipeline"], BrowserRuntimeNonClass["pipeline"]>
>;
type _NonClassExport_promises = Assert<
  IsEqualStrict<NodeRuntimeNonClass["promises"], BrowserRuntimeNonClass["promises"]>
>;
type _NonClassExport_promisify = Assert<
  IsEqualStrict<NodeRuntimeNonClass["promisify"], BrowserRuntimeNonClass["promisify"]>
>;
type _NonClassExport_setDefaultHighWaterMark = Assert<
  IsEqualStrict<
    NodeRuntimeNonClass["setDefaultHighWaterMark"],
    BrowserRuntimeNonClass["setDefaultHighWaterMark"]
  >
>;

// ============================================================================
// Stream factory return constraints
//
// Factory functions are required to return the shared interfaces so that their
// signatures are fully identical across Node and browser.
// ============================================================================

type _FactoryReturn_createReadable_Node = Assert<
  ReturnExtends<NodeRuntimeNonClass["createReadable"], IReadable<any>>
>;
type _FactoryReturn_createReadable_Browser = Assert<
  ReturnExtends<BrowserRuntimeNonClass["createReadable"], IReadable<any>>
>;

type _HelperReturn_compose_Node = Assert<
  ReturnExtends<NodeRuntimeNonClass["compose"], ITransform<any, any>>
>;
type _HelperReturn_compose_Browser = Assert<
  ReturnExtends<BrowserRuntimeNonClass["compose"], ITransform<any, any>>
>;

type _FactoryReturn_createReadableFromArray_Node = Assert<
  ReturnExtends<NodeRuntimeNonClass["createReadableFromArray"], IReadable<any>>
>;
type _FactoryReturn_createReadableFromArray_Browser = Assert<
  ReturnExtends<BrowserRuntimeNonClass["createReadableFromArray"], IReadable<any>>
>;

type _FactoryReturn_createReadableFromAsyncIterable_Node = Assert<
  ReturnExtends<NodeRuntimeNonClass["createReadableFromAsyncIterable"], IReadable<any>>
>;
type _FactoryReturn_createReadableFromAsyncIterable_Browser = Assert<
  ReturnExtends<BrowserRuntimeNonClass["createReadableFromAsyncIterable"], IReadable<any>>
>;

type _FactoryReturn_createReadableFromGenerator_Node = Assert<
  ReturnExtends<NodeRuntimeNonClass["createReadableFromGenerator"], IReadable<any>>
>;
type _FactoryReturn_createReadableFromGenerator_Browser = Assert<
  ReturnExtends<BrowserRuntimeNonClass["createReadableFromGenerator"], IReadable<any>>
>;

type _FactoryReturn_createReadableFromPromise_Node = Assert<
  ReturnExtends<NodeRuntimeNonClass["createReadableFromPromise"], IReadable<any>>
>;
type _FactoryReturn_createReadableFromPromise_Browser = Assert<
  ReturnExtends<BrowserRuntimeNonClass["createReadableFromPromise"], IReadable<any>>
>;

type _FactoryReturn_createEmptyReadable_Node = Assert<
  ReturnExtends<NodeRuntimeNonClass["createEmptyReadable"], IReadable<any>>
>;
type _FactoryReturn_createEmptyReadable_Browser = Assert<
  ReturnExtends<BrowserRuntimeNonClass["createEmptyReadable"], IReadable<any>>
>;

type _FactoryReturn_createWritable_Node = Assert<
  ReturnExtends<NodeRuntimeNonClass["createWritable"], IWritable<any>>
>;
type _FactoryReturn_createWritable_Browser = Assert<
  ReturnExtends<BrowserRuntimeNonClass["createWritable"], IWritable<any>>
>;

type _FactoryReturn_createNullWritable_Node = Assert<
  ReturnExtends<NodeRuntimeNonClass["createNullWritable"], IWritable<any>>
>;
type _FactoryReturn_createNullWritable_Browser = Assert<
  ReturnExtends<BrowserRuntimeNonClass["createNullWritable"], IWritable<any>>
>;

type _FactoryReturn_createTransform_Node = Assert<
  ReturnExtends<NodeRuntimeNonClass["createTransform"], ITransform<any, any>>
>;
type _FactoryReturn_createTransform_Browser = Assert<
  ReturnExtends<BrowserRuntimeNonClass["createTransform"], ITransform<any, any>>
>;

type _FactoryReturn_createPassThrough_Node = Assert<
  ReturnExtends<NodeRuntimeNonClass["createPassThrough"], ITransform<any, any>>
>;
type _FactoryReturn_createPassThrough_Browser = Assert<
  ReturnExtends<BrowserRuntimeNonClass["createPassThrough"], ITransform<any, any>>
>;

type _FactoryReturn_createDuplex_Node = Assert<
  ReturnExtends<NodeRuntimeNonClass["createDuplex"], IDuplex<any, any>>
>;
type _FactoryReturn_createDuplex_Browser = Assert<
  ReturnExtends<BrowserRuntimeNonClass["createDuplex"], IDuplex<any, any>>
>;

type _FactoryReturn_duplexPair_Node = Assert<
  ReturnExtends<NodeRuntimeNonClass["duplexPair"], ReadonlyArray<IDuplex<any, any>>>
>;
type _FactoryReturn_duplexPair_Browser = Assert<
  ReturnExtends<BrowserRuntimeNonClass["duplexPair"], ReadonlyArray<IDuplex<any, any>>>
>;

type _FactoryReturn_createCollector_Node = Assert<
  ReturnExtends<NodeRuntimeNonClass["createCollector"], ICollector<any>>
>;
type _FactoryReturn_createCollector_Browser = Assert<
  ReturnExtends<BrowserRuntimeNonClass["createCollector"], ICollector<any>>
>;
type _NonClassExport_streamToBuffer = Assert<
  IsEqualStrict<NodeRuntimeNonClass["streamToBuffer"], BrowserRuntimeNonClass["streamToBuffer"]>
>;
type _NonClassExport_streamToPromise = Assert<
  IsEqualStrict<NodeRuntimeNonClass["streamToPromise"], BrowserRuntimeNonClass["streamToPromise"]>
>;
type _NonClassExport_streamToString = Assert<
  IsEqualStrict<NodeRuntimeNonClass["streamToString"], BrowserRuntimeNonClass["streamToString"]>
>;
type _NonClassExport_streamToUint8Array = Assert<
  IsEqualStrict<
    NodeRuntimeNonClass["streamToUint8Array"],
    BrowserRuntimeNonClass["streamToUint8Array"]
  >
>;

// ============================================================================
// Core factory/utils used cross-platform
// ============================================================================

type _NormalizeWritableParams = Assert<
  ParamsEqual<typeof NodeStreams.toWritable, typeof BrowserStreams.toWritable>
>;

type _CreateReadableParams = Assert<
  // @ts-expect-error Node vs browser `read()` callback signature differs
  ParamsEqual<typeof NodeStreams.createReadable, typeof BrowserStreams.createReadable>
>;

type _CreateWritableParams = Assert<
  ParamsEqual<typeof NodeStreams.createWritable, typeof BrowserStreams.createWritable>
>;

type _CreateTransformParams = Assert<
  ParamsEqual<typeof NodeStreams.createTransform, typeof BrowserStreams.createTransform>
>;

type _PipelineParams = Assert<
  ParamsEqual<typeof NodeStreams.pipeline, typeof BrowserStreams.pipeline>
>;

type _FinishedParams = Assert<
  ParamsEqual<typeof NodeStreams.finished, typeof BrowserStreams.finished>
>;

type _StreamToPromiseParams = Assert<
  ParamsEqual<typeof NodeStreams.streamToPromise, typeof BrowserStreams.streamToPromise>
>;

type _StreamToBufferReturns = Assert<
  ReturnsEqual<typeof NodeStreams.streamToBuffer, typeof BrowserStreams.streamToBuffer>
>;

type _StreamToStringParams = Assert<
  ParamsEqual<typeof NodeStreams.streamToString, typeof BrowserStreams.streamToString>
>;

type _StreamToUint8ArrayParams = Assert<
  ParamsEqual<typeof NodeStreams.streamToUint8Array, typeof BrowserStreams.streamToUint8Array>
>;
