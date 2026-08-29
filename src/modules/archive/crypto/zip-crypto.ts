/**
 * Traditional PKWARE ZIP encryption (ZipCrypto).
 *
 * This implements the "traditional ZIP encryption" algorithm as specified
 * in the PKWARE APPNOTE.TXT (section 6.1.5 "Traditional PKWARE Encryption").
 *
 * WARNING: ZipCrypto is cryptographically weak and should only be used
 * for backward compatibility. Use AES encryption for new archives.
 *
 * References:
 * - PKWARE APPNOTE.TXT 6.1.5 - Traditional Encryption
 * - https://www.forensicfocus.com/stable/wp-content/uploads/2009/04/zip_encryption.pdf
 */

import { crc32UpdateByte } from "@archive/compression/crc32.base";
import { stringToUint8Array as encodeUtf8 } from "@utils/binary";

/**
 * ZipCrypto encryption header size.
 * The first 12 bytes of encrypted data are the encryption header.
 */
export const ZIP_CRYPTO_HEADER_SIZE = 12;

/**
 * Internal state for ZipCrypto cipher.
 * Uses three 32-bit keys updated with each byte processed.
 */
export interface ZipCryptoState {
  key0: number;
  key1: number;
  key2: number;
}

/**
 * Initialize ZipCrypto state with a password.
 */
export function zipCryptoInitKeys(password: string | Uint8Array): ZipCryptoState {
  const state: ZipCryptoState = {
    key0: 0x12345678,
    key1: 0x23456789,
    key2: 0x34567890
  };

  const bytes = typeof password === "string" ? encodeUtf8(password) : password;

  for (let i = 0; i < bytes.length; i++) {
    zipCryptoUpdateKeys(state, bytes[i]!);
  }

  return state;
}

/**
 * Update the cipher state with a single byte.
 */
export function zipCryptoUpdateKeys(state: ZipCryptoState, byte: number): void {
  state.key0 = crc32UpdateByte(state.key0, byte);
  state.key1 = (state.key1 + (state.key0 & 0xff)) >>> 0;
  state.key1 = ((Math.imul(state.key1, 134775813) >>> 0) + 1) >>> 0;
  state.key2 = crc32UpdateByte(state.key2, (state.key1 >>> 24) & 0xff);
}

/**
 * Get the next stream byte for encryption/decryption.
 */
export function zipCryptoGetStreamByte(state: ZipCryptoState): number {
  const temp = (state.key2 | 2) >>> 0;
  return (Math.imul(temp, temp ^ 1) >>> 8) & 0xff;
}

/**
 * Decrypt a single byte and update state.
 */
export function zipCryptoDecryptByte(state: ZipCryptoState, cipher: number): number {
  const plain = (cipher ^ zipCryptoGetStreamByte(state)) & 0xff;
  zipCryptoUpdateKeys(state, plain);
  return plain;
}

/**
 * Encrypt a single byte and update state.
 */
export function zipCryptoEncryptByte(state: ZipCryptoState, plain: number): number {
  const cipher = (plain ^ zipCryptoGetStreamByte(state)) & 0xff;
  zipCryptoUpdateKeys(state, plain);
  return cipher;
}

/**
 * Decrypt the encryption header and verify.
 *
 * @param state - Initialized cipher state
 * @param header - 12-byte encryption header from encrypted data
 * @param crc32 - Expected CRC32 of the uncompressed data (for verification)
 * @param lastModTime - Last modified time field (alternative verification)
 * @returns true if header passes verification
 */
export function zipCryptoDecryptHeader(
  state: ZipCryptoState,
  header: Uint8Array,
  crc32: number,
  lastModTime?: number
): boolean {
  if (header.length !== ZIP_CRYPTO_HEADER_SIZE) {
    return false;
  }

  // Decrypt all 12 header bytes
  const decrypted = new Uint8Array(ZIP_CRYPTO_HEADER_SIZE);
  for (let i = 0; i < ZIP_CRYPTO_HEADER_SIZE; i++) {
    decrypted[i] = zipCryptoDecryptByte(state, header[i]!);
  }

  // The last byte should match either:
  // 1. The high byte of CRC32 (modern approach)
  // 2. The high byte of the last modified time (older approach, for data descriptor)
  const checkByte = decrypted[11]!;
  const crcHighByte = (crc32 >>> 24) & 0xff;

  return (
    checkByte === crcHighByte ||
    (lastModTime !== undefined && checkByte === ((lastModTime >>> 8) & 0xff))
  );
}

