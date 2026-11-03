// Worker transport: global fetch with manual redirects; DNS via DNS-over-HTTPS for the guard.
export async function resolve(host) {
  const q = async (type) => {
    const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`, { headers: { accept: 'application/dns-json' } });
    if (!r.ok) throw new Error(`DoH ${r.status}`);
    const j = await r.json();
    return (j.Answer || []).filter((a) => a.type === (type === 'A' ? 1 : 28)).map((a) => a.data);
  };
  const [a, aaaa] = await Promise.all([q('A'), q('AAAA').catch(() => [])]);
  return [...a, ...aaaa];
}

export async function transport({ method, url, headers, body, timeoutMs, maxBytes }) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const h = { ...headers }; delete h['accept-encoding'];
    const res = await fetch(url.href, { method, headers: h, body, redirect: 'manual', signal: ctrl.signal });
    const ttfb = Date.now() - t0;
    const hdrs = {}; res.headers.forEach((v, k) => { hdrs[k] = v; });
    let truncated = false; const chunks = []; let size = 0;
    if (res.body && method !== 'HEAD') {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (size + value.byteLength > maxBytes) { chunks.push(value.subarray(0, maxBytes - size)); size = maxBytes; truncated = true; await reader.cancel(); break; }
        chunks.push(value); size += value.byteLength;
      }
    }
    const out = new Uint8Array(size); let o = 0; for (const c of chunks) { out.set(c, o); o += c.byteLength; }
    return { status: res.status, headers: hdrs, body: out, truncated, ttfb };
  } finally { clearTimeout(t); }
}
