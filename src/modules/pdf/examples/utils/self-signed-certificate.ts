/**
 * Generate a self-signed RSA certificate — an *input* to the signing examples,
 * not part of the library.
 *
 * Signing a PDF needs a certificate and a private key, and producing those is
 * not this library's job: in production they come from a CA, a keystore, or an
 * HSM. This file exists only so `pdf-signatures.ts` can run unattended, and it
 * lives beside the examples rather than under `__tests__/` for exactly that
 * reason — an example that imports from a test directory cannot be copied, and
 * the test tree is not a contract. The signature tests reuse it because they
 * need the same input.
 *
 * The equivalent on the command line, if you would rather supply your own:
 *
 * ```sh
 * openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
 *   -subj "/CN=Example Signer" -outform DER -keyout key.der -out cert.der
 * ```
 *
 * Not bundled into any build: `tsconfig.esm.json` excludes `src/**\/examples/**`,
 * and `node:crypto` makes it Node-only regardless.
 */
import type * as cryptoType from "node:crypto";

/** A self-signed certificate and its private key, both DER-encoded. */
export interface SelfSignedCertificate {
  /** DER-encoded X.509 certificate. */
  certificate: Uint8Array;
  /** DER-encoded PKCS#8 private key. */
  privateKey: Uint8Array;
}

// ---------------------------------------------------------------------------
// Minimal ASN.1 DER helpers (self-contained, no prod imports needed)
// ---------------------------------------------------------------------------

const TAG_INTEGER = 0x02;
const TAG_BIT_STRING = 0x03;
const TAG_NULL = 0x05;
const TAG_OID = 0x06;
const TAG_SEQUENCE = 0x30;
const TAG_SET = 0x31;

function asn1EncodeLength(length: number): Uint8Array {
  if (length < 0x80) {
    return new Uint8Array([length]);
  }
  const bytes: number[] = [];
  let l = length;
  while (l > 0) {
    bytes.unshift(l & 0xff);
    l >>= 8;
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function asn1Encode(tag: number, value: Uint8Array): Uint8Array {
  const length = asn1EncodeLength(value.length);
  const result = new Uint8Array(1 + length.length + value.length);
  result[0] = tag;
  result.set(length, 1);
  result.set(value, 1 + length.length);
  return result;
}

function asn1Sequence(...children: Uint8Array[]): Uint8Array {
  let totalLen = 0;
  for (const c of children) {
    totalLen += c.length;
  }
  const body = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of children) {
    body.set(c, offset);
    offset += c.length;
  }
  return asn1Encode(TAG_SEQUENCE, body);
}

function asn1Set(...children: Uint8Array[]): Uint8Array {
  let totalLen = 0;
  for (const c of children) {
    totalLen += c.length;
  }
  const body = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of children) {
    body.set(c, offset);
    offset += c.length;
  }
  return asn1Encode(TAG_SET, body);
}

function asn1Oid(oid: string): Uint8Array {
  const parts = oid.split(".").map(Number);
  const bytes: number[] = [40 * parts[0] + parts[1]];
  for (let i = 2; i < parts.length; i++) {
    let v = parts[i];
    if (v < 128) {
      bytes.push(v);
    } else {
      const enc: number[] = [];
      enc.push(v & 0x7f);
      v >>= 7;
      while (v > 0) {
        enc.push(0x80 | (v & 0x7f));
        v >>= 7;
      }
      enc.reverse();
      bytes.push(...enc);
    }
  }
  return asn1Encode(TAG_OID, new Uint8Array(bytes));
}

function asn1Integer(value: Uint8Array): Uint8Array {
  if (value.length > 0 && value[0] & 0x80) {
    const padded = new Uint8Array(value.length + 1);
    padded.set(value, 1);
    return asn1Encode(TAG_INTEGER, padded);
  }
  return asn1Encode(TAG_INTEGER, value);
}

function asn1ContextExplicit(tagNum: number, value: Uint8Array): Uint8Array {
  return asn1Encode(0xa0 | tagNum, value);
}

function concatDer(...parts: Uint8Array[]): Uint8Array {
  let totalLen = 0;
  for (const p of parts) {
    totalLen += p.length;
  }
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const p of parts) {
    result.set(p, offset);
    offset += p.length;
  }
  return result;
}

const OID_SHA256_WITH_RSA = "1.2.840.113549.1.1.11";

/**
 * Generate a self-signed RSA certificate for development and testing.
 *
 * **Not for production use.** A fresh random RSA-2048 key pair and a minimal
 * X.509 v3 structure, valid 2025-01-01 to 2035-01-01. Nothing trusts it, so a
 * signature made with it verifies cryptographically but establishes no identity.
 *
 * @param commonName - Certificate CN field. Default: "Test"
 * @returns DER-encoded certificate and private key
 */
export async function generateSelfSignedCertificate(
  commonName?: string
): Promise<SelfSignedCertificate> {
  const nodeCrypto: typeof cryptoType = await import("node:crypto");

  const cn = commonName ?? "Test";

  const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" }
  });

  const pubKeyDer = new Uint8Array(publicKey);
  const privKeyDer = new Uint8Array(privateKey);

  // Build X.509 v3 TBSCertificate
  const sha256WithRsaAlg = asn1Sequence(
    asn1Oid(OID_SHA256_WITH_RSA),
    asn1Encode(TAG_NULL, new Uint8Array())
  );

  const versionExplicit = asn1ContextExplicit(0, asn1Integer(new Uint8Array([2]))); // v3
  const serial = asn1Integer(new Uint8Array([1]));

  // CN=<commonName>
  const cnUtf8 = asn1Encode(0x0c, new TextEncoder().encode(cn)); // UTF8String
  const cnAttr = asn1Sequence(asn1Oid("2.5.4.3"), cnUtf8); // OID for CN
  const rdnSet = asn1Set(cnAttr);
  const name = asn1Sequence(rdnSet);

  // Validity: 2025-01-01 to 2035-01-01 (UTCTime)
  const notBefore = asn1Encode(0x17, new TextEncoder().encode("250101000000Z"));
  const notAfter = asn1Encode(0x17, new TextEncoder().encode("350101000000Z"));
  const validity = asn1Sequence(notBefore, notAfter);

  const tbsContent = concatDer(
    versionExplicit,
    serial,
    sha256WithRsaAlg,
    name, // issuer
    validity,
    name, // subject (same as issuer for self-signed)
    pubKeyDer // SubjectPublicKeyInfo
  );
  const tbs = asn1Encode(TAG_SEQUENCE, tbsContent);

  // Sign TBS with RSA-SHA256
  const key = nodeCrypto.createPrivateKey({
    key: Buffer.from(privKeyDer),
    format: "der",
    type: "pkcs8"
  });
  const signer = nodeCrypto.createSign("SHA256");
  signer.update(tbs);
  const sig = signer.sign(key);

  // BIT STRING wrapping of signature (prepend 0x00 for unused bits)
  const sigBits = new Uint8Array(sig.length + 1);
  sigBits[0] = 0;
  sigBits.set(sig, 1);
  const sigBitString = asn1Encode(TAG_BIT_STRING, sigBits);

  // Certificate = SEQUENCE { TBS, AlgorithmIdentifier, Signature }
  const certDer = asn1Encode(TAG_SEQUENCE, concatDer(tbs, sha256WithRsaAlg, sigBitString));

  return { certificate: certDer, privateKey: privKeyDer };
}
