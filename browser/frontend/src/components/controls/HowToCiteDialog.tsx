/** "How to cite" (the toolbar's More menu): FiberBrowser and FiberHMM, as the About box and CITATION.cff say. */
import { useEffect, useState } from 'react';
import { X } from '../ui/Icons';
import { citationText, FIBERBROWSER_VERSION, PREPRINT_BIBTEX, PREPRINT_DOI_URL, PREPRINT_REFERENCE } from '../../utils/citation';

export function HowToCiteDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const [bibtexCopied, setBibtexCopied] = useState(false);
  useEffect(() => {
    if (!open) return;
    setCopied(false);
    setBibtexCopied(false);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);
  if (!open) return null;
  const text = citationText();
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      <div role="dialog" aria-modal="true" aria-labelledby="how-to-cite-title" data-testid="how-to-cite-dialog"
        className="relative mx-4 max-h-[calc(100vh-2rem)] w-full max-w-md overflow-y-auto rounded-lg bg-white shadow-xl dark:bg-gray-800" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-white/10">
          <h2 id="how-to-cite-title" className="text-sm font-semibold text-gray-700 dark:text-gray-200">How to cite</h2>
          <button type="button" onClick={onClose} className="fb-icon-btn h-6 w-6" aria-label="Close"><X size={14} /></button>
        </div>
        <div className="space-y-2 px-4 py-3 text-[13px] text-gray-600 dark:text-gray-300">
          <p>If you use FiberBrowser or FiberHMM, which calls the chromatin footprints FiberBrowser shows, please cite our preprint:</p>
          <p>{PREPRINT_REFERENCE}{' '}
            <a className="break-words text-brand-700 underline dark:text-brand-300" href={PREPRINT_DOI_URL} target="_blank" rel="noreferrer">{PREPRINT_DOI_URL}</a>
          </p>
          <div className="flex items-center justify-between">
            <span className="font-medium">BibTeX</span>
            <button type="button" className="fb-btn" data-testid="how-to-cite-copy-bibtex"
              onClick={() => { void navigator.clipboard?.writeText(PREPRINT_BIBTEX).then(() => setBibtexCopied(true), () => setBibtexCopied(false)); }}>
              {bibtexCopied ? 'Copied' : 'Copy BibTeX'}
            </button>
          </div>
          <pre className="overflow-x-auto rounded bg-gray-50 p-2 text-[11px] dark:bg-white/5"><code>{PREPRINT_BIBTEX}</code></pre>
          <p>Please also give the FiberBrowser version you used: {FIBERBROWSER_VERSION}.</p>
          <p className="text-[11px] text-gray-400 dark:text-gray-500">Exported figures carry a one-line citation (Export figure: “Citation line”).</p>
        </div>
        <div className="flex justify-end border-t border-gray-200 px-4 py-2 dark:border-white/10">
          <button type="button" className="fb-btn" data-testid="how-to-cite-copy"
            onClick={() => { void navigator.clipboard?.writeText(text).then(() => setCopied(true), () => setCopied(false)); }}>
            {copied ? 'Copied' : 'Copy citation'}
          </button>
        </div>
      </div>
    </div>
  );
}
