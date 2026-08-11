/**
 * True Streaming ZIP creator - shared implementation.
 *
 * This module is intentionally platform-agnostic.
 * - In Node builds it uses `./compression/crc32` + `./compression/streaming-compress` (zlib-backed).
 * - In browser builds the bundler aliases those imports to their browser variants.
 */

import { crc32Update, crc32Finalize, ensureZlibSync } from "@archive/compression/crc32";
import {
  createDeflateStream,
  SyncDeflater,
  hasNativeAsyncDeflate
} from "@archive/compression/streaming-compress";
import { EMPTY_UINT8ARRAY } from "@archive/core/bytes";
import { DEFAULT_ZIP_LEVEL, DEFAULT_ZIP_TIMESTAMPS } from "@archive/core/defaults";
import { createAbortError, toError, ArchiveError } from "@archive/core/errors";
import type { ZipStringCodec, ZipStringEncoding } from "@archive/core/text";
import { encodeZipStringWithCodec, resolveZipStringCodec } from "@archive/core/text";
import type { ZipCryptoState, AesKeyStrength, ZipEncryptionMethod } from "@archive/crypto";
import {
  zipCryptoInitKeys,
  zipCryptoCreateHeader,
  zipCryptoEncryptByte,
  aesEncrypt,
  buildAesExtraField,
  randomBytes,
  isAesEncryption,
  getAesKeyStrength
} from "@archive/crypto";
import type { ZipTimestampMode } from "@archive/zip-spec/timestamps";
import type { ZipEntryInfo } from "@archive/zip-spec/zip-entry-info";
import type { ZipPathOptions } from "@archive/zip-spec/zip-path";
import { normalizeZipPath } from "@archive/zip-spec/zip-path";
import type { Zip64Mode } from "@archive/zip-spec/zip-records";
import {
  buildDataDescriptor,
  buildDataDescriptorZip64,
  concatExtraFields,
  UINT16_MAX,
  UINT32_MAX,
  buildLocalFileHeader,
  VERSION_ZIP64,
  VERSION_NEEDED,
  FLAG_ENCRYPTED,
  FLAG_DATA_DESCRIPTOR,
  FLAG_UTF8,
  COMPRESSION_AES,
  getUnixModeFromExternalAttributes,
  isSymlinkMode
} from "@archive/zip-spec/zip-records";
import { isProbablyIncompressibleChunks } from "@archive/zip/compressibility";
import type { ZipCentralDirEntry, ZipWritableFile } from "@archive/zip/writable-file";
import {
  measureCentralDirectoryAndEocd,
  writeCentralDirectoryAndEocdInto
} from "@archive/zip/writer-core";
import { resolveZipExternalAttributesAndVersionMadeBy } from "@archive/zip/zip-entry-attributes";
import {
  buildZipEntryMetadata,
  resolveZipCompressionMethod
} from "@archive/zip/zip-entry-metadata";

export type { Zip64Mode } from "@archive/zip-spec/zip-records";
export type { ZipCentralDirEntry, ZipWritableFile } from "@archive/zip/writable-file";

const SMART_STORE_DECIDE_BYTES = 16 * 1024;

/** Input batching threshold for push().  Small chunks are accumulated in an
 *  internal buffer and flushed to the compression pipeline once this size is
 *  reached.  64 KB matches the standard deflate window and keeps the number
 *  of async push() calls — each of which creates a full Promise chain in the
 *  browser CompressionStream path — down to a manageable level. */
const INPUT_BATCH_BYTES = 65536;

/**
 * Encryption options for streaming ZIP creation.
 */
export interface StreamingZipEncryptionOptions {
  /** Encryption method to use */
  encryptionMethod?: ZipEncryptionMethod;
  /** Password for encryption */
  password?: string | Uint8Array;
}

/**
 * True Streaming ZIP File - compresses chunk by chunk
 */
export class ZipDeflateFile {
  private _deflate: ReturnType<typeof createDeflateStream> | null = null;
  private _crc: number = 0xffffffff;
  private _uncompressedSize: number = 0;
  private _compressedSize: number = 0;
  private _finalized = false;
  private _headerEmitted = false;
  private _ondata: ((data: Uint8Array, final: boolean) => void | Promise<void>) | null = null;
  private _onerror: ((err: Error) => void) | null = null;
  private _centralDirEntryInfo: ZipCentralDirEntry | null = null;
  private _pendingEnd = false;
  private _emittedDataDescriptor = false;
  private _localHeader: Uint8Array | null = null;
  private _zip64Mode: Zip64Mode = "auto";
  private _zip64 = false;

  // Smart STORE: delay method selection until we sample data.
  private _deflateWanted: boolean | null = null;
  private _pendingChunks: Uint8Array[] = [];
  private _sampleLen = 0;
  private _smartStore: boolean;

  // Promise resolution for completion (including data descriptor)
  private _completeResolve: (() => void) | null = null;
  private _completeReject: ((err: Error) => void) | null = null;
  private _completePromise: Promise<void> | null = null;
  private _completeError: Error | null = null;

  // Encryption state
  private _encryptionMethod: ZipEncryptionMethod = "none";
  private _password: string | Uint8Array | undefined;
  private _zipCryptoState: ZipCryptoState | null = null;
  private _aesKeyStrength: AesKeyStrength | undefined;
  // For AES, we need to buffer compressed data before encryption (HMAC requires full ciphertext)
  private _aesBuffer: Uint8Array[] = [];
  private _aesBufferSize = 0;
  // Original compression method for AES extra field
  private _originalCompressionMethod: number = 0;
  // Cached AES extra field (built once, reused for local header and central directory)
  private _aesExtraField: Uint8Array | null = null;

  // Queue for incoming data before ondata is set
  private _dataQueue: Uint8Array[] = [];
  private _finalQueued = false;

  // Serialize push() calls so callers don't need to await to preserve ordering.
  private _pushChain: Promise<void> = Promise.resolve();
  private _outputTail: Promise<void> = Promise.resolve();

  // Input batching: accumulate small chunks before feeding the compression
  // pipeline.  This collapses thousands of tiny push() calls (each creating a
  // full async Promise chain on browsers) into a handful of large pushes.
  // Threshold matches the common deflate window size (64 KB).
  private _inputBuf: Uint8Array | null = null;
  private _inputPos = 0;

  // Synchronous compression state for pushSync() path.
  private _syncDeflater: SyncDeflater | null = null;
  private _syncZlibReady = false;

