// Node transport: http/https request pinned to the address the guard checked
// (the socket connects to that IP, so a DNS answer cannot change between check and connect).
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import dns from 'node:dns/promises';

export async function resolve(host) {
  const r = await dns.lookup(host, { all: true, verbatim: true });
  return r.map((x) => x.address);
}

export function transport({ method, url, headers, body, timeoutMs, maxBytes, address }) {
  return new Promise((resolveP, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const t0 = Date.now();
    let ttfb = 0;
    const req = mod.request(url, {
      method, headers, timeout: timeoutMs,
      // Pin the connection to the checked address; keep SNI/Host as the hostname.
      lookup: address ? (hostname, opts, cb) => {
        const family = address.includes(':') ? 6 : 4;
        if (opts && opts.all) cb(null, [{ address, family }]); else cb(null, address, family);
      } : undefined,
      rejectUnauthorized: true,
    }, (res) => {
      ttfb = Date.now() - t0;
      let stream = res;
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      try {
        if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
        else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
        else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      } catch { stream = res; }
      const chunks = []; let size = 0; let truncated = false; let done = false;
      const finish = () => {
        if (done) return; done = true;
        const hdrs = {};
        for (let i = 0; i < res.rawHeaders.length; i += 2) {
          const k = res.rawHeaders[i].toLowerCase(); const v = res.rawHeaders[i + 1];
          hdrs[k] = hdrs[k] ? `${hdrs[k]}, ${v}` : v;
        }
        resolveP({ status: res.statusCode, headers: hdrs, body: new Uint8Array(Buffer.concat(chunks)), truncated, ttfb });
      };
      if (method === 'HEAD' || res.statusCode === 204 || res.statusCode === 304) { res.resume(); res.on('end', finish); return; }
      stream.on('data', (c) => {
        if (size + c.length > maxBytes) { chunks.push(c.subarray(0, maxBytes - size)); size = maxBytes; truncated = true; req.destroy(); finish(); return; }
        chunks.push(c); size += c.length;
      });
      stream.on('end', finish);
      stream.on('error', (e) => { if (!done) { if (chunks.length) { truncated = true; finish(); } else reject(e); } });
    });
    req.on('timeout', () => { req.destroy(Object.assign(new Error(`timed out after ${timeoutMs} ms`), { code: 'timeout' })); });
    req.on('error', (e) => reject(e));
    if (body) req.write(body);
    req.end();
  });
}
