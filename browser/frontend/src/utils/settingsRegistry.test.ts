/**
 * Every setting in the settings sidebar can be found by the command palette and
 * the settings search: each control is tagged with a registered setting (a
 * label and synonyms to find it by), and every definition is registered and
 * used. A new control without a setting fails here, naming its file and line.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { allSettings } from './settingsRegistry';
import { SIDEBAR_SECTIONS, SIDEBAR_SUBSECTIONS } from './settingsCatalog';

const SRC = path.resolve(__dirname, '..');
const SIDEBAR_DIR = path.join(SRC, 'components/controls/sidebar');

/** Files under the sidebar folder that are not settings-sidebar content. */
const NOT_SIDEBAR: Record<string, string> = {
  'shared/SidebarSetting.tsx': 'the row and toggle components themselves: their callers pass `setting`',
  'file/ConnectClusterDialog.tsx': 'a dialog (sign in to a cluster), not a setting',
  'file/SessionRelinkDialog.tsx': 'a dialog (find moved files), not a setting',
  'haplotype/HaplotypeComparisonForm.tsx': 'shown in the Regions and Contacts panels, not the sidebar',
  'haplotype/HaplotypeComparisonSettings.tsx': 'shown in the Regions and Contacts panels, not the sidebar',
  'SettingsSearch.tsx': 'the settings search field itself',
};

