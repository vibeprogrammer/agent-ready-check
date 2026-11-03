// Starts server/node.mjs on a free port for e2e specs (output to a log file, own process group) and stops it.
import { spawn } from 'node:child_process';
import { openSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

export async function freePort() {
  return new Promise((ok, fail) => {
    const s = net.createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); });
  });
}

export async function startServer(env = {}) {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), 'arc-e2e-'));
  const log = openSync(join(dir, 'server.log'), 'a');
  const child = spawn(process.execPath, ['server/node.mjs'], {
    cwd: ROOT, detached: true, stdio: ['ignore', log, log],
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', REPORTS_DIR: join(dir, 'reports'), ALLOW_PRIVATE: '1', RATE_LIMIT: '50', ...env },
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    try { const r = await fetch(`${base}/api/health`); if (r.ok) break; } catch { /* not up yet */ }
    if (Date.now() > deadline) { stop(); throw new Error(`server did not start, see ${dir}/server.log`); }
    await new Promise((r) => setTimeout(r, 200));
  }
  function stop() {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ }
    setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } rmSync(dir, { recursive: true, force: true }); }, 2000).unref();
  }
  return { base, port, stop, dir };
}
