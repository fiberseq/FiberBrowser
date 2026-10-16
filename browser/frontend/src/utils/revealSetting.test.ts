import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { revealSetting } from './revealSetting';
import type { SettingDef } from './settingsCatalog';

describe('revealSetting', () => {
  // jsdom has no CSS: a folded group's card is display:none through its `hidden` class.
  const proto = HTMLElement.prototype as HTMLElement & { checkVisibility?: () => boolean };
  const had = proto.checkVisibility;
  beforeAll(() => { proto.checkVisibility = function (this: HTMLElement) { return !this.closest('.hidden'); }; });
  afterAll(() => { proto.checkVisibility = had; });
  afterEach(() => { document.body.innerHTML = ''; });

  it("waits for the control on show, not a hidden copy (a folded group's card; Codex review)", async () => {
    document.body.innerHTML = `
      <div data-testid="operations-toolbar">
        <div data-testid="toolbar-group-reads">
          <div class="hidden"><span data-testid="read-display-mode-toggle" id="hidden-copy"></span></div>
        </div>
      </div>`;
    const setting: SettingDef = {
      id: 'x', label: 'Reads: Fit or All',
      location: { kind: 'toolbar', group: 'reads', groupLabel: 'Reads', selector: '[data-testid="read-display-mode-toggle"]' },
    };
    // The group opens a moment later and renders the real control.
    setTimeout(() => {
      const shown = document.createElement('span');
      shown.dataset.testid = 'read-display-mode-toggle';
      shown.id = 'shown';
      shown.innerHTML = '<button>Fit</button>';
      document.querySelector('[data-testid="toolbar-group-reads"]')!.appendChild(shown);
    }, 60);
    expect(await revealSetting(setting)).toBe(true);
    expect(document.getElementById('shown')!.hasAttribute('data-setting-revealed')).toBe(true);
    expect(document.getElementById('hidden-copy')!.hasAttribute('data-setting-revealed')).toBe(false);
    expect(document.activeElement?.textContent).toBe('Fit');
  });
});
