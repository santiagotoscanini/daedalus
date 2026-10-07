/** The universe's lazy chunk: the marks and the field. Nothing outside this
 * directory imports it except by dynamic import, so the brand paths stay out
 * of the first paint. */
export { Field } from "./field";
export { Glyph } from "./glyph";
