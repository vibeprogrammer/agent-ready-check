#!/usr/bin/env python3
"""Smoke-test a deployed Agent-Ready Check: the agent surfaces answer as the service promises.

    python3 infra/check_site.py https://agent-ready-check.example.com

Standard library only (Python 3.9+). Exit code 1 when a check fails. Called by deploy.sh / deploy.ps1 after a deploy.
"""
import hashlib
import json
import os
import sys
import urllib.error
import urllib.request

UA = "agent-ready-check-deploy-smoke/1.0"


def req(url, method="GET", headers=None, body=None, timeout=60):
    h = {"User-Agent": UA, **(headers or {})}
    data = body.encode() if isinstance(body, str) else body
    r = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, {k.lower(): v for k, v in resp.headers.items()}, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, {k.lower(): v for k, v in e.headers.items()}, e.read().decode("utf-8", "replace")


def main(base):
    base = base.rstrip("/")
    results = []

    def check(name, fn):
        try:
            ok, note = fn()
        except Exception as e:  # noqa: BLE001 - report every failure the same way
            ok, note = False, f"{type(e).__name__}: {e}"
        results.append((ok, name, note))

    def health():
        s, h, b = req(base + "/api/health")
        j = json.loads(b)
        browser_ok = j.get("browser") is True or os.environ.get("EXPECT_BROWSER") != "1"
        return s == 200 and j.get("status") == "ok" and browser_ok, f"HTTP {s}, browser {j.get('browser')}, store {j.get('store')}, {j.get('checks')} checks"

    def link_headers():
        s, h, _ = req(base + "/", headers={"Accept": "text/html"})
        link = h.get("link", "")
        want = ["api-catalog", "service-desc", "describedby", "ard"]
        missing = [w for w in want if f'rel="{w}"' not in link]
        return s == 200 and not missing, f"HTTP {s}" + (f", missing rel {missing}" if missing else ", Link has " + ", ".join(want))

    def markdown():
        s, h, b = req(base + "/", headers={"Accept": "text/markdown"})
        return s == 200 and h.get("content-type", "").startswith("text/markdown") and "accept" in h.get("vary", "").lower(), f"HTTP {s}, {h.get('content-type')}, Vary {h.get('vary')}"

    def robots():
        s, h, b = req(base + "/robots.txt")
        return s == 200 and "User-agent:" in b and "Content-Signal:" in b and "Sitemap:" in b, f"HTTP {s}, {len(b)} bytes"

    def sitemap():
        s, h, b = req(base + "/sitemap.xml")
        return s == 200 and "<urlset" in b and "<lastmod>" in b, f"HTTP {s}"

    def llms():
        s, h, b = req(base + "/llms.txt")
        return s == 200 and b.startswith("# ") and "](" in b, f"HTTP {s}, {len(b)} bytes"

    def catalog():
        s, h, b = req(base + "/.well-known/api-catalog")
        return s == 200 and "linkset+json" in h.get("content-type", "") and len(json.loads(b).get("linkset", [])) > 0, f"HTTP {s}, {h.get('content-type')}"

    def card():
        s, h, b = req(base + "/.well-known/mcp/server-card.json")
        j = json.loads(b)
        return s == 200 and bool(j.get("name")), f"HTTP {s}, name {j.get('name')}"

    def skills():
        s, h, b = req(base + "/.well-known/agent-skills/index.json")
        sk = json.loads(b)["skills"][0]
        s2, _, md = req(base + sk["url"] if sk["url"].startswith("/") else sk["url"])
        digest = "sha256:" + hashlib.sha256(md.encode("utf-8")).hexdigest()
        return s == 200 and s2 == 200 and digest == sk["digest"], f"digest {'matches' if digest == sk['digest'] else 'DIFFERS'}"

    def ard():
        s, h, b = req(base + "/.well-known/ard.json")
        j = json.loads(b)
        return s == 200 and j.get("specVersion") and len(j.get("entries", [])) > 0, f"HTTP {s}, {len(j.get('entries', []))} entries"

    def mcp_list():
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}})
        s, h, b = req(base + "/mcp", "POST", {"Content-Type": "application/json", "Accept": "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25"}, body)
        names = [t["name"] for t in json.loads(b)["result"]["tools"]]
        return s == 200 and "scan_site" in names, f"tools {', '.join(names)}"

    def mcp_origin():
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "ping"})
        s, h, b = req(base + "/mcp", "POST", {"Content-Type": "application/json", "Origin": "https://evil.example"}, body)
        return s == 403, f"foreign Origin -> HTTP {s}"

    def problem():
        s, h, b = req(base + "/api/does-not-exist", headers={"Accept": "application/json"})
        return s == 404 and h.get("content-type", "").startswith("application/problem+json"), f"HTTP {s}, {h.get('content-type')}"

    def security():
        s, h, b = req(base + "/")
        want = ["content-security-policy", "x-content-type-options", "strict-transport-security"]
        missing = [w for w in want if w not in h]
        return not missing, "missing " + ", ".join(missing) if missing else "CSP, nosniff, HSTS present"

    for name, fn in [("health", health), ("Link headers on /", link_headers), ("Markdown negotiation", markdown), ("robots.txt", robots),
                     ("sitemap.xml", sitemap), ("llms.txt", llms), ("API catalog", catalog), ("MCP server card", card),
                     ("Agent Skills digest", skills), ("ARD manifest", ard), ("MCP tools/list", mcp_list), ("MCP Origin check", mcp_origin),
                     ("problem+json 404", problem), ("security headers", security)]:
        check(name, fn)

    width = max(len(n) for _, n, _ in results)
    for ok, name, note in results:
        print(f"   {'OK  ' if ok else 'FAIL'} {name.ljust(width)}  {note}")
    failed = [n for ok, n, _ in results if not ok]
    print(f"   {len(results) - len(failed)}/{len(results)} smoke checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
