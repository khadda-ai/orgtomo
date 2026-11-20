// Thin wrapper around the vendored `yaml` bundle (ISC, see engine/vendor/yaml.LICENSE).
import Y from '../vendor/yaml.mjs';

/** @param {string} text */
export const parse = (text) => Y.parse(text);
/** @param {unknown} value */
export const stringify = (value) => Y.stringify(value, { lineWidth: 0 });
/** Parse keeping comments so a single value can be changed without losing them. */
export const parseDocument = (text) => Y.parseDocument(text);