/**
 * Generate an encryption header for writing.
 *
 * @param state - Initialized cipher state
 * @param crc32 - CRC32 of the uncompressed data
 * @param getRandomBytes - Function to generate random bytes
 * @returns 12-byte encrypted header
 */
export function zipCryptoCreateHeader(
  state: ZipCryptoState,
  crc32: number,
  getRandomBytes: (length: number) => Uint8Array
): Uint8Array {
  const header = new Uint8Array(ZIP_CRYPTO_HEADER_SIZE);

  // First 11 bytes are random
  const random = getRandomBytes(11);
  for (let i = 0; i < 11; i++) {
    header[i] = zipCryptoEncryptByte(state, random[i]!);
  }

  // Last byte is high byte of CRC32 for verification
  const checkByte = (crc32 >>> 24) & 0xff;
  header[11] = zipCryptoEncryptByte(state, checkByte);

  return header;
}

/**
 * High-level decryption interface for ZipCrypto.
 *
 * @param encryptedData - Full encrypted data including 12-byte header
 * @param password - Password string or bytes
 * @param crc32 - Expected CRC32 for header verification
 * @param lastModTime - Optional last modified time for alternative verification
 * @returns Decrypted data (excluding header) or null if verification fails
 */
export function zipCryptoDecrypt(
  encryptedData: Uint8Array,
  password: string | Uint8Array,
  crc32: number,
  lastModTime?: number
): Uint8Array | null {
  if (encryptedData.length < ZIP_CRYPTO_HEADER_SIZE) {
    return null;
  }

  const state = zipCryptoInitKeys(password);

  // Decrypt and verify header
  const header = encryptedData.subarray(0, ZIP_CRYPTO_HEADER_SIZE);
  if (!zipCryptoDecryptHeader(state, header, crc32, lastModTime)) {
    return null;
  }

  // Decrypt remaining data directly
  const payloadLen = encryptedData.length - ZIP_CRYPTO_HEADER_SIZE;
  const output = new Uint8Array(payloadLen);
  for (let i = 0; i < payloadLen; i++) {
    output[i] = zipCryptoDecryptByte(state, encryptedData[ZIP_CRYPTO_HEADER_SIZE + i]!);
  }
  return output;
}

/**
 * High-level encryption interface for ZipCrypto.
 *
 * @param data - Plain data to encrypt
 * @param password - Password string or bytes
 * @param crc32 - CRC32 of the data
 * @param getRandomBytes - Function to generate random bytes
 * @returns Encrypted data including 12-byte header
 */
export function zipCryptoEncrypt(
  data: Uint8Array,
  password: string | Uint8Array,
  crc32: number,
  getRandomBytes: (length: number) => Uint8Array
): Uint8Array {
  const state = zipCryptoInitKeys(password);

  // Allocate output buffer once
  const output = new Uint8Array(ZIP_CRYPTO_HEADER_SIZE + data.length);

  // Create and encrypt header directly into output
  const random = getRandomBytes(11);
  for (let i = 0; i < 11; i++) {
    output[i] = zipCryptoEncryptByte(state, random[i]!);
  }
  output[11] = zipCryptoEncryptByte(state, (crc32 >>> 24) & 0xff);

  // Encrypt data directly into output
  for (let i = 0; i < data.length; i++) {
    output[ZIP_CRYPTO_HEADER_SIZE + i] = zipCryptoEncryptByte(state, data[i]!);
  }

  return output;
}

/**
 * Check if a password is valid for ZipCrypto-encrypted data without full decryption.
 * This only verifies the encryption header check byte.
 *
 * @param encryptedData - Full encrypted data including 12-byte header
 * @param password - Password string or bytes
 * @param crc32 - Expected CRC32 for header verification
 * @param lastModTime - Optional last modified time for alternative verification
 * @returns true if password verification passes, false otherwise
 */
export function zipCryptoCheckPassword(
  encryptedData: Uint8Array,
  password: string | Uint8Array,
  crc32: number,
  lastModTime?: number
): boolean {
  if (encryptedData.length < ZIP_CRYPTO_HEADER_SIZE) {
    return false;
  }

  const state = zipCryptoInitKeys(password);
  const header = encryptedData.subarray(0, ZIP_CRYPTO_HEADER_SIZE);
  return zipCryptoDecryptHeader(state, header, crc32, lastModTime);
}