/** Sidebar subsections rendered from files outside the sidebar folder. */
const SUBSECTION_FILES = [
  'components/controls/library/LibraryHost.tsx',
  'components/controls/daf-run/DafRunEntryPoints.tsx',
  'components/controls/sidebar/DataSection.tsx',
  'components/controls/sidebar/GenomeSection.tsx',
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

const CONTROL_TAGS = new Set(['input', 'select', 'textarea', 'SidebarSettingToggle', 'SidebarSettingRow']);

function tagName(node: ts.JsxOpeningLikeElement): string {
  return node.tagName.getText();
}

function attributes(node: ts.JsxOpeningLikeElement): ts.JsxAttributeLike[] {
  return [...node.attributes.properties];
}

function attrText(node: ts.JsxOpeningLikeElement, name: string): string | undefined {
  for (const attr of attributes(node)) {
    if (ts.isJsxAttribute(attr) && attr.name.getText() === name) {
      const init = attr.initializer;
      if (!init) return '';
      return ts.isStringLiteral(init) ? init.text : init.getText();
    }
  }
  return undefined;
}

/** Tagged with a setting: `setting={…}`, `{...settingAnchor(…)}` or `data-setting-id`. */
function isAnchor(node: ts.JsxOpeningLikeElement): boolean {
  return attributes(node).some(attr => (
    (ts.isJsxAttribute(attr) && ['setting', 'data-setting-id'].includes(attr.name.getText()))
    || (ts.isJsxSpreadAttribute(attr) && /settingAnchor\(/.test(attr.expression.getText()))
  ));
}

function openingOf(node: ts.Node): ts.JsxOpeningLikeElement | undefined {
  if (ts.isJsxElement(node)) return node.openingElement;
  if (ts.isJsxSelfClosingElement(node)) return node;
  return undefined;
}

/**
 * The form controls in a TSX source without a setting on them or around them
 * (within the same file). `within`: only controls inside that component
 * (e.g. SidebarSubSection, for files that also render dialogs).
 */
export function untaggedControls(source: string, fileName = 'x.tsx', within?: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const visit = (node: ts.Node, anchored: boolean, inside: boolean) => {
    const opening = openingOf(node);
    let nowAnchored = anchored;
    let nowInside = inside;
    if (opening) {
      const tag = tagName(opening);
      if (within && tag === within) nowInside = true;
      if (isAnchor(opening)) nowAnchored = true;
      const type = attrText(opening, 'type');
      const isControl = CONTROL_TAGS.has(tag) && !(tag === 'input' && (type === 'hidden' || type === 'file'));
      if (isControl && nowInside && !nowAnchored) {
        const { line } = sf.getLineAndCharacterOfPosition(opening.getStart());
        out.push(`${fileName}:${line + 1} <${tag}>`);
      }
    }
    ts.forEachChild(node, child => visit(child, nowAnchored, nowInside));
  };
  visit(sf, false, !within);
  return out;
}

const rel = (file: string) => path.relative(path.join(SRC, '..'), file);

describe('settings registry', () => {
  const settings = allSettings();

  it('every setting has a unique id, a label and a real place', () => {
    const ids = settings.map(s => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const setting of settings) {
      expect(setting.label.trim(), setting.id).not.toBe('');
      const where = setting.location;
      if (where.kind === 'sidebar') {
        expect(Object.keys(SIDEBAR_SECTIONS), setting.id).toContain(where.section);
        if (where.subsection) expect(SIDEBAR_SUBSECTIONS[where.subsection]?.section, setting.id).toBe(where.section);
      }
      if (where.kind === 'toolbar') expect(where.selector, setting.id).not.toBe('');
    }
  });

  it('every control in the settings sidebar is tagged with a setting', () => {
    const files = walk(SIDEBAR_DIR).filter(file => file.endsWith('.tsx') && !NOT_SIDEBAR[path.relative(SIDEBAR_DIR, file)]);
    const offenders = files.flatMap(file => untaggedControls(readFileSync(file, 'utf8'), rel(file)));
    // Sidebar subsections defined in other folders: their controls inside the subsection.
    for (const file of SUBSECTION_FILES.map(f => path.join(SRC, f))) {
      if (file.startsWith(SIDEBAR_DIR)) continue;
      offenders.push(...untaggedControls(readFileSync(file, 'utf8'), rel(file), 'SidebarSubSection'));
    }
    expect(offenders, 'Define these with defineSettings (utils/settingsCatalog) and tag them with settingAnchor() or setting={…}').toEqual([]);
  });

  it('the check catches a control without a setting (a new setting with no label)', () => {
    const bare = `export function X(){return <div><label><input type="checkbox"/> New thing</label></div>;}`;
    expect(untaggedControls(bare)).toEqual(['x.tsx:1 <input>']);
    const row = `export function X(){return <SidebarSettingRow label="New"><select/></SidebarSettingRow>;}`;
    expect(untaggedControls(row)).toEqual(['x.tsx:1 <SidebarSettingRow>', 'x.tsx:1 <select>']);
    const tagged = `export function X(){return <label {...settingAnchor(S.x)}><input type="checkbox"/></label>;}`;
    expect(untaggedControls(tagged)).toEqual([]);
    expect(untaggedControls(`export function X(){return <SidebarSettingToggle setting={S.x} checked onChange={f}/>;}`)).toEqual([]);
    expect(untaggedControls(`export function X(){return <input type="file"/>;}`)).toEqual([]);
  });

  it('every settings definition is registered, and every one is used by its control', () => {
    const registry = readFileSync(path.join(SRC, 'utils/settingsRegistry.ts'), 'utf8');
    const defining = walk(path.join(SRC, 'components')).filter(file => /defineSettings\(/.test(readFileSync(file, 'utf8')));
    expect(defining.length).toBeGreaterThan(10);
    const missing: string[] = [];
    const unused: string[] = [];
    for (const file of defining) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/export const (\w+)\s*=\s*defineSettings\(\{([\s\S]*?)\n\}\);/g)) {
        const [, name, body] = match;
        if (!new RegExp(`\\b${name}\\b`).test(registry)) missing.push(`${rel(file)}: ${name}`);
        // Top-level keys of the object: `  key: {` (or `key:{`).
        const keys = [...body.matchAll(/^\s{0,2}(\w+):\s*(?:\{|cigarSetting)/gm)].map(m => m[1]);
        expect(keys.length, `${rel(file)}: ${name}`).toBeGreaterThan(0);
        for (const key of keys) {
          const used = new RegExp(`(settingAnchor\\(\\s*${name}\\.${key}\\s*\\))|(setting=\\{\\s*${name}\\.${key}\\s*\\})`).test(source);
          if (!used) unused.push(`${rel(file)}: ${name}.${key}`);
        }
      }
    }
    expect(missing, 'add these to utils/settingsRegistry.ts').toEqual([]);
    expect(unused, 'a setting whose control is gone (remove it) or not tagged').toEqual([]);
  });

  it('the subsection names match the sidebar', () => {
    const sources = [...walk(SIDEBAR_DIR), ...SUBSECTION_FILES.map(f => path.join(SRC, f))]
      .filter(file => !NOT_SIDEBAR[path.relative(SIDEBAR_DIR, file)])
      .map(file => readFileSync(file, 'utf8'));
    const found = new Map<string, string>();
    for (const source of sources) {
      for (const m of source.matchAll(/<SidebarSubSection\s+id="([^"]+)"\s+label="([^"]+)"/g)) found.set(m[1], m[2]);
    }
    expect(Object.fromEntries(found)).toEqual(Object.fromEntries(Object.entries(SIDEBAR_SUBSECTIONS).map(([id, s]) => [id, s.label])));
    for (const [id, sub] of Object.entries(SIDEBAR_SUBSECTIONS)) expect(id.split('.')[0], id).toBe(sub.section);
    // The sections' own names: the sidebar (each page, in rail order) and the rail render them from SIDEBAR_SECTIONS.
    const sidebar = readFileSync(path.join(SRC, 'components/controls/Sidebar.tsx'), 'utf8');
    const rail = readFileSync(path.join(SRC, 'components/controls/SidebarIconStrip.tsx'), 'utf8');
    expect(sidebar).toContain('label={SIDEBAR_SECTIONS[id].label}');
    expect(sidebar).toContain(`SECTION_ORDER: SidebarSectionId[] = [${Object.keys(SIDEBAR_SECTIONS).map(id => `'${id}'`).join(', ')}]`);
    for (const id of Object.keys(SIDEBAR_SECTIONS)) expect(rail).toContain(`label: SIDEBAR_SECTIONS.${id}.label`);
  });

  it('on/off settings read and flip their value', async () => {
    const { useBrowserStore } = await import('../stores/browserStore');
    const before = useBrowserStore.getState();
    try {
      for (const setting of settings.filter(s => s.toggle && s.id !== 'chrome.per-panel-navigation')) {
        const was = setting.toggle!.get();
        setting.toggle!.set(!was);
        expect(setting.toggle!.get(), setting.id).toBe(!was);
        setting.toggle!.set(was);
        expect(setting.toggle!.get(), setting.id).toBe(was);
      }
    } finally {
      useBrowserStore.setState(before, true);
    }
  });
});
