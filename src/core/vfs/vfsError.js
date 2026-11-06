/**
 * @file A single, consistent error type for the entire Virtual File
 * System. Every VFS operation that fails throws one of these instead
 * of a generic Error, so callers (Explorer, Terminal, and anything
 * else built on top later) can branch on `error.code` instead of
 * parsing message strings.
 */

/** @typedef {"NOT_READY"|"NOT_FOUND"|"ALREADY_EXISTS"|"INVALID_PATH"|"INVALID_NAME"|"NOT_A_FOLDER"|"NOT_A_FILE"|"READ_ONLY"|"PROTECTED"|"CIRCULAR_REFERENCE"|"BINARY_CONTENT"|"NO_CONTENT"|"INVALID_CONTENT"} VFSErrorCode */

class VFSError extends Error {
  /**
   * @param {VFSErrorCode} code
   * @param {string} message - Human-readable, descriptive explanation.
   */
  constructor(code, message) {
    super(message);
    this.name = "VFSError";
    this.code = code;
  }
}

export { VFSError };
