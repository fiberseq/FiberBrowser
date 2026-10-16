// @vitest-environment node
/**
 * The toolbar's action colours as the build emits them, not as index.css spells
 * them: Tailwind keeps a component class only when it sees its full name in the
 * source, and fb-r2-layout found a dynamically built tone class missing from the
 * build (Sort and Filter fell back to Scan's blue). This runs PostCSS + Tailwind
 * with the app's own config over index.css, as `vite build` does.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import { beforeAll, describe, expect, it } from 'vitest';
import tailwindConfig from '../../../tailwind.config.js';
import { ACTION_TONE_CLASS } from './ActionButton';
import '../../plugins/builtinPanels';
import { getAnalysisPanel } from '../../plugins/registry';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
let built = '';

beforeAll(async () => {
  const source = readFileSync(path.join(root, 'src/index.css'), 'utf8');
  const config = {
    ...tailwindConfig,
    // The app's sources only: a class named only in a test must not count as kept.
    content: [
      path.join(root, 'index.html'),
      path.join(root, 'src/**/*.{js,ts,jsx,tsx}').replace(/\\/g, '/'),
      `!${path.join(root, 'src/**/*.test.{ts,tsx}').replace(/\\/g, '/')}`,
    ],
  };
  const result = await postcss([tailwindcss(config as never)]).process(source, { from: path.join(root, 'src/index.css') });
  built = result.css;
}, 120_000);

/** Declarations of every rule whose selector matches `test`. */
function rulesMatching(test: (selector: string) => boolean): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(built))) {
    const selector = m[1].trim();
    if (test(selector)) out.push({ selector, body: m[2] });
  }
  return out;
}

describe('the built stylesheet', () => {
  it('has every action colour class, each with its own tone', () => {
    const tones = Object.entries(ACTION_TONE_CLASS);
    // Scan, Cluster, Sort, Filter and (fb-r4-regions) Highlight.
    expect(tones.length).toBe(5);
    for (const [tone, cls] of tones) {
      const rules = rulesMatching(sel => sel.split(',').some(s => s.trim() === `.${cls}`));
      expect(rules.length, `.${cls} in the built CSS`).toBeGreaterThan(0);
      expect(rules.map(r => r.body).join(';')).toContain(`--tone: var(--fb-action-${tone})`);
    }
    // Each tone its own colour.
    const css = readFileSync(path.join(root, 'src/index.css'), 'utf8');
    const values = tones.map(([tone]) => css.match(new RegExp(`--fb-action-${tone}:\\s*(#[0-9a-f]{6})`, 'i'))?.[1]?.toLowerCase());
    expect(values.every(Boolean), JSON.stringify(values)).toBe(true);
    expect(new Set(values).size, JSON.stringify(values)).toBe(tones.length);
  });

  it('a blocked action keeps its colour (faded), never grey', () => {
    const blocked = rulesMatching(sel => sel.includes('.fb-action') && sel.includes('aria-disabled') && !sel.includes(':not([aria-disabled'));
    expect(blocked.length).toBeGreaterThan(0);
    for (const rule of blocked) {
      // Only the fade and the cursor: no grey ink, fill or border replacing the tone.
      expect(rule.body, rule.selector).not.toMatch(/(^|;|\s)(color|background-color|border-color)\s*:/);
    }
    expect(blocked.map(r => r.body).join(';')).toMatch(/opacity:\s*0?\.\d+/);
  });
});

describe('each action matches the panel it leads to', () => {
  const css = readFileSync(path.join(root, 'src/index.css'), 'utf8');
  const token = (tone: string) => css.match(new RegExp(`--fb-action-${tone}:\\s*(#[0-9a-f]{6})`, 'i'))?.[1]?.toLowerCase();
  const panel = (contentType: string) => getAnalysisPanel(contentType)?.headerColor.toLowerCase();
  it('Scan ↔ Peak Detection, Cluster ↔ Clusters, Filter ↔ Rules, Highlight ↔ Regions', () => {
    expect(token('peaks')).toBe(panel('peak-detection'));
    expect(token('highlight')).toBe(panel('circular-genome'));  // the Regions panel
    expect(token('cluster')).toBe(panel('cluster-detail'));
    expect(token('filter')).toBe(panel('cluster-features'));
  });
});
