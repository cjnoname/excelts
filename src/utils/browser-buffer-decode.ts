const textDecoder =
  typeof global.TextDecoder === "undefined" ? null : new global.TextDecoder("utf-8");

function bufferToString(chunk: Buffer<ArrayBuffer>): string {
  if (typeof chunk === "string") {
    return chunk;
  }
  if (textDecoder) {
    return textDecoder.decode(chunk);
  }
  return chunk.toString();
}

export { bufferToString };
