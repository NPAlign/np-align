// Stamps every script reference with a version (?v=...) so browsers fetch the
// newest code after an update instead of a saved old copy.
//   node tools/stamp-version.mjs
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const v = new Date().toISOString().replace(/\D/g, '').slice(0, 12); // e.g. 202611181015

const files = ['index.html', ...readdirSync(join(root, 'src')).filter((f) => f.endsWith('.js')).map((f) => `src/${f}`)];
for (const f of files) {
  const p = join(root, f);
  const before = readFileSync(p, 'utf8');
  const after = before
    // import ... from './x.js'  /  import('./x.js')
    .replace(/(from\s+['"]\.\/[\w-]+\.js)(\?v=\d+)?(['"])/g, `$1?v=${v}$3`)
    // new URL('./worker.js', import.meta.url)
    .replace(/(new URL\(['"]\.\/[\w-]+\.js)(\?v=\d+)?(['"])/g, `$1?v=${v}$3`)
    // <script src="src/app.js"> and <link href="styles.css">
    .replace(/((?:src|href)="(?:src\/[\w-]+\.js|styles\.css))(\?v=\d+)?(")/g, `$1?v=${v}$3`);
  if (after !== before) writeFileSync(p, after);
}
console.log(`stamped version ${v}`);
