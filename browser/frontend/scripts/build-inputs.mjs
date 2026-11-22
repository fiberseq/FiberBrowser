/**
 * What a frontend build was made from, written into the build as `build-inputs.json` (vite.config.ts) and checked
 * by packaging/check_frontend_dist.py, which recomputes the same hashes in Python (keep the two identical).
 *
 * Algorithm (version 1): every file under the listed inputs (relative to browser/frontend), skipping names that start
 * with "." (e.g. .DS_Store) and, for the inputs only, tests (*.test.ts, *.test.tsx) and __fixtures__ folders. Each file
 * gives the line "<sha256 of its bytes>  <POSIX relative path>\n"; the lines, sorted by the UTF-8 bytes of the path,
 * are hashed with sha256. Bytes are hashed as read: a checkout that converts line endings (CRLF) hashes differently.
 * The outputs hash is the same over the build folder, without build-inputs.json.
 *
 *     node scripts/build-inputs.mjs [--frontend DIR] [--outputs DIR]    # prints the hashes as JSON
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERSION = 1;
export const MANIFEST = 'build-inputs.json';
/** The build inputs, relative to browser/frontend (check_frontend_dist.py SOURCES, without the prefix). */
export const INPUTS = [
  'src', 'public', 'index.html', 'package.json', 'package-lock.json', 'vite.config.ts',
  'tsconfig.json', 'tsconfig.node.json', 'tailwind.config.js', 'postcss.config.js',
];

const isTest = (rel) => rel.endsWith('.test.ts') || rel.endsWith('.test.tsx') || rel.split('/').includes('__fixtures__');

function walk(base, rel, out) {
  const path = join(base, ...rel.split('/'));
  if (!existsSync(path)) return;
  if (statSync(path).isDirectory()) {
    for (const name of readdirSync(path)) {
      if (!name.startsWith('.')) walk(base, `${rel}/${name}`, out);
    }
  } else {
    out.push(rel);
  }
}

const byUtf8 = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

/** {files, sha256} over the given relative files of base. */
function digest(base, files) {
  const lines = [...files].sort(byUtf8)
    .map(rel => `${createHash('sha256').update(readFileSync(join(base, ...rel.split('/')))).digest('hex')}  ${rel}\n`);
  return { files: lines.length, sha256: createHash('sha256').update(lines.join(''), 'utf8').digest('hex') };
}

export function hashInputs(frontendDir, inputs = INPUTS) {
  const files = [];
  for (const input of inputs) walk(frontendDir, input, files);
  return digest(frontendDir, files.filter(rel => !isTest(rel)));
}

export function hashOutputs(outDir) {
  const files = [];
  for (const name of existsSync(outDir) ? readdirSync(outDir) : []) {
    if (!name.startsWith('.') && name !== MANIFEST) walk(outDir, name, files);
  }
  return digest(outDir, files);
}

export function manifest(frontendDir, outDir) {
  return {
    version: VERSION,
    inputs: { base: 'browser/frontend', paths: INPUTS, ...hashInputs(frontendDir) },
    outputs: hashOutputs(outDir),
  };
}

const FRONTEND = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

/** Write build-inputs.json into the build folder (outDir resolved against the vite root, as vite does). */
export function writeManifest(root, outDir) {
  const out = resolve(root, outDir);
  writeFileSync(join(out, MANIFEST), `${JSON.stringify(manifest(FRONTEND, out), null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const frontend = resolve(opt('--frontend') ?? FRONTEND);
  const outputs = opt('--outputs');
  const result = { version: VERSION, inputs: { paths: INPUTS, ...hashInputs(frontend) } };
  if (outputs) result.outputs = hashOutputs(resolve(outputs));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
