import { useState } from 'react';
import { useGenomeCheckStore } from '../../../../stores/genomeCheckStore';
import { resetRegistryAnnotation } from '../../../../utils/annotationReset';

/**
 * Beside "Gene annotation loaded": reset it to the reference's own registry annotation ("Reset to dm6 genes"), or
 * load that one when none is loaded. Said plainly when the loaded genes are not on the reference's contigs.
 */
export function AnnotationResetAction({ testIdPrefix = 'annotation-reset' }: { testIdPrefix?: string }) {
  const annotation = useGenomeCheckStore(s => s.check?.annotation);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = annotation?.target;
  if (!annotation || !target || !annotation.can_reset || annotation.current) return null;
  const mismatch = annotation.loaded && annotation.fits === false;
  const label = busy
    ? (target.cached ? `Loading ${target.genome_id} genes…` : `Downloading ${target.genome_id} genes…`)
    : annotation.loaded ? `Reset to ${target.genome_id} genes` : `Load ${target.genome_id} genes`;
  const onClick = async () => {
    setBusy(true);
    setError(null);
    const res = await resetRegistryAnnotation(target.genome_id);
    setBusy(false);
    if (!res.success) setError(res.error ?? null);
  };
  return (
    <div className="space-y-0.5 pl-2.5" data-testid={testIdPrefix}>
      {mismatch && (
        <div className="text-[11px] text-amber-700 dark:text-amber-300" data-testid={`${testIdPrefix}-mismatch`}>
          {annotation.genome_id ? `These are ${annotation.genome_id} genes` : 'These genes are'} not on {target.genome_id}&apos;s contigs.
        </div>
      )}
      <button
        type="button"
        onClick={() => { void onClick(); }}
        disabled={busy}
        className={`rounded px-1.5 py-0.5 text-[11px] font-medium disabled:opacity-50 ${mismatch
          ? 'bg-amber-100 text-amber-900 hover:bg-amber-200 dark:bg-amber-900/40 dark:text-amber-100 dark:hover:bg-amber-900/60'
          : 'text-blue-700 hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-blue-900/30'}`}
        title={`Replace the loaded annotation with ${target.name}'s${target.gtf_label ? ` (${target.gtf_label})` : ''}`
          + (target.cached ? ', from the downloaded copy' : ', downloaded once to ~/.fiberhmm/genomes') + '. The FASTA stays.'}
        data-testid={`${testIdPrefix}-button`}
      >
        {label}
      </button>
      {error && <div className="text-[11px] text-red-500" role="alert">{error}</div>}
    </div>
  );
}
