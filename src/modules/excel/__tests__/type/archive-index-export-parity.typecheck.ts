// This file is typechecked by `npm run type` (tsgo) but is NOT executed by Vitest.
// It enforces that Node and browser archive index modules keep compatible export surfaces.

type Assert<T extends true> = T;

type IsNever<T> = [T] extends [never] ? true : false;

type IsAny<T> = 0 extends 1 & T ? true : false;

type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type IsEqualStrict<A, B> =
  IsAny<A> extends true ? false : IsAny<B> extends true ? false : IsEqual<A, B>;

import type * as NodeIndexModule from "@archive";
import type {
  CompressOptions as NodeCompressOptions,
  StreamCompressOptions as NodeStreamCompressOptions,
  ZipOptions as NodeZipOptions,
  ZipEntryOptions as NodeZipEntryOptions,
  UnzipOptions as NodeUnzipOptions,
  ArchiveSource as NodeArchiveSource,
  ArchiveSink as NodeArchiveSink
} from "@archive";
import type * as BrowserIndexModule from "@archive/index.browser";
import type {
  CompressOptions as BrowserCompressOptions,
  StreamCompressOptions as BrowserStreamCompressOptions,
  ZipOptions as BrowserZipOptions,
  ZipEntryOptions as BrowserZipEntryOptions,
  UnzipOptions as BrowserUnzipOptions,
  ArchiveSource as BrowserArchiveSource,
  ArchiveSink as BrowserArchiveSink
} from "@archive/index.browser";

type NodeRuntime = typeof NodeIndexModule;
type BrowserRuntime = typeof BrowserIndexModule;

type ClassKeys<T> = {
  [K in keyof T]-?: T[K] extends abstract new (...args: any[]) => any ? K : never;
}[keyof T];

type NonClassKeys<T> = Exclude<keyof T, ClassKeys<T>>;

// Node-only exports (file system convenience layer + gzip support)
type NodeOnlyClassExports = "ArchiveFile" | "TarGzArchive";
type NodeOnlyNonClassExports =
  | "toNodeReadable"
  | "traverseDirectory"
  | "traverseDirectorySync"
  | "glob"
  | "globSync"
  | "globToRegex"
  | "matchGlob"
  | "matchGlobAny"
  | "ensureDir"
  | "ensureDirSync"
  | "fileExists"
  | "fileExistsSync"
  | "readFileBytes"
  | "readFileBytesSync"
  | "writeFileBytes"
  | "writeFileBytesSync"
  | "setFileTime"
  | "setFileTimeSync"
  | "safeStats"
  | "safeStatsSync"
  | "readFileText"
  | "readFileTextSync"
  | "writeFileText"
  | "writeFileTextSync"
  | "remove"
  | "removeSync"
  | "copyFile"
  | "copyFileSync"
  | "createReadStream"
  | "createWriteStream"
  | "createTempDir"
  | "createTempDirSync"
  // TAR + Gzip support (Node.js only - requires zlib)
  | "targz"
  | "parseTarGz"
  | "parseTarGzStream"
  | "untargz"
  | "gzipTar"
  | "gunzip"
  | "gzip"
  | "gzipSync"
  | "gunzipSync";

// Exclude Node-only exports from parity checks
type SharedClassKeys<T> = Exclude<ClassKeys<T>, NodeOnlyClassExports>;
type SharedNonClassKeys<T> = Exclude<NonClassKeys<T>, NodeOnlyNonClassExports>;

type NodeRuntimeNonClass = Pick<NodeRuntime, SharedNonClassKeys<NodeRuntime>>;
type BrowserRuntimeNonClass = Pick<BrowserRuntime, SharedNonClassKeys<BrowserRuntime>>;

// Export name parity (for shared exports)

type _ClassExportNames_NodeExtra = Assert<
  IsNever<Exclude<SharedClassKeys<NodeRuntime>, SharedClassKeys<BrowserRuntime>>>
>;

type _ClassExportNames_BrowserExtra = Assert<
  IsNever<Exclude<SharedClassKeys<BrowserRuntime>, SharedClassKeys<NodeRuntime>>>
