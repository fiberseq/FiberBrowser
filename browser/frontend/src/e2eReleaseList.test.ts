/** Every Playwright spec is either in CI's release list (test:e2e:release) or listed, with why, in
 *  tests/e2e/release-exclusions.json: a new spec can't be left out silently (3.1.1: fifteen 3.1 specs were). */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');
const specs = (dir: string): string[] => readdirSync(dir).flatMap(f => {
  const p = path.join(dir, f);
  return statSync(p).isDirectory() ? specs(p) : f.endsWith('.spec.ts') ? [path.relative(root, p).split(path.sep).join('/')] : [];
});

describe('e2e release list', () => {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const filters: string[] = pkg.scripts['test:e2e:release'].split(/\s+/).slice(2);
  const excluded: Record<string, string> = JSON.parse(readFileSync(path.join(root, 'tests/e2e/release-exclusions.json'), 'utf8')).specs;
  const all = specs(path.join(root, 'tests/e2e'));
  const inRelease = (s: string) => filters.some(f => new RegExp(f).test(s));

  it('every spec is in the release list or excluded with a reason', () => {
    const missing = all.filter(s => !inRelease(s) && !excluded[s]);
    expect(missing).toEqual([]);
    for (const [s, why] of Object.entries(excluded)) expect(why.trim().length, s).toBeGreaterThan(10);
  });
  it('the exclusions name real specs that the release list does not already run', () => {
    expect(Object.keys(excluded).filter(s => !all.includes(s))).toEqual([]);
    expect(Object.keys(excluded).filter(inRelease)).toEqual([]);
  });
});
