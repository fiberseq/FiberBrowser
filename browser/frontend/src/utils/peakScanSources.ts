/**
 * Peak-rule sources the server scans from reads, and the source name it
 * expects. Built-in sources go as they are; an interval layer (a custom MA
 * type such as ctcf, ddda_mcg or tf_cr) goes as 'layer:<name>'. Peak rules
 * store a layer by its bare key (the Peak Detection source list and saved
 * presets do), so a bare key that isn't another kind of source is a layer.
 */
export const BUILTIN_SCAN_SOURCES = new Set([
  'accessibility', 'fire', 'tf_density', 'msp', 'tf_layer', 'nuc_layer', 'm6a', 'm5c', 'deam',
]);

/** Sources handled in the browser, not by a server read scan. */
const CLIENT_SOURCES = new Set(['custom', 'matched', 'fire_signal']);
const LAYER_NAME = /^[A-Za-z0-9_]+$/;

/** The server scan source for a peak rule's source, or null when the browser handles it (tracks, annotations, profiles, drawn peaks). */
export function serverScanSource(source: string): string | null {
  if (BUILTIN_SCAN_SOURCES.has(source)) return source;
  if (source.startsWith('layer:')) return LAYER_NAME.test(source.slice(6)) ? source : null;
  if (CLIENT_SOURCES.has(source) || !LAYER_NAME.test(source)) return null;
  return `layer:${source}`;
}
