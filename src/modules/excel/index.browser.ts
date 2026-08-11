/**
 * documonster/excel — browser entry.
 *
 * Same surface as the Node entry via the shared base (domain namespaces, public
 * types and errors), but the two platform-specific namespaces resolve to their
 * browser variants: `Workbook` (cross-platform IO only, no Node file-path
 * operations) and `Stream`. `scripts/verify-public-types.ts` keeps the two
 * entries' exported names identical.
 */
export * from "@excel/index.base";

export * as Workbook from "@excel/surface/workbook.browser";
export * as Stream from "@excel/surface/stream.browser";
