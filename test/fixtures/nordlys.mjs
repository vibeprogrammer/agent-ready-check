// Start the Nordlys Cabins demo (github.com/webmaxru/agent-ready-web-demos, MIT, by Maxim Salnikov)
// at a given --upto layer, on a free local port. DEMOS_DIR points at a checkout with `npm ci` done.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, openSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

export const DEMOS_DIR = resolve(process.env.DEMOS_DIR || '../demos');
export const hasDemos = () => existsSync(join(DEMOS_DIR, 'nordlys-cabins', 'server.js')) && existsSync(join(DEMOS_DIR, 'node_modules', 'hono'));

function freePort() {
  return new Promise((res, rej) => { const s = createServer(); s.unref(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
}

/** @returns {Promise<{url:string, close:()=>void}>} */
export async function startNordlys({ upto = 20, variant = 'clean' } = {}) {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const logFile = join(tmpdir(), `nordlys-${upto}-${variant}-${port}.log`);
  const fd = openSync(logFile, 'w');
  const child = spawn(process.execPath, ['server.js', `--upto=${upto}`, `--variant=${variant}`, `--port=${port}`, '--host=127.0.0.1', '--now=2026-11-02'], {
    cwd: join(DEMOS_DIR, 'nordlys-cabins'), env: { ...process.env, PUBLIC_ORIGIN: url, PORT: String(port) }, stdio: ['ignore', fd, fd], detached: true,
  });
  closeSync(fd);
  const close = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } } };
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`${url}/__layers`); if (r.ok) return { url, close, logFile }; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  close();
  throw new Error(`Nordlys did not start on ${url}; see ${logFile}`);
}

// The graded fixture set: the chapter layers that change what a grader sees.
export const FIXTURES = [
  { name: 'baseline-legacy', upto: 0, variant: 'legacy' },
  { name: 'upto-02', upto: 2 }, { name: 'upto-03', upto: 3 }, { name: 'upto-04', upto: 4 }, { name: 'upto-05', upto: 5 },
  { name: 'upto-06', upto: 6 }, { name: 'upto-07', upto: 7 }, { name: 'upto-08', upto: 8 }, { name: 'upto-09', upto: 9 },
  { name: 'upto-11', upto: 11 }, { name: 'upto-12', upto: 12 }, { name: 'upto-14', upto: 14 }, { name: 'upto-15', upto: 15 },
  { name: 'upto-16', upto: 16 }, { name: 'upto-17', upto: 17 }, { name: 'full', upto: 20 },
];
