/**
 * documonster/excel — Node entry.
 *
 * Re-exports the platform-independent base (domain namespaces, public types and
 * errors) and adds the Node variants of the two platform-specific namespaces:
 * `Workbook` (file-path IO) and `Stream`. The platform-specific streaming types
 * ride along on the `Stream` namespace, so both entries expose the same names.
 */
export * from "@excel/index.base";

export * as Workbook from "@excel/surface/workbook";
export * as Stream from "@excel/surface/stream";