  readonly name: string;
  readonly level: number;
  readonly nameBytes: Uint8Array;
  readonly commentBytes: Uint8Array;
  readonly dosTime: number;
  readonly dosDate: number;
  extraField: Uint8Array;
  private _flags: number;
  private _compressionMethod: number;
  private readonly _modTime: Date;

  private _externalAttributes: number;
  private _versionMadeBy?: number;
  private readonly _stringCodec: ReturnType<typeof resolveZipStringCodec>;

  constructor(
    name: string,
    options?: {
      level?: number;
      modTime?: Date;
      atime?: Date;
      ctime?: Date;
      birthTime?: Date;
      timestamps?: ZipTimestampMode;
      comment?: string;
      smartStore?: boolean;
      zip64?: Zip64Mode;
      /** Encryption method to use */
      encryptionMethod?: ZipEncryptionMethod;
      /** Password for encryption */
      password?: string | Uint8Array;

      /** Optional Unix mode/permissions (may include type bits). */
      mode?: number;
      /** Optional MS-DOS attributes (low 8 bits). */
      msDosAttributes?: number;
      /** Advanced override for external attributes. */
      externalAttributes?: number;
      /** Advanced override for central directory versionMadeBy. */
      versionMadeBy?: number;

      /** Optional entry name normalization. */
      path?: false | ZipPathOptions;

      /** Optional string encoding for this entry name/comment. */
      encoding?: ZipStringEncoding;
    }
  ) {
    const resolvedName = options?.path ? normalizeZipPath(name, options.path) : name;
    this.name = resolvedName;
    const modTime = options?.modTime ?? new Date();
    this._modTime = modTime;
    this.level = options?.level ?? DEFAULT_ZIP_LEVEL;

    this._smartStore = options?.smartStore ?? true;

    this._zip64Mode = options?.zip64 ?? "auto";
    this._zip64 = this._zip64Mode === true;

    // Encryption setup
    this._encryptionMethod = options?.encryptionMethod ?? "none";
    this._password = options?.password;
    if (this._encryptionMethod !== "none" && !this._password) {
      throw new ArchiveError("Password is required for encryption");
    }
    if (isAesEncryption(this._encryptionMethod)) {
      this._aesKeyStrength = getAesKeyStrength(this._encryptionMethod);
    }

    // Smart-store sampling does not allocate a contiguous buffer.

    this._stringCodec = resolveZipStringCodec(options?.encoding);

    const metadata = buildZipEntryMetadata({
      name: resolvedName,
      comment: options?.comment,
      modTime,
      atime: options?.atime,
      ctime: options?.ctime,
      birthTime: options?.birthTime,
      timestamps: options?.timestamps ?? DEFAULT_ZIP_TIMESTAMPS,
      useDataDescriptor: true,
      deflate: false,
      codec: this._stringCodec
    });

    this.nameBytes = metadata.nameBytes;
    this.commentBytes = metadata.commentBytes;
    this.dosTime = metadata.dosTime;
    this.dosDate = metadata.dosDate;
    this.extraField = metadata.extraField;
    this._flags = metadata.flags;
    this._compressionMethod = metadata.compressionMethod;

    // External attributes + versionMadeBy
    const attrs = resolveZipExternalAttributesAndVersionMadeBy({
      name: resolvedName,
      mode: options?.mode,
      msDosAttributes: options?.msDosAttributes,
      externalAttributes: options?.externalAttributes,
      versionMadeBy: options?.versionMadeBy
    });

    this._externalAttributes = attrs.externalAttributes;
    this._versionMadeBy = attrs.versionMadeBy;

    // Set encryption flag
    if (this._encryptionMethod !== "none") {
      this._flags |= FLAG_ENCRYPTED;
    }

    // If smart store is disabled, decide method upfront and keep true streaming semantics.
    if (!this._smartStore) {
      const deflate = this.level > 0;
      this._deflateWanted = deflate;
      this._compressionMethod = this._buildCompressionMethod(deflate);
      if (deflate) {
        this._initDeflateStream();
      }
      return;
    }

    // Level 0: always STORE.
    if (this.level === 0) {
      this._deflateWanted = false;
      this._compressionMethod = this._buildCompressionMethod(false);
    }
  }

  private _buildCompressionMethod(deflate: boolean): number {
    return resolveZipCompressionMethod(deflate);
  }

  /**
   * Get or build the AES extra field (cached for reuse).
   */
  private _getAesExtraField(): Uint8Array {
    if (!this._aesKeyStrength) {
      return EMPTY_UINT8ARRAY;
    }
    if (!this._aesExtraField) {
      this._aesExtraField = buildAesExtraField(
        2,
        this._aesKeyStrength,
        this._originalCompressionMethod
      );
    }
    return this._aesExtraField;
  }

  /**
   * Initialize ZipCrypto encryption state and emit header.
   * Called once before first data write.
   */
  private _initZipCryptoEncryption(): void {
    if (this._zipCryptoState || this._encryptionMethod !== "zipcrypto") {
      return;
    }

    this._zipCryptoState = zipCryptoInitKeys(this._password!);

    // Create and emit encryption header (12 bytes)
    // Note: We use CRC=0 here since we don't know it yet (data descriptor mode)
    // The check byte will be based on DOS time instead
    const dosTimeForCheck = (this.dosTime << 16) | this.dosDate;
    const header = zipCryptoCreateHeader(this._zipCryptoState, dosTimeForCheck, randomBytes);

    this._compressedSize += header.length;
    this._enqueueData(header, false);
  }

