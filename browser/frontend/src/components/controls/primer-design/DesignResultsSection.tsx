import type { Dispatch, SetStateAction } from 'react';
import type { DafcPrimerQuad, PrimerPair, SavedPrimer } from '../../../types';
import { Refresh } from '../../ui/Icons';
import { AnalysisButton } from '../shared';
import { Check } from '../../ui/Icons';

interface DesignResultsSectionProps {
  dafcQuads: DafcPrimerQuad[];
  designResults: PrimerPair[];
  activePair: PrimerPair | null;
  savedPrimerCount: number;
  resultNames: Record<number, string>;
  setResultNames: Dispatch<SetStateAction<Record<number, string>>>;
  addedIndices: Set<number>;
  designDuplicates: Record<number, SavedPrimer>;
  onAddDafcQuadToOrder: (quad: DafcPrimerQuad, index: number) => void;
  onHighlightPair: (pair: PrimerPair) => void;
  onAddToOrder: (pair: PrimerPair, index: number) => void;
  onRedesignDafc: () => void;
  onRedesignPrimers: () => void;
  onClearPrimers: () => void;
  designing: boolean;
}

export function DesignResultsSection({
  dafcQuads,
  designResults,
  activePair,
  savedPrimerCount,
  resultNames,
  setResultNames,
  addedIndices,
  designDuplicates,
  onAddDafcQuadToOrder,
  onHighlightPair,
  onAddToOrder,
  onRedesignDafc,
  onRedesignPrimers,
  onClearPrimers,
  designing,
}: DesignResultsSectionProps) {
  return (
    <>
      {dafcQuads.length > 0 && (
        <div className="space-y-1">
          <div className="font-medium text-gray-700 dark:text-gray-300">
            {dafcQuads.length} compatible quad{dafcQuads.length !== 1 ? 's' : ''} found
          </div>
          <div className="divide-y divide-gray-100 dark:divide-white/5">
            {dafcQuads.map((quad, i) => (
              <div key={i} className="py-1.5 px-1 rounded hover:bg-gray-50 dark:hover:bg-gray-800/30 space-y-1">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-gray-400 font-mono w-4">#{i + 1}</span>
                  <span className="text-[11px] text-gray-500">Max dTm {quad.max_tm_range}C across all 4 primers</span>
                  <span className="flex-1" />
                  <input
                    type="text"
                    className="input-tool w-24 text-[11px]"
                    placeholder={`3C_${Math.floor(savedPrimerCount / 2) + 1}`}
                    value={resultNames[i] || ''}
                    onChange={e => setResultNames(prev => ({ ...prev, [i]: e.target.value }))}
                    onClick={e => e.stopPropagation()}
                  />
                  <AnalysisButton
                    onClick={() => onAddDafcQuadToOrder(quad, i)}
                    theme="cyan"
                    variant={addedIndices.has(i) ? 'success' : 'soft'}
                    className="px-1.5"
                  >
                    {addedIndices.has(i) ? <span className="inline-flex items-center gap-0.5"><Check size={10} strokeWidth={2.5} aria-hidden="true" />Added</span> : '+ Order'}
                  </AnalysisButton>
                </div>
                <div className="pl-5 border-l-2 border-blue-300 dark:border-blue-700">
                  <div className="text-[11px] text-blue-600 dark:text-blue-400 font-medium">Locus X - {quad.x_pair.product_size.toLocaleString()}bp</div>
                  <div className="grid grid-cols-2 gap-x-3 text-[11px] font-mono">
                    <div><span className="text-green-600">F:</span> {quad.x_pair.fwd_seq} <span className="text-gray-400">Tm {quad.x_pair.fwd_tm}</span></div>
                    <div><span className="text-red-500">R:</span> {quad.x_pair.rev_seq} <span className="text-gray-400">Tm {quad.x_pair.rev_tm}</span></div>
                  </div>
                </div>
                <div className="pl-5 border-l-2 border-amber-300 dark:border-amber-700">
                  <div className="text-[11px] text-amber-600 dark:text-amber-400 font-medium">Locus Y - {quad.y_pair.product_size.toLocaleString()}bp</div>
                  <div className="grid grid-cols-2 gap-x-3 text-[11px] font-mono">
                    <div><span className="text-green-600">F:</span> {quad.y_pair.fwd_seq} <span className="text-gray-400">Tm {quad.y_pair.fwd_tm}</span></div>
                    <div><span className="text-red-500">R:</span> {quad.y_pair.rev_seq} <span className="text-gray-400">Tm {quad.y_pair.rev_tm}</span></div>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="flex gap-2 pt-1">
            <AnalysisButton onClick={onRedesignDafc} disabled={designing} theme="cyan" variant="soft" className="flex items-center gap-0.5">
              <Refresh size={10} /> Redesign
            </AnalysisButton>
            <AnalysisButton onClick={onClearPrimers} variant="outline">Clear results</AnalysisButton>
          </div>
        </div>
      )}

      {designResults.length > 0 && (
        <div className="space-y-1">
          <div className="font-medium text-gray-700 dark:text-gray-300">
            {designResults.length} primer pair{designResults.length !== 1 ? 's' : ''} found
          </div>
          <div className="divide-y divide-gray-100 dark:divide-white/5">
            {designResults.map((pair, i) => {
              const isActive = activePair === pair || (activePair && activePair.fwd_seq === pair.fwd_seq && activePair.rev_seq === pair.rev_seq);
              const gap = (pair.fwd_distance || 0) + (pair.rev_distance || 0);
              return (
                <div
                  key={i}
                  className={`py-1.5 px-1 rounded cursor-pointer transition-colors ${isActive ? 'bg-rose-50 dark:bg-rose-900/20 ring-1 ring-rose-300 dark:ring-rose-700' : 'hover:bg-gray-50 dark:hover:bg-gray-800/30'}`}
                  onClick={() => onHighlightPair(pair)}
                >
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-gray-400 font-mono w-4">#{i + 1}</span>
                    <span className="text-[11px] text-gray-500">{pair.product_size.toLocaleString()}bp | gap {gap}bp | dTm {pair.tm_diff}C{pair.fwd_blast_hits != null && pair.rev_blast_hits != null ? ` | BLAST ${pair.fwd_blast_hits}/${pair.rev_blast_hits}` : ''}</span>
                    {designDuplicates[i] && (
                      <span
                        className="px-1 py-0 rounded text-[11px] bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
                        title={`Matches "${designDuplicates[i].name}" already in cart (from ${designDuplicates[i].source ?? 'design'}${designDuplicates[i].loadedFromFile ? `: ${designDuplicates[i].loadedFromFile}` : ''})`}
                      >
                        In cart
                      </span>
                    )}
                    <span className="flex-1" />
                    <input
                      type="text"
                      className="input-tool w-24 text-[11px]"
                      placeholder={`Primer_${savedPrimerCount + 1}`}
                      value={resultNames[i] || ''}
                      onChange={e => setResultNames(prev => ({ ...prev, [i]: e.target.value }))}
                      onClick={e => e.stopPropagation()}
                    />
                    <AnalysisButton
                      onClick={e => { e.stopPropagation(); onAddToOrder(pair, i); }}
                      disabled={!!designDuplicates[i]}
                      theme="rose"
                      variant={designDuplicates[i] ? 'neutral' : addedIndices.has(i) ? 'success' : 'soft'}
                      className="px-1.5"
                      title={designDuplicates[i] ? 'Already in cart - skip to avoid re-ordering' : 'Add to order list'}
                    >
                      {designDuplicates[i] ? 'In cart' : addedIndices.has(i) ? <span className="inline-flex items-center gap-0.5"><Check size={10} strokeWidth={2.5} aria-hidden="true" />Added</span> : '+ Order'}
                    </AnalysisButton>
                  </div>
                  <div className="grid grid-cols-2 gap-x-3 text-[11px] font-mono">
                    <div><span className="text-green-600">F:</span> {pair.fwd_seq} <span className="text-gray-400">Tm {pair.fwd_tm}C</span></div>
                    <div><span className="text-red-500">R:</span> {pair.rev_seq} <span className="text-gray-400">Tm {pair.rev_tm}C</span></div>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="flex gap-2 pt-1">
            <AnalysisButton onClick={onRedesignPrimers} disabled={designing} theme="rose" variant="soft" className="flex items-center gap-0.5">
              <Refresh size={10} /> Redesign
            </AnalysisButton>
            <AnalysisButton onClick={onClearPrimers} variant="outline">Clear results</AnalysisButton>
          </div>
        </div>
      )}
    </>
  );
}
