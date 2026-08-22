// This file is typechecked by `npm run type` (tsgo) but is NOT executed by Vitest.
// It enforces that Node and browser-redirected archive modules keep compatible API parameters.

type Assert<T extends true> = T;

type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type ParamsEqual<A extends (...args: any[]) => any, B extends (...args: any[]) => any> = IsEqual<
  Parameters<A>,
  Parameters<B>
>;

type ReturnsEqual<A extends (...args: any[]) => any, B extends (...args: any[]) => any> = IsEqual<
  ReturnType<A>,
  ReturnType<B>
>;

// Use value imports here (this file is not executed, and typecheck runs with --noEmit).
// This keeps tsgo happy and lets us use `typeof module.fn` for signature extraction.
import type * as NodeCompress from "@archive/compression/compress";
import type * as BrowserCompress from "@archive/compression/compress.browser";
import type * as NodeCrc32 from "@archive/compression/crc32";
import type * as BrowserCrc32 from "@archive/compression/crc32.browser";
import type * as NodeStreaming from "@archive/compression/streaming-compress";
import type * as BrowserStreaming from "@archive/compression/streaming-compress.browser";
import type * as NodeParse from "@archive/unzip/stream";
import type * as BrowserParse from "@archive/unzip/stream.browser";

// ============================================================================
// compress.ts vs compress.browser.ts
// ============================================================================

type _CompressParams = Assert<
  ParamsEqual<typeof NodeCompress.compress, typeof BrowserCompress.compress>
>;
type _CompressReturns = Assert<
  ReturnsEqual<typeof NodeCompress.compress, typeof BrowserCompress.compress>
>;
type _CompressSyncParams = Assert<
  ParamsEqual<typeof NodeCompress.compressSync, typeof BrowserCompress.compressSync>
>;
type _CompressSyncReturns = Assert<
  ReturnsEqual<typeof NodeCompress.compressSync, typeof BrowserCompress.compressSync>
>;
type _DecompressParams = Assert<
  ParamsEqual<typeof NodeCompress.decompress, typeof BrowserCompress.decompress>
>;
type _DecompressReturns = Assert<
  ReturnsEqual<typeof NodeCompress.decompress, typeof BrowserCompress.decompress>
>;
type _DecompressSyncParams = Assert<
  ParamsEqual<typeof NodeCompress.decompressSync, typeof BrowserCompress.decompressSync>
>;
type _DecompressSyncReturns = Assert<
  ReturnsEqual<typeof NodeCompress.decompressSync, typeof BrowserCompress.decompressSync>
>;
type _HasCompressionStreamParams = Assert<
  ParamsEqual<typeof NodeCompress.hasCompressionStream, typeof BrowserCompress.hasCompressionStream>
>;
type _HasCompressionStreamReturns = Assert<
  ReturnsEqual<
    typeof NodeCompress.hasCompressionStream,
    typeof BrowserCompress.hasCompressionStream
  >
>;

// ============================================================================
// crc32.ts vs crc32.browser.ts
// ============================================================================

type _Crc32Params = Assert<ParamsEqual<typeof NodeCrc32.crc32, typeof BrowserCrc32.crc32>>;
type _Crc32UpdateParams = Assert<
  ParamsEqual<typeof NodeCrc32.crc32Update, typeof BrowserCrc32.crc32Update>
>;
type _Crc32FinalizeParams = Assert<
  ParamsEqual<typeof NodeCrc32.crc32Finalize, typeof BrowserCrc32.crc32Finalize>
>;
type _Crc32FinalizeReturns = Assert<
  ReturnsEqual<typeof NodeCrc32.crc32Finalize, typeof BrowserCrc32.crc32Finalize>
>;
type _EnsureCrc32Params = Assert<
  ParamsEqual<typeof NodeCrc32.ensureCrc32, typeof BrowserCrc32.ensureCrc32>
>;

// ============================================================================
// streaming-compress.ts vs streaming-compress.browser.ts
// (Parameters MUST match; return types are unified via shared minimal interfaces.)
// ============================================================================

type _CreateDeflateStreamParams = Assert<
  ParamsEqual<typeof NodeStreaming.createDeflateStream, typeof BrowserStreaming.createDeflateStream>
>;
type _CreateInflateStreamParams = Assert<
  ParamsEqual<typeof NodeStreaming.createInflateStream, typeof BrowserStreaming.createInflateStream>
>;
type _HasDeflateRawParams = Assert<
  ParamsEqual<typeof NodeStreaming.hasDeflateRaw, typeof BrowserStreaming.hasDeflateRaw>
>;

type _CreateDeflateStreamReturns = Assert<
  ReturnsEqual<
    typeof NodeStreaming.createDeflateStream,
    typeof BrowserStreaming.createDeflateStream
  >
>;
type _CreateInflateStreamReturns = Assert<
  ReturnsEqual<
    typeof NodeStreaming.createInflateStream,
    typeof BrowserStreaming.createInflateStream
  >
>;

// ============================================================================
// parse.ts vs parse.browser.ts
// (Parameters MUST match; return types are unified via ParseStream (Duplex-based).)
// ============================================================================

type _CreateParseParams = Assert<
  ParamsEqual<typeof NodeParse.createParse, typeof BrowserParse.createParse>
>;
type _CreateParseClassParams = Assert<
  ParamsEqual<typeof NodeParse.createParseClass, typeof BrowserParse.createParseClass>
>;

type _CreateParseReturns = Assert<
  ReturnsEqual<typeof NodeParse.createParse, typeof BrowserParse.createParse>
>;