  /**
   * Encrypt data chunk using ZipCrypto (streaming).
   * Uses the exported zipCryptoEncryptByte for each byte.
   */
  private _zipCryptoEncryptChunk(data: Uint8Array): Uint8Array {
    if (!this._zipCryptoState) {
      return data;
    }

    const output = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) {
      output[i] = zipCryptoEncryptByte(this._zipCryptoState, data[i]!);
    }
    return output;
  }

  private _initDeflateStream(): void {
    if (this._deflate) {
      return;
    }

    this._deflate = createDeflateStream({ level: this.level });

    this._deflate.on("error", (err: Error) => {
      this._rejectComplete(err);
    });

    // Handle compressed output - this is true streaming!
    this._deflate.on("data", (chunk: Uint8Array) => {
      // For AES, buffer compressed data (HMAC needs full ciphertext)
      if (this._aesKeyStrength) {
        this._aesBuffer.push(chunk);
        this._aesBufferSize += chunk.length;
        return;
      }

      // For ZipCrypto, encrypt and emit immediately (true streaming)
      if (this._encryptionMethod === "zipcrypto") {
        this._initZipCryptoEncryption();
        const encrypted = this._zipCryptoEncryptChunk(chunk);
        this._compressedSize += encrypted.length;
        this._enqueueData(encrypted, false);
        return;
      }

      // No encryption
      this._compressedSize += chunk.length;
      this._enqueueData(chunk, false);
    });

    // Handle end - emit data descriptor
    // IMPORTANT: Only use 'end' event, NOT 'finish'!
    // Node.js zlib emits events in order: finish -> data -> end
    this._deflate.on("end", () => {
      if (this._pendingEnd && !this._emittedDataDescriptor) {
        this._emittedDataDescriptor = true;
        this._finalizeEncryptionAndEmitDescriptor();
      }
    });
  }

  /**
   * Finalize encryption (if needed) and emit data descriptor.
   */
  private _finalizeEncryptionAndEmitDescriptor(): void {
    // AES: encrypt buffered data and emit
    if (this._aesKeyStrength && this._aesBuffer.length > 0) {
      this._finalizeAesEncryption()
        .then(() => this._emitDataDescriptor())
        .catch(err => this._rejectComplete(err));
      return;
    }

    this._emitDataDescriptor();
  }

  /**
   * Finalize AES encryption: encrypt buffered data and emit.
   */
  private async _finalizeAesEncryption(): Promise<void> {
    if (!this._aesKeyStrength || this._aesBufferSize === 0) {
      return;
    }

    let compressedData: Uint8Array;
    if (this._aesBuffer.length === 1) {
      compressedData = this._aesBuffer[0]!;
    } else {
      // Concatenate all buffered chunks
      compressedData = new Uint8Array(this._aesBufferSize);
      let offset = 0;
      for (let i = 0; i < this._aesBuffer.length; i++) {
        const chunk = this._aesBuffer[i]!;
        compressedData.set(chunk, offset);
        offset += chunk.length;
      }
    }
    this._aesBuffer.length = 0;
    this._aesBufferSize = 0;

    // Encrypt using AES
    const encrypted = await aesEncrypt(compressedData, this._password!, this._aesKeyStrength);

    this._compressedSize = encrypted.length;
    this._enqueueData(encrypted, false);
  }

  private _buildLocalHeader(): Uint8Array {
    // For AES encryption, add AES extra field
    let extraField = this.extraField;
    let compressionMethod = this._compressionMethod;

    if (this._aesKeyStrength) {
      // Store original compression method for AES extra field
      this._originalCompressionMethod = this._compressionMethod;
      // Set compression method to AES indicator
      compressionMethod = COMPRESSION_AES;
      // Use cached AES extra field
      extraField = concatExtraFields(this.extraField, this._getAesExtraField());
    }

    // CRC + sizes are written via data descriptor for true streaming.
    return buildLocalFileHeader({
      fileName: this.nameBytes,
      extraField,
      flags: this._flags,
      compressionMethod,
      dosTime: this.dosTime,
      dosDate: this.dosDate,
      crc32: 0,
      compressedSize: 0,
      uncompressedSize: 0,
      versionNeeded: this._zip64 ? VERSION_ZIP64 : VERSION_NEEDED
    });
  }

  private _accumulateSampleLen(data: Uint8Array): void {
    if (this._deflateWanted !== null) {
      return;
    }
    if (data.length === 0) {
      return;
    }

    if (this._sampleLen >= SMART_STORE_DECIDE_BYTES) {
      return;
    }
    const take = Math.min(SMART_STORE_DECIDE_BYTES - this._sampleLen, data.length);
    if (take <= 0) {
      return;
    }
    this._sampleLen += take;
  }

  private _shouldDecide(final: boolean): boolean {
    if (this._deflateWanted !== null) {
      return false;
    }
    return final || this._sampleLen >= SMART_STORE_DECIDE_BYTES;
  }

  private _decideCompressionIfNeeded(
    final: boolean,
    dataForDecision: Uint8Array,
    skipDeflateInit = false
  ): void {
    if (this._deflateWanted !== null) {
      return;
    }

    // Match non-streaming builder semantics: empty files never need DEFLATE.
    if (final && this._sampleLen === 0) {
      this._deflateWanted = false;
      this._sampleLen = 0;
      this._compressionMethod = this._buildCompressionMethod(false);
      this._localHeader = null;
      return;
    }

    // Default to DEFLATE unless heuristic says STORE.
    const store = isProbablyIncompressibleChunks(
      (function* (pending: Uint8Array[], current: Uint8Array): Iterable<Uint8Array> {
        for (const c of pending) {
          if (c.length) {
            yield c;
          }
        }
        if (current.length) {
          yield current;
        }
      })(this._pendingChunks, dataForDecision),
      { sampleBytes: SMART_STORE_DECIDE_BYTES, minDecisionBytes: SMART_STORE_DECIDE_BYTES }
    );
    this._deflateWanted = !store;
    this._sampleLen = 0;

    this._compressionMethod = this._buildCompressionMethod(this._deflateWanted);
    this._localHeader = null;

    if (this._deflateWanted) {
      if (!skipDeflateInit) {
        this._initDeflateStream();
      }
    }
  }

  private _emitHeaderIfNeeded(): void {
    if (this._headerEmitted) {
      return;
    }
    this._emitHeader();
    this._headerEmitted = true;
  }

  private async _flushPendingChunks(): Promise<void> {
    if (this._pendingChunks.length === 0) {
      return;
    }
    for (const chunk of this._pendingChunks) {
      await this._writeData(chunk);
    }
    this._pendingChunks.length = 0;
  }

  private _enqueueData(data: Uint8Array, final: boolean): void {
    if (this._ondata) {
      this._trackHandoff(this._ondata(data, final));
    } else {
      this._dataQueue.push(data);
      if (final) {
        this._finalQueued = true;
      }
    }
  }

  private _trackHandoff(handoff: void | Promise<void>): void {
    if (!handoff) {
      return;
    }
    this._outputTail = this._outputTail.then(() => handoff);
    void this._outputTail.catch(() => undefined);
  }

  private _flushQueue(): void {
    if (!this._ondata) {
      return;
    }

    const len = this._dataQueue.length;
    const finalIndex = this._finalQueued ? len - 1 : -1;
    for (let i = 0; i < len; i++) {
      this._trackHandoff(this._ondata(this._dataQueue[i], i === finalIndex));
    }
    this._dataQueue.length = 0;
    this._finalQueued = false;
  }

  get ondata(): ((data: Uint8Array, final: boolean) => void | Promise<void>) | null {
    return this._ondata;
  }

  set ondata(cb: (data: Uint8Array, final: boolean) => void | Promise<void>) {
    this._ondata = cb;
    // Flush any queued data
    this._flushQueue();
  }

  get onerror(): ((err: Error) => void) | null {
    return this._onerror;
  }

  set onerror(cb: (err: Error) => void) {
    this._onerror = cb;
    // If an error already occurred, surface it immediately.
    if (this._completeError) {
      cb(this._completeError);
    }
  }

  private _resolveComplete(): void {
    if (this._completeResolve) {
      this._completeResolve();
    }
  }

  private _rejectComplete(err: Error): void {
    if (this._completeError) {
      return;
    }
    this._completeError = err;
    if (this._onerror) {
      this._onerror(err);
    }
    if (this._completeReject) {
      this._completeReject(err);
    }
  }

  private _ensureCompletePromise(): Promise<void> {
    if (this._completeError) {
      return Promise.reject(this._completeError);
    }
    if (this._emittedDataDescriptor) {
      return Promise.resolve();
    }
    if (!this._completePromise) {
      this._completePromise = new Promise<void>((resolve, reject) => {
        this._completeResolve = resolve;
        this._completeReject = reject;
      });
    }
    return this._completePromise;
  }

  private _tapCallback(promise: Promise<void>, callback?: (err?: Error | null) => void): void {
    if (!callback) {
      return;
    }
    promise.then(() => callback()).catch(err => callback(err));
  }

  private async _waitForOutput(promise: Promise<void>): Promise<void> {
    await promise;
    await this._outputTail;
  }

  private _writeDataSync(data: Uint8Array, final: boolean): void {
    if (data.length === 0 && !final) {
      return;
    }

    // Update CRC32 on uncompressed data
    if (data.length > 0) {
      this._crc = crc32Update(this._crc, data);
      this._uncompressedSize += data.length;
    }

    if (this._deflateWanted) {
      // Stateful synchronous compression — maintains LZ77 window and bit position
      // across chunks so the output is a single valid DEFLATE stream.
      if (!this._syncDeflater) {
        this._syncDeflater = new SyncDeflater(this.level);
      }
      if (data.length > 0) {
        const compressed = this._syncDeflater.write(data);
        if (compressed.length > 0) {
          this._compressedSize += compressed.length;
          this._enqueueData(compressed, false);
        }
      }
      if (final) {
        const tail = this._syncDeflater.finish();
        if (tail.length > 0) {
          this._compressedSize += tail.length;
          this._enqueueData(tail, false);
        }
        this._syncDeflater = null;
      }
      return;
    }

    // STORE mode - handle encryption
    if (this._aesKeyStrength) {
      this._aesBuffer.push(data);
      this._aesBufferSize += data.length;
      return;
    }

    if (this._encryptionMethod === "zipcrypto") {
      this._initZipCryptoEncryption();
      const encrypted = this._zipCryptoEncryptChunk(data);
      this._compressedSize += encrypted.length;
      this._enqueueData(encrypted, false);
      return;
    }

    // STORE mode without encryption - pass through
    if (data.length > 0) {
      this._compressedSize += data.length;
      this._enqueueData(data, false);
    }
  }

  private _writeData(data: Uint8Array): Promise<void> {
    if (data.length === 0) {
      return Promise.resolve();
    }

    // Update CRC32 on uncompressed data
    this._crc = crc32Update(this._crc, data);
    this._uncompressedSize += data.length;

    if (this._deflate) {
      // Write to deflate stream - returns Promise for async streaming
      return new Promise<void>((resolve, reject) => {
        this._deflate!.write(data, (err?: Error | null) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    }

    // STORE mode - handle encryption
    if (this._aesKeyStrength) {
      // For AES in STORE mode, buffer data for later encryption
      this._aesBuffer.push(data);
      this._aesBufferSize += data.length;
      return Promise.resolve();
    }

    if (this._encryptionMethod === "zipcrypto") {
      // For ZipCrypto in STORE mode, encrypt and emit immediately
      this._initZipCryptoEncryption();
      const encrypted = this._zipCryptoEncryptChunk(data);
      this._compressedSize += encrypted.length;
      this._enqueueData(encrypted, false);
      return Promise.resolve();
    }

    // STORE mode without encryption - pass through
    this._compressedSize += data.length;
    this._enqueueData(data, false);
    return Promise.resolve();
  }

  private _endDeflateAndWait(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const deflate = this._deflate!;
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const onEnd = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        deflate.off("error", onError);
        deflate.off("end", onEnd);
      };

      deflate.once("error", onError);
      deflate.once("end", onEnd);
      deflate.end();
    });
  }

  private _finalizeAfterWrite(writePromise: Promise<void>): Promise<void> {
    this._finalized = true;
    this._pendingEnd = true;

    const completePromise = this._ensureCompletePromise();
    if (this._deflate) {
      return writePromise.then(() => this._endDeflateAndWait()).then(() => completePromise);
    }

    // STORE mode - handle AES encryption before emitting data descriptor
    if (this._aesKeyStrength && this._aesBufferSize > 0) {
      this._emittedDataDescriptor = true;
      this._finalizeAesEncryption()
        .then(() => this._emitDataDescriptor())
        .catch(err => this._rejectComplete(err));
      return completePromise;
    }

    // STORE mode - emit data descriptor directly
    this._emittedDataDescriptor = true;
    this._emitDataDescriptor();
    return completePromise;
  }

  private _pushUnchained(
    data: Uint8Array,
    final: boolean,
    callback?: (err?: Error | null) => void
  ): Promise<void> {
    if (this._finalized) {
      const promise = Promise.reject(new Error("Cannot push to finalized ZipDeflateFile"));
      this._tapCallback(promise, callback);
      return promise;
    }

    // If a previous async operation already failed, don't do more work.
    if (this._completeError) {
      const promise = Promise.reject(this._completeError);
      this._tapCallback(promise, callback);
      return promise;
    }

    if (this._deflateWanted === null) {
      this._accumulateSampleLen(data);

      if (!this._shouldDecide(final)) {
        if (data.length > 0) {
          this._pendingChunks.push(data);
        }
        const promise = Promise.resolve();
        this._tapCallback(promise, callback);
        return promise;
      }

      this._decideCompressionIfNeeded(final, data);
      this._emitHeaderIfNeeded();

      const hadPendingChunks = this._pendingChunks.length > 0;
      const flushPromise = this._flushPendingChunks();

      let writePromise = flushPromise;
      if (data.length > 0) {
        writePromise = hadPendingChunks
          ? flushPromise.then(() => this._writeData(data))
          : this._writeData(data);
      }
      const outputPromise = final ? this._finalizeAfterWrite(writePromise) : writePromise;
      const promise = this._waitForOutput(outputPromise);
      this._tapCallback(promise, callback);
      return promise;
    }

    this._emitHeaderIfNeeded();

    const writePromise = this._writeData(data);
    const outputPromise = final ? this._finalizeAfterWrite(writePromise) : writePromise;
    const promise = this._waitForOutput(outputPromise);
    this._tapCallback(promise, callback);
    return promise;
  }

  /**
   * Push data — compresses and outputs immediately.
   *
   * Returns a Promise that resolves once this input has been compressed **and**
   * the resulting output has been handed to `ondata` (including any handoff the
   * consumer returned to apply backpressure). If `final` is true it also covers
   * the data descriptor. Awaiting it therefore means "the bytes produced so far
   * have reached the destination", not merely "the input was accepted" — which
   * is what lets callers sample downstream backpressure afterwards. Browser
   * deflate is asynchronous, so the distinction is load-bearing there.
   *
   * When no async deflate stream is needed (the common case: smartStore without
   * encryption), data is compressed and emitted synchronously via SyncDeflater.
   * This avoids _pushChain closure accumulation that would cause unbounded
   * memory growth when callers push data in a tight synchronous loop.
   */
  push(data: Uint8Array, final = false, callback?: (err?: Error | null) => void): Promise<void> {
    // Use the synchronous path only when:
    //  1. No async deflate stream is already active
    //  2. No encryption (which requires async crypto)
    //  3. No native async deflate available (browser CompressionStream)
    //
    // When a native async CompressionStream("deflate-raw") is available
    // (modern browsers), prefer the async path — it produces better
    // compression (Dynamic Huffman via the browser's native engine) and
    // doesn't block the main thread.
    if (!this._deflate && this._encryptionMethod === "none" && !hasNativeAsyncDeflate()) {
      try {
        this._pushSyncPath(data, final);
        callback?.();
      } catch (err) {
        callback?.(err instanceof Error ? err : new Error(String(err)));
        return Promise.reject(err);
      }
      return this._outputTail;
    }

    // --- Async path: batch small chunks to reduce Promise-chain overhead ---
    if (!final && data.length > 0 && data.length < INPUT_BATCH_BYTES) {
      if (!this._inputBuf) {
        this._inputBuf = new Uint8Array(INPUT_BATCH_BYTES);
        this._inputPos = 0;
      }
      if (this._inputPos + data.length <= INPUT_BATCH_BYTES) {
        this._inputBuf.set(data, this._inputPos);
        this._inputPos += data.length;
        callback?.();
        return this._outputTail;
      }

      const combined = new Uint8Array(this._inputPos + data.length);
      combined.set(this._inputBuf.subarray(0, this._inputPos));
      combined.set(data, this._inputPos);
      this._inputPos = 0;
      return this._pushAsync(combined, false, callback);
    }

    // Large or final data flushes any buffered input first.
    if (this._inputPos > 0) {
      const flushData = this._inputBuf!.slice(0, this._inputPos);
      this._inputPos = 0;

      // Chain: flush buffered → push current
      const flushPromise = this._pushAsync(flushData, false);
      const promise = (this._pushChain = flushPromise.then(
        () => this._pushUnchained(data, final, callback),
        () => this._pushUnchained(data, final, callback)
      ));
      promise.catch(() => {});
      return promise;
    }

    return this._pushAsync(data, final, callback);
  }

  /** Enqueue an async push through the _pushChain serialization. */
  private _pushAsync(
    data: Uint8Array,
    final: boolean,
    callback?: (err?: Error | null) => void
  ): Promise<void> {
    // Chain the async push so calls are serialized. Use a recovery wrapper
    // so that a single failed push does not break the chain for subsequent
    // pushes — errors are surfaced via onerror/rejectComplete instead.
    const promise = (this._pushChain = this._pushChain.then(
      () => this._pushUnchained(data, final, callback),
      () => this._pushUnchained(data, final, callback)
    ));

    // Prevent unhandled rejection when callers intentionally ignore the Promise.
    promise.catch(() => {});
    return promise;
  }

  /**
   * Synchronous push path — compresses and emits data without any Promises.
   *
   * Uses SyncDeflater (native zlib.deflateRawSync on Node.js, pure-JS LZ77 on
   * browsers) so the entire data flow is synchronous:
   *   push → _writeDataSync → SyncDeflater.write → _enqueueData → ondata
   *
   * Called automatically by push() when no async deflate stream is active.
   */
  private _pushSyncPath(data: Uint8Array, final = false): void {
    if (this._finalized) {
      throw new ArchiveError("Cannot push to finalized ZipDeflateFile");
    }

    // Ensure native CRC32 is available before the first _writeDataSync call.
    // Without this, the JS fallback is ~60x slower.
    if (!this._syncZlibReady) {
      ensureZlibSync();
      this._syncZlibReady = true;
    }

    if (this._deflateWanted === null) {
      this._accumulateSampleLen(data);

      if (!this._shouldDecide(final)) {
        if (data.length > 0) {
          this._pendingChunks.push(data);
        }
        return;
      }

      this._decideCompressionIfNeeded(final, data, true);
      this._emitHeaderIfNeeded();

      // Flush pending chunks synchronously
      for (const chunk of this._pendingChunks) {
        this._writeDataSync(chunk, false);
      }
      this._pendingChunks.length = 0;

      if (data.length > 0) {
        this._writeDataSync(data, final);
      }

      if (final) {
        this._finalizeSyncAfterWrite();
      }
      return;
    }

    this._emitHeaderIfNeeded();

    this._writeDataSync(data, final);

    if (final) {
      this._finalizeSyncAfterWrite();
    }
  }

  private _finalizeSyncAfterWrite(): void {
    this._finalized = true;
    this._pendingEnd = false;
    this._emittedDataDescriptor = true;

    // AES encryption requires async crypto — not supported for sync path
    if (this._aesKeyStrength && this._aesBufferSize > 0) {
      throw new ArchiveError("AES encryption is not supported with synchronous push");
    }

    // Finalize the sync deflater if it has pending data
    if (this._syncDeflater) {
      const tail = this._syncDeflater.finish();
      if (tail.length > 0) {
        this._compressedSize += tail.length;
        this._enqueueData(tail, false);
      }
      this._syncDeflater = null;
    }

    this._emitDataDescriptor();

    // _emitDataDescriptor may call _rejectComplete instead of throwing
    // (e.g. ZIP64 required but zip64=false). In the sync path, surface
    // this as a throw so push() can reject properly.
    if (this._completeError) {
      throw this._completeError;
    }
  }

  /**
   * Emit local file header with Data Descriptor flag
   */
  private _emitHeader(): void {
    if (!this._localHeader) {
      this._localHeader = this._buildLocalHeader();
    }
    this._enqueueData(this._localHeader, false);
  }

  /**
   * Emit Data Descriptor with CRC and sizes
   */
  private _emitDataDescriptor(): void {
    const crcValue = crc32Finalize(this._crc);

    // ZIP64 trigger: when sizes exceed classic limits.
    const needsZip64Sizes =
      this._compressedSize > UINT32_MAX || this._uncompressedSize > UINT32_MAX;

    if (this._zip64Mode === false && needsZip64Sizes) {
      this._rejectComplete(new Error("ZIP64 is required but zip64=false"));
      return;
    }

    if (this._zip64Mode === true) {
      this._zip64 = true;
    } else if (needsZip64Sizes && !this._zip64) {
      this._zip64 = true;
    }

    const descriptor = this._zip64
      ? buildDataDescriptorZip64(crcValue, this._compressedSize, this._uncompressedSize)
      : buildDataDescriptor(crcValue, this._compressedSize, this._uncompressedSize);

    // Determine compression method and extra field for central directory
    let cdCompressionMethod = this._compressionMethod;
    let cdExtraField = this.extraField;

    if (this._aesKeyStrength) {
      // For AES, use COMPRESSION_AES and reuse cached AES extra field
      cdCompressionMethod = COMPRESSION_AES;
      cdExtraField = concatExtraFields(this.extraField, this._getAesExtraField());
    }

    // Store entry info for central directory
    this._centralDirEntryInfo = {
      name: this.nameBytes,
      extraField: cdExtraField,
      comment: this.commentBytes,
      flags: this._flags,
      crc: crcValue,
      compressedSize: this._compressedSize,
      uncompressedSize: this._uncompressedSize,
      compressionMethod: cdCompressionMethod,
      dosTime: this.dosTime,
      dosDate: this.dosDate,
      offset: -1,
      zip64: this._zip64,
      externalAttributes: this._externalAttributes,
      versionMadeBy: this._versionMadeBy
    };

    this._enqueueData(descriptor, true);

    this._resolveComplete();
  }

  /**
   * Returns a promise that resolves when the file is completely written
   * (including data descriptor)
   */
  complete(): Promise<void> {
    return this._ensureCompletePromise();
  }

  /**
   * @internal Flush batched input and wait until everything produced so far has
   * reached `ondata`, so the caller can then observe downstream backpressure.
   *
   * Producers call this after each input chunk. `push()` already includes output
   * delivery, but small inputs may still sit in the batch buffer; this drains
   * that buffer first. Callers must not treat it as "all bytes emitted": smart
   * STORE deliberately withholds output until it has sampled enough data.
   */
  async outputCheckpoint(): Promise<void> {
    if (this._inputPos > 0) {
      const data = this._inputBuf!.slice(0, this._inputPos);
      this._inputPos = 0;
      await this._pushAsync(data, false);
    }
    await this._pushChain;
    // Smart STORE intentionally buffers up to SMART_STORE_DECIDE_BYTES before
    // choosing STORE vs DEFLATE. Do not force that decision merely to create an
    // output checkpoint: doing so would change compression semantics for small
    // streaming chunks. Until output exists, there is nothing downstream to
    // backpressure; the fixed 16 KiB sample is the producer-side memory bound.
    await this._outputTail;
  }

  /**
   * Get entry metadata in the same shape as unzip parser outputs.
   * This is best-effort: writer-only fields like encryption are always false.
   */
  getEntryInfo(): ZipEntryInfo | null {
    if (!this._centralDirEntryInfo) {
      return null;
    }

    const path = this.name;
    const pathIsDir = path.endsWith("/") || path.endsWith("\\");

    // Extract Unix mode from external attributes for symlink detection
    const externalAttributes = this._centralDirEntryInfo.externalAttributes;
    const mode = getUnixModeFromExternalAttributes(externalAttributes);
    const type = isSymlinkMode(mode) ? "symlink" : pathIsDir ? "directory" : "file";

    return {
      path,
      type,
      compressedSize: this._centralDirEntryInfo.compressedSize,
      uncompressedSize: this._centralDirEntryInfo.uncompressedSize,
      compressionMethod: this._centralDirEntryInfo.compressionMethod,
      crc32: this._centralDirEntryInfo.crc,
      lastModified: this._modTime,
      localHeaderOffset: this._centralDirEntryInfo.offset,
      comment: this._stringCodec.decode(this._centralDirEntryInfo.comment),
      externalAttributes,
      mode,
      versionMadeBy: this._centralDirEntryInfo.versionMadeBy,
      extraField: this._centralDirEntryInfo.extraField,
      isEncrypted: this._encryptionMethod !== "none",
      encryptionMethod: this._aesKeyStrength
        ? "aes"
        : this._encryptionMethod === "zipcrypto"
          ? "zipcrypto"
          : undefined,
      aesKeyStrength: this._aesKeyStrength,
      originalCompressionMethod: this._aesKeyStrength ? this._originalCompressionMethod : undefined
    };
  }

  /** Writer-only metadata for building the Central Directory. */
  getCentralDirectoryEntryInfo(): ZipCentralDirEntry | null {
    return this._centralDirEntryInfo;
  }

  isComplete(): boolean {
    return this._emittedDataDescriptor && this._centralDirEntryInfo !== null;
  }

  abort(reason?: unknown): void {
    if (this._completeError) {
      return;
    }

    const err = createAbortError(reason);
    this._finalized = true;
    this._pendingEnd = true;
    this._rejectComplete(err);

    try {
      const deflate = this._deflate;
      if (deflate && typeof deflate.destroy === "function") {
        deflate.destroy(err);
      }
    } catch {
      // ignore
    }
  }
}

