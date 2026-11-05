// Build the Azure Static Web Apps deployment:
//   node scripts/build-azure.mjs [--base-url https://agent.isainative.dev]
// Output
//   dist/azure/web/     the static app: /assets/* (CSS, JS, fonts, favicon), a fallback index.html and
//                       staticwebapp.config.json (every other path is rewritten to the managed function)
//   api/dist/index.mjs  the managed Azure Functions app (server/azure-function.mjs + the whole checker, bundled)
// api/package.json keeps @azure/functions as its one installed dependency (npm ci in api/ before deploying).
import { build } from 'esbuild';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { ASSETS, renderHomeHtml } from '../src/report/index.mjs';
import { swaConfig } from './swa-config.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const BASE_URL = arg('--base-url', process.env.BASE_URL || '');
const WEB = join(ROOT, 'dist/azure/web');
const API_DIST = join(ROOT, 'api/dist');

await rm(WEB, { recursive: true, force: true });
await rm(API_DIST, { recursive: true, force: true });
await mkdir(WEB, { recursive: true });

// 1. Static assets, byte-for-byte what the Node server and the Worker serve at the same paths.
for (const [path, a] of Object.entries(ASSETS)) {
  const file = join(WEB, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, a.encoding === 'base64' ? Buffer.from(a.body, 'base64') : a.body);
}
// Static Web Apps needs a default file in the app folder. The "/*" route sends "/" to the function first, so this
// copy is only a fallback; it is the real home page, not a placeholder.
await writeFile(join(WEB, 'index.html'), renderHomeHtml({ baseUrl: BASE_URL }));
await writeFile(join(WEB, 'staticwebapp.config.json'), `${JSON.stringify(swaConfig(), null, 2)}\n`);

// 2. The function bundle: Node 22, ESM, everything bundled except @azure/functions (installed in api/) and the
// browser-only modules (browser checks run on the separate runner, never inside the function).
const nodeExternals = {
  name: 'externals',
  setup(b) {
    b.onResolve({ filter: /^canvas$/ }, () => ({ path: join(ROOT, 'node_modules/linkedom/commonjs/canvas-shim.cjs') }));
    b.onResolve({ filter: /^(@azure\/functions|playwright-core|axe-core|@playwright\/test)$/ }, (args) => ({ path: args.path, external: true }));
  },
};
const result = await build({
  entryPoints: [join(ROOT, 'server/azure-function.mjs')],
  outfile: join(API_DIST, 'index.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  minify: true,
  legalComments: 'none',
  metafile: true,
  logLevel: 'warning',
  plugins: [nodeExternals],
  // CommonJS dependencies inside an ESM bundle still call require() for Node built-ins.
  banner: { js: "import { createRequire as __arcCreateRequire } from 'node:module'; const require = __arcCreateRequire(import.meta.url);" },
});
const out = Object.values(result.metafile.outputs)[0];
const ext = [...new Set((out.imports || []).filter((i) => i.external && !i.path.startsWith('node:')).map((i) => i.path))];
console.log(`api/dist/index.mjs ${(out.bytes / 1024).toFixed(0)} KiB; external: ${ext.join(', ') || 'none'}`);
console.log(`dist/azure/web: ${Object.keys(ASSETS).length} assets, index.html, staticwebapp.config.json${BASE_URL ? ` (base ${BASE_URL})` : ''}`);
