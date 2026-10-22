/**
 * Stream kernel - Node.js-compatible error codes
 *
 * Errors carry the same `code` values as Node.js so that callers can branch on
 * `err.code` identically in both environments.
 */

import { createAbortError } from "@utils/errors";

export { createAbortError };

type CodedError = Error & { code: string };

function coded(code: string, message: string, Ctor: ErrorConstructor = Error): CodedError {
  const err = new Ctor(message) as CodedError;
  err.code = code;
  return err;
}

/** `util.inspect` for the primitives Node's messages print: strings quoted, the rest as is. */
function inspectPrimitive(value: unknown): string {
  if (typeof value !== "string") {
    return typeof value === "bigint" ? `${value}n` : String(value);
  }
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  return `${quote}${value}${quote}`;
}

/** Node's `addNumericalSeparator`: `9007199254740992` → `9_007_199_254_740_992`. */
function addNumericalSeparator(value: string): string {
  let result = "";
  let i = value.length;
  const start = value[0] === "-" ? 1 : 0;
  for (; i >= start + 4; i -= 3) {
    result = `_${value.slice(i - 3, i)}${result}`;
  }
  return `${value.slice(0, i)}${result}`;
}

/** Node's `determineSpecificType`: how a message names the value it received. */
function determineSpecificType(value: unknown): string {
  if (value === null || value === undefined) {
    return String(value);
  }
  switch (typeof value) {
    case "bigint":
      return `type bigint (${value}n)`;
    case "number":
      return `type number (${Object.is(value, -0) ? "-0" : String(value)})`;
    case "boolean":
    case "symbol":
      return `type ${typeof value} (${String(value)})`;
    case "function":
      return `function ${value.name}`;
    case "object": {
      const ctor = (value as { constructor?: { name?: string } }).constructor;
      return ctor && "name" in ctor ? `an instance of ${ctor.name}` : "[Object: null prototype]";
    }
    default: {
      const text = String(value);
      const shown = text.length > 28 ? `${text.slice(0, 25)}...` : text;
      return shown.includes("'")
        ? `type string (${JSON.stringify(shown)})`
        : `type string ('${shown}')`;
    }
  }
}

/** Primitive names Node writes as `of type …`; anything else capitalised is a class. */
const TYPE_NAMES = [
  "string",
  "function",
  "number",
  "object",
  "Function",
  "Object",
  "boolean",
  "bigint",
  "symbol"
];
const CLASS_NAME = /^([A-Z][a-z0-9]*)+$/;

function listOf(items: string[], lead: string): string {
  if (items.length > 2) {
    const last = items.pop();
    return `${lead}${items.join(", ")}, or ${last}`;
  }
  return `${lead}${items.join(" or ")}`;
}

/**
 * Node's `ERR_INVALID_ARG_TYPE`. `expected` is what Node passes — type names,
 * class names or free text, as in `lib/internal/errors.js` — and the sentence
 * is built the same way, so the message is Node's word for word.
 */
export function errInvalidArgType(
  name: string,
  expected: string | readonly string[],
  actual: unknown
): CodedError {
  let message = name.endsWith(" argument")
    ? `The ${name} must be `
    : `The "${name}" ${name.includes(".") ? "property" : "argument"} must be `;

  const types: string[] = [];
  const instances: string[] = [];
  const other: string[] = [];
  for (const value of typeof expected === "string" ? [expected] : expected) {
    if (TYPE_NAMES.includes(value)) {
      types.push(value.toLowerCase());
    } else if (CLASS_NAME.test(value)) {
      instances.push(value);
    } else {
      other.push(value === "object" ? "Object" : value);
    }
  }
  // "object" among class names reads as "an instance of …, or Object".
  if (instances.length > 0 && types.includes("object")) {
    types.splice(types.indexOf("object"), 1);
    instances.push("Object");
  }

  if (types.length > 0) {
    message += types.length === 1 ? `of type ${types[0]}` : listOf(types, "one of type ");
    if (instances.length > 0 || other.length > 0) {
      message += " or ";
    }
  }
  if (instances.length > 0) {
    message += listOf(instances, "an instance of ");
    if (other.length > 0) {
      message += " or ";
    }
  }
  if (other.length > 0) {
    if (other.length > 1) {
      message += listOf(other, "one of ");
    } else {
      message += `${other[0].toLowerCase() !== other[0] ? "an " : ""}${other[0]}`;
    }
  }

  return coded(
    "ERR_INVALID_ARG_TYPE",
    `${message}. Received ${determineSpecificType(actual)}`,
    TypeError
  );
}