/**
 * Passthrough ZIP entry writer.
 *
 * Emits a local header with data-descriptor flag, then streams the provided
 * raw payload (already compressed and/or encrypted), then emits a data descriptor.
 */
export class ZipRawFile implements ZipWritableFile {
  private _headerEmitted = false;
  private _finalized = false;
  private _started = false;
  private _zip64Mode: Zip64Mode = "auto";
  private _zip64 = false;

  private _dataQueue: Uint8Array[] = [];
  private _dataQueueHead = 0;
  private _finalQueued = false;

  private _ondata: ((data: Uint8Array, final: boolean) => void | Promise<void>) | null = null;
  private _onerror: ((err: Error) => void) | null = null;
  private _outputTail: Promise<void> = Promise.resolve();

  private _centralDirEntryInfo: ZipCentralDirEntry;

  readonly name: string;
  readonly nameBytes: Uint8Array;
  readonly commentBytes: Uint8Array;
  readonly dosTime: number;
  readonly dosDate: number;
  readonly extraField: Uint8Array;
  private readonly _flags: number;
  private readonly _compressionMethod: number;
  private readonly _crc32: number;
  private readonly _compressedSize: number;
  private readonly _uncompressedSize: number;
  private readonly _externalAttributes: number;
  private readonly _versionMadeBy?: number;

