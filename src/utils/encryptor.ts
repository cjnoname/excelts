import crypto from "crypto";

const Encryptor = {
  /**
   * Calculate a hash of the concatenated buffers with the given algorithm.
   * @param algorithm - The hash algorithm.
   * @returns The hash
   */
  hash(algorithm: string, ...buffers: Buffer[]): Buffer {
    const hash = crypto.createHash(algorithm);
    hash.update(Buffer.concat(buffers));
    return hash.digest();
  },
  /**
   * Convert a password into an encryption key
   * @param password - The password
   * @param hashAlgorithm - The hash algoritm
   * @param saltValue - The salt value
   * @param spinCount - The spin count
   * @returns The encryption key
   */
  convertPasswordToHash(
    password: string,
    hashAlgorithm: string,
    saltValue: string,
    spinCount: number
  ): string {
    hashAlgorithm = hashAlgorithm.toLowerCase();
    const hashes = crypto.getHashes();
    if (hashes.indexOf(hashAlgorithm) < 0) {
      throw new Error(`Hash algorithm '${hashAlgorithm}' not supported!`);
    }

    // Password must be in unicode buffer
    const passwordBuffer = Buffer.from(password, "utf16le");
    // Generate the initial hash
    let key = this.hash(hashAlgorithm, Buffer.from(saltValue, "base64"), passwordBuffer);
    // Now regenerate until spin count
    for (let i = 0; i < spinCount; i++) {
      const iterator = Buffer.alloc(4);
      // this is the 'special' element of Excel password hashing
      // that stops us from using crypto.pbkdf2()
      iterator.writeUInt32LE(i, 0);
      key = this.hash(hashAlgorithm, key, iterator);
    }
    return key.toString("base64");
  },
  /**
   * Generates cryptographically strong pseudo-random data.
   * @param size The size argument is a number indicating the number of bytes to generate.
   */
  randomBytes(size: number): Buffer {
    return crypto.randomBytes(size);
  }
};
export { Encryptor };