>;

type _NonClassExportNames_NodeExtra = Assert<
  IsNever<Exclude<keyof NodeRuntimeNonClass, keyof BrowserRuntimeNonClass>>
>;

type _NonClassExportNames_BrowserExtra = Assert<
  IsNever<Exclude<keyof BrowserRuntimeNonClass, keyof NodeRuntimeNonClass>>
>;

// Non-class export type parity (explicit list to keep errors actionable)

type _NonClass_crc32 = Assert<
  IsEqualStrict<NodeRuntimeNonClass["crc32"], BrowserRuntimeNonClass["crc32"]>
>;

type _NonClass_crc32Update = Assert<
  IsEqualStrict<NodeRuntimeNonClass["crc32Update"], BrowserRuntimeNonClass["crc32Update"]>
>;

type _NonClass_crc32Finalize = Assert<
  IsEqualStrict<NodeRuntimeNonClass["crc32Finalize"], BrowserRuntimeNonClass["crc32Finalize"]>
>;

type _NonClass_compress = Assert<
  IsEqualStrict<NodeRuntimeNonClass["compress"], BrowserRuntimeNonClass["compress"]>
>;

type _NonClass_compressSync = Assert<
  IsEqualStrict<NodeRuntimeNonClass["compressSync"], BrowserRuntimeNonClass["compressSync"]>
>;

type _NonClass_decompress = Assert<
  IsEqualStrict<NodeRuntimeNonClass["decompress"], BrowserRuntimeNonClass["decompress"]>
>;

type _NonClass_decompressSync = Assert<
  IsEqualStrict<NodeRuntimeNonClass["decompressSync"], BrowserRuntimeNonClass["decompressSync"]>
>;

type _NonClass_hasCompressionStream = Assert<
  IsEqualStrict<
    NodeRuntimeNonClass["hasCompressionStream"],
    BrowserRuntimeNonClass["hasCompressionStream"]
  >
>;

type _NonClass_createDeflateStream = Assert<
  IsEqualStrict<
    NodeRuntimeNonClass["createDeflateStream"],
    BrowserRuntimeNonClass["createDeflateStream"]
  >
>;

type _NonClass_createInflateStream = Assert<
  IsEqualStrict<
    NodeRuntimeNonClass["createInflateStream"],
    BrowserRuntimeNonClass["createInflateStream"]
  >
>;

type _NonClass_hasDeflateRaw = Assert<
  IsEqualStrict<NodeRuntimeNonClass["hasDeflateRaw"], BrowserRuntimeNonClass["hasDeflateRaw"]>
>;

type _NonClass_zip = Assert<
  IsEqualStrict<NodeRuntime["Archive"]["zip"], BrowserRuntime["Archive"]["zip"]>
>;

type _NonClass_unzip = Assert<
  IsEqualStrict<NodeRuntime["Archive"]["unzip"], BrowserRuntime["Archive"]["unzip"]>
>;

// `Archive` domain namespace parity (the high-level API now lives here)
type _Namespace_Archive = Assert<IsEqual<NodeRuntime["Archive"], BrowserRuntime["Archive"]>>;

// Exported type parity

type _Type_CompressOptions = Assert<IsEqual<NodeCompressOptions, BrowserCompressOptions>>;

type _Type_StreamCompressOptions = Assert<
  IsEqual<NodeStreamCompressOptions, BrowserStreamCompressOptions>
>;

type _Type_ZipOptions = Assert<IsEqual<NodeZipOptions, BrowserZipOptions>>;

type _Type_ZipEntryOptions = Assert<IsEqual<NodeZipEntryOptions, BrowserZipEntryOptions>>;

type _Type_UnzipOptions = Assert<IsEqual<NodeUnzipOptions, BrowserUnzipOptions>>;

type _Type_ArchiveSource = Assert<IsEqual<NodeArchiveSource, BrowserArchiveSource>>;

type _Type_ArchiveSink = Assert<IsEqual<NodeArchiveSink, BrowserArchiveSink>>;
