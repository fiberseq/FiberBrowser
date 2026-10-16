import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { pickAnyFile, pickFile } from '../../api/files';
import { loadGtf } from '../../api/reference';
import type { DatasetGenomeCheck, GenomeSuggestion } from '../../api/genomeCheck';
import { useReferenceFastaLoader } from '../../hooks/useReferenceFastaLoader';
import { useBrowserStore } from '../../stores/browserStore';
import { problemKey, useGenomeCheckStore, visibleProblems } from '../../stores/genomeCheckStore';
import { usePanelGenomeStore } from '../../stores/panelGenomeStore';
import { isSandboxPage } from '../../utils/sandbox';
import { useLaunchUiStore } from '../../utils/launchSession';
import { isPlasmidMapPath, loadPlasmidFiles, PLASMID_MAP_EXTS } from '../../utils/plasmidLoader';
import { loadRegistryGenome } from '../../utils/registryGenomeLoad';
import { AlertTriangle, ChevronDown, FolderOpen, Globe, LayoutColumns, X } from '../ui/Icons';

const SHOWN = 3;
const noop = () => {};

/**
 * Keyboard use of a dropdown menu: it opens with focus on its first item;
 * arrow keys (Home/End) move between items, Escape or Tab closes it (focus
 * back on its button). The keys stay in the menu (the browser's own shortcuts
 * don't pan or zoom the view meanwhile).
 */
function useMenuKeys(open: boolean, close: () => void, menuRef: RefObject<HTMLDivElement>) {
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menu"] [role="menuitem"]:not([disabled])')?.focus();
  }, [open, menuRef]);
  return (e: KeyboardEvent) => {
    if (!open) {
      if (e.key === 'ArrowDown' && (e.target as HTMLElement).getAttribute('aria-haspopup') === 'menu') {
        e.preventDefault();
        e.stopPropagation();
        (e.target as HTMLElement).click();
      }
      return;
    }
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]:not([disabled])') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const focus = (i: number) => items[(i + items.length) % items.length]?.focus();
    const trigger = () => menuRef.current?.querySelector<HTMLElement>('[aria-haspopup="menu"]');
    if (e.key === 'ArrowDown') focus(at + 1);
    else if (e.key === 'ArrowUp') focus(at < 0 ? items.length - 1 : at - 1);
    else if (e.key === 'Home') focus(0);
    else if (e.key === 'End') focus(items.length - 1);
    else if (e.key === 'Escape') { close(); trigger()?.focus(); }
    else if (e.key === 'Tab') { close(); return; }
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
}

/**
 * Re-checks the datasets against the loaded genome whenever either side can
 * have changed: datasets added or removed, a genome, FASTA, annotation or
 * plasmid map loaded (every loader bumps refreshGeneration or the chromosome list).
 */
export function useGenomeCheckWatcher(): void {
  const { datasetKey, currentGenome, hasFasta, fastaPath, chromKey, refreshGeneration } = useBrowserStore(useShallow(s => ({
    datasetKey: s.datasets.map(d => d.id).join('\n'),
    currentGenome: s.currentGenome,
    hasFasta: s.hasFasta,
    fastaPath: s.fastaPath,
    chromKey: `${s.chroms.length}:${s.chroms.slice(0, 3).map(c => `${c.name}=${c.size}`).join(',')}:${s.chroms.filter(c => c.plasmid).map(c => c.name).join(',')}`,
    refreshGeneration: s.refreshGeneration,
  })));
  const refresh = useGenomeCheckStore(s => s.refresh);
  useEffect(() => {
    // No datasets: nothing can mismatch (and an old answer must not linger).
    if (!datasetKey) useGenomeCheckStore.setState({ check: null });
    else void refresh();
  }, [datasetKey, currentGenome, hasFasta, fastaPath, chromKey, refreshGeneration, refresh]);
}

const ACTION = 'inline-flex shrink-0 items-center gap-1 whitespace-nowrap px-[9px] py-[3px] rounded-fb border text-xs font-medium disabled:opacity-50';
const PRIMARY = `${ACTION} border-transparent bg-rose-600 hover:bg-rose-700 dark:bg-rose-700 dark:hover:bg-rose-600 text-white`;
const SECONDARY = `${ACTION} bg-white/80 dark:bg-gray-800 border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700`;
const DISMISS = `${ACTION} border-transparent bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-600 dark:text-gray-300`;

