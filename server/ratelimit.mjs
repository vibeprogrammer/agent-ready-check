// In-memory fixed-window rate limiter (one process). Interface shared with d1RateLimiter:
//   hit(key) -> Promise<{ allowed, limit, remaining, reset (s), window (s), policy }>
// Headers follow draft-ietf-httpapi-ratelimit-headers-11 (IETF WG draft, May 2026; book ch. 7 and Appendix B):
//   RateLimit-Policy: "scans";q=10;w=600     RateLimit: "scans";r=7;t=412
export function memoryRateLimiter({ limit = 10, windowSeconds = 600, policy = 'scans', now = () => Date.now(), maxKeys = 10_000 } = {}) {
  const windows = new Map();
  return {
    limit, windowSeconds, policy,
    async hit(key) {
      const t = now();
      let w = windows.get(key);
      if (!w || t - w.start >= windowSeconds * 1000) {
        w = { start: t, used: 0 };
        windows.delete(key);
        windows.set(key, w);
        if (windows.size > maxKeys) windows.delete(windows.keys().next().value);
      }
      const reset = Math.max(0, Math.ceil((w.start + windowSeconds * 1000 - t) / 1000));
      if (w.used >= limit) return { allowed: false, limit, remaining: 0, reset, window: windowSeconds, policy };
      w.used += 1;
      return { allowed: true, limit, remaining: limit - w.used, reset, window: windowSeconds, policy };
    },
  };
}

/** RateLimit-Policy and RateLimit header values for a hit result. */
export function rateLimitHeaders(h) {
  return {
    'RateLimit-Policy': `"${h.policy}";q=${h.limit};w=${h.window}`,
    RateLimit: `"${h.policy}";r=${h.remaining};t=${h.reset}`,
  };
}
