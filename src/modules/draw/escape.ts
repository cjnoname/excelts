/**
 * XML escaping for the SVG serialiser.
 *
 * Local rather than shared with `@xml` because this module sits at Layer 1
 * alongside it and may not import sideways; the rules are three replacements
 * long, so a dependency would cost more than it saves.
 */

/** Escape text content: `&`, `<` and `>`. */
export function escapeXmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escape an attribute value: text rules plus both quote characters. */
export function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