export function errInvalidArgValue(
  name: string,
  value: unknown,
  reason = "is invalid"
): CodedError {
  return coded(
    "ERR_INVALID_ARG_VALUE",
    `The argument '${name}' ${reason}. Received ${String(value)}`,
    TypeError
  );
}

export function errInvalidReturnValue(expected: string, name: string, value: unknown): CodedError {
  return coded(
    "ERR_INVALID_RETURN_VALUE",
    `Expected ${expected} to be returned from the "${name}" function but got ${typeof value}.`,
    TypeError
  );
}

export function errMethodNotImplemented(method: string): CodedError {
  return coded("ERR_METHOD_NOT_IMPLEMENTED", `The ${method} method is not implemented`);
}

export function errMissingArgs(name: string): CodedError {
  return coded("ERR_MISSING_ARGS", `The "${name}" argument must be specified`, TypeError);
}

export function errMultipleCallback(): CodedError {
  return coded("ERR_MULTIPLE_CALLBACK", "Callback called multiple times");
}

export function errOutOfRange(name: string, range: string, value: unknown): CodedError {
  const received =
    Number.isInteger(value) && Math.abs(value as number) > 2 ** 32
      ? addNumericalSeparator(String(value))
      : inspectPrimitive(value);
  return coded(
    "ERR_OUT_OF_RANGE",
    `The value of "${name}" is out of range. It must be ${range}. Received ${received}`,
    RangeError
  );
}

/** Node's `validateObject` (`lib/internal/validators.js`) without its options: a plain, non-null, non-array object. */
export function validateObject(value: unknown, name: string): asserts value is object {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw errInvalidArgType(name, "Object", value);
  }
}

/** Node's `validateInteger` (`lib/internal/validators.js`). */
export function validateInteger(
  value: unknown,
  name: string,
  min = Number.MIN_SAFE_INTEGER,
  max = Number.MAX_SAFE_INTEGER
): asserts value is number {
  if (typeof value !== "number") {
    throw errInvalidArgType(name, "number", value);
  }
  if (!Number.isInteger(value)) {
    throw errOutOfRange(name, "an integer", value);
  }
  if (value < min || value > max) {
    throw errOutOfRange(name, `>= ${min} && <= ${max}`, value);
  }
}

export function errStreamAlreadyFinished(method: string): CodedError {
  return coded("ERR_STREAM_ALREADY_FINISHED", `Cannot call ${method} after a stream was finished`);
}

export function errStreamCannotPipe(): CodedError {
  return coded("ERR_STREAM_CANNOT_PIPE", "Cannot pipe, not readable");
}

export function errStreamDestroyed(method: string): CodedError {
  return coded("ERR_STREAM_DESTROYED", `Cannot call ${method} after a stream was destroyed`);
}

export function errStreamNullValues(): CodedError {
  return coded("ERR_STREAM_NULL_VALUES", "May not write null values to stream", TypeError);
}

export function errStreamPrematureClose(): CodedError {
  return coded("ERR_STREAM_PREMATURE_CLOSE", "Premature close");
}

export function errStreamPushAfterEof(): CodedError {
  return coded("ERR_STREAM_PUSH_AFTER_EOF", "stream.push() after EOF");
}

export function errStreamUnableToPipe(): CodedError {
  return coded("ERR_STREAM_UNABLE_TO_PIPE", "Cannot pipe to a closed or destroyed stream");
}

export function errStreamUnshiftAfterEndEvent(): CodedError {
  return coded("ERR_STREAM_UNSHIFT_AFTER_END_EVENT", "stream.unshift() after end event");
}

export function errStreamWriteAfterEnd(): CodedError {
  return coded("ERR_STREAM_WRITE_AFTER_END", "write after end");
}

export function errUnknownEncoding(encoding: unknown): CodedError {
  return coded("ERR_UNKNOWN_ENCODING", `Unknown encoding: ${String(encoding)}`, TypeError);
}

/**
 * Combine two errors the way Node.js does when a second failure happens while
 * handling the first: the outer error wins, the inner one is kept alongside.
 */
export function aggregateTwoErrors(
  inner: Error | null | undefined,
  outer: Error | null | undefined
): Error | null | undefined {
  if (inner && outer && inner !== outer) {
    const errors = (outer as { errors?: Error[] }).errors;
    if (Array.isArray(errors)) {
      errors.push(inner);
      return outer;
    }
    const err = new AggregateError([outer, inner], outer.message) as AggregateError & {
      code?: string;
    };
    err.code = (outer as { code?: string }).code;
    return err;
  }
  return inner || outer;
}
