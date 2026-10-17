// Owner report (3.0.0, first launch): the tour tab said it needed data ("load a BAM") and stopped. A tour tab never
// has data of its own: it asks the server for the demo again, and says what went wrong when it still can't have it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const demoApi = vi.hoisted(() => ({ getDemo: vi.fn(), loadDemo: vi.fn() }));
const actions = vi.hoisted(() => ({ executeBrowserAction: vi.fn(async () => undefined) }));
vi.mock('../api/demo', () => demoApi);
vi.mock('../actions/browserActions', () => actions);

const SANDBOX = 'sb-AAAAAAAAAAAAAAAAAAAAAAAA';

function at(search: string) {
  window.history.replaceState(null, '', `/${search}`);
}

describe('the tour asks again for its demo', () => {
  beforeEach(() => {
    demoApi.getDemo.mockReset();
    demoApi.loadDemo.mockReset();
    actions.executeBrowserAction.mockClear();
  });
  afterEach(() => at(''));

  it('repeats a request that got no answer, but not the server\'s error answer', async () => {
    const { askAgainIfUnanswered } = await import('./guidedTour');
    const flaky = vi.fn()
      .mockRejectedValueOnce(new TypeError('Load failed'))
      .mockResolvedValueOnce('ok');
    await expect(askAgainIfUnanswered(flaky, { waitMs: 0 })).resolves.toBe('ok');
    expect(flaky).toHaveBeenCalledTimes(2);
    const refused = vi.fn().mockRejectedValue(new Error('API error 500: boom'));
    await expect(askAgainIfUnanswered(refused, { waitMs: 0 })).rejects.toThrow('API error 500');
    expect(refused).toHaveBeenCalledTimes(1);
    const gone = vi.fn().mockRejectedValue(new TypeError('Load failed'));
    await expect(askAgainIfUnanswered(gone, { tries: 3, waitMs: 0 })).rejects.toThrow('Load failed');
    expect(gone).toHaveBeenCalledTimes(3);
  });

  it('a tour tab asks again after any failure; the main tab once', async () => {
    const { findTourDemo } = await import('./guidedTour');
    const info = { available: true, label: 'NAPA', genome: 'hg38', dataset_id: null, region: { chrom: 'chr19', start: 1, end: 2 } };
    demoApi.getDemo.mockRejectedValueOnce(new Error('API error 503')).mockResolvedValueOnce(info);
    await expect(findTourDemo(true, 0)).resolves.toEqual({ info, error: null });
    expect(demoApi.getDemo).toHaveBeenCalledTimes(2);
    demoApi.getDemo.mockReset();
    demoApi.getDemo.mockRejectedValue(new Error('API error 404'));
    await expect(findTourDemo(false, 0)).resolves.toEqual({ info: null, error: 'API error 404' });
    expect(demoApi.getDemo).toHaveBeenCalledTimes(1);
  });

  it('a tour tab without its demo says why, never "load a BAM"', async () => {
    at(`?sandbox=${SANDBOX}`);
    vi.useFakeTimers();
    try {
      const { runGuidedTour } = await import('./guidedTour');
      demoApi.getDemo.mockRejectedValue(new TypeError('Load failed'));
      const run = runGuidedTour();
      await vi.runAllTimersAsync();
      await run;
    } finally {
      vi.useRealTimers();
    }
    expect(demoApi.getDemo.mock.calls.length).toBeGreaterThan(1);
    const shown = actions.executeBrowserAction.mock.calls.map(call => call[1] as { title?: string; description?: string });
    expect(shown).toHaveLength(1);
    expect(shown[0].title).toBe('The tour can\'t start');
    expect(shown[0].description).toContain('Load failed');
    expect(shown[0].description).not.toMatch(/BAM/);
  });

  it('the main tab with no data and no demo still asks for a dataset', async () => {
    const { runGuidedTour } = await import('./guidedTour');
    demoApi.getDemo.mockRejectedValue(new Error('API error 404'));
    await runGuidedTour();
    const shown = actions.executeBrowserAction.mock.calls.map(call => call[1] as { description?: string });
    expect(shown[0].description).toContain('load a BAM or BigBed');
  });
});

describe('a tour tab loads no genome of its own on start-up', () => {
  afterEach(() => {
    at('');
    vi.resetModules();
  });

  it('the main tab restores its reference; a tour tab leaves it to the demo', async () => {
    vi.resetModules();
    at('');
    expect((await import('./genomeAutoload')).startupGenomeAutoload()).toBe(true);
    vi.resetModules();
    at(`?sandbox=${SANDBOX}&tour=1`);
    expect((await import('./genomeAutoload')).startupGenomeAutoload()).toBe(false);
  });
});
