/**
 * DOCX module error types.
 *
 * All DOCX-related errors extend DocxError.
 */

import type { BaseErrorOptions } from "@utils/errors";
import { BaseError } from "@utils/errors";

/**
 * Base class for all DOCX-related errors.
 */
export class DocxError extends BaseError {
  constructor(message: string, options?: BaseErrorOptions) {
    super(message, options);
    this.name = "DocxError";
  }
}

/**
 * Check if an error is a DOCX error.
 */
export function isDocxError(err: unknown): err is DocxError {
  return err instanceof DocxError;
}

/**
 * Error thrown when DOCX parsing fails.
 */
export class DocxParseError extends DocxError {
  override name = "DocxParseError";
}

/**
 * Error thrown when DOCX generation/writing fails.
 */
export class DocxWriteError extends DocxError {
  override name = "DocxWriteError";
}

/**
 * Error thrown when a required DOCX part is missing.
 */
export class DocxMissingPartError extends DocxParseError {
  override name = "DocxMissingPartError";

  constructor(partPath: string) {
    super(`Required DOCX part not found: ${partPath}`);
  }
}

/**
 * Error thrown when document structure is invalid.
 */
export class DocxInvalidStructureError extends DocxParseError {
  override name = "DocxInvalidStructureError";
}

/**
 * Error thrown when an unsupported feature is encountered during parsing.
 */
export class DocxUnsupportedFeatureError extends DocxError {
  override name = "DocxUnsupportedFeatureError";

  constructor(feature: string) {
    super(`Unsupported DOCX feature: ${feature}`);
  }
}

/**
 * Error thrown when a DOCX file is encrypted (CFB format) and no password
 * was provided. Pass `{ password }` in the second argument of `Io.read()`
 * to decrypt automatically, or call `decryptDocx()` from `documonster/word/crypto`
 * directly if you need lower-level access to the decrypted ZIP bytes.
 */
export class DocxEncryptedError extends DocxError {
  override name = "DocxEncryptedError";

  constructor() {
    super(
      "The document is encrypted (password-protected). " +
        'Pass { password } to readDocx(), or use decryptDocx() from "documonster/word/crypto" ' +
        "for lower-level decryption."
    );
  }
}

/**
 * Error thrown when an encrypted DOCX cannot be decrypted with the provided
 * password (wrong password) or when the encryption metadata is malformed.
 */
export class DocxDecryptionError extends DocxError {
  override name = "DocxDecryptionError";
}

/**
 * Error thrown when an input package exceeds a declared resource limit (e.g.
 * total package size, single part size, number of parts). Used to defend
 * against ZIP bombs and runaway memory usage.
 */
export class DocxLimitExceededError extends DocxParseError {
  override name = "DocxLimitExceededError";
  /** Limit category that was exceeded. */
  readonly limit: "packageSize" | "partSize" | "partCount";
  /** Configured maximum. */
  readonly maximum: number;
  /** Actual measured value (or the value that would have been reached). */
  readonly actual: number;

  constructor(
    limit: "packageSize" | "partSize" | "partCount",
    maximum: number,
    actual: number,
    detail?: string
  ) {
    super(
      `DOCX ${limit} limit exceeded: actual ${actual} > maximum ${maximum}` +
        (detail ? ` (${detail})` : "")
    );
    this.limit = limit;
    this.maximum = maximum;
    this.actual = actual;
  }
}

/**
 * Error thrown when the active `WordSecurityPolicy.rawXmlPolicy` is `"reject"`
 * and the writer encounters opaque/preserved rawXml that would otherwise have
 * been emitted verbatim. Callers can either drop the offending model field
 * before serialisation or relax the policy to `"strip"` / `"preserve"`.
 */
export class DocxRawXmlPolicyError extends DocxWriteError {
  override name = "DocxRawXmlPolicyError";
  /** Short label identifying the offending writer site. */
  readonly site: string;

  constructor(site: string) {
    super(
      `Raw XML rejected by security policy at "${site}". ` +
        "Either remove the rawXml/opaque field from the model or set " +
        "WordSecurityPolicy.rawXmlPolicy to 'preserve' or 'strip'."
    );
    this.site = site;
  }
}

/** Error thrown when template processing fails. */
export class TemplateError extends DocxError {
  override readonly name = "TemplateError";
  /** The placeholder that caused the error. */
  readonly placeholder: string;
  /** Location hint (e.g. "body paragraph 3", "header"). */
  readonly location: string;
  /** The tag name/expression that caused the error. */
  readonly tagName?: string;
  /** The paragraph index within the current block where the error occurred. */
  readonly paragraphIndex?: number;
  /** The section path (e.g. "body", "header:default", "footer:first"). */
  readonly sectionPath?: string;

  constructor(
    message: string,
    placeholder: string,
    location: string,
    options?: BaseErrorOptions & {
      tagName?: string;
      paragraphIndex?: number;
      sectionPath?: string;
    }
  ) {
    super(message, options);
    this.placeholder = placeholder;
    this.location = location;
    this.tagName = options?.tagName;
    this.paragraphIndex = options?.paragraphIndex;
    this.sectionPath = options?.sectionPath;
  }
}
