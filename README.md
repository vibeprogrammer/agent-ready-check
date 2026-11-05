# Agent-Ready Check

Check how ready a website is for AI agents. **113 checks in 13 layers**, from the accessibility tree and robots.txt to MCP, WebMCP, agent discovery, commerce, identity, security and privacy, with evidence, a fix and a fix prompt for every finding.

It is built on the book **"The Agent-Ready Web"** by Maxim Salnikov and its demos ([webmaxru/agent-ready-web-demos](https://github.com/webmaxru/agent-ready-web-demos), MIT): every check cites the chapter that explains it and the standard behind it, with that standard's status (RFC, W3C Recommendation, draft, vendor proposal), so you do not over-invest in drafts.

> **Live:** https://agent-ready-check.sites.tab.bot (a preview instance). The production home is moving to **https://agent.isainative.dev** on Azure Static Web Apps; see [DEPLOY.md](DEPLOY.md) and [docs/PUBLISHING.md](docs/PUBLISHING.md).

## Compared with isitagentready.com

| | isitagentready.com | Agent-Ready Check |
| --- | --- | --- |
| Checks | 23 in 5 categories | 113 in 13 layers |
| isitagentready Level 0-5 | yes | yes, computed from the same 23 checks with Cloudflare's published rules |
| Lighthouse Agentic Browsing view | no | yes, the 7 audits |
| Perception (accessibility tree, agent-relevant axe rules, server vs rendered HTML) | no | yes (browser mode) |
| Structured data (schema.org validity, parity with visible text) | no | yes |
| Security (hidden prompt injection, tool annotations, headers) | no | yes |
| Privacy, performance (CLS for agents) | no | yes |
| Evidence (request and response) per finding | no | yes |
| Fix snippet and fix prompt per finding | fix text | yes, plus "copy all fix prompts" |
| Standard status per finding, drafts weighted lower | no | yes |
| Per-role view (developer, designer, content/SEO, PM, architect, QA, security, analytics) | no | yes |

### Measured agreement (3 November 2026)

Both scanners ran on the same 12 sites from the same machine: Cloudflare's through its public API (`POST https://isitagentready.com/api/scan`), ours with browser checks on. Script: `scripts/compare-iia.mjs`; raw results in [docs/comparison/](docs/comparison/).

| Site | Cloudflare level | Our compat level | isitagentready checks agreeing | Agent-Ready score (ours, 0-100) | Lighthouse Agentic view (ours) |
|---|---|---|---|---|---|
| isitagentready.com | 4 | 4 | 23/23 | 76 | 0.67 |
| developers.cloudflare.com | 4 | 4 | 23/23 | 87 | 1 |
| docs.stripe.com | 4 | 4 | 23/23 | 70 | 0.33 |
| supabase.com | 4 | 4 | 23/23 | 79 | 0.75 |
| modelcontextprotocol.io | 4 | 4 | 23/23 | 84 | 0.67 |
| www.allbirds.com | 1 | 1 | 23/23 | 69 | 0.67 |
| github.com | 1 | 1 | 23/23 | 65 | 0.75 |
| developer.mozilla.org | 1 | 1 | 23/23 | 76 | 1 |
| en.wikipedia.org | 0 | 0 | 23/23 | 64 | 0.5 |
| salnikov.no | 1 | 1 | 23/23 | 80 | 1 |
| vercel.com | 1 | 1 | 23/23 | 83 | 0.5 |
| www.bbc.com | 1 | 1 | 23/23 | 73 | 1 |

The Level matches on 12 of 12 sites and 276 of 276 individual check results match. The first run disagreed on 8 results; three of our compat rules were aligned with what the live scanner does (a robots.txt `Sitemap` line must lead to a sitemap; ARD entries need `displayName`; an `Offer` on software is not a shop), and one difference was Cloudflare rate-limiting its own WebMCP check.

## Scoring

- Each check is `pass` (1), `warn` (0.5) or `fail` (0); `info`, `neutral` (not applicable), `skipped` (needs a browser) and `error` (network) do not count.
- Weight = severity (1-3) x maturity of the standard: RFC / Recommendation / book guidance 1.0, draft 0.6, proposal or convention 0.4. The maturity factor is our opinion and the report says so.
- Layer score = weighted credit / weighted total. Capability layers (APIs, MCP, commerce, identity) only score when the site has that capability.
- Overall score = layer scores weighted by layer (perception 3; crawler access, structured data, content, security 2; APIs 1.5; the rest 1).
- The isitagentready-compatible level uses only the 23 compat results and Cloudflare's level rules.

## Use it

### Web

Open the site, enter a URL. Reports have shareable links (`/r/<id>`, kept 30 days) and every page also answers `Accept: text/markdown`.

### HTTP API

```bash
curl -s -X POST https://<host>/api/scan -H 'content-type: application/json' -d '{"url":"https://example.com"}'
curl -s -X POST https://<host>/api/scan -H 'content-type: application/json' -d '{"url":"https://example.com","format":"agent"}'   # only the fixes, as Markdown prompts
curl -s https://<host>/api/checks
curl -s https://<host>/api/checks/content.markdown-negotiation
```

OpenAPI 3.1 at `/openapi.json`, listed in the RFC 9727 catalog at `/.well-known/api-catalog`. Errors are `application/problem+json` (RFC 9457). Rate limits are announced with `RateLimit-Policy` / `RateLimit` (draft-ietf-httpapi-ratelimit-headers-11); over the limit you get 429 with `Retry-After`. The same URL is served from a 10-minute cache.

### MCP

Stateless Streamable HTTP at `/mcp` (protocol 2026-07-28 with `server/discover`; the 2025-11-25 and 2025-06-18 handshakes also work). Tools: `scan_site`, `list_checks`, `explain_check`, `get_report`. Server card at `/mcp/server-card` and `/.well-known/mcp/server-card.json`. Browser origins other than the service's own are refused (403).

```json
{ "mcpServers": { "agent-ready-check": { "type": "http", "url": "https://<host>/mcp" } } }
```

### WebMCP

The home page registers `scan_site` with `document.modelContext.registerTool()` and declares the scan form as a tool, so an agent in the browser can scan without clicking.

### CLI

Published to npm as [`agent-ready-check`](https://www.npmjs.com/package/agent-ready-check) from GitHub releases (trusted publishing with provenance; see [docs/PUBLISHING.md](docs/PUBLISHING.md)). Until the first version is on npm, run it from GitHub with `npx github:vibeprogrammer/agent-ready-check <url>`.

```bash
npx agent-ready-check https://example.com                 # table
npx agent-ready-check https://example.com --json          # full report
npx agent-ready-check https://example.com --md            # Markdown report
npx agent-ready-check https://example.com --prompts       # fix prompts for a coding agent
npx agent-ready-check https://example.com --browser       # also the browser checks (playwright-core + Chromium)
npx agent-ready-check http://localhost:3000 --allow-private --fail-under 80 --level-at-least 3   # CI gate, exit 1 on failure
npx agent-ready-check https://example.com --only crawl.robots-txt,content.llms-txt
```

### Badge

```markdown
![Agent-Ready Check](https://<host>/badge/example.com.svg)
```

Shows the latest stored report for the host; never starts a scan.

### As a library

```js
import { scan } from 'agent-ready-check';
const report = await scan('https://example.com', { browser: false });
console.log(report.score, report.compat.isitagentready.level);
```

## The service is agent-ready itself

robots.txt with named AI crawler groups, `Content-Signal` and `Agentmap`; sitemap with `lastmod`; llms.txt and llms-full.txt; Markdown negotiation with `Vary: Accept`; `Link` headers (`api-catalog`, `service-desc`, `service-doc`, `describedby`, `alternate`, `sitemap`, `ard`); OpenAPI; API catalog; MCP server and card; Agent Skills index with a sha256 digest (`/.well-known/agent-skills/index.json`, skill also in [skills/agent-ready-check/SKILL.md](skills/agent-ready-check/SKILL.md)); ARD manifest; WebMCP; security.txt; CSP, HSTS and nosniff.

It targets isitagentready **Level 4**. Level 5 would need Web Bot Auth or OAuth metadata, which an anonymous public scanner has no use for, so we do not fake them.

Its own scores are recorded in each release's notes and in the deploy workflow's run summary (a self-scan runs after every deploy).

## Safe fetching

Every hop goes through an SSRF guard: http/https only, ports 80/443, DNS resolved and every address checked against private, loopback, link-local, CGNAT, multicast, reserved and IPv6 ULA/mapped ranges; redirects followed by hand (max 5) with the guard on each hop; Node pins the connection to the checked address. Per request 10 s and a byte cap; per scan 120 requests, 8 at a time, 60 s. The user agent identifies itself (`AgentReadyCheck/<version>`), and crawl-type reads obey robots.txt for that token.

## Hosting

- **Azure Static Web Apps + Azure Functions** (production): the site on the Free plan, the whole app as one managed function, reports in Blob Storage, an optional browser runner on Container Apps that scales to zero. About 0 USD a month at light use. One Cloud Shell run sets it up (`infra/deploy.sh` or `infra/deploy.ps1 -GitHubRepo <owner>/<repo> -CustomDomain <domain>`), then GitHub Actions deploys every push to `main` with OIDC. Architecture, decisions and costs: [DEPLOY.md](DEPLOY.md). Click-by-click setup: [docs/PUBLISHING.md](docs/PUBLISHING.md).
- **Node 22+**: `npm ci && npm start` (port 8080; `BROWSER=1` for browser checks, `REPORTS_DIR=./reports` to keep reports).
- **Docker**: `docker build -t agent-ready-check . && docker run -p 8080:8080 agent-ready-check` (Playwright base image, browser checks on).
- **Browser runner** for hosts that cannot start a browser: `Dockerfile.runner`, or `RUNNER_TOKEN=... bash scripts/runner-start.sh` on any small Linux box. It serves `POST /collect` behind a bearer token, one browser job at a time.
- **Cloudflare-style Worker + D1**: `npm run build:worker`, then publish `dist/worker/`; set `BROWSER_RUNNER_URL` and `RUNNER_TOKEN` to use a runner.

## Development

```bash
npm ci
npm test                 # unit tests (node:test)
npm run test:fixtures    # graded Nordlys Cabins fixtures (DEMOS_DIR=../agent-ready-web-demos)
npm run test:e2e         # Playwright (CHROMIUM_PATH to use an existing Chromium)
npm run lint
npm run build:worker
npm run build:azure      # dist/azure/web + api/dist (Azure Static Web Apps)
```

## Credits

Checks, fixes and the running example come from **"The Agent-Ready Web"** by **Maxim Salnikov** and its demos ([webmaxru/agent-ready-web-demos](https://github.com/webmaxru/agent-ready-web-demos), MIT). isitagentready is Cloudflare's checker; this project re-implements its published rules for comparison and is not affiliated with Cloudflare or Google.

## License

MIT, Copyright (c) 2026 Maxim Salnikov. See [LICENSE](LICENSE).
