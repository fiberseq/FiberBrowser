import '../testSetup';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { IdentifyTab, lensIdentifyKey, readRmskPref } from './IdentifyTab';
import { cancelIdentify, resetIdentifyStore, setVisibleIdentifyKey, startDfamSearch, startIdentify, useIdentifyStore } from './identifyStore';
import { roo } from './identifyFixtures.test-data';
import type { LensResponse } from './insertionLensModel';
import { INSERTION_LENS_PANEL } from './insertionLensTarget';

const fetchJson = vi.fn();
vi.mock('../../api/sharedFetch', async orig => ({ ...(await orig<object>()), fetchJson: (...a: unknown[]) => fetchJson(...a) }));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const response = {
  success: true, chrom: 'chr2L', flank: 1000,
  site: { pos: 9467038, tolerance: 30, len_min: 50, len_max: null },
  cluster: { ref: 9467038, len: 9183, len_lo: 9180, len_hi: 9190, carriers: 3267, reference: 10 },
  carriers: [], reference: [], excluded: { other_insert: 0, not_informative: 0 }, truncated: { carriers: 0, reference: 0 },
  consensus: { seq: 'ACGT'.repeat(50), length: 200, n_reads: 32, seconds: 1 },
} as unknown as LensResponse;
const KEY = lensIdentifyKey(response, 'ds1');
const LIBRARY = {
  success: true, genome: 'dm6', active: null, genome_loaded: true,
  tools: { blastn: true, makeblastdb: true, minimap2: true },
  libraries: [{ id: 'dmel-canonical-v10.2', label: 'D. melanogaster TE canonical set v10.2', short: 'D. melanogaster TE library',
    source: 'Bergman lab', homepage: 'https://github.com/bergmanlab/drosophila-transposons', licence: 'CC0 1.0 (public domain dedication)',
    licence_url: 'https://creativecommons.org/publicdomain/zero/1.0/', citation: 'x', size_bytes: 829547, version: 'v10.2', installed: false }],
};

const wait = (ms: number) => act(async () => { await new Promise(r => setTimeout(r, ms)); });
const posts = () => fetchJson.mock.calls.filter(c => (c[1] as RequestInit | undefined)?.method === 'POST');