  private _source: Uint8Array | AsyncIterable<Uint8Array>;
  private _chunkSize: number;
  private readonly _stringCodec: ReturnType<typeof resolveZipStringCodec>;

  private _doneResolve: (() => void) | null = null;
  private _doneReject: ((err: Error) => void) | null = null;
  private _donePromise: Promise<void>;

  constructor(
    name: string,
    options: {
      compressedData: Uint8Array | AsyncIterable<Uint8Array>;
      crc32: number;
      compressedSize: number;
      uncompressedSize: number;
      compressionMethod: number;
      flags?: number;
      comment?: Uint8Array;
      extraField?: Uint8Array;
      dosTime: number;
      dosDate: number;
      zip64?: Zip64Mode;
      externalAttributes?: number;
      versionMadeBy?: number;
      chunkSize?: number;
      codec?: ZipStringCodec;
    }
  ) {
    this.name = name;
    this._stringCodec = options.codec ?? resolveZipStringCodec();
    this.nameBytes = this._stringCodec.encode(name);
    this.commentBytes = options.comment ?? EMPTY_UINT8ARRAY;
    this.dosTime = options.dosTime;
    this.dosDate = options.dosDate;
    this.extraField = options.extraField ?? EMPTY_UINT8ARRAY;

    this._crc32 = options.crc32 >>> 0;
    this._compressedSize = options.compressedSize;
    this._uncompressedSize = options.uncompressedSize;
    this._compressionMethod = options.compressionMethod;

    this._externalAttributes = options.externalAttributes ?? 0;
    this._versionMadeBy = options.versionMadeBy;

    this._zip64Mode = options.zip64 ?? "auto";
    this._zip64 =
      this._zip64Mode === true ||
      this._compressedSize > UINT32_MAX ||
      this._uncompressedSize > UINT32_MAX;

    // Always write data descriptor for passthrough entries to avoid
    // local-header ZIP64 complexity.
    this._flags =
      (options.flags ?? 0) | (this._stringCodec.useUtf8Flag ? FLAG_UTF8 : 0) | FLAG_DATA_DESCRIPTOR;

    this._centralDirEntryInfo = {
      name: this.nameBytes,
      extraField: this.extraField,
      comment: this.commentBytes,
      flags: this._flags,
      crc: this._crc32,
      compressedSize: this._compressedSize,
      uncompressedSize: this._uncompressedSize,
      compressionMethod: this._compressionMethod,
      dosTime: this.dosTime,
      dosDate: this.dosDate,
      offset: 0,
      zip64: this._zip64,
      externalAttributes: this._externalAttributes,
      versionMadeBy: this._versionMadeBy
    };

    this._source = options.compressedData;
    this._chunkSize = options.chunkSize ?? 64 * 1024;

    this._donePromise = new Promise<void>((resolve, reject) => {
      this._doneResolve = resolve;
      this._doneReject = reject;
    });
  }

