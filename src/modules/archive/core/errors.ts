/**
 * Archive module error types.
 *
 * All archive-related errors extend ArchiveError.
 */

import type { BaseErrorOptions } from "@utils/errors";
import { BaseError } from "@utils/errors";

// Re-export common utilities from base
export {
  AbortError,
  createAbortError,
  isAbortError,
  throwIfAborted,
  createLinkedAbortController,
  toError,
  suppressUnhandledRejection,
  errorToJSON,
  getErrorChain,
  getRootCause,
  type BaseErrorOptions
} from "@utils/errors";

/**
 * Base class for all archive-related errors.
 */
export class ArchiveError extends BaseError {
  constructor(message: string, options?: BaseErrorOptions) {
    super(message, options);
    this.name = "ArchiveError";
  }
}

// -----------------------------------------------------------------------------
// ZIP Parsing Errors
// -----------------------------------------------------------------------------

/**
 * Error thrown when ZIP parsing fails.
 */
export class ZipParseError extends ArchiveError {
  override name = "ZipParseError";
}

/**
 * Error thrown when an invalid ZIP signature is encountered.
 */
export class InvalidZipSignatureError extends ZipParseError {
  override name = "InvalidZipSignatureError";

  constructor(expected: string, actual: number, context?: string, options?: BaseErrorOptions) {
    const msg = context
      ? `Invalid ${context}: expected ${expected}, got 0x${actual.toString(16).padStart(8, "0")}`
      : `Invalid signature: expected ${expected}, got 0x${actual.toString(16).padStart(8, "0")}`;
    super(msg, options);
  }
}

/**
 * Error thrown when End of Central Directory is not found.
 */
export class EocdNotFoundError extends ZipParseError {
  override name = "EocdNotFoundError";

  constructor(options?: BaseErrorOptions) {
    super("Invalid ZIP file: End of Central Directory not found", options);
  }
}

// -----------------------------------------------------------------------------
// CRC32 Validation Errors
// -----------------------------------------------------------------------------

/**
 * Error thrown when CRC32 validation fails.
 */
export class Crc32MismatchError extends ArchiveError {
  override name = "Crc32MismatchError";

  constructor(
    public readonly path: string,
    public readonly expected: number,
    public readonly actual: number,
    options?: BaseErrorOptions
  ) {
    super(
      `CRC32 mismatch for "${path}": expected 0x${expected.toString(16).padStart(8, "0")}, got 0x${actual.toString(16).padStart(8, "0")}`,
      options
    );
  }
}

// -----------------------------------------------------------------------------
// Entry Size Validation Errors
// -----------------------------------------------------------------------------

/**
 * Reason for entry size mismatch.
 * - `too-many-bytes`: ZIP bomb detected - actual size exceeds declared size
 * - `too-few-bytes`: Corruption detected - actual size is less than declared size
 */
export type EntrySizeMismatchReason = "too-many-bytes" | "too-few-bytes";

/**
 * Error thrown when the actual decompressed size doesn't match the declared size.
 * This is a security feature to detect ZIP bombs and corrupted archives.
 */
export class EntrySizeMismatchError extends ArchiveError {
  override name = "EntrySizeMismatchError";

  constructor(
    public readonly path: string,
    public readonly expected: number,
    public readonly actual: number,
    public readonly reason: EntrySizeMismatchReason,
    options?: BaseErrorOptions
  ) {
    const msg =
      reason === "too-many-bytes"
        ? `Entry "${path}" produced more bytes than declared: expected ${expected}, got at least ${actual}`
        : `Entry "${path}" produced fewer bytes than declared: expected ${expected}, got ${actual}`;
    super(msg, options);
  }

  /**
   * Check if this error indicates a potential ZIP bomb (too many bytes).
   */
  isZipBomb(): boolean {
    return this.reason === "too-many-bytes";
  }

  /**
   * Check if this error indicates data corruption (too few bytes).
   */
  isCorruption(): boolean {
    return this.reason === "too-few-bytes";
  }
}

// -----------------------------------------------------------------------------
// Encryption Errors
// -----------------------------------------------------------------------------

/**
 * Error thrown when decryption fails (wrong password or corrupted data).
 */
export class DecryptionError extends ArchiveError {
  override name = "DecryptionError";

  constructor(path: string, details?: string, options?: BaseErrorOptions) {
    super(
      details
        ? `Failed to decrypt "${path}": ${details}`
        : `Failed to decrypt "${path}": incorrect password or corrupted data`,
      options
    );
  }
}

/**
 * Error thrown when a password is required but not provided.
 */
export class PasswordRequiredError extends ArchiveError {
  override name = "PasswordRequiredError";

  constructor(path: string, options?: BaseErrorOptions) {
    super(`File "${path}" is encrypted. Please provide a password to extract.`, options);
  }
}

// -----------------------------------------------------------------------------
// HTTP / Network Errors
// -----------------------------------------------------------------------------

/**
 * Error thrown when the server doesn't support Range requests.
 */
export class RangeNotSupportedError extends ArchiveError {
  override name = "RangeNotSupportedError";

  constructor(url: string, options?: BaseErrorOptions) {
    super(`Server does not support Range requests for: ${url}`, options);
  }
}

/**
 * Error thrown when an HTTP request fails.
 */
export class HttpRangeError extends ArchiveError {
  override name = "HttpRangeError";

  constructor(
    public readonly url: string,
    public readonly status: number,
    public readonly statusText: string,
    options?: BaseErrorOptions
  ) {
    super(`HTTP ${status} ${statusText} for: ${url}`, options);
  }
}

// -----------------------------------------------------------------------------
// ZIP64 / Size Errors
// -----------------------------------------------------------------------------

/**
 * Error thrown when a file is too large for in-memory extraction.
 */
export class FileTooLargeError extends ArchiveError {
  override name = "FileTooLargeError";

  constructor(path: string, reason: string, options?: BaseErrorOptions) {
    super(`File "${path}" is too large to extract into memory (${reason})`, options);
  }
}

// -----------------------------------------------------------------------------
// Unsupported Feature Errors
// -----------------------------------------------------------------------------

/**
 * Error thrown when an unsupported compression method is encountered.
 */
export class UnsupportedCompressionError extends ArchiveError {
  override name = "UnsupportedCompressionError";

  constructor(method: number, options?: BaseErrorOptions) {
    super(`Unsupported compression method: ${method}`, options);
  }
}