describe('Identify tab', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useRealTimers();
    resetIdentifyStore();
    fetchJson.mockReset();
    useBrowserStore.setState({ panels: [{ id: 'p-ins', contentType: INSERTION_LENS_PANEL } as never], referenceRevision: 0 });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = async (visible = true) => {
    await act(async () => {
      root.render(<IdentifyTab response={response} datasetId="ds1" reversed={false} visible={visible} dark={false} />);
    });
  };

  it('uses the captured panel reference for its library and search, even after another panel is selected', async () => {
    fetchJson.mockResolvedValue(LIBRARY);
    await act(async () => root.render(<IdentifyTab response={response} datasetId="ds1" genome="source-ref" reversed visible dark={false} />));
    expect(fetchJson.mock.calls[0][0]).toBe('/api/insertions/te_library?panel_genome=source-ref');
    const { identifyLens } = await import('./IdentifyTab');
    await act(async () => { identifyLens(response, 'ds1', { genome: 'source-ref' }); });
    await wait(0);
    expect(posts().some(([url]) => String(url).includes('panel_genome=source-ref'))).toBe(true);
    expect(lensIdentifyKey(response, 'ds1', 'source-ref')).not.toBe(lensIdentifyKey(response, 'ds1', 'other-ref'));
  });

  it('a declaration while the library request is still pending: that reply is dropped and a new request is made', async () => {
    const pending: Array<(v: unknown) => void> = [];
    fetchJson.mockImplementation((url: string) => (String(url).startsWith('/api/insertions/te_library')
      ? new Promise(resolve => { pending.push(resolve); }) : Promise.resolve({})));
    await act(async () => root.render(<IdentifyTab response={response} datasetId="ds1" genome="alt-ref" reversed visible dark={false} />));
    await wait(0);
    expect(pending.length).toBe(1);
    await act(async () => { useBrowserStore.getState().bumpReferenceRevision(); });
    await wait(0);
    expect(pending.length).toBe(2);                                  // a new request, not only a dropped one
    const line = () => container.querySelector('[data-testid="identify-library-auto"]');
    expect(line()).toBeNull();
    await act(async () => { pending[0](LIBRARY); });                         // the dropped reply: not shown
    await wait(0);
    expect(line()).toBeNull();
    await act(async () => { pending[1](LIBRARY); });                         // the new reply is shown
    await wait(0);
    expect(line()!.textContent).toContain('CC0 1.0');
    expect(pending.length).toBe(2);
  });

  it('reads the TE library (and the reference id that marks a result stale) again after a genome is declared', async () => {
    fetchJson.mockResolvedValue(LIBRARY);
    await act(async () => root.render(<IdentifyTab response={response} datasetId="ds1" genome="alt-ref" reversed visible dark={false} />));
    await wait(0);
    const libraryCalls = () => fetchJson.mock.calls.filter(([url]) => String(url).startsWith('/api/insertions/te_library')).length;
    expect(libraryCalls()).toBe(1);
    await act(async () => { useBrowserStore.getState().bumpReferenceRevision(); });
    await wait(0);
    expect(libraryCalls()).toBe(2);
  });

  it('says the library is set up by the first Identify (size, licence; no download button) and sends nothing on its own', async () => {
    fetchJson.mockImplementation(async (url: string) => (url === '/api/insertions/te_library' ? LIBRARY : {}));
    await render();
    await wait(0);
    expect(container.querySelector('[data-testid="identify-download-library"]')).toBeNull();
    const line = container.querySelector('[data-testid="identify-library-auto"]')!;
    expect(line.textContent).toContain('downloaded once on the first Identify (0.8 MB');
    expect(line.textContent).toContain('CC0 1.0');
    expect(posts()).toHaveLength(0);
  });

  it('after a run that set the library up, the library line is read again', async () => {
    let statusCalls = 0;
    let polls = 0;
    fetchJson.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/insertions/te_library')) {
        statusCalls += 1;
        return statusCalls === 1 ? LIBRARY
          : { ...LIBRARY, active: 'dmel-canonical-v10.2', libraries: [{ ...LIBRARY.libraries[0], installed: true }] };
      }
      if (url === '/api/insertions/identify') return { success: true, status: 'running', job_id: 'j9', progress: 0.05, message: 'Setting up' };
      if (url.startsWith('/api/insertions/identify/jobs/j9')) {
        polls += 1;
        return polls < 2 ? { status: 'running', progress: 0.5, message: 'Searching' } : { status: 'done', result: roo };
      }
      return {};
    });
    await render();
    await wait(0);
    await act(async () => { (container.querySelector('[data-testid="identify-run"]') as HTMLButtonElement).click(); });
    await wait(2300);
    expect(statusCalls).toBe(2);
    expect(container.querySelector('[data-testid="identify-library-auto"]')).toBeNull();
    expect(container.querySelector('[data-testid="identify-library"]')!.textContent).toContain('TE library: D. melanogaster TE canonical set v10.2');
  });

  it('a bundled library needs no download', async () => {
    const bundled = { ...LIBRARY, libraries: [{ ...LIBRARY.libraries[0], bundled: true }] };
    fetchJson.mockImplementation(async (url: string) => (url === '/api/insertions/te_library' ? bundled : {}));
    await render();
    await wait(0);
    const line = container.querySelector('[data-testid="identify-library-auto"]')!;
    expect(line.textContent).toContain('bundled with FiberBrowser');
    expect(line.textContent).not.toContain('downloaded');
  });

  it('a cached result shows the summary, cartoon and tables at once and is saved on the panel', async () => {
    fetchJson.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/insertions/identify') {
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({ chrom: 'chr2L', ref: 9467038, length: 9183, seq: response.consensus!.seq });
        return { success: true, status: 'done', cached: true, result: roo };
      }
      return LIBRARY;
    });
    await render();
    await act(async () => { (container.querySelector('[data-testid="identify-run"]') as HTMLButtonElement).click(); });
    await wait(0);
    expect(container.querySelector('[data-testid="identify-summary"]')!.textContent).toBe(roo.summary);
    expect(container.querySelector('[data-testid="cartoon-caption"]')!.textContent).toBe('full-length roo (LTR/Bel-Pao), − strand, 5-bp TSD');
    expect(container.querySelectorAll('[data-testid="cartoon-ltr"]')).toHaveLength(2);
    expect(container.querySelector('[data-testid="identify-te-table"]')!.textContent).toContain('roo');
    // A candidate, with its coverage, identity and the database it was found in.
    const verdict = container.querySelector('[data-testid="identify-verdict"]')!;
    expect(verdict.getAttribute('data-status')).toBe('candidate');
    expect(verdict.querySelector('[data-testid="identify-verdict-status"]')!.textContent).toBe('Best candidate');
    expect(verdict.textContent).toContain('98.8% identity');
    expect(verdict.textContent).toContain('D. melanogaster TE canonical set v10.2');
    expect(verdict.getAttribute('title')).toContain('≥ 80% identity over ≥ 50% of the insert');
    const saved = useBrowserStore.getState().panels[0].insertionIdentify!;
    expect(saved[KEY].result.summary).toBe(roo.summary);
    expect(useIdentifyStore.getState().entries[KEY].unseen).toBe(false);
  });

  it('a background job keeps polling after the tab is gone, then raises the badge', async () => {
    let polls = 0;
    fetchJson.mockImplementation(async (url: string) => {
      if (url === '/api/insertions/identify') return { success: true, status: 'running', job_id: 'j1', progress: 0.1, message: 'Searching' };
      if (url.startsWith('/api/insertions/identify/jobs/j1')) {
        polls += 1;
        return polls < 2 ? { status: 'running', progress: 0.5, message: 'Searching the genome' } : { status: 'done', result: roo };
      }
      return LIBRARY;
    });
    setVisibleIdentifyKey(null);
    await startIdentify(KEY, { seq: 'ACGT', chrom: 'chr2L', ref: 1, length: 4, rmsk: false });
    expect(useIdentifyStore.getState().entries[KEY].status).toBe('running');
    await wait(2300);
    const entry = useIdentifyStore.getState().entries[KEY];
    expect(entry.status).toBe('done');
    expect(entry.unseen).toBe(true); // finished out of sight: the tab shows a dot
    setVisibleIdentifyKey(KEY);
    expect(useIdentifyStore.getState().entries[KEY].unseen).toBe(false);
  });

  it('a missing tool is reported clearly', async () => {
    fetchJson.mockImplementation(async (url: string) => (url === '/api/insertions/identify'
      ? { success: false, missing_tools: true, error: 'Identifying an insertion needs BLAST+ (blastn, makeblastdb) or minimap2' }
      : LIBRARY));
    await render();
    await act(async () => { (container.querySelector('[data-testid="identify-run"]') as HTMLButtonElement).click(); });
    await wait(0);
    expect(container.querySelector('[data-testid="identify-error"]')!.textContent).toMatch(/needs BLAST\+/);
  });

  it('Dfam: nothing is sent until the user confirms "Send to Dfam"', async () => {
    fetchJson.mockImplementation(async (url: string) => {
      if (url === '/api/insertions/identify') return { success: true, status: 'done', result: roo };
      if (url === '/api/insertions/identify/dfam') return { success: true, status: 'running', job_id: 'd1' };
      return LIBRARY;
    });
    await render();
    await act(async () => { (container.querySelector('[data-testid="identify-run"]') as HTMLButtonElement).click(); });
    await wait(0);
    const dfamPosts = () => posts().filter(c => c[0] === '/api/insertions/identify/dfam');
    await act(async () => { (container.querySelector('[data-testid="identify-dfam-open"]') as HTMLButtonElement).click(); });
    expect(container.querySelector('[data-testid="identify-dfam-confirm"]')!.textContent).toContain('dfam.org');
    expect(dfamPosts()).toHaveLength(0);
    // Cancel: still nothing.
    const cancel = [...container.querySelectorAll('[data-testid="identify-dfam-confirm"] button')].find(b => b.textContent === 'Cancel') as HTMLButtonElement;
    await act(async () => { cancel.click(); });
    expect(dfamPosts()).toHaveLength(0);
    await act(async () => { (container.querySelector('[data-testid="identify-dfam-open"]') as HTMLButtonElement).click(); });
    await act(async () => { (container.querySelector('[data-testid="identify-dfam-send"]') as HTMLButtonElement).click(); });
    await wait(0);
    expect(dfamPosts()).toHaveLength(1);
    expect(JSON.parse(String((dfamPosts()[0][1] as RequestInit).body))).toMatchObject({ opt_in: true, seq: response.consensus!.seq });
  });

  it('startDfamSearch refuses without a literal opt-in', async () => {
    await startDfamSearch(KEY, 'ACGT', false as unknown as true);
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it('the identify request never goes to an external URL', async () => {
    fetchJson.mockImplementation(async (url: string) => (url === '/api/insertions/identify' ? { success: true, status: 'done', result: roo } : LIBRARY));
    await render();
    await act(async () => { (container.querySelector('[data-testid="identify-run"]') as HTMLButtonElement).click(); });
    await wait(0);
    for (const [url] of fetchJson.mock.calls) expect(String(url)).toMatch(/^\/api\/insertions\//);
  });

  it('RepeatMasker naming (coordinates to UCSC, never the sequence) is on by default; turning it off is remembered', async () => {
    localStorage.clear();
    expect(readRmskPref()).toBe(true);
    fetchJson.mockImplementation(async (url: string) => (url === '/api/insertions/identify' ? { success: true, status: 'done', result: roo } : LIBRARY));
    await render();
    const box = container.querySelector('[data-testid="identify-rmsk"]') as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(box.closest('label')!.textContent).toContain('sends hit coordinates to UCSC');
    await act(async () => { (container.querySelector('[data-testid="identify-run"]') as HTMLButtonElement).click(); });
    const first = JSON.parse(String((posts().find(c => c[0] === '/api/insertions/identify')![1] as RequestInit).body));
    expect(first.rmsk).toBe(true);
    // Its online state sits next to Run (VAR-9), apart from the local search.
    const state = container.querySelector('[data-testid="identify-online-state"]') as HTMLElement;
    expect(state.textContent).toBe('Online: RepeatMasker names (UCSC)');
    expect(container.querySelector('[data-testid="identify-local"]')!.textContent).toContain('on this computer');
    await act(async () => { box.click(); });
    expect(state.textContent).toBe('Local only');
    expect(localStorage.getItem('fb.identify.rmsk')).toBe('0');
    expect(readRmskPref()).toBe(false);
    localStorage.clear();
  });

  it('the footer says which BLAST+ produced the result (not what is installed now)', async () => {
    const tool = { name: 'blastn', version: '2.17.0+', path: '/opt/homebrew/bin/blastn', label: 'BLAST+ 2.17.0+ (/opt/homebrew/bin/blastn)' };
    fetchJson.mockImplementation(async (url: string) => (url === '/api/insertions/identify'
      ? { success: true, status: 'done', result: { ...roo, tool } }
      : { ...LIBRARY, tools: { ...LIBRARY.tools, blast_label: 'BLAST+ 2.18.0+ (/usr/local/bin/blastn)' } }));
    await render();
    await act(async () => { (container.querySelector('[data-testid="identify-run"]') as HTMLButtonElement).click(); });
    await wait(0);
    expect(container.querySelector('[data-testid="identify-blast-tool"]')!.textContent).toContain('BLAST+ 2.17.0+ (/opt/homebrew/bin/blastn)');
  });

  it('missing tools: what to install, and a re-check', async () => {
    fetchJson.mockImplementation(async () => ({ ...LIBRARY, tools: { blastn: false, makeblastdb: false, minimap2: false,
      hint: "Install BLAST+ with 'brew install blast' or 'conda install -c bioconda blast'" } }));
    await render();
    await wait(0);
    expect(container.querySelector('[data-testid="identify-tools-missing"]')!.textContent).toMatch(/brew install blast/);
    const again = [...container.querySelectorAll('button')].find(b => b.textContent === 'Check again')!;
    await act(async () => { again.click(); });
    expect(fetchJson.mock.calls.some(c => c[0] === '/api/insertions/te_library?refresh=true')).toBe(true);
  });

  it('a reply for a replaced job never overwrites the new one', async () => {
    let releaseOld: (v: unknown) => void = () => {};
    fetchJson.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/insertions/identify') {
        const body = JSON.parse(String(init?.body));
        if (body.seq === 'OLD') return new Promise(r => { releaseOld = r; });
        return { success: true, status: 'running', job_id: 'new', progress: 0 };
      }
      if (url.includes('/jobs/new')) return { status: 'running', progress: 0.3, message: 'Searching' };
      return LIBRARY;
    });
    const first = startIdentify(KEY, { seq: 'OLD', chrom: 'chr2L', ref: 1, length: 4, rmsk: false });
    await startIdentify(KEY, { seq: 'NEW', chrom: 'chr2L', ref: 1, length: 4, rmsk: false, restart: true });
    releaseOld({ success: true, status: 'done', result: roo });
    await first;
    const entry = useIdentifyStore.getState().entries[KEY];
    expect(entry.status).toBe('running');
    expect(entry.jobId).toBe('new');
    expect(useBrowserStore.getState().panels[0].insertionIdentify).toBeUndefined();
    await cancelIdentify(KEY);
  });

  it('a result computed against another reference is marked stale', async () => {
    fetchJson.mockImplementation(async (url: string) => (url === '/api/insertions/identify'
      ? { success: true, status: 'done', result: { ...roo, reference_id: 'old-ref' } }
      : { ...LIBRARY, reference_id: 'new-ref' }));
    await render();
    await act(async () => { (container.querySelector('[data-testid="identify-run"]') as HTMLButtonElement).click(); });
    await wait(0);
    expect(container.querySelector('[data-testid="identify-stale"]')!.textContent).toMatch(/another reference genome/);
  });
});