  /**
   * Resolves when the file has fully emitted its local header, payload,
   * and trailing data descriptor.
   */
  done(): Promise<void> {
    return this._donePromise;
  }

  get ondata(): ((data: Uint8Array, final: boolean) => void | Promise<void>) | null {
    return this._ondata;
  }

  set ondata(fn: ((data: Uint8Array, final: boolean) => void | Promise<void>) | null) {
    this._ondata = fn;
    this._drainQueue();
  }

  get onerror(): ((err: Error) => void) | null {
    return this._onerror;
  }

  set onerror(fn: ((err: Error) => void) | null) {
    this._onerror = fn;
  }

  getCentralDirectoryEntryInfo(): ZipCentralDirEntry | null {
    return this._centralDirEntryInfo;
  }

  private _enqueueData(data: Uint8Array, final: boolean): void {
    if (this._finalQueued) {
      return;
    }
    if (data.length) {
      this._dataQueue.push(data);
    }
    if (final) {
      this._finalQueued = true;
    }
    this._drainQueue();
  }

  /**
   * Chain one `ondata` handoff onto this entry's output tail so callers can
   * await delivery. A consumer that applies backpressure returns a Promise;
   * a synchronous consumer returns nothing and the tail is unchanged.
   */
  private _trackHandoff(handoff: void | Promise<void>): void {
    if (!handoff) {
      return;
    }
    this._outputTail = this._outputTail.then(() => handoff);
    void this._outputTail.catch(() => undefined);
  }

