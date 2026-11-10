// Builds loadable extension folders: dist/chrome and dist/firefox.
// No dependencies: copies src/ and writes a browser-specific manifest.json.
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = async (path) => JSON.parse(await readFile(join(root, path), 'utf8'));

const pkg = await readJson('package.json');
const base = await readJson('manifests/base.json');

for (const browser of ['chrome', 'firefox']) {
  const out = join(root, 'dist', browser);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await cp(join(root, 'src'), out, { recursive: true });
  const manifest = { ...base, version: pkg.version, ...(await readJson(`manifests/${browser}.json`)) };
  await writeFile(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Built dist/${browser}`);
}
