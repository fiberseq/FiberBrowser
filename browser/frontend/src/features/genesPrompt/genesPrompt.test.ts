import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GenomeCheckResponse } from '../../api/genomeCheck';
import { dismissGenesNotice, genesNoticeDismissed, genesPromptFor, mainGenesTrackShown } from './genesPrompt';
import { genesPromptText } from './GenesPromptControls';

const local = { publicMode: false, sandbox: false };

function check(kind: string, annotation: Partial<NonNullable<GenomeCheckResponse['annotation']>> | null): GenomeCheckResponse {
  return {
    reference: { kind, label: kind === 'fasta' ? 'my_genome' : 'dm6', assembly: kind === 'fasta' ? null : 'dm6' },
    annotation: annotation === null ? undefined : { loaded: false, gene_count: 0, genome_id: null, fits: null, target: null,
      current: false, can_reset: false, ...annotation },
  } as unknown as GenomeCheckResponse;
}

const DM6 = { genome_id: 'dm6', name: 'D. melanogaster (dm6)', gtf_label: 'Ensembl', cached: false };

describe('genes prompt', () => {
  afterEach(() => { vi.restoreAllMocks(); try { localStorage.clear(); } catch { /* none */ } });

  it('offers the catalog annotation when none is loaded and the loader may run', () => {
    const p = genesPromptFor(check('registry', { target: DM6, can_reset: true }), local);
    expect(p).toMatchObject({ kind: 'download', genomeId: 'dm6', key: 'genome:dm6' });
    expect(genesPromptText(p!)).toMatchObject({ message: 'No genes loaded for dm6', action: 'Load dm6 genes',
      busy: 'Downloading dm6 genes…' });
    expect(genesPromptText({ ...(p as any), cached: true }).busy).toBe('Loading dm6 genes…');
  });

  it('says nothing once genes are loaded, or where the catalog download is not allowed (public, tour)', () => {
    expect(genesPromptFor(check('registry', { target: DM6, can_reset: true, loaded: true, gene_count: 9 }), local)).toBeNull();
    expect(genesPromptFor(check('registry', { target: DM6, can_reset: false }), local)).toBeNull();
    expect(genesPromptFor(check('none', null), local)).toBeNull();
    expect(genesPromptFor(null, local)).toBeNull();
  });

  it('a local FASTA without a known annotation offers "Load a GTF…", never on a public server or in a tour tab', () => {
    const p = genesPromptFor(check('fasta', {}), local);
    expect(p).toMatchObject({ kind: 'upload', label: 'my_genome' });
    expect(genesPromptText(p!).action).toBe('Load a GTF…');
    expect(genesPromptFor(check('fasta', {}), { publicMode: true, sandbox: false })).toBeNull();
    expect(genesPromptFor(check('fasta', {}), { publicMode: false, sandbox: true })).toBeNull();
    expect(genesPromptFor(check('plasmids', {}), local)).toBeNull();
  });

  it('knows whether a main-genome Genes track is shown', () => {
    const panel = (over: object) => ({ id: 'p', contentType: 'dataset', collapsed: false,
      subTracks: [{ type: 'gene', visible: true }], ...over }) as any;
    expect(mainGenesTrackShown([panel({})])).toBe(true);
    expect(mainGenesTrackShown([panel({ subTracks: [{ type: 'gene', visible: false }] })])).toBe(false);
    expect(mainGenesTrackShown([panel({ subTracks: [{ type: 'gene', visible: true, removed: true }] })])).toBe(false);
    expect(mainGenesTrackShown([panel({ collapsed: true })])).toBe(false);
    expect(mainGenesTrackShown([panel({ genome: 'mm10' })])).toBe(false);   // a panel on its own genome
    expect(mainGenesTrackShown([])).toBe(false);
    // As TrackContainer lays them out: a collapsed layout row, or another panel maximized, hides it.
    const rowed = panel({ layoutRow: 1 });
    expect(mainGenesTrackShown([rowed], { collapsedRows: new Set([1]) })).toBe(false);
    expect(mainGenesTrackShown([rowed], { collapsedRows: new Set([0]) })).toBe(true);
    const other = { id: 'q', contentType: 'dataset', collapsed: false, subTracks: [] } as any;
    expect(mainGenesTrackShown([rowed, other], { fullViewPanelId: 'q' })).toBe(false);
    expect(mainGenesTrackShown([rowed, other], { fullViewPanelId: 'p' })).toBe(true);
    expect(mainGenesTrackShown([rowed, other], { fullViewPanelId: 'gone' })).toBe(true);
  });

  it('remembers a dismissed notice per genome, and keeps showing it without storage', () => {
    expect(genesNoticeDismissed('genome:dm6')).toBe(false);
    dismissGenesNotice('genome:dm6');
    expect(genesNoticeDismissed('genome:dm6')).toBe(true);
    expect(genesNoticeDismissed('genome:mm10')).toBe(false);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(() => dismissGenesNotice('genome:mm10')).not.toThrow();
    expect(genesNoticeDismissed('genome:dm6')).toBe(false);
  });
});
