import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TUTORIAL_ANCHORS, tutorialAnchorById } from './tutorialAnchors';
import { COPILOT_TEACH_ACTIONS, splitTeachActions } from './copilotTeach';
import milestones from '../data/tutorialMilestones.json';

const SRC = resolve(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(tsx?)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

// Components, and the panel registry (plugins) that names each panel's content type.
const SOURCE = [...sourceFiles(join(SRC, 'components')), ...sourceFiles(join(SRC, 'plugins'))].map(f => readFileSync(f, 'utf8')).join('\n');
const SOURCE_LOWER = SOURCE.toLowerCase();

/** `${prefix}${expr}${suffix}` template attribute values in the components, e.g. `toolbar-group-${testId}`. */
const TEMPLATES = [...SOURCE.matchAll(/`([a-z0-9.-]*)\$\{[^}`]+\}([a-z0-9.-]*)`/g)]
  .map(m => ({ prefix: m[1], suffix: m[2] }))
  .filter(t => t.prefix || t.suffix);

/** Whether an attribute value is rendered somewhere: literally, or by a template whose variable part is a literal. */
function rendered(value: string): boolean {
  if (SOURCE.includes(`"${value}"`) || SOURCE.includes(`'${value}'`)) return true;
  return TEMPLATES.some(({ prefix, suffix }) => {
    if (!value.startsWith(prefix) || !value.endsWith(suffix) || value.length <= prefix.length + suffix.length) return false;
    const middle = value.slice(prefix.length, value.length - suffix.length).toLowerCase();
    return SOURCE_LOWER.includes(`"${middle}"`) || SOURCE_LOWER.includes(`'${middle}'`);
  });
}

describe('tutorial anchor catalog', () => {
  it('has unique ids, each with a selector, place and description', () => {
    const ids = TUTORIAL_ANCHORS.map(a => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const a of TUTORIAL_ANCHORS) {
      expect(a.selector && a.label && a.where && a.description, a.id).toBeTruthy();
      if (a.reveal.expand) expect(tutorialAnchorById(a.reveal.expand), `${a.id} expands ${a.reveal.expand}`).toBeTruthy();
    }
  });

  it('points only at elements the components render', () => {
    const missing: string[] = [];
    for (const a of TUTORIAL_ANCHORS) {
      for (const [, value] of a.selector.matchAll(/\[[a-z-]+[\^$*]?="([^"]+)"\]/g)) {
        if (!rendered(value)) missing.push(`${a.id}: ${value}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('covers every fix anchor the troubleshooting diagnostics use', () => {
    const diagnostics = readFileSync(join(SRC, 'utils/copilotDiagnostics.ts'), 'utf8');
    const union = diagnostics.match(/export type CopilotFixAnchor =([^;]+);/)?.[1] ?? '';
    const ids = [...union.matchAll(/'([a-z-]+)'/g)].map(m => m[1]);
    expect(ids.length).toBeGreaterThan(10);
    expect(ids.filter(id => !tutorialAnchorById(id))).toEqual([]);
  });

  it('gives milestones and conditions anchors from the catalog', () => {
    for (const entry of [...milestones.milestones, ...milestones.conditions]) {
      expect(tutorialAnchorById(entry.anchor), entry.id).toBeTruthy();
    }
  });
});

describe('teach-only allowlist', () => {
  it('matches the backend allowlist', () => {
    const backend = readFileSync(resolve(SRC, '../../services/copilot_tutorial.py'), 'utf8');
    const block = backend.match(/COPILOT_TEACH_ACTIONS = frozenset\(\{([^}]+)\}\)/)?.[1] ?? '';
    const backendIds = [...block.matchAll(/"([a-z_]+)"/g)].map(m => m[1]).sort();
    expect(backendIds).toEqual([...COPILOT_TEACH_ACTIONS].sort());
  });

  it('keeps teach steps and drops operations', () => {
    const { allowed, dropped } = splitTeachActions([
      { type: 'explain' }, { type: 'try_it' }, { type: 'navigate_region' }, { type: 'scan_peaks' }, { type: 'cluster_selected_peaks' },
    ]);
    expect(allowed.map(a => a.type)).toEqual(['explain', 'try_it', 'navigate_region']);
    expect(dropped.map(a => a.type)).toEqual(['scan_peaks', 'cluster_selected_peaks']);
  });
});
