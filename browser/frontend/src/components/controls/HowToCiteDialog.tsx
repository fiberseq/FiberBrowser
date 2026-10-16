/** "How to cite" (the toolbar's More menu): FiberBrowser and FiberHMM, as the About box and CITATION.cff say. */
import { useEffect, useState } from 'react';
import { X } from '../ui/Icons';
import { citationText, FIBERBROWSER_URL, FIBERBROWSER_VERSION, FIBERHMM_URL } from '../../utils/citation';

export function HowToCiteDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!open) return;
    setCopied(false);
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
        className="relative mx-4 w-full max-w-md rounded-lg bg-white shadow-xl dark:bg-gray-800" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-white/10">
          <h2 id="how-to-cite-title" className="text-sm font-semibold text-gray-700 dark:text-gray-200">How to cite</h2>
          <button type="button" onClick={onClose} className="fb-icon-btn h-6 w-6" aria-label="Close"><X size={14} /></button>
        </div>
        <div className="space-y-2 px-4 py-3 text-[13px] text-gray-600 dark:text-gray-300">
          <p>If you use FiberBrowser {FIBERBROWSER_VERSION} in published work, please cite FiberBrowser and FiberHMM, which
            calls the footprints it shows.</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>FiberBrowser {FIBERBROWSER_VERSION}: <a className="text-brand-700 underline dark:text-brand-300" href={`https://${FIBERBROWSER_URL}`} target="_blank" rel="noreferrer">{FIBERBROWSER_URL}</a> (its CITATION.cff has the full reference)</li>
            <li>FiberHMM: <a className="text-brand-700 underline dark:text-brand-300" href={`https://${FIBERHMM_URL}`} target="_blank" rel="noreferrer">{FIBERHMM_URL}</a></li>
          </ul>
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
