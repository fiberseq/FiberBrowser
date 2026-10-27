import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_COLORMAP, type ColorRule } from '../../../types';
import { useBrowserStore } from '../../../stores/browserStore';
import '../../../plugins/builtinPanels';
import { ColormapEditorInline } from '../ColormapEditor';
import { RuleEditor } from './RuleEditor';
import { describeNucConditions } from './NucConditionEditor';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const baseRule: ColorRule = {
  id: 'r1', name: 'Nuc test', color: '#16a34a', opacity: 1, sizeMin: 1, sizeMax: null,
  targetLayers: [], conditions: [], enabled: true,
};

describe('nucleosome conditions in the colormap rule editor', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function renderRule(rule: ColorRule, onUpdate = vi.fn()) {
    act(() => root.render(
      <RuleEditor
        rule={rule} index={0} onUpdate={onUpdate} onRemove={() => undefined}
        onDragStart={() => undefined} onDragOver={() => undefined} onDrop={() => undefined}
        orthogonalTracks={[]} availableLayers={['nuc', 'tf']} defaultExpanded
      />,
    ));
    return onUpdate;
  }

  it('reads the conditions in one line', () => {
    expect(describeNucConditions({})).toBe('');
    expect(describeNucConditions({ nucCoarse: [2, 3], zMin: -2, zMax: 2, nucTf: false }))
      .toBe('mono/long · z -2 to 2 · nucleosome calls');
    expect(describeNucConditions({ zMax: -2, nucTf: true })).toBe('z ≤ -2 · TF calls');
    expect(describeNucConditions({ nucNamed: [3] })).toBe('octasome');
  });

  it('adds the section on request and edits classes, z and the TF flag', () => {
    const onUpdate = renderRule(baseRule);
    expect(container.querySelector('[data-testid="nuc-condition-editor"]')).toBeNull();
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="labeling-add-nuc-condition"]')!.click());
    expect(container.querySelector('[data-testid="nuc-condition-editor"]')).not.toBeNull();
    act(() => container.querySelector<HTMLInputElement>('[data-testid="nuc-coarse-2"]')!.click());
    expect(onUpdate).toHaveBeenLastCalledWith({ nucCoarse: [2] });
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="nuc-calls-tf"]')!.click());
    expect(onUpdate).toHaveBeenLastCalledWith({ nucTf: true });
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="nuc-calls-any"]')!.click());
    expect(onUpdate).toHaveBeenLastCalledWith({ nucTf: undefined });
    const zMax = container.querySelector<HTMLInputElement>('input[aria-label="z max"]')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => { setValue.call(zMax, '-2'); zMax.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(onUpdate).toHaveBeenLastCalledWith({ zMax: -2 });
    act(() => { setValue.call(zMax, ''); zMax.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(onUpdate).toHaveBeenLastCalledWith({ zMax: null });
  });

  it('shows the section for a rule that sets a condition, with the calibration note on named classes', () => {
    renderRule({ ...baseRule, nucCoarse: [3], nucTf: false });
    const editor = container.querySelector('[data-testid="nuc-condition-editor"]')!;
    expect(editor).not.toBeNull();
    expect(container.querySelector<HTMLInputElement>('[data-testid="nuc-coarse-3"]')!.checked).toBe(true);
    expect(container.querySelector('[data-testid="nuc-calls-nuc"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('[data-testid="nuc-named-note"]')!.textContent).toMatch(/absolute calibration/);
    expect(container.textContent).not.toContain('(no conditions');
  });

  it('adds the size-class template at the top and switches the Size classes layer on', () => {
    useBrowserStore.setState({
      chrom: 'chr1', start: 100, end: 500,
      datasets: [{ id: 'ds1', available_layers: { nuc: true, tf: true, nucsz: true, nucseg: true } }],
      enabledModTypes: { nuc: true, tf: true },
    } as any);
    useBrowserStore.getState().setActiveColormap(DEFAULT_COLORMAP);
    act(() => root.render(<ColormapEditorInline />));
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="add-nuc-size-classes"]')!.click());
    const rules = useBrowserStore.getState().activeColormap.rules;
    expect(rules.slice(0, 7).map(rule => rule.id)).toEqual(
      ['nuc-size-1', 'nuc-size-2', 'nuc-size-3', 'nuc-size-4', 'nuc-size-5', 'nuc-size-0', 'nuc-size-6']);
    expect(rules.slice(7).map(rule => rule.id)).toEqual(DEFAULT_COLORMAP.rules.map(rule => rule.id));
    expect(rules[1]).toMatchObject({ color: '#16a34a', nucCoarse: [2], nucTf: false });
    expect((useBrowserStore.getState().enabledModTypes as Record<string, boolean>).nucsz).toBe(true);
    // Adding again replaces the template instead of stacking a second copy.
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="add-nuc-size-classes"]')!.click());
    expect(useBrowserStore.getState().activeColormap.rules).toHaveLength(7 + DEFAULT_COLORMAP.rules.length);
    // The default colormap itself is untouched.
    expect(DEFAULT_COLORMAP.rules).toHaveLength(5);
  });

  it('says when nucleosome rules cannot match because the layer is off', () => {
    useBrowserStore.setState({
      datasets: [{ id: 'ds1', available_layers: { nuc: true, nucsz: true } }],
      enabledModTypes: { nuc: true, nucsz: false },
    } as any);
    useBrowserStore.getState().setActiveColormap({ ...DEFAULT_COLORMAP, rules: [{ ...baseRule, nucCoarse: [2] }, ...DEFAULT_COLORMAP.rules] });
    act(() => root.render(<ColormapEditorInline />));
    const notice = container.querySelector('[data-testid="nuc-size-layer-off"]')!;
    expect(notice.textContent).toMatch(/size classes are off/);
    act(() => notice.querySelector('button')!.click());
    expect((useBrowserStore.getState().enabledModTypes as Record<string, boolean>).nucsz).toBe(true);
    expect(container.querySelector('[data-testid="nuc-size-layer-off"]')).toBeNull();
  });
});
