/**
 * How to cite FiberBrowser (one text for About, the More menu's "How to cite" and exported figures). The full metadata
 * is the repository's CITATION.cff (GitHub's "Cite this repository"); the desktop About box says the same
 * (fiberbrowser/desktop.py citation_text).
 */
import { version } from '../../package.json';

export const FIBERBROWSER_VERSION: string = version;
export const FIBERBROWSER_URL = 'github.com/fiberseq/FiberBrowser';
export const FIBERHMM_URL = 'github.com/fiberseq/FiberHMM';
export const PREPRINT_DOI_URL = 'https://doi.org/10.64898/2026.10.29.762797';
export const PREPRINT_REFERENCE = 'Tullius, T. W., Catalano, C., Ranchalis, J., Hu, J., Vollger, M. R., Stergachis, A. B., & Levine, M. S. (2026). FiberBrowser: a unified framework for single-molecule genomics. bioRxiv.';
export const PREPRINT_BIBTEX = `@article{tullius2026fiberbrowser,
  title   = {{FiberBrowser}: a unified framework for single-molecule genomics},
  author  = {Tullius, Thomas W. and Catalano, Christopher and Ranchalis, Jane and
             Hu, Jie and Vollger, Mitchell R. and Stergachis, Andrew B. and
             Levine, Michael S.},
  journal = {bioRxiv},
  year    = {2026},
  doi     = {10.64898/2026.10.29.762797}
}`;

/** The citation, as the About box gives it. */
export function citationText(v: string = FIBERBROWSER_VERSION): string {
  return `How to cite: ${PREPRINT_REFERENCE} ${PREPRINT_DOI_URL}\nFiberBrowser version used: ${v}.`;
}

/** The short line at the foot of an exported figure (Export figure: "Citation line"). */
export function figureCitationLine(v: string = FIBERBROWSER_VERSION): string {
  return `Made with FiberBrowser ${v} · please cite Tullius et al., bioRxiv 2026 (doi:10.64898/2026.10.29.762797)`;
}

const FIGURE_CITATION_KEY = 'fiberbrowser_figure_citation';

/** Whether exported figures carry the citation line (default on; turned off, remembered in this browser). */
export function loadFigureCitation(): boolean {
  try { return localStorage.getItem(FIGURE_CITATION_KEY) !== '0'; } catch { return true; }
}

export function saveFigureCitation(on: boolean): void {
  try { localStorage.setItem(FIGURE_CITATION_KEY, on ? '1' : '0'); } catch { /* private mode */ }
}
