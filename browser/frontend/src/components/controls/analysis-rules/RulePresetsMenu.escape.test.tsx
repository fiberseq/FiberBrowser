import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RulePresetsMenu } from './RuleEditorHeader';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('Rules Presets menu and Escape', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  it('Escape closes the menu without reaching the app-wide Escape shortcut', () => {
    const appShortcut = vi.fn();
    window.addEventListener('keydown', appShortcut);
    try {
      act(() => root.render(
        <RulePresetsMenu noun="cluster rules" savedNames={[]} onSave={() => {}} onLoad={() => {}} onDelete={() => {}} onExportJson={() => {}} onImportJson={() => {}} />,
      ));
      act(() => (container.querySelector('[data-testid="rule-presets-button"]') as HTMLButtonElement).click());
      expect(container.querySelector('[data-testid="rule-presets-menu"]')).not.toBeNull();
      act(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
      expect(container.querySelector('[data-testid="rule-presets-menu"]')).toBeNull();
      expect(appShortcut).not.toHaveBeenCalled();
      // With the menu closed, Escape reaches the app as before.
      act(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
      expect(appShortcut).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('keydown', appShortcut);
    }
  });
});
