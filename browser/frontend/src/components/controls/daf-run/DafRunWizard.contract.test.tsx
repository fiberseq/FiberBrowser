/**
 * The run wizard against recorded real backend answers (coverage plan #23).
 *
 * The other wizard tests mock `api/pipeline` with hand-written status objects. Here `api/pipeline` is the real module
 * and only `fetch` is answered, from the golden responses the backend test tests/test_api_contract_golden.py records
 * from the real routes (/api/pipeline/status, /scan, /validate, /jobs). The wizard is mounted on its own, walked
 * through reads → reference → run, and the body it POSTs to /api/pipeline/jobs is checked field by field against
 * the server's defaults and what was entered. The native file picker is the only other stand-in.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pipelineStatus from '../../../api/__fixtures__/contract/pipeline_status.json';
import pipelineScan from '../../../api/__fixtures__/contract/pipeline_scan.json';
import pipelineValidate from '../../../api/__fixtures__/contract/pipeline_validate.json';
import pipelineSubmit from '../../../api/__fixtures__/contract/pipeline_submit.json';
import status from '../../../api/__fixtures__/contract/status.json';

const READS = (pipelineScan as { samples: Array<{ files: Array<{ path: string }> }> }).samples[0].files[0].path;

vi.mock('../../../api/files', () => ({
  pickAnyFile: vi.fn(async () => ({ success: true, paths: [READS] })),
  pickFolder: vi.fn(), pickFile: vi.fn(), pickDataset: vi.fn(), uploadFile: vi.fn(),
}));

import { DafRunWizard } from './DafRunWizard';
import { useDafRunStore } from './dafRunStore';
import { useBrowserStore } from '../../../stores/browserStore';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type Call = { url: string; method: string; body: any };

function backend() {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method || 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });
    const reply = (payload: unknown, code = 200) => new Response(JSON.stringify(payload), {
      status: code, headers: { 'Content-Type': 'application/json' } });
    if (url.startsWith('/api/pipeline/status')) return reply(pipelineStatus);
    if (url.startsWith('/api/pipeline/scan')) return reply(pipelineScan);
    if (url.startsWith('/api/pipeline/validate')) return reply(pipelineValidate);
    if (url.startsWith('/api/pipeline/jobs') && method === 'POST') return reply(pipelineSubmit);
    if (url.startsWith('/api/pipeline/jobs')) return reply({ jobs: [] });
    if (url.startsWith('/api/status')) return reply(status);
    return reply({ detail: `unexpected ${method} ${url}` }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

describe('run wizard with recorded backend answers', () => {
  let box: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    box = document.createElement('div');
    document.body.appendChild(box);
    root = createRoot(box);
    useBrowserStore.setState({ publicMode: false });
    useDafRunStore.setState({ open: true, tab: 'new', jobs: [], draft: null, draftSeeded: false });
  });

  afterEach(() => {
    act(() => root.unmount());
    box.remove();
    vi.unstubAllGlobals();
  });

  const el = (testId: string) => box.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
  const click = async (selector: string) => {
    const node = box.querySelector(selector) as HTMLElement | null;
    expect(node, selector).toBeTruthy();
    await act(async () => { node!.click(); });
  };
  const wait = (ms: number) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
  const type = async (node: HTMLInputElement, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value);
      node.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  it('submits the body the server expects: the scanned sample, the reference, the server defaults', async () => {
    const calls = backend();
    await act(async () => root.render(<DafRunWizard />));
    await wait(20);
    expect(calls.some(c => c.url.startsWith('/api/pipeline/status'))).toBe(true);

    // Step 1: reads, scanned by the server
    await click('[data-testid="daf-run-choose-files"]');
    await wait(20);
    const scan = calls.find(c => c.url.startsWith('/api/pipeline/scan'));
    expect(scan?.body).toEqual({ paths: [READS], input_kind: 'reads' });
    const names = box.querySelectorAll('[data-testid="daf-run-sample-name"]');
    expect(names).toHaveLength(1);
    expect((names[0] as HTMLInputElement).value).toBe('sample_a');

    // Step 2: a FASTA file reference
    await click('[data-testid="daf-run-next"]');
    await click('[data-testid="daf-run-ref-file"]');
    await type(el('daf-run-reference-path') as HTMLInputElement, '/data/ref.fa');

    // Step 3: enzyme, cores; the server checks the request, then Run
    await click('[data-testid="daf-run-next"]');
    await click('[data-testid="daf-run-enzyme-dddb"] input');
    await wait(450);
    const validate = calls.filter(c => c.url.startsWith('/api/pipeline/validate'));
    expect(validate.length).toBeGreaterThan(0);
    expect(el('daf-run-preview')?.textContent).toContain('sample_a');
    const submit = el('daf-run-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    await click('[data-testid="daf-run-submit"]');
    await wait(20);

    const posted = calls.filter(c => c.url.startsWith('/api/pipeline/jobs') && c.method === 'POST');
    expect(posted).toHaveLength(1);
    const body = posted[0].body;
    // the validated request and the submitted one are the same request
    expect(body).toEqual(validate[validate.length - 1].body);
    expect(body.samples).toEqual([{ name: 'sample_a', files: (pipelineScan as any).samples[0].files }]);
    expect(body.reference).toEqual({ kind: 'file', path: '/data/ref.fa' });
    expect(body.enzyme).toBe('dddb');
    expect(body.input_kind).toBe('reads');
    expect(body.cores).toBe((pipelineStatus as any).default_cores);
    expect(body.options).toEqual((pipelineStatus as any).default_options);
    expect(body.output_root.startsWith((pipelineStatus as any).output_parent)).toBe(true);
    expect(body.regions).toEqual([]);
    expect(typeof body.auto_open).toBe('boolean');
    expect(body.basecall).toBeUndefined();
    // the server's answer opens the Runs tab on the new job
    expect(useDafRunStore.getState().tab).toBe('runs');
  });
});
