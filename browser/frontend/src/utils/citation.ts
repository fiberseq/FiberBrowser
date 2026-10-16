/**
 * How to cite FiberBrowser (one text for About, the More menu's "How to cite" and exported figures). The full metadata
 * is the repository's CITATION.cff (GitHub's "Cite this repository"); the desktop About box says the same
 * (fiberbrowser/desktop.py citation_text).
 */
import { version } from '../../package.json';

export const FIBERBROWSER_VERSION: string = version;
export const FIBERBROWSER_URL = 'github.com/fiberseq/FiberBrowser';
export const FIBERHMM_URL = 'github.com/fiberseq/FiberHMM';

/** The citation, as the About box gives it. */
export function citationText(v: string = FIBERBROWSER_VERSION): string {
  return `How to cite: FiberBrowser ${v} (${FIBERBROWSER_URL}; CITATION.cff) and FiberHMM (${FIBERHMM_URL}).`;
}

/** The short line at the foot of an exported figure (Export figure: "Citation line"). */
export function figureCitationLine(v: string = FIBERBROWSER_VERSION): string {
  return `Made with FiberBrowser ${v} (${FIBERBROWSER_URL}) · please cite FiberBrowser and FiberHMM`;
}

const FIGURE_CITATION_KEY = 'fiberbrowser_figure_citation';

/** Whether exported figures carry the citation line (default on; turned off, remembered in this browser). */
export function loadFigureCitation(): boolean {
  try { return localStorage.getItem(FIGURE_CITATION_KEY) !== '0'; } catch { return true; }
}

export function saveFigureCitation(on: boolean): void {
  try { localStorage.setItem(FIGURE_CITATION_KEY, on ? '1' : '0'); } catch { /* private mode */ }
}
