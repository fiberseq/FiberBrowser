import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JobStatus, formatElapsed } from './JobStatus';
import { CheckboxRow } from './CheckboxRow';

describe('JobStatus', () => {
  it('formats elapsed time without inventing a remaining time', () => {
    expect(formatElapsed(9)).toBe('9s');
    expect(formatElapsed(245)).toBe('4m 05s');
    expect(formatElapsed(3720)).toBe('1h 02m');
    const html = renderToStaticMarkup(<JobStatus title="Find classes" state="running" stage="Finding classes" startedAt={Date.now() - 12_000} />);
    expect(html).toContain('Finding classes');
    expect(html).toMatch(/1[12]s elapsed/);
    expect(html).not.toMatch(/remaining|ETA/i);
  });
  it('shows the pre-launch hint only before a run', () => {
    const idle = renderToStaticMarkup(<JobStatus title="Find classes" state="idle" hint="Usually several minutes for a view this size" />);
    expect(idle).toContain('Usually several minutes');
    const running = renderToStaticMarkup(<JobStatus title="Find classes" state="running" hint="Usually several minutes" />);
    expect(running).not.toContain('Usually several minutes');
    expect(renderToStaticMarkup(<JobStatus title="x" state="idle" />)).toBe('');
  });
  it('offers Cancel while live and keeps the last result afterwards', () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const onCancel = vi.fn();
    const div = document.createElement('div'); const root = createRoot(div);
    try {
      act(() => root.render(<JobStatus title="Find classes" state="running" stage="Counting" startedAt={Date.now()} onCancel={onCancel} testId="fc" compact />));
      act(() => (div.querySelector('[data-testid="fc-cancel"]') as HTMLButtonElement).click());
      expect(onCancel).toHaveBeenCalledTimes(1);
      act(() => root.render(<JobStatus title="Find classes" state="cancelling" stage="Counting" startedAt={Date.now()} onCancel={onCancel} testId="fc" compact />));
      expect((div.querySelector('[data-testid="fc-cancel"]') as HTMLButtonElement).disabled).toBe(true);
      act(() => root.render(<JobStatus title="Find classes" state="complete" startedAt={Date.now() - 5000} finishedAt={Date.now()} result="5 classes found" testId="fc" compact />));
      expect(div.querySelector('[data-testid="fc-cancel"]')).toBeNull();
      expect(div.querySelector('[data-testid="fc-result"]')?.textContent).toBe('5 classes found');
      expect(div.textContent).toContain('5s elapsed');
    } finally { act(() => root.unmount()); }
  });
  it('draws a stated stage count as a determinate bar; unknown progress as moving stripes (N6)', () => {
    const counted = renderToStaticMarkup(<JobStatus title="Find classes" state="running" stage="Finding classes" testId="fc"
      stageProgress={{ label: 'Find classes', noun: 'tile', completed: 44, total: 59 }} />);
    expect(counted).toContain('Find classes: tile 44 of 59');
    expect(counted).not.toContain('total not yet known');
    expect(counted).toContain('aria-valuenow="75"');
    expect(counted).toMatch(/data-testid="fc-fill"[^>]*width:74\.5/);
    // a real count wins over the stated one
    const both = renderToStaticMarkup(<JobStatus title="x" state="running" progress={{ fraction: .5, completed: 1, total: 2, unit: 'classes' }}
      stageProgress={{ noun: 'tile', completed: 1, total: 10 }} />);
    expect(both).toContain('1 / 2 classes completed');
    expect(both).not.toContain('tile 1 of 10');
    // unknown: stripes over the whole bar, no part-fill that reads as a share done
    const unknown = renderToStaticMarkup(<JobStatus title="Find classes" state="running" testId="fc" steps={[{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }]} stepIndex={0} />);
    expect(unknown).toMatch(/data-testid="fc-fill"[^>]*data-indeterminate="true"/);
    expect(unknown).not.toMatch(/width:3[25]%/);
    expect(unknown.match(/data-indeterminate="true"/g)).toHaveLength(2);       // the bar and the current step
    // the old props still work: no stageProgress, a fraction
    expect(renderToStaticMarkup(<JobStatus title="x" state="running" progress={{ fraction: .2 }} testId="o" />)).toMatch(/data-testid="o-fill"[^>]*width:20%/);
  });
  it('under the step strip the bar says only the count, not the step name again (R5); without a strip it keeps it', () => {
    const steps = [{ key: 'find', label: 'Find classes' }, { key: 'count', label: 'Count' }];
    const html = renderToStaticMarkup(<JobStatus title="Find classes" state="running" testId="fc" steps={steps} stepIndex={1}
      stageProgress={{ label: 'Count', noun: 'group', completed: 113, total: 124 }} />);
    expect(html).toMatch(/data-testid="fc-bar-text">group 113 of 124</);
    expect(html).toContain('aria-valuenow="91"');
    expect(renderToStaticMarkup(<JobStatus compact title="Find classes" state="running" testId="c"
      stageProgress={{ label: 'Count', noun: 'group', completed: 113, total: 124 }} />)).toContain('Count: group 113 of 124');
  });
  it('a named later part of a step keeps the earlier part full instead of turning back into stripes (R5)', () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const div = document.createElement('div'); const root = createRoot(div);
    const steps = [{ key: 'scan', label: 'Scan regions' }, { key: 'pairs', label: 'Pair tests' }];
    const fill = () => div.querySelector<HTMLElement>('[data-testid="p-fill"]')!;
    try {
      act(() => root.render(<JobStatus title="Pair analysis" state="running" runKey="j1" testId="p" steps={steps} stepIndex={1}
        progress={{ fraction: 210 / 253, completed: 210, total: 253, unit: 'pair tests' }} />));
      expect(parseFloat(fill().style.width)).toBeCloseTo(83, 0);
      // the pair tests are done; the combination patterns have no count
      act(() => root.render(<JobStatus title="Pair analysis" state="running" runKey="j1" testId="p" steps={steps} stepIndex={1}
        progress={null} phase="Pair tests done · testing combination patterns" />));
      expect(fill().dataset.held).toBe('83');                                   // the finished part stays full ...
      expect(fill().querySelector('[data-indeterminate="true"]')).not.toBeNull();  // ... and only the rest is striped
      expect(div.querySelector('[data-testid="p-bar-text"]')!.textContent).toBe('Pair tests done · testing combination patterns');
      expect(div.textContent).not.toContain('total not yet known');
      expect(div.textContent).not.toContain('% of this stage');
      expect(div.querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow')).toBeNull();
      const segment = div.querySelector('[data-testid="p-steps"] [aria-current="step"]')!;
      expect(segment.querySelector('[data-held="83"]')).not.toBeNull();
      // cancelled there: the part done stays on the bar (static, the stopped colour), not 0
      act(() => root.render(<JobStatus title="Pair analysis" state="cancelled" runKey="j1" testId="p" steps={steps} stepIndex={1}
        progress={null} phase="Pair tests done · testing combination patterns" />));
      expect(parseFloat(fill().style.width)).toBeCloseTo(83, 0);
      expect(fill().className).toContain('bg-amber-500');
      expect(div.querySelector('[data-indeterminate="true"]')).toBeNull();
      expect(parseFloat((div.querySelector('[data-testid="p-steps"] [data-state="active"] div div') as HTMLElement).style.width)).toBeCloseTo(83, 0);
      // a new run (or step) starts from nothing: an uncounted part is stripes again, with its name
      act(() => root.render(<JobStatus title="Pair analysis" state="running" runKey="j2" testId="p" steps={steps} stepIndex={1}
        progress={null} phase="Pair tests done · testing combination patterns" />));
      expect(fill().dataset.indeterminate).toBe('true');
      expect(div.querySelector('[data-testid="p-bar-text"]')!.textContent).toBe('Pair tests done · testing combination patterns · total not yet known');
      // no phase given: stripes, as before
      act(() => root.render(<JobStatus title="x" state="running" runKey="j3" testId="p" steps={steps} stepIndex={1} progress={{ fraction: .5 }} />));
      act(() => root.render(<JobStatus title="x" state="running" runKey="j3" testId="p" steps={steps} stepIndex={1} progress={null} />));
      expect(fill().dataset.indeterminate).toBe('true');
    } finally { act(() => root.unmount()); }
  });
  it('the compact line (Identify, the alt-allele build, quantify in a dataset) is unchanged: no bar, no step strip, no stripes', () => {
    const html = renderToStaticMarkup(<JobStatus compact title="Identify" state="running" stage="BLAST against the reference" progress={{ fraction: .4 }}
      startedAt={Date.now() - 3000} onCancel={() => {}} testId="id" />);
    expect(html).toContain('40% of this stage');
    expect(html).not.toContain('role="progressbar"');
    expect(html).not.toContain('data-indeterminate');
    expect(html).not.toContain('Step ');
    expect(html).toContain('data-testid="id-cancel"');
  });
  it('says what failed in the body', () => {
    const html = renderToStaticMarkup(<JobStatus title="Identify" state="error" message="BLAST not found" />);
    expect(html).toContain('Identify failed');
    expect(html).toContain('BLAST not found');
    expect(html).toContain('role="alert"');
  });
});

describe('CheckboxRow', () => {
  it('toggles from the whole row and keeps a 24 px target', () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const onChange = vi.fn();
    const div = document.createElement('div'); document.body.appendChild(div); const root = createRoot(div);
    try {
      act(() => root.render(<CheckboxRow checked={false} onChange={onChange} label="Require calls at both SVs" description="why" testId="row" />));
      const row = div.querySelector('[data-testid="row"]') as HTMLLabelElement;
      expect(row.tagName).toBe('LABEL');
      expect(row.className).toContain('min-h-[24px]');
      act(() => (row.querySelector('span span') as HTMLElement).click());
      expect(onChange).toHaveBeenCalledWith(true);
    } finally { act(() => root.unmount()); div.remove(); }
  });
});
