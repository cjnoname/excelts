const textEncoder = typeof global.TextEncoder === "undefined" ? null : new global.TextEncoder();

function stringToBuffer(str: string | Buffer<ArrayBuffer>): Buffer<ArrayBuffer> {
  if (typeof str !== "string") {
    return str;
  }
  if (textEncoder) {
    return Buffer.from(textEncoder.encode(str).buffer);
  }
  return Buffer.from(str);
}

export { stringToBuffer };
