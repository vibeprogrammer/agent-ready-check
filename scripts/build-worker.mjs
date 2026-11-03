// Bundle server/worker.mjs into dist/worker/_worker.mjs for a Cloudflare Worker (static assets + D1).
//   node scripts/build-worker.mjs [--out dist/worker]
// - ESM, platform neutral, conditions worker/browser, JSON imports inlined, minified.
// - public/ is copied next to the bundle as static assets; public/index.html is inlined into the bundle
//   instead (as the virtual module "virtual:home-html"), so "/" is answered by the Worker with its Link
//   headers and Markdown negotiation rather than by the asset layer.
// - tab-site.json declares the Worker entry and the D1 binding.
// - Fails when the bundle imports a node: built-in (the core must stay runtime-neutral).
import { build } from 'esbuild';
import { mkdir, rm, cp, readFile, writeFile, stat, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const outArg = process.argv.indexOf('--out');
const OUT = join(ROOT, outArg > 0 ? process.argv[outArg + 1] : 'dist/worker');
const PUBLIC = join(ROOT, 'public');

const homeHtml = existsSync(join(PUBLIC, 'index.html')) ? await readFile(join(PUBLIC, 'index.html'), 'utf8') : '';

const virtualHome = {
  name: 'virtual-home-html',
  setup(b) {
    b.onResolve({ filter: /^virtual:home-html$/ }, () => ({ path: 'home-html', namespace: 'virtual' }));
    b.onLoad({ filter: /.*/, namespace: 'virtual' }, () => ({ contents: `export default ${JSON.stringify(homeHtml)};`, loader: 'js' }));
  },
};

// Optional Node-only modules some core files import lazily; they must never reach the Worker bundle.
const forbidNode = {
  name: 'forbid-node',
  setup(b) {
    b.onResolve({ filter: /^node:|^(fs|path|http|https|zlib|dns|net|tls|child_process|os|crypto|stream|url)$/ }, (args) => ({ errors: [{ text: `Node built-in "${args.path}" imported by ${args.importer} would not run in a Worker` }] }));
    // linkedom tries require('canvas') and falls back to its shim; bundle the shim so nothing stays external.
    b.onResolve({ filter: /^canvas$/ }, () => ({ path: join(ROOT, 'node_modules/linkedom/commonjs/canvas-shim.cjs') }));
    b.onResolve({ filter: /^(playwright-core|axe-core|@playwright\/test)$/ }, (args) => ({ path: args.path, external: true }));
  },
};

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const result = await build({
  entryPoints: [join(ROOT, 'server/worker.mjs')],
  outfile: join(OUT, '_worker.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  conditions: ['worker', 'browser'],
  mainFields: ['module', 'main'],
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  metafile: true,
  logLevel: 'warning',
  plugins: [virtualHome, forbidNode],
  // The browser runner's URL and token come from the deployer's environment at build time; never committed.
  define: {
    __BROWSER_RUNNER_URL__: JSON.stringify(process.env.BROWSER_RUNNER_URL || ''),
    __RUNNER_TOKEN__: JSON.stringify(process.env.RUNNER_TOKEN || ''),
  },
});

// Check what the bundle still imports at run time (from esbuild's metafile, not a regex over minified code).
const imports = Object.values(result.metafile.outputs).flatMap((o) => o.imports || []).filter((i) => i.external).map((i) => i.path);
const nodeImports = imports.filter((p) => p.startsWith('node:'));
if (nodeImports.length) {
  console.error(`The Worker bundle imports Node built-ins: ${[...new Set(nodeImports)].join(', ')}`);
  process.exit(1);
}
if (imports.length) console.warn(`Note: the bundle keeps dynamic imports of ${[...new Set(imports)].join(', ')} (browser-only code paths, never taken in the Worker).`);

if (existsSync(PUBLIC)) {
  await cp(PUBLIC, OUT, { recursive: true, filter: (src) => src !== join(PUBLIC, 'index.html') });
}
await writeFile(join(OUT, 'tab-site.json'), `${JSON.stringify({
  kind: 'worker',
  entry: '_worker.mjs',
  bindings: [{ type: 'd1', name: 'DB' }],
  worker: { compatibility_date: '2026-08-01', compatibility_flags: ['nodejs_compat'], not_found_handling: 'none' },
}, null, 2)}\n`);

const size = (await stat(join(OUT, '_worker.mjs'))).size;
const files = (await readdir(OUT, { recursive: true })).length;
console.log(`dist/worker/_worker.mjs ${(size / 1024).toFixed(0)} KiB, ${files} files in ${OUT.replace(ROOT, '')}${homeHtml ? ', home page inlined' : ', home page rendered by src/report'}`);