  private _drainQueue(): void {
    if (!this._ondata) {
      return;
    }

    while (this._dataQueueHead < this._dataQueue.length) {
      const chunk = this._dataQueue[this._dataQueueHead++]!;
      this._trackHandoff(this._ondata(chunk, false));
    }

    if (this._dataQueueHead > 0) {
      this._dataQueue.length = 0;
      this._dataQueueHead = 0;
    }

    if (this._finalQueued) {
      this._finalQueued = false;
      this._trackHandoff(this._ondata(EMPTY_UINT8ARRAY, true));

      // Emitting final means this file is fully written.
      void this._outputTail.then(
        () => {
          this._doneResolve?.();
          this._doneResolve = null;
          this._doneReject = null;
        },
        err => {
          this._doneReject?.(err);
          this._doneResolve = null;
          this._doneReject = null;
        }
      );
    }
  }

  private _buildLocalHeader(): Uint8Array {
    return buildLocalFileHeader({
      fileName: this.nameBytes,
      extraField: this.extraField,
      flags: this._flags,
      compressionMethod: this._compressionMethod,
      dosTime: this.dosTime,
      dosDate: this.dosDate,
      crc32: 0,
      compressedSize: 0,
      uncompressedSize: 0,
      versionNeeded: this._zip64 ? VERSION_ZIP64 : VERSION_NEEDED
    });
  }

  private _buildDataDescriptor(): Uint8Array {
    if (this._zip64) {
      return buildDataDescriptorZip64(this._crc32, this._compressedSize, this._uncompressedSize);
    }
    return buildDataDescriptor(this._crc32, this._compressedSize, this._uncompressedSize);
  }

