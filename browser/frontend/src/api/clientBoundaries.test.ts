import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SOURCE_ROOT = join(process.cwd(), 'src');
const ALLOWED_FILES = new Set([
  'api/client.test.ts',
  'api/clientBoundaries.test.ts',
]);
const IMPORT_CLIENT_RE = /from\s+['"][^'"]*api\/client['"]|import\(\s*['"][^'"]*api\/client['"]\s*\)/;

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      collectSourceFiles(path, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

describe('API client module boundaries', () => {
  it('keeps application code off the legacy api/client barrel', () => {
    const offenders = collectSourceFiles(SOURCE_ROOT)
      .map(path => relative(SOURCE_ROOT, path))
      .filter(path => !ALLOWED_FILES.has(path))
      .filter(path => IMPORT_CLIENT_RE.test(readFileSync(join(SOURCE_ROOT, path), 'utf8')));

    expect(offenders).toEqual([]);
  }, 15_000);
});
