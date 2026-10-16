import { afterEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../stores/browserStore';
import { planNaturalLanguageCommand, streamNaturalLanguageCommand } from './naturalLanguage';

afterEach(() => {
  vi.unstubAllGlobals();
});

function sentBody(fetchMock: ReturnType<typeof vi.fn>) {
  const init = fetchMock.mock.calls[0][1] as RequestInit;
  return JSON.parse(String(init.body));
}

describe('Copilot requests carry troubleshooting context', () => {
  it('plan requests send the browser\'s diagnostics and raw state', async () => {
    useBrowserStore.setState({ datasets: [], panels: [] });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await planNaturalLanguageCommand('why are no reads visible?', { chrom: 'chr2L' });
    const body = sentBody(fetchMock);
    expect(body.diagnostics.map((d: { code: string }) => d.code)).toContain('no_datasets');
    expect(body.raw_state).toMatchObject({ datasets: [], panels: [] });
  });

  it('stream requests send them too, and an explicit set wins', async () => {
    const fetchMock = vi.fn(async () => new Response('{"event":"done"}\n', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await streamNaturalLanguageCommand('stuck', undefined, () => {}, {
      troubleshooting: { diagnostics: [{ code: 'x', severity: 'info', message: 'm' }], raw_state: { a: 1 } },
    });
    const body = sentBody(fetchMock);
    expect(body.diagnostics).toEqual([{ code: 'x', severity: 'info', message: 'm' }]);
    expect(body.raw_state).toEqual({ a: 1 });
  });
});
