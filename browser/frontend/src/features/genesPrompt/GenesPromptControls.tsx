import { useBrowserStore } from '../../stores/browserStore';
import { useGenomeCheckStore } from '../../stores/genomeCheckStore';
import { isSandboxPage } from '../../utils/sandbox';
import { genesPromptFor, type GenesPrompt } from './genesPrompt';
import { useGenesLoader } from './useGenesLoader';

/** The genes prompt for the loaded reference (null: genes are loaded, or nothing can be offered here). */
export function useGenesPrompt(): GenesPrompt | null {
  const check = useGenomeCheckStore(s => s.check);
  const publicMode = useBrowserStore(s => s.publicMode);
  return genesPromptFor(check, { publicMode, sandbox: isSandboxPage() });
}

const BUTTON = 'rounded px-1.5 py-0.5 text-[11px] font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-50 dark:text-blue-300 dark:hover:bg-blue-900/30';

export function genesPromptText(prompt: GenesPrompt): { message: string; action: string; busy: string } {
  if (prompt.kind === 'download') {
    return { message: `No genes loaded for ${prompt.genomeId}`, action: `Load ${prompt.genomeId} genes`,
      busy: prompt.cached ? `Loading ${prompt.genomeId} genes…` : `Downloading ${prompt.genomeId} genes…` };
  }
  return { message: `No genes loaded for ${prompt.label}`, action: 'Load a GTF…', busy: 'Loading the annotation…' };
}

/** "No genes loaded for dm6 · Load dm6 genes", with its progress and, on failure, the error and Retry. Render it with
 *  ``key={prompt.key}``: another genome's prompt starts fresh (no earlier genome's error or progress). */
export function GenesPromptControls({ prompt, testId }: { prompt: GenesPrompt; testId: string }) {
  const { busy, error, start, upload, fileInput } = useGenesLoader(prompt);
  const text = genesPromptText(prompt);
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5" data-testid={testId} data-kind={prompt.kind}>
      <span data-testid={`${testId}-message`}>{text.message}</span>
      <span aria-hidden="true">·</span>
      {error ? (
        <>
          <span className="text-red-600 dark:text-red-400" role="alert" data-testid={`${testId}-error`}>{error}</span>
          <button type="button" className={BUTTON} disabled={busy} onClick={start} data-testid={`${testId}-retry`}>Retry</button>
        </>
      ) : (
        <button type="button" className={BUTTON} disabled={busy} onClick={start} data-testid={`${testId}-button`}
          title={prompt.kind === 'download'
            ? `${prompt.name}'s gene annotation${prompt.cached ? ', from the downloaded copy' : ', downloaded once'}. The FASTA stays.`
            : 'Upload a GTF or GFF annotation for this reference'}>
          {busy ? text.busy : text.action}
        </button>
      )}
      {prompt.kind === 'upload' && (
        <input ref={fileInput} type="file" accept=".gtf,.gff,.gff3,.gtf.gz,.gff.gz,.gff3.gz" className="hidden"
          data-testid={`${testId}-file`} onChange={e => { const files = e.target.files; void upload(files).finally(() => { e.target.value = ''; }); }} />
      )}
    </span>
  );
}