interface ActionsProps {
  suggestion: GenomeSuggestion | null;
  onDismiss?: () => void;
  /** The dataset the genome is for: its reads are shown once the genome loads. */
  datasetId?: string;
  /** The datasets that don't fit (they can each get their own reference): default [datasetId]. */
  datasetIds?: string[];
  /** Only the suggested genome (a panel's notice; the banner has the file loaders too). */
  primaryOnly?: boolean;
  /**
   * A panel's notice when other datasets share its wrong genome: besides opening them all with the
   * suggested one, open only this dataset (its id).
   */
  onlyThis?: string;
  /** Where it shows (tests and the tour tell the banner from a track's notice). */
  testIdPrefix?: string;
}

/**
 * What the user can do about a mismatch, in this order: load the suggested
 * online genome (when the file's assembly is plain), their own FASTA, gene
 * annotation or plasmid map (the app's own loaders), or dismiss. A public
 * server or a tour tab only reports.
 */
export function GenomeMismatchActions({ suggestion, onDismiss, datasetId, datasetIds, primaryOnly = false, onlyThis, testIdPrefix = 'genome-mismatch' }: ActionsProps) {
  const publicMode = useBrowserStore(s => s.publicMode);
  const datasets = useBrowserStore(s => s.datasets);
  const [oneMenu, setOneMenu] = useState(false);
  const oneMenuRef = useRef<HTMLDivElement>(null);
  const loadingGenome = useGenomeCheckStore(s => s.loadingGenome);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ownMenu, setOwnMenu] = useState(false);
  const ownMenuRef = useRef<HTMLDivElement>(null);
  const targets = datasetIds?.length ? datasetIds : (datasetId ? [datasetId] : []);
  // A reference of its own (another panel genome): local work, never a public server or a tour tab.
  const canOwn = !publicMode && !isSandboxPage() && targets.length > 0;
  useEffect(() => {
    if (!ownMenu) return;
    const close = (e: MouseEvent) => { if (!ownMenuRef.current?.contains(e.target as Node)) setOwnMenu(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [ownMenu]);
  useEffect(() => {
    if (!oneMenu) return;
    const close = (e: MouseEvent) => { if (!oneMenuRef.current?.contains(e.target as Node)) setOneMenu(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [oneMenu]);

  const afterLoad = useCallback(() => {
    useBrowserStore.getState().triggerRefresh();
    void useGenomeCheckStore.getState().refresh();
  }, []);
  // The sidebar's FASTA loader: pick, load, show the new reference. The
  // annotation stays to the server: it keeps one that fits the new reference
  // (e.g. from Load GTF… just before) and drops one of another assembly.
  const fasta = useReferenceFastaLoader(null, noop);
  useEffect(() => { if (fasta.fastaError) setError(fasta.fastaError); }, [fasta.fastaError]);

  const run = async (what: string, action: () => Promise<string | null | undefined>) => {
    setBusy(what);
    setError(null);
    try {
      const failure = await action();
      if (failure) setError(failure);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      afterLoad();
    }
  };

  // The dataset(s) keep their own reference and panel; the main genome stays.
  // One dataset among other panels: each panel navigates from then on (fb-r3-nav);
  // several together form their reference's link group.
  const attachOwn = (what: string, request: Omit<Parameters<ReturnType<typeof usePanelGenomeStore.getState>['attach']>[0], 'dataset_ids'>,
    ids: string[] = targets) =>
    run(what, async () => {
      const res = await usePanelGenomeStore.getState().attach({ dataset_ids: ids, ...request }, { perPanel: ids.length === 1 });
      return res.success ? null : (res.error || 'Could not load that reference');
    });
  const openOwnPanel = () => (suggestion ? attachOwn('own', { genome_id: suggestion.genome_id }) : undefined);
  const openOneOwnPanel = (id: string) => {
    setOneMenu(false);
    return suggestion ? attachOwn(`own:${id}`, { genome_id: suggestion.genome_id }, [id]) : undefined;
  };
  const labelOf = (id: string) => datasets.find(d => d.id === id)?.label ?? id;
  const oneMenuKeys = useMenuKeys(oneMenu, () => setOneMenu(false), oneMenuRef);
  const ownMenuKeys = useMenuKeys(ownMenu, () => setOwnMenu(false), ownMenuRef);
  const ownFasta = (withAnnotation: boolean) => {
    setOwnMenu(false);
    return run('own-fasta', async () => {
      const fastaPick = await pickFile('fasta');
      if (!fastaPick.success || !fastaPick.path) return null;
      let gtfPath: string | undefined;
      if (withAnnotation) {
        const gtfPick = await pickFile('gtf');
        if (gtfPick.success && gtfPick.path) gtfPath = gtfPick.path;
      }
      const res = await usePanelGenomeStore.getState().attach({ dataset_ids: targets, fasta_path: fastaPick.path, gtf_path: gtfPath },
        { perPanel: targets.length === 1 });
      return res.success ? null : (res.error || 'Could not load that FASTA');
    });
  };
  const ownContigs = () => {
    setOwnMenu(false);
    return attachOwn('own-contigs', { contigs: true });
  };

  const loadSuggested = () => run('genome', async () => {
    if (!suggestion) return null;
    const res = await loadRegistryGenome(suggestion.genome_id, { goToDatasetId: datasetId });
    return res.success ? null : res.error;
  });
  const loadAnnotation = () => run('gtf', async () => {
    const picked = await pickFile('gtf');
    if (!picked.success || !picked.path) return null;
    const res = await loadGtf(picked.path);
    return res.success ? null : (res.message || 'Failed to load the annotation');
  });
  const loadPlasmidMap = () => run('plasmid', async () => {
    const picked = await pickAnyFile();
    if (!picked.success) return null;
    const paths = picked.paths?.length ? picked.paths : (picked.path ? [picked.path] : []);
    const maps = paths.filter(isPlasmidMapPath);
    if (maps.length === 0) {
      return paths.length ? `Choose a plasmid map (${PLASMID_MAP_EXTS.slice(0, 5).map(e => `.${e}`).join(', ')}, …)` : null;
    }
    // Loaded maps are matched to the BAM's contigs by sequence (plasmid_reconcile).
    const res = await loadPlasmidFiles(maps);
    if (!res.success) return res.error || 'Failed to load the plasmid map';
    return res.failed > 0 ? `${res.failed} could not be loaded: ${res.error}` : null;
  });

  const anyBusy = busy !== null || loadingGenome !== null || fasta.fastaLoading;
  const canLoadFiles = !publicMode && !(primaryOnly && suggestion?.can_load);
  const genomeBusy = loadingGenome !== null && loadingGenome === suggestion?.genome_id;
  const offerOwnPanel = canOwn && !!suggestion?.can_load;
  const many = targets.length > 1;
  // With "Open … in its own panel" offered, the loaders that replace the genome fold into one menu.
  const foldFiles = offerOwnPanel && canLoadFiles && !primaryOnly;
  const fileActions = [
    { id: 'load-fasta', label: fasta.fastaLoading ? 'Loading FASTA…' : 'Load FASTA…', title: 'Load the reference FASTA the file was aligned to (needs its .fai index)',
      onClick: () => { setOwnMenu(false); setError(null); void fasta.handleLoadFasta().then(afterLoad); } },
    { id: 'load-gtf', label: busy === 'gtf' ? 'Loading annotation…' : 'Load GTF…', title: 'Load gene annotation (GTF/GFF/BED) for that reference',
      onClick: () => { setOwnMenu(false); void loadAnnotation(); } },
    { id: 'load-plasmid', label: busy === 'plasmid' ? 'Loading plasmid map…' : 'Load plasmid map…',
      title: "Load a plasmid map (SnapGene .dna, GenBank, EMBL); the BAM's contig is matched to it by sequence, whatever its name",
      onClick: () => { setOwnMenu(false); void loadPlasmidMap(); } },
  ];
  const fileButtons = (
    <>
      {fileActions.map(action => (
        <button key={action.id} type="button" onClick={action.onClick} disabled={anyBusy} className={SECONDARY}
          data-testid={`${testIdPrefix}-${action.id}`} title={action.title}>
          <FolderOpen size={12} />{action.label}
        </button>
      ))}
    </>
  );
  const fileMenuItems = fileActions.map(action => (
    <button key={action.id} type="button" role="menuitem" className="fb-menu-item" onClick={action.onClick}
      disabled={anyBusy} data-testid={`${testIdPrefix}-${action.id}`} title={action.title}>
      <FolderOpen size={14} />{action.label}
    </button>
  ));
  const loadingText = suggestion ? (suggestion.cached ? `Loading ${suggestion.genome_id}…` : `Downloading ${suggestion.genome_id}…`) : '';
  const download = suggestion?.cached ? '' : ' (downloaded once to ~/.fiberhmm/genomes)';
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid={`${testIdPrefix}-actions`}>
      {offerOwnPanel && suggestion && (
        <button
          type="button"
          onClick={() => { void openOwnPanel(); }}
          disabled={anyBusy}
          className={PRIMARY}
          data-testid={`${testIdPrefix}-own-genome`}
          title={many
            ? `Keep the current genome for the other panels and give these ${targets.length} datasets ${suggestion.name}${download}. `
              + `With Linked navigation they move together (one ${suggestion.genome_id} locus); Per panel lets each move on its own.`
            : `Keep the current genome for the other panels and give this dataset ${suggestion.name}: its panel navigates on ${suggestion.genome_id}'s chromosomes, sequence and genes${download}. `
              + 'Navigation switches to Per panel when other panels are open.'}
        >
          <LayoutColumns size={12} />
          {busy === 'own'
            ? loadingText
            : many
              ? `Open all ${targets.length} ${suggestion.genome_id} datasets with ${suggestion.genome_id}`
              : `Open with ${suggestion.genome_id} in its own panel`}
        </button>
      )}
      {offerOwnPanel && suggestion && many && onlyThis && targets.includes(onlyThis) && (
        <button type="button" onClick={() => { void openOneOwnPanel(onlyThis); }} disabled={anyBusy} className={SECONDARY}
          data-testid={`${testIdPrefix}-own-genome-one`}
          title={`Give only this dataset ${suggestion.genome_id}, in its own panel (navigation switches to Per panel)`}>
          {busy === `own:${onlyThis}` ? loadingText : 'Only this one'}
        </button>
      )}
      {offerOwnPanel && suggestion && many && !onlyThis && !primaryOnly && (
        <div className="relative" ref={oneMenuRef} onKeyDown={oneMenuKeys}>
          <button type="button" onClick={() => setOneMenu(open => !open)} disabled={anyBusy} className={SECONDARY}
            aria-haspopup="menu" aria-expanded={oneMenu} data-testid={`${testIdPrefix}-own-genome-one`}
            title={`Give one dataset ${suggestion.genome_id} in its own panel (navigation switches to Per panel)`}>
            {busy?.startsWith('own:') ? loadingText : 'One dataset'}<ChevronDown size={12} />
          </button>
          {oneMenu && (
            <div role="menu" className="fb-menu" data-testid={`${testIdPrefix}-own-genome-one-menu`}>
              {targets.map(id => (
                <button key={id} type="button" role="menuitem" className="fb-menu-item" onClick={() => { void openOneOwnPanel(id); }}
                  data-testid={`${testIdPrefix}-own-genome-one-${id}`}>
                  <LayoutColumns size={14} />{`Open ${labelOf(id)} with ${suggestion.genome_id}`}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {suggestion?.can_load && !publicMode && (
        <button
          type="button"
          onClick={() => { void loadSuggested(); }}
          disabled={anyBusy}
          className={offerOwnPanel ? SECONDARY : PRIMARY}
          data-testid={`${testIdPrefix}-load-genome`}
          title={(offerOwnPanel ? `Switch every panel to ${suggestion.genome_id} (replaces the genome loaded now). ` : '') + (suggestion.cached
            ? `Load ${suggestion.name} from the downloaded copy`
            : `Download ${suggestion.name} (sequence and gene annotation, once; later loads use the copy in ~/.fiberhmm/genomes)`)}
        >
          <Globe size={12} />
          {genomeBusy
            ? (suggestion.cached ? `Loading ${suggestion.genome_id}…` : `Downloading ${suggestion.genome_id}…`)
            : (offerOwnPanel ? `Switch to ${suggestion.genome_id}` : `Load ${suggestion.genome_id}`)}
        </button>
      )}
      {canLoadFiles && !foldFiles && fileButtons}
      {(foldFiles || (canOwn && !primaryOnly)) && (
        <div className="relative" ref={ownMenuRef} onKeyDown={ownMenuKeys}>
          <button type="button" onClick={() => setOwnMenu(open => !open)} disabled={anyBusy} className={SECONDARY}
            aria-haspopup="menu" aria-expanded={ownMenu} data-testid={`${testIdPrefix}-own-reference`}
            title={foldFiles
              ? 'Another reference: for this dataset only (its own panel), or for every panel'
              : `A reference for ${many ? 'these datasets' : 'this dataset'} only, in ${many ? 'their own panels' : 'its own panel'} (the other panels keep the genome loaded now)`}>
            {busy === 'own-fasta' || busy === 'own-contigs' ? 'Loading…' : (foldFiles ? 'Other reference' : 'Own reference')}<ChevronDown size={12} />
          </button>
          {ownMenu && (
            <div role="menu" className="fb-menu" data-testid={`${testIdPrefix}-own-reference-menu`}>
              {canOwn && (
                <>
                  <div className="px-3 pb-0.5 pt-1 text-[11px] font-semibold text-gray-500 dark:text-gray-400">
                    {many ? 'These datasets, in their own panels' : 'This dataset, in its own panel'}
                  </div>
                  <button type="button" role="menuitem" className="fb-menu-item" onClick={() => { void ownFasta(false); }}
                    data-testid={`${testIdPrefix}-own-fasta`}>
                    <FolderOpen size={14} />FASTA…
                  </button>
                  <button type="button" role="menuitem" className="fb-menu-item" onClick={() => { void ownFasta(true); }}
                    data-testid={`${testIdPrefix}-own-fasta-gtf`}>
                    <FolderOpen size={14} />FASTA and annotation…
                  </button>
                  {!many && (
                    <button type="button" role="menuitem" className="fb-menu-item items-start" onClick={() => { void ownContigs(); }}
                      data-testid={`${testIdPrefix}-own-contigs`}>
                      <LayoutColumns size={14} className="mt-0.5" />
                      <span className="flex flex-col">
                        <span>No reference</span>
                        <span className="text-[11px] text-gray-500 dark:text-gray-400">The file&apos;s own contigs (a plasmid or amplicon); its FASTA when the header names one here</span>
                      </span>
                    </button>
                  )}
                </>
              )}
              {foldFiles && (
                <>
                  {canOwn && <div className="fb-menu-sep" />}
                  <div className="px-3 pb-0.5 pt-1 text-[11px] font-semibold text-gray-500 dark:text-gray-400">Every panel (replaces the genome)</div>
                  {fileMenuItems}
                </>
              )}
            </div>
          )}
        </div>
      )}
      {onDismiss && (
        <button type="button" onClick={onDismiss} className={DISMISS} data-testid={`${testIdPrefix}-dismiss`}>
          <X size={12} />Dismiss
        </button>
      )}
      {error && <span className="basis-full text-[11px] text-rose-700 dark:text-rose-300" role="alert">{error}</span>}
    </div>
  );
}

/**
 * The datasets "Open with … in its own panel" gives the suggested genome:
 * those it was suggested for (or every one that doesn't fit when there is no
 * suggestion). Only datasets that can't be shown (errors), not partial fits.
 */
export function ownReferenceTargets(problems: DatasetGenomeCheck[], suggestion: GenomeSuggestion | null): string[] {
  const errors = problems.filter(p => p.severity === 'error');
  const pool = errors.length > 0 ? errors : problems;
  const matching = suggestion ? pool.filter(p => p.suggestion?.genome_id === suggestion.genome_id) : [];
  return (matching.length > 0 ? matching : pool).map(p => p.dataset_id);
}

/** The suggestion the actions offer: the problems' own if they agree, else the overall one. */
function sharedSuggestion(problems: DatasetGenomeCheck[], overall: GenomeSuggestion | null): GenomeSuggestion | null {
  const ids = new Set(problems.map(p => p.suggestion?.genome_id).filter(Boolean));
  if (ids.size === 1) return problems.find(p => p.suggestion)?.suggestion ?? null;
  return ids.size === 0 ? null : overall;
}

/**
 * A prominent, non-blocking banner when a loaded dataset doesn't fit the
 * loaded genome ("napa_ddda.bam was aligned to hg38, but dm6 is loaded").
 * It clears by itself once the right reference is loaded.
 */
export function GenomeMismatchBanner() {
  useGenomeCheckWatcher();
  const { check, dismissed, dismiss } = useGenomeCheckStore(useShallow(s => ({ check: s.check, dismissed: s.dismissed, dismiss: s.dismiss })));
  const problems = useMemo(() => visibleProblems(check, dismissed), [check, dismissed]);
  // A session being reopened is half-restored (its genome may not be back
  // yet): no mismatch, and no buttons that would fight the restore.
  const restoring = useLaunchUiStore(s => s.restoring);
  if (restoring || !check || problems.length === 0) return null;

  const error = problems.some(p => p.severity === 'error');
  const suggestion = sharedSuggestion(problems, check.suggestion);
  const unlisted = problems.find(p => p.known_not_in_registry && !p.suggestion);
  const tone = error
    ? 'bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-800 text-rose-900 dark:text-rose-100'
    : 'bg-amber-50 dark:bg-amber-900/30 border-amber-200 dark:border-amber-700 text-amber-900 dark:text-amber-100';
  const more = problems.length > SHOWN
    ? `…and ${problems.length - SHOWN} more dataset${problems.length - SHOWN === 1 ? '' : 's'}.`
    : null;
  const note = unlisted
    ? `${unlisted.assembly.short ?? unlisted.assembly.name} isn’t one of the online genomes: load its FASTA (and annotation).`
    : null;
  const fullText = [...problems.slice(0, SHOWN).map(p => p.message), more, note].filter(Boolean).join(' ');
  // Icon, title and the message (up to two lines, then an ellipsis; the whole
  // text on hover); the actions sit at the right and wrap below, never over it.
  return (
    <div
      role="alert"
      className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-3 py-1.5 text-[12px] ${tone}`}
      data-testid="genome-mismatch-banner"
      data-severity={error ? 'error' : 'warning'}
    >
      <div className="flex min-w-0 flex-[1_1_320px] items-center gap-2" title={fullText}>
        <AlertTriangle size={16} className="flex-shrink-0" aria-hidden="true" />
        <span className="flex-shrink-0 whitespace-nowrap font-semibold">
          {error ? 'Genome mismatch' : 'Contigs missing from the reference'}
        </span>
        <span className="min-w-0 flex-1 line-clamp-2 break-words" data-testid="genome-mismatch-text">
          {problems.slice(0, SHOWN).map((p, i) => (
            <span key={p.dataset_id} data-testid="genome-mismatch-message">{i > 0 ? ' ' : ''}{p.message}</span>
          ))}
          {more && <span className="opacity-80"> {more}</span>}
          {note && <span className="opacity-80"> {note}</span>}
        </span>
      </div>
      <div className="ml-auto flex min-w-0 justify-end">
      <GenomeMismatchActions suggestion={suggestion}
        datasetId={(problems.find(p => p.suggestion?.genome_id && p.suggestion.genome_id === suggestion?.genome_id) ?? problems[0])?.dataset_id}
        datasetIds={ownReferenceTargets(problems, suggestion)}
        onDismiss={() => dismiss(problems.map(problemKey))} />
      </div>
    </div>
  );
}

/**
 * Inside a read track with no reads in view: the mismatch (and what to load)
 * instead of "go to this dataset's reads", which would only jump to the reads
 * on the wrong reference.
 */
export function GenomeMismatchNotice({ problem }: { problem: DatasetGenomeCheck }) {
  // Other open datasets on the same wrong genome: open them all with it (one linked group), or only this one.
  const siblings = useGenomeCheckStore(useShallow(s => sameSuggestionTargets(visibleProblems(s.check, s.dismissed), problem)));
  // Not while a session is being reopened (as the banner above).
  const restoring = useLaunchUiStore(s => s.restoring);
  if (restoring) return null;
  return (
    <div className="max-w-md space-y-1.5" data-testid={`genome-mismatch-notice-${problem.dataset_id}`}>
      <div className="text-[12px] font-medium text-rose-700 dark:text-rose-300">Wrong reference for this dataset</div>
      <div className="text-[11px] text-gray-600 dark:text-gray-300">{problem.message}</div>
      <GenomeMismatchActions suggestion={problem.suggestion} datasetId={problem.dataset_id} primaryOnly
        datasetIds={siblings.length > 1 ? siblings : undefined} onlyThis={siblings.length > 1 ? problem.dataset_id : undefined}
        testIdPrefix={`genome-mismatch-notice-${problem.dataset_id}`} />
    </div>
  );
}

/**
 * The datasets that can't be shown and have the same suggested genome as this
 * one (this one first), e.g. every dm6 dataset beside the hg38 demo.
 */
export function sameSuggestionTargets(problems: DatasetGenomeCheck[], problem: DatasetGenomeCheck): string[] {
  const genome = problem.suggestion?.genome_id;
  if (!genome || problem.severity !== 'error') return [problem.dataset_id];
  const others = problems.filter(p => p.dataset_id !== problem.dataset_id && p.severity === 'error' && p.suggestion?.genome_id === genome);
  return [problem.dataset_id, ...others.map(p => p.dataset_id)];
}
