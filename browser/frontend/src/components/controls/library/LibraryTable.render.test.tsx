import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LibraryEntry } from '../../../api/library';
import { EntryBadges, FRAME_UNVERIFIABLE_TEXT, LibraryTable } from './LibraryTable';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const rows: LibraryEntry[] = [
  {
    id: 'a', kind: 'bam', path: '/d/a.fiberhmm.bam', folder: '/d', label: 'a.fiberhmm.bam', sample: 'embryo A',
    available: true, tags: ['embryo'], notes: '', reads: 12345, date: '2026-08-06T10:00:00',
    chemistry: { key: 'dddb', declared: true }, reference: { genome: 'dm6', n_contigs: 7 },
    qc: { verdicts: { overall: 'WARN' } }, rerun: 'rerun-required',
    advisories: { key: 'k', items: [{ id: 'x', severity: 'rerun-required', title: 'Old DddB table' }] },
  },
  {
    id: 'b', kind: 'plasmid_map', path: '/d/p.gb', folder: '/d', label: 'p.gb', available: false, tags: [], notes: '',
    reference: { plasmid: true, contigs: [{ name: 'pX', length: 4200, circular: true }] },
  },
];

describe('LibraryTable', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders rows with chemistry, reference, reads, QC and badges', () => {
    act(() => root.render(
      <LibraryTable entries={rows} sort={{ key: 'date', dir: 'desc' }} onSort={() => {}} selectedId="a"
        onSelect={() => {}} checked={[]} onToggle={() => {}} onToggleAll={() => {}} />,
    ));
    const trs = container.querySelectorAll('[data-testid="library-row"]');
    expect(trs).toHaveLength(2);
    const first = trs[0].textContent ?? '';
    expect(first).toContain('a.fiberhmm.bam');
    expect(first).toContain('embryo A');
    expect(first).toContain('DddB');
    expect(first).toContain('dm6');
    expect(first).toContain('12,345');
    expect(first).toContain('#embryo');
    expect(container.querySelector('[data-testid="library-qc-verdict"]')!.textContent).toBe('WARN');
    expect(container.querySelector('[data-testid="library-rerun-badge"]')!.textContent).toBe('Needs re-run');
    expect(trs[1].getAttribute('data-available')).toBe('false');
    expect(trs[1].textContent).toContain('pX (4.2 kb)');
    expect(container.querySelector('[data-testid="library-missing-badge"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="library-sort-date"]')!.getAttribute('aria-sort')).toBe('descending');
  });

  it('sorts, selects and checks', () => {
    const onSort = vi.fn();
    const onSelect = vi.fn();
    const onToggle = vi.fn();
    const onToggleAll = vi.fn();
    act(() => root.render(
      <LibraryTable entries={rows} sort={{ key: 'date', dir: 'desc' }} onSort={onSort} selectedId={null}
        onSelect={onSelect} checked={['b']} onToggle={onToggle} onToggleAll={onToggleAll} />,
    ));
    act(() => (container.querySelector('[data-testid="library-sort-reads"]') as HTMLButtonElement).click());
    expect(onSort).toHaveBeenCalledWith('reads');
    act(() => (container.querySelectorAll('[data-testid="library-row"]')[1] as HTMLElement).click());
    expect(onSelect).toHaveBeenCalledWith('b');
    const boxes = container.querySelectorAll('input[type="checkbox"]');
    expect((boxes[2] as HTMLInputElement).checked).toBe(true);
    act(() => (boxes[1] as HTMLInputElement).click());
    expect(onToggle).toHaveBeenCalledWith('a');
    expect(onSelect).toHaveBeenCalledTimes(1);  // the checkbox does not select the row
    act(() => (boxes[0] as HTMLInputElement).click());
    expect(onToggleAll).toHaveBeenCalledWith(['a', 'b'], true);
  });
});

describe('re-run badge explains itself (UI audit M26)', () => {
  it('the badge tooltip says what the advisory is and how to fix it', async () => {
    const { EntryBadges } = await import('./LibraryTable');
    const entry = {
      ...rows[0], rerun: 'rerun-recommended',
      advisories: { key: 'k', fiberhmm_version: '3.0.0', items: [{
        id: 'daf-dedup-orientation', severity: 'rerun-recommended',
        title: 'DAF duplicates grouped by alignment orientation',
        reason: 'Before 3.0 DAF dedup grouped reads by alignment orientation.',
        fix: 'Re-run fiberhmm-dedup with FiberHMM >= 3.0.',
      }] },
    } as LibraryEntry;
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => root.render(<EntryBadges entry={entry} />));
    const badge = container.querySelector('[data-testid="library-rerun-badge"]')!;
    expect(badge.textContent).toBe('Re-run recommended');
    const title = badge.getAttribute('title')!;
    expect(title).toContain('DAF duplicates grouped by alignment orientation');
    expect(title).toContain('Before 3.0 DAF dedup');
    expect(title).toContain('Fix: Re-run fiberhmm-dedup');
    expect(title).toContain('FiberHMM 3.0.0');
    act(() => root.unmount());
  });
});

describe('frame evidence badge', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
  afterEach(() => { act(() => root.unmount()); container.remove(); });
  it('a BAM whose header gives no frame evidence gets a "Frame unconfirmed" badge with FiberHMM\'s wording', () => {
    act(() => root.render(<><EntryBadges entry={{ ...rows[0], rerun: null, frame_unverifiable: true }} /><EntryBadges entry={{ ...rows[0], rerun: null }} /></>));
    const badges = [...container.querySelectorAll('[data-testid="library-frame-badge"]')];
    expect(badges).toHaveLength(1);
    expect(badges[0].textContent).toBe('Frame unconfirmed');
    expect(badges[0].getAttribute('title')).toBe(FRAME_UNVERIFIABLE_TEXT);
    expect(FRAME_UNVERIFIABLE_TEXT).toContain("footprint coordinates on reverse reads can't be confirmed; re-call with FiberHMM 3.0");
  });
});