  async start(): Promise<void> {
    if (this._started) {
      return;
    }
    this._started = true;

    try {
      if (!this._headerEmitted) {
        this._headerEmitted = true;
        this._enqueueData(this._buildLocalHeader(), false);
      }

      if (this._source instanceof Uint8Array) {
        // Fast path: emit entire buffer if small enough (avoids loop overhead)
        if (this._source.length <= this._chunkSize) {
          this._enqueueData(this._source, false);
          await this._outputTail;
        } else {
          for (let offset = 0; offset < this._source.length; offset += this._chunkSize) {
            const chunk = this._source.subarray(
              offset,
              Math.min(this._source.length, offset + this._chunkSize)
            );
            this._enqueueData(chunk, false);
            await this._outputTail;
          }
        }
      } else {
        for await (const chunk of this._source) {
          this._enqueueData(chunk, false);
          await this._outputTail;
        }
      }

      if (!this._finalized) {
        this._finalized = true;
        this._enqueueData(this._buildDataDescriptor(), true);
        await this._outputTail;
      }
    } catch (e) {
      const err = toError(e);
      try {
        this._doneReject?.(err);
      } catch {
        // ignore
      } finally {
        this._doneResolve = null;
        this._doneReject = null;
      }
      try {
        this._onerror?.(err);
      } catch {
        // ignore
      }
    }
  }

  abort(reason?: unknown): void {
    if (this._finalized) {
      return;
    }
    this._finalized = true;
    const err = createAbortError(reason);

    try {
      this._doneReject?.(err);
    } catch {
      // ignore
    } finally {
      this._doneResolve = null;
      this._doneReject = null;
    }
    try {
      this._onerror?.(err);
    } catch {
      // ignore
    }
  }
}

/**
 * Streaming ZIP Creator - processes files sequentially
 */
export class StreamingZip {
  private callback: (err: Error | null, data: Uint8Array, final: boolean) => void | Promise<void>;
  private entries: ZipCentralDirEntry[] = [];
  private currentOffset = 0;
  private ended = false;
  private endPending = false;

  private addedEntryCount = 0;

  private zipComment: Uint8Array;
  private zip64Mode: Zip64Mode;
  private readonly _stringCodec: ZipStringCodec;

  // Queue for sequential file processing
  private fileQueue: ZipWritableFile[] = [];
  private fileQueueIndex = 0;
  private activeFile: ZipWritableFile | null = null;

  constructor(
    callback: (err: Error | null, data: Uint8Array, final: boolean) => void | Promise<void>,
    options?: {
      comment?: string;
      zip64?: Zip64Mode;
      encoding?: ZipStringEncoding;
      codec?: ZipStringCodec;
    }
  ) {
    this.callback = callback;
    this._stringCodec = options?.codec ?? resolveZipStringCodec(options?.encoding);
    this.zipComment = encodeZipStringWithCodec(options?.comment, this._stringCodec);
    this.zip64Mode = options?.zip64 ?? "auto";
  }

  add(file: ZipWritableFile): void {
    if (this.ended) {
      throw new ArchiveError("Cannot add files after calling end() ");
    }

    // Fail fast: if ZIP64 is forbidden, classic ZIP can't exceed 65535 entries.
    if (this.zip64Mode === false && this.addedEntryCount >= UINT16_MAX) {
      throw new ArchiveError("ZIP64 is required but zip64=false");
    }
    this.addedEntryCount++;

    this.fileQueue.push(file);

    // If no active file, process this one
    if (!this.activeFile) {
      this._processNextFile();
    }
  }

  private _processNextFile(): void {
    if (this.fileQueueIndex >= this.fileQueue.length) {
      this.activeFile = null;

      // Reset queue storage
      this.fileQueue = [];
      this.fileQueueIndex = 0;

      // Check if we can finalize
      if (this.endPending) {
        this._finalize();
      }
      return;
    }

    const file = this.fileQueue[this.fileQueueIndex++]!;
    this.activeFile = file;
    const startOffset = this.currentOffset;

    file.onerror = (err: Error) => {
      if (this.ended) {
        return;
      }
      this.ended = true;
      this.callback(err, EMPTY_UINT8ARRAY, true);
    };

    file.ondata = (data: Uint8Array, final: boolean) => {
      if (this.ended) {
        return;
      }
      this.currentOffset += data.length;
      const handoff = this.callback(null, data, false);

      if (final) {
        const entryInfo = file.getCentralDirectoryEntryInfo();
        if (entryInfo) {
          entryInfo.offset = startOffset;
          this.entries.push(entryInfo);
        }

        // Process next file
        this._processNextFile();
      }
      return handoff;
    };

    // Auto-start writers that require an explicit start().
    if (typeof file.start === "function") {
      try {
        const promise = file.start();
        // Avoid unhandled rejections and surface errors to the pipeline.
        promise.catch(e => {
          const err = toError(e);
          try {
            file.onerror?.(err);
          } catch {
            // ignore
          }
        });
      } catch (e) {
        const err = toError(e);
        try {
          file.onerror?.(err);
        } catch {
          // ignore
        }
      }
    }
  }

  private _finalize(): void {
    if (this.ended) {
      return;
    }
    this.ended = true;

    const centralDirOffset = this.currentOffset;

    let finalChunk: Uint8Array;
    try {
      const sizing = measureCentralDirectoryAndEocd(this.entries, {
        zipComment: this.zipComment,
        zip64Mode: this.zip64Mode,
        centralDirOffset
      });
      finalChunk = new Uint8Array(sizing.totalSize);
      writeCentralDirectoryAndEocdInto(this.entries, {
        zipComment: this.zipComment,
        zip64Mode: this.zip64Mode,
        centralDirOffset,
        out: finalChunk,
        offset: 0
      });
    } catch (e) {
      const err = toError(e);
      this.callback(err, EMPTY_UINT8ARRAY, true);
      return;
    }

    this.callback(null, finalChunk, true);
  }

  end(): void {
    if (this.endPending || this.ended) {
      return;
    }
    this.endPending = true;

    // If no active file (all complete), finalize now
    if (!this.activeFile) {
      this._finalize();
    }
    // Otherwise, _processNextFile will call _finalize when done
  }

  abort(reason?: unknown): void {
    if (this.ended) {
      return;
    }

    const err = createAbortError(reason);
    this.ended = true;
    this.endPending = true;

    try {
      this.activeFile?.abort(err);
    } catch {
      // ignore
    }

    this.callback(err, EMPTY_UINT8ARRAY, true);
  }
}

// =============================================================================
// Export aliases for fflate compatibility
export { StreamingZip as Zip, ZipDeflateFile as ZipDeflate };
