/**
 * TAR Format Constants
 *
 * TAR (Tape Archive) is a simple archival format where files are stored
 * sequentially with 512-byte headers. This module supports:
 * - POSIX ustar format (most common)
 * - GNU tar extensions (long filenames)
 * - PAX extended headers
 */

// TAR block size is always 512 bytes
export const TAR_BLOCK_SIZE = 512;

// Magic values
export const USTAR_MAGIC = "ustar\0"; // POSIX ustar
export const USTAR_VERSION = "00";

// File type flags (single character)
export const TAR_TYPE = {
  FILE: "0", // Regular file (also '\0' for old tar)
  FILE_OLD: "\0", // Regular file (old format)
  HARD_LINK: "1", // Hard link
  SYMLINK: "2", // Symbolic link
  CHAR_DEVICE: "3", // Character special device
  BLOCK_DEVICE: "4", // Block special device
  DIRECTORY: "5", // Directory
  FIFO: "6", // FIFO special file
  CONTIGUOUS: "7", // Contiguous file
  // Extended types
  GNU_LONG_NAME: "L", // GNU long filename
  GNU_LONG_LINK: "K", // GNU long linkname
  PAX_GLOBAL: "g", // PAX global extended header
  PAX_EXTENDED: "x" // PAX extended header for next file
} as const;

export type TarType = (typeof TAR_TYPE)[keyof typeof TAR_TYPE];

// Header field offsets and sizes (POSIX ustar format)
export const TAR_HEADER = {
  name: { offset: 0, size: 100 }, // File name
  mode: { offset: 100, size: 8 }, // File mode (octal)
  uid: { offset: 108, size: 8 }, // User ID (octal)
  gid: { offset: 116, size: 8 }, // Group ID (octal)
  size: { offset: 124, size: 12 }, // File size (octal)
  mtime: { offset: 136, size: 12 }, // Modification time (octal, seconds since epoch)
  checksum: { offset: 148, size: 8 }, // Header checksum
  type: { offset: 156, size: 1 }, // File type
  linkname: { offset: 157, size: 100 }, // Name of linked file
  magic: { offset: 257, size: 6 }, // USTAR magic
  version: { offset: 263, size: 2 }, // USTAR version
  uname: { offset: 265, size: 32 }, // User name
  gname: { offset: 297, size: 32 }, // Group name
  devmajor: { offset: 329, size: 8 }, // Device major number (octal)
  devminor: { offset: 337, size: 8 }, // Device minor number (octal)
  prefix: { offset: 345, size: 155 } // Filename prefix (for long names)
} as const;

// Default values
export const DEFAULT_TAR_MODE = 0o644; // rw-r--r--
export const DEFAULT_TAR_DIR_MODE = 0o755; // rwxr-xr-x
export const DEFAULT_TAR_UID = 0;
export const DEFAULT_TAR_GID = 0;
export const DEFAULT_TAR_UNAME = "";
export const DEFAULT_TAR_GNAME = "";
