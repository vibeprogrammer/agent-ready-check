# Agent-Ready Check: plan

Status: plan v1, 3 Nov 2026. Lead task f6f8cdf4. Repo: https://github.com/vibeprogrammer/agent-ready-check (public, MIT).
Knowledge base: *The Agent-Ready Web* v1.0.0 by Maxim Salnikov (Appendix B status table, read 2 Nov 2026) and its demos
(github.com/webmaxru/agent-ready-web-demos v1.0.0, MIT). Cloudflare's checker read from https://isitagentready.com/llms-full.txt on 3 Nov 2026 (copy in `shared/ref/`).

## 1. What we build

A web service, API, MCP server, CLI and npm-style package that scans a site and reports how ready it is for AI agents,
layer by layer, the way the book teaches it. 113 checks in 13 layers, against isitagentready's 23 checks in 5 categories.
Every one of Cloudflare's 23 checks and every one of Lighthouse's 7 Agentic Browsing audits has a matching check here,
so the report can show both graders' views next to our own score.

Product name (Maxim decides): **Agent-Ready Check**. Domain idea: `agent-ready-check.salnikov.no` (sits beside
`agent-ready-web.salnikov.no`); alternative `agentready.salnikov.no`. Nothing is bought or configured by Tab.

## 2. Architecture

```
           +---------------------------- core (runtime-neutral ESM, no Node APIs) ----------------------------+
 URL --->  | SafeFetcher (SSRF guard, timeouts, caps, UA, budget, evidence log)                               |
           | ScanContext (lazy artifacts: homepage, robots, DOM, JSON-LD, llms.txt, sitemap, OpenAPI, cards)  |
           | checks/<layer>.mjs  (113 checks, each = metadata + run(ctx) -> result + compat)                     |
           | score.mjs (layer scores, overall, isitagentready level, Lighthouse view, roles)                   |
           | report/ (JSON, Markdown, HTML, SVG badge, fix prompts)                                           |
           +----------------------------------------------------------------------------------------------+
                ^ optional browserData                   ^ used by
   browser/ (Node only: playwright-core + Chromium       server/app.mjs (Hono: UI, /api, /mcp, well-known files)
   with WebMCPTesting, axe-core, CLS observer)             |-- node entry  (CLI, Docker, Azure Container Apps)
                                                           |-- worker entry (Cloudflare Worker on sites.tab.bot, D1 storage)
```

- Language: modern JavaScript (ESM, JSDoc types), Node 22+ and Workers. No build step except the Worker bundle (esbuild).
- Runtime deps (all pure JS): `hono`, `linkedom`, `yaml`. Optional: `playwright-core`, `axe-core` (browser mode).
  Dev: `esbuild`, `eslint`, `@playwright/test`. JSON Schema checks use a small structural validator (Ajv's code
  generation is not allowed in Workers).
- 9 of the 113 checks need a real browser (accessibility tree, axe, imperative WebMCP, CLS, rendered parity, consent
  overlays). Static HTML fallbacks cover part of them; when no browser runs, these checks report `skipped` with the reason,
  and they never count against the score.

## 3. Check catalogue (113 checks)

Columns: severity 1–3 (3 = agents fail without it), the standard with its status and date (from Appendix B, Table B.10,
2 Nov 2026), the book chapter that teaches it, the grader check it mirrors (IIAR = isitagentready, LH = Lighthouse 13.6.0
Agentic Browsing), what it needs to run, and the test method. "heuristic" marks thresholds that are this checker's own
judgement, stated in the report as such. Machine-readable copy: `shared/catalog.json` (and `src/catalog.json` in the repo).

### Perception (`perception`, layer weight 3, book ch. 2,3)

How agents see the page: semantic HTML, accessibility tree, server vs rendered.

| id | check | sev | standard (status, date) | ch | grader map | runs on | how it is tested |
|---|---|---|---|---|---|---|---|
| `perception.html-lang` | <html lang> declares the page language | 1 | [HTML Living Standard](https://html.spec.whatwg.org/): Living Standard, continuous | 3 | — | http | Parse server HTML; pass if html[lang] is a valid BCP 47 tag |
| `perception.title` | Page has a descriptive <title> | 2 | [HTML Living Standard](https://html.spec.whatwg.org/): Living Standard, continuous | 3 | — | http | Parse server HTML; fail if missing/empty, warn if generic (Home, Untitled) or > 70 chars |
| `perception.landmarks` | Landmarks: one <main>, plus header/nav/footer | 2 | [WAI-ARIA](https://www.w3.org/TR/wai-aria-1.2/): W3C Recommendation, 2023-06-06 | 3 | — | http | Parse server HTML; count main/role=main (exactly 1), nav, header, footer |
| `perception.headings` | Heading outline: one <h1>, no skipped levels | 2 | [HTML Living Standard](https://html.spec.whatwg.org/): Living Standard, continuous | 3 | — | http | Parse server HTML; list h1-h6 in order, fail if no h1, warn if >1 h1 or level jumps |
| `perception.form-labels` | Every form control has an accessible name | 3 | [WCAG](https://www.w3.org/TR/WCAG22/): W3C Recommendation, 2023-10-05 | 3 | — | http | Static: input/select/textarea (not hidden/submit) need <label for>, wrapping label, aria-label(ledby) or title |
| `perception.control-names` | Buttons and links have accessible names | 3 | [WCAG](https://www.w3.org/TR/WCAG22/): W3C Recommendation, 2023-10-05 | 3 | — | http | Static: button, a[href], [role=button] need text, aria-label, aria-labelledby, img alt or title |
| `perception.click-divs` | No click-only <div>/<span> controls | 3 | [WAI-ARIA](https://www.w3.org/TR/wai-aria-1.2/): W3C Recommendation, 2023-06-06 | 3 | — | http | Static: div/span with onclick or [data-action]-like handlers and no role/tabindex; browser run adds cursor:pointer elements without role |
| `perception.img-alt` | Images have alt text | 1 | [WCAG](https://www.w3.org/TR/WCAG22/): W3C Recommendation, 2023-10-05 | 3 | — | http | Static: img without alt attribute (alt="" allowed for decoration) |
| `perception.native-forms` | Key forms are real <form>s with a submit button and action | 2 | [HTML Living Standard](https://html.spec.whatwg.org/): Living Standard, continuous | 2 | — | http | Static: forms have method/action or submit button; inputs outside forms counted; warn on JS-only forms |
| `perception.server-html` | Server HTML carries the content (not an empty JS shell) | 3 | [The Agent-Ready Web (book guidance)](https://github.com/webmaxru/agent-ready-web-demos): Book recommendation (opinion, sourced per chapter), 2026-11-02 | 3 | — | http | Static: visible text length of server HTML; fail under 200 chars with a large script bundle; browser run compares with rendered text (heuristic) |
| `perception.rendered-parity` | Rendered page and server HTML say the same thing | 2 | [The Agent-Ready Web (book guidance)](https://github.com/webmaxru/agent-ready-web-demos): Book recommendation (opinion, sourced per chapter), 2026-11-02 | 3 | — | browser | Browser: share of rendered visible text present in server HTML (token overlap); warn < 70%, fail < 30% (heuristic) |
| `perception.axe-agent-rules` | The 33 agent-relevant axe rules pass | 3 | [Lighthouse agent-accessibility-tree (33 axe rules)](https://github.com/GoogleChrome/lighthouse): Tool audit (rules from axe-core / WCAG), 2026-10-27 | 3 | LH `agent-accessibility-tree` | browser | Browser: axe-core runOnly the 33 TARGET_RULES from Lighthouse 13.6.0; fail on any violation (Lighthouse is binary) |
| `perception.a11y-tree` | Interactive elements appear in the accessibility tree with names and roles | 3 | [WAI-ARIA](https://www.w3.org/TR/wai-aria-1.2/): W3C Recommendation, 2023-06-06 | 3 | — | browser | Browser: accessibility snapshot; share of interactive nodes with a name; list unnamed (heuristic) |
| `perception.focusable-controls` | Custom controls are keyboard-focusable | 1 | [WCAG](https://www.w3.org/TR/WCAG22/): W3C Recommendation, 2023-10-05 | 3 | — | browser | Browser: elements with click listeners / role=button that are not focusable (tabIndex < 0) |

### Crawler access (`crawl`, layer weight 2, book ch. 4)

robots.txt groups per AI crawler, content signals, sitemaps, bot challenges.

| id | check | sev | standard (status, date) | ch | grader map | runs on | how it is tested |
|---|---|---|---|---|---|---|---|
| `crawl.robots-txt` | robots.txt is published | 3 | [Robots Exclusion Protocol](https://www.rfc-editor.org/rfc/rfc9309): RFC (Standards Track), 2022-09 | 4 | IIAR `robotsTxt` | http | GET /robots.txt: 200, text/plain, at least one User-agent line (isitagentready rule) |
| `crawl.robots-syntax` | robots.txt parses cleanly | 2 | [Robots Exclusion Protocol](https://www.rfc-editor.org/rfc/rfc9309): RFC (Standards Track), 2022-09 | 4 | — | http | Parse per RFC 9309: unknown lines, rules before any User-agent, size > 500 KiB (parser limit), HTML served as robots |
| `crawl.ai-bot-rules` | robots.txt has rules for AI crawlers | 2 | [Robots Exclusion Protocol](https://www.rfc-editor.org/rfc/rfc9309): RFC (Standards Track), 2022-09 | 4 | IIAR `robotsTxtAiRules` | http | Named AI tokens or a wildcard group (isitagentready rule); lists which tokens are named |
| `crawl.ai-crawler-matrix` | AI crawler policy per bot (training / search / user) | 2 | [Robots Exclusion Protocol](https://www.rfc-editor.org/rfc/rfc9309): RFC (Standards Track), 2022-09 | 4 | — | http | Evaluate the homepage path for 17 documented AI tokens with RFC 9309 group matching; warn when search or user fetchers are blocked while training is allowed, or all AI is blocked by accident (heuristic) |
| `crawl.content-signal` | Content-Signal preferences are declared | 2 | [Content Signals Policy](https://contentsignals.org/): Vendor proposal, 2025-09-24 | 4 | IIAR `contentSignals` | http | robots.txt Content-Signal line with ai-train, search or ai-input (isitagentready rule) |
| `crawl.content-signal-valid` | Content-Signal values are well-formed | 1 | [Content Signals Policy](https://contentsignals.org/): Vendor proposal, 2025-09-24 | 4 | — | http | Keys in {search, ai-input, ai-train}, values yes/no, inside a User-agent group |
| `crawl.aipref-usage` | AI preferences (Content-Usage, IETF aipref) if present are valid | 1 | [AI Preferences vocabulary + attachment](https://datatracker.ietf.org/wg/aipref/about/): IETF WG draft, 2026-09-14 | 4 | — | http | robots.txt Content-Usage lines and Content-Usage response header parsed against the vocab draft; informational when absent |
| `crawl.robots-meta` | Homepage is not noindex/none for everyone | 3 | [X-Robots-Tag / meta robots](https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag): De-facto convention, continuous | 4 | — | http | Homepage X-Robots-Tag header and <meta name=robots>: fail on noindex/none for all agents |
| `crawl.bot-challenge` | Agents get the page, not a challenge | 3 | [The Agent-Ready Web (book guidance)](https://github.com/webmaxru/agent-ready-web-demos): Book recommendation (opinion, sourced per chapter), 2026-11-02 | 15 | — | http | GET homepage with this checker's identifying UA vs a browser UA: warn/fail when the bot gets 403/429/challenge HTML and the browser gets 200 (heuristic) |
| `crawl.sitemap` | A sitemap is published | 2 | [Sitemaps protocol](https://www.sitemaps.org/protocol.html): Convention backed by the major search engines, long-standing | 6 | IIAR `sitemap` | http | /sitemap.xml returns XML, or a Sitemap line in robots.txt (isitagentready rule) |
| `crawl.sitemap-valid` | Sitemap is valid XML with <loc> URLs on this site | 2 | [Sitemaps protocol](https://www.sitemaps.org/protocol.html): Convention backed by the major search engines, long-standing | 6 | — | http | Parse urlset/sitemapindex; count URLs; all on the same site; under 50,000 URLs / 50 MB |
| `crawl.sitemap-lastmod` | Sitemap carries honest lastmod dates | 1 | [Sitemaps protocol](https://www.sitemaps.org/protocol.html): Convention backed by the major search engines, long-standing | 6 | — | http | Share of URLs with W3C-datetime lastmod; warn if all identical or in the future |
| `crawl.sitemap-in-robots` | robots.txt names the sitemap | 1 | [Robots Exclusion Protocol](https://www.rfc-editor.org/rfc/rfc9309): RFC (Standards Track), 2022-09 | 6 | — | http | Sitemap: line(s) present and absolute |
| `crawl.tdmrep` | TDM reservation (TDMRep) if used is valid | 1 | [TDM Reservation Protocol](https://www.w3.org/community/reports/tdmrep/CG-FINAL-tdmrep-20240510/): W3C CG report, 2024-05-10 | 4 | — | http | /.well-known/tdmrep.json and tdm-reservation header/meta; informational |
| `crawl.rsl` | RSL licence pointer if used resolves | 1 | [RSL (Really Simple Licensing)](https://rslstandard.org/): Published specification, 2025-12-10 | 4 | — | http | robots.txt License: line / <link rel=license type=application/rsl+xml>; fetch and check XML; informational |

### Structured data (`structured`, layer weight 2, book ch. 5)

JSON-LD validity against schema.org and parity with visible content.

| id | check | sev | standard (status, date) | ch | grader map | runs on | how it is tested |
|---|---|---|---|---|---|---|---|
| `structured.jsonld-present` | Page has JSON-LD structured data | 2 | [JSON-LD](https://www.w3.org/TR/json-ld11/): W3C Recommendation, 2020-07 | 5 | — | http | Static: script[type="application/ld+json"] blocks on the homepage (and the sampled page) |
| `structured.jsonld-syntax` | JSON-LD blocks parse as JSON | 3 | [JSON-LD](https://www.w3.org/TR/json-ld11/): W3C Recommendation, 2020-07 | 5 | — | http | JSON.parse each block; report position of errors |
| `structured.jsonld-context` | JSON-LD uses the schema.org context | 1 | [JSON-LD](https://www.w3.org/TR/json-ld11/): W3C Recommendation, 2020-07 | 5 | — | http | @context is https://schema.org (or http) in each top-level node or @graph |
| `structured.schema-types` | @type values exist in schema.org | 2 | [schema.org](https://schema.org/): Community vocabulary, continuous | 5 | — | http | Every @type checked against the bundled schema.org type list (release noted in the report) |
| `structured.schema-properties` | Properties exist in schema.org | 1 | [schema.org](https://schema.org/): Community vocabulary, continuous | 5 | — | http | Every property name checked against the bundled schema.org property list |
| `structured.key-properties` | Key properties are filled for the main types | 2 | [schema.org](https://schema.org/): Community vocabulary, continuous | 5 | — | http | Organization/WebSite/Product/Offer/LodgingBusiness/Event/Article/FAQPage: required-for-meaning fields (name, url, offers.price+priceCurrency, startDate...) |
| `structured.visible-parity` | Structured data matches visible content | 3 | [The Agent-Ready Web (book guidance)](https://github.com/webmaxru/agent-ready-web-demos): Book recommendation (opinion, sourced per chapter), 2026-11-02 | 5 | — | http | name, headline, price and description values found in visible server text (normalised); warn below 80%, fail below 50% (heuristic) |
| `structured.identity` | Homepage identifies the organisation (Organization/WebSite) | 1 | [schema.org](https://schema.org/): Community vocabulary, continuous | 5 | — | http | Organization or WebSite node with name and url; sameAs and logo noted |
| `structured.canonical` | Canonical URL is declared and consistent | 1 | [HTML Living Standard](https://html.spec.whatwg.org/): Living Standard, continuous | 5 | — | http | link rel=canonical present, absolute, same site; matches final URL or redirects there |
| `structured.meta-description` | Meta description and Open Graph basics | 1 | [Open Graph protocol](https://ogp.me/): De-facto convention, long-standing | 5 | — | http | meta description, og:title, og:description present |

### Agent-readable content (`content`, layer weight 2, book ch. 6)

Markdown negotiation, llms.txt, Link headers, feeds.

| id | check | sev | standard (status, date) | ch | grader map | runs on | how it is tested |
|---|---|---|---|---|---|---|---|
| `content.markdown-negotiation` | Markdown via Accept: text/markdown | 3 | [Markdown for Agents (Accept: text/markdown)](https://developers.cloudflare.com/fundamentals/reference/markdown-for-agents/): Vendor convention on RFC 9110 negotiation, 2026 | 6 | IIAR `markdownNegotiation` | http | GET homepage with Accept: text/markdown; pass on Content-Type text/markdown (isitagentready rule) |
| `content.markdown-vary` | Negotiated responses send Vary: Accept | 2 | [HTTP Semantics (content negotiation, Vary)](https://www.rfc-editor.org/rfc/rfc9110): RFC (Standards Track), 2022-06 | 6 | — | http | Both the HTML and Markdown responses carry Vary including Accept, so caches do not mix them |
| `content.markdown-quality` | The Markdown is real Markdown with the page content | 2 | [text/markdown media type](https://www.rfc-editor.org/rfc/rfc7763): RFC (Informational), 2016-03 | 6 | — | http | Markdown body is not HTML, has a heading, shares >= 50% of key terms with the HTML text (heuristic) |
| `content.markdown-alternate` | Pages link their Markdown twin | 1 | [llms.txt](https://llmstxt.org/): Proposal, 2026-08-10 | 6 | — | http | <link rel=alternate type=text/markdown> or Link header; fetch it, expect text/markdown or text/plain |
| `content.llms-txt` | llms.txt is published | 2 | [llms.txt](https://llmstxt.org/): Proposal, 2026-08-10 | 6 | — | http | GET /llms.txt: 200 text, not HTML |
| `content.llms-txt-format` | llms.txt follows the format (H1, summary, link lists) | 2 | [llms.txt](https://llmstxt.org/): Proposal, 2026-08-10 | 6 | LH `llms-txt` | http | Lighthouse llms-txt rules: H1, Markdown link, >= 50 chars; plus blockquote summary and H2 sections |
| `content.llms-txt-links` | llms.txt links resolve | 2 | [llms.txt](https://llmstxt.org/): Proposal, 2026-08-10 | 6 | — | http | HEAD/GET up to 15 linked URLs (robots-respecting); warn on any 4xx/5xx, fail if most fail |
| `content.llms-full` | llms-full.txt (optional) | 1 | [llms-full.txt](https://llmstxt.org/): Convention (not in llms.txt v2), — | 6 | — | http | GET /llms-full.txt; informational, size reported |
| `content.link-headers` | Link headers point agents to resources | 2 | [Web Linking](https://www.rfc-editor.org/rfc/rfc8288): RFC (Standards Track), 2017-10 | 6 | IIAR `linkHeaders` | http | Homepage Link header with agent-useful rels (service-desc, describedby, api-catalog, alternate markdown, sitemap, ...) (isitagentready rule) |
| `content.feeds` | Feeds are discoverable (RSS/Atom/JSON Feed) | 1 | [RSS 2.0 / Atom (RFC 4287) / JSON Feed](https://www.rfc-editor.org/rfc/rfc4287): RFC + conventions, 2005-12 | 6 | — | http | link rel=alternate with feed types; fetch first and validate root element |
| `content.caching` | Responses support conditional requests | 1 | [HTTP Semantics (content negotiation, Vary)](https://www.rfc-editor.org/rfc/rfc9110): RFC (Standards Track), 2022-06 | 6 | — | http | Homepage has ETag or Last-Modified; a conditional request returns 304 |

### APIs (`api`, layer weight 1.5, book ch. 7,10,13)

api-catalog, OpenAPI quality, problem+json, rate-limit headers.

| id | check | sev | standard (status, date) | ch | grader map | runs on | how it is tested |
|---|---|---|---|---|---|---|---|
| `api.catalog` | API catalog at /.well-known/api-catalog | 2 | [api-catalog](https://www.rfc-editor.org/rfc/rfc9727): RFC (Standards Track), 2025-06 | 7 | IIAR `apiCatalog` | http | GET /.well-known/api-catalog: linkset+json with linkset array (isitagentready rule) |
| `api.catalog-valid` | API catalog entries are complete | 2 | [api-catalog](https://www.rfc-editor.org/rfc/rfc9727): RFC (Standards Track), 2025-06 | 7 | — | http · when api | Content-Type application/linkset+json; each entry has anchor and service-desc/service-doc; links resolve |
| `api.openapi` | OpenAPI description is discoverable | 2 | [OpenAPI Specification](https://spec.openapis.org/oas/latest.html): Dated spec, 2026-09-10 | 7 | — | http · when api | Find via api-catalog service-desc, Link header, or /openapi.json, /openapi.yaml, /.well-known/openapi.json |
| `api.openapi-valid` | OpenAPI document is valid | 2 | [OpenAPI Specification](https://spec.openapis.org/oas/latest.html): Dated spec, 2026-09-10 | 7 | — | http · when api | Parse JSON/YAML; openapi 3.x, info.title/version, paths; refs resolve locally |
| `api.openapi-agent-quality` | Operations are described for agents | 2 | [The Agent-Ready Web (book guidance)](https://github.com/webmaxru/agent-ready-web-demos): Book recommendation (opinion, sourced per chapter), 2026-11-02 | 10 | — | http · when api | Share of operations with operationId, summary/description, described parameters and response schemas (heuristic) |
| `api.problem-json` | Errors use problem+json (RFC 9457) | 1 | [Problem Details for HTTP APIs](https://www.rfc-editor.org/rfc/rfc9457): RFC (Standards Track), 2023-08 | 7 | — | http · when api | Request an unknown path under the API base; expect application/problem+json with type/title/status |
| `api.ratelimit` | Rate limits are announced in headers | 1 | [RateLimit header fields](https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/): IETF WG draft, 2026-05 | 7 | — | http · when api | API responses carry RateLimit/RateLimit-Policy (draft-11) or Retry-After on 429 |
| `api.deprecation` | Deprecation/Sunset headers are well-formed (if used) | 1 | [Deprecation header (+ Sunset RFC 8594)](https://www.rfc-editor.org/rfc/rfc9745): RFC (Standards Track), 2025-03 | 20 | — | http · when api | Deprecation (RFC 9745 structured date) and Sunset (HTTP-date) on API responses; informational |
| `api.actionable-interface` | Key actions have a machine interface | 2 | [The Agent-Ready Web (book guidance)](https://github.com/webmaxru/agent-ready-web-demos): Book recommendation (opinion, sourced per chapter), 2026-11-02 | 13 | — | http | If the site has forms or commerce signals: at least one of API catalog/OpenAPI, MCP endpoint or WebMCP tools |

### MCP (`mcp`, layer weight 1, book ch. 8,10,11)

Server card, live initialize/tools/list probe, schemas, Origin validation.

| id | check | sev | standard (status, date) | ch | grader map | runs on | how it is tested |
|---|---|---|---|---|---|---|---|
| `mcp.server-card` | MCP server card is published | 2 | [MCP Server Cards](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2127): Contested (SEP page "Final", extension repo "Experimental"), 2026 | 11 | IIAR `mcpServerCard` | http | /.well-known/mcp/server-card.json, /.well-known/mcp/server-cards.json or /.well-known/mcp.json with a name (isitagentready rule) |
| `mcp.server-card-valid` | Server card is complete and points to a live endpoint | 2 | [MCP Server Cards](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2127): Contested (SEP page "Final", extension repo "Experimental"), 2026 | 11 | — | http · when mcp | serverInfo name+version, transport/remotes url, capabilities; SEP-2127 location also checked |
| `mcp.endpoint` | MCP endpoint answers initialize | 3 | [Model Context Protocol](https://modelcontextprotocol.io/specification/2026-07-28): Dated spec, 2026-07-28 | 8 | — | http · when mcp | POST initialize (protocolVersion 2026-07-28) to the endpoint from the card/ARD or /mcp; pass on a JSON-RPC result or a spec 401 challenge |
| `mcp.protocol-version` | Server speaks a current MCP protocol version | 1 | [Model Context Protocol](https://modelcontextprotocol.io/specification/2026-07-28): Dated spec, 2026-07-28 | 8 | — | http · when mcp | protocolVersion from initialize; warn on versions before 2025-06-18 |
| `mcp.tools-list` | tools/list returns tools (public endpoints) | 2 | [Model Context Protocol](https://modelcontextprotocol.io/specification/2026-07-28): Dated spec, 2026-07-28 | 8 | — | http · when mcp | tools/list on public endpoints; count and names; skipped when auth is required |
| `mcp.tool-schemas` | Tool inputSchemas are valid JSON Schema objects with descriptions | 2 | [Model Context Protocol](https://modelcontextprotocol.io/specification/2026-07-28): Dated spec, 2026-07-28 | 10 | — | http · when mcp | Each tool: name pattern, description length, inputSchema type object, properties described, required subset |
| `mcp.origin-validation` | Endpoint rejects foreign Origin headers | 2 | [Model Context Protocol](https://modelcontextprotocol.io/specification/2026-07-28): Dated spec, 2026-07-28 | 16 | — | http · when mcp | POST initialize with Origin: https://evil.example; spec says servers MUST validate Origin (DNS rebinding); pass on 403/400 |

### WebMCP (`webmcp`, layer weight 1, book ch. 9,10)

Declarative and imperative tools found in a real browser.

| id | check | sev | standard (status, date) | ch | grader map | runs on | how it is tested |
|---|---|---|---|---|---|---|---|
| `webmcp.tools` | Page exposes WebMCP tools | 2 | [WebMCP](https://webmachinelearning.github.io/webmcp/): W3C CG draft, Chrome origin trial, 2026-11-02 | 9 | IIAR `webMcp`, LH `webmcp-registered-tools` | http | Browser with WebMCPTesting: document.modelContext.getTools(); static fallback finds registerTool calls and <form toolname> (isitagentready rule) |
| `webmcp.form-coverage` | Forms declare toolname and tooldescription | 2 | [Lighthouse WebMCP audits](https://github.com/GoogleChrome/lighthouse): Tool audit over a W3C CG draft, 2026-10-27 | 9 | LH `webmcp-form-coverage` | http · when forms | Every <form> has both attributes (Lighthouse webmcp-form-coverage) |
| `webmcp.schema-validity` | Declarative tool attributes and field names are valid | 2 | [Lighthouse WebMCP audits](https://github.com/GoogleChrome/lighthouse): Tool audit over a W3C CG draft, 2026-10-27 | 9 | LH `webmcp-schema-validity` | http · when forms | toolname pattern, descriptions, named fields with toolparamdescription; Lighthouse 0/0.5/1 scoring |
| `webmcp.tool-schemas` | Imperative tools have valid input schemas | 2 | [WebMCP](https://webmachinelearning.github.io/webmcp/): W3C CG draft, Chrome origin trial, 2026-11-02 | 9 | — | browser | Each registered tool: inputSchema is a JSON Schema object, required subset of properties, outputSchema valid if given |
| `webmcp.tool-count` | Tool count stays manageable (<= 40) | 1 | [Lighthouse WebMCP audits](https://github.com/GoogleChrome/lighthouse): Tool audit over a W3C CG draft, 2026-10-27 | 10 | — | browser | Count of registered tools; warn above 40 (Lighthouse threshold) |
| `webmcp.descriptions` | Tool descriptions tell an agent when to use them | 1 | [The Agent-Ready Web (book guidance)](https://github.com/webmaxru/agent-ready-web-demos): Book recommendation (opinion, sourced per chapter), 2026-11-02 | 10 | — | http | Description length 20-500 chars, starts with a verb, names inputs; duplicates flagged (heuristic) |
| `webmcp.annotations` | Tools carry readOnlyHint / untrustedContentHint annotations | 1 | [WebMCP](https://webmachinelearning.github.io/webmcp/): W3C CG draft, Chrome origin trial, 2026-11-02 | 10 | — | browser | Read-only-looking tools (get/search/list/check) marked readOnlyHint; write tools not |
| `webmcp.origin-trial` | WebMCP origin-trial token (for Chrome) if WebMCP is used | 1 | [WebMCP](https://webmachinelearning.github.io/webmcp/): W3C CG draft, Chrome origin trial, 2026-11-02 | 9 | — | http | meta http-equiv=origin-trial or Origin-Trial header; informational |

### Discovery (`discovery`, layer weight 1, book ch. 11)

ARD, Agent Skills, A2A, DNS-AID, well-known hygiene.

| id | check | sev | standard (status, date) | ch | grader map | runs on | how it is tested |
|---|---|---|---|---|---|---|---|
| `discovery.ard` | ARD manifest is discoverable | 2 | [Agentic Resource Discovery (ARD)](https://agenticresourcediscovery.org/): Proposal, 2026-08-26 | 11 | IIAR `ard`, LH `ard-schema` | http | Agentmap robots line, link rel=ard, Link header, /.well-known/ard.json, legacy /.well-known/ai-catalog.json (isitagentready + Lighthouse order) |
| `discovery.ard-valid` | ARD manifest is valid | 2 | [Agentic Resource Discovery (ARD)](https://agenticresourcediscovery.org/): Proposal, 2026-08-26 | 11 | — | http | specVersion, host, entries with urn:air identifier, displayName, IANA media type, exactly one of url/data; warns on legacy location |
| `discovery.agent-skills` | Agent Skills index is published | 2 | [Agent Skills Discovery](https://github.com/cloudflare/agent-skills-discovery-rfc): Vendor proposal, 2026 | 11 | IIAR `agentSkills` | http | /.well-known/agent-skills/index.json (or legacy /.well-known/skills/index.json) with a skills array (isitagentready rule) |
| `discovery.agent-skills-valid` | Skill entries are complete and digests match | 2 | [Agent Skills Discovery](https://github.com/cloudflare/agent-skills-discovery-rfc): Vendor proposal, 2026 | 11 | — | http | $schema, name/type/description/url/digest per entry; fetch each skill (max 10) and compare sha256 digest |
| `discovery.a2a-card` | A2A Agent Card (opt-in) | 1 | [A2A (Agent2Agent) Agent Card](https://a2a-protocol.org/latest/specification/): Dated spec, 2026-05-26 | 11 | IIAR `a2aAgentCard` | http · when optin | /.well-known/agent-card.json with name, version, supportedInterfaces (isitagentready rule, opt-in) |
| `discovery.dns-aid` | DNS-AID records under _agents | 1 | [DNS for AI Discovery (DNS-AID)](https://datatracker.ietf.org/doc/draft-mozleywilliams-dnsop-dnsaid/): Individual draft, 2026-05-27 | 11 | IIAR `dnsAid` | dns | DNS-over-HTTPS SVCB/HTTPS lookup of _index._agents.<host> and _mcp/_a2a, DNSSEC AD flag (isitagentready rule) |
| `discovery.poppy` | Personal Agent Protocol manifest (informational) | 1 | [Personal Agent Protocol (poppy.json)](https://personalagentprotocol.org/docs/spec): Proposal, 2026 | 11 | IIAR `personalAgentProtocol` | http · when optin | /.well-known/poppy.json organisation/domain/interfaces (isitagentready rule, informational) |
| `discovery.soft-404` | Unknown paths return 404 (no soft-404s) | 2 | [Well-Known URIs](https://www.rfc-editor.org/rfc/rfc8615): RFC (Standards Track), 2019-05 | 11 | — | http | GET a random /.well-known path and a random page; a 200 HTML answer makes every probe ambiguous and agents waste requests |
| `discovery.wellknown-types` | Well-known JSON files are served as JSON | 1 | [Well-Known URIs](https://www.rfc-editor.org/rfc/rfc8615): RFC (Standards Track), 2019-05 | 11 | — | http | Every found well-known JSON resource has a JSON media type and parses |

### Commerce (`commerce`, layer weight 1, book ch. 12)

UCP, ACP, x402, MPP, AP2, product data (scored only on shops).

| id | check | sev | standard (status, date) | ch | grader map | runs on | how it is tested |
|---|---|---|---|---|---|---|---|
| `commerce.detected` | Commerce signals detected | 1 | [The Agent-Ready Web (book guidance)](https://github.com/webmaxru/agent-ready-web-demos): Book recommendation (opinion, sourced per chapter), 2026-11-02 | 12 | — | http | Product/Offer JSON-LD, cart/checkout links, platform markers (Shopify, WooCommerce...); decides whether commerce checks score |
| `commerce.product-data` | Products/offers have price, currency and availability | 2 | [schema.org](https://schema.org/): Community vocabulary, continuous | 12 | — | http · when commerce | Product/Offer JSON-LD: offers.price, priceCurrency, availability; checked against visible price |
| `commerce.ucp` | UCP business profile | 2 | [Universal Commerce Protocol](https://ucp.dev/specification/overview/): Dated spec (Lodging: draft), 2026 | 12 | IIAR `ucp` | http · when commerce | /.well-known/ucp with protocol_version (or ucp.version) and services (isitagentready rule) |
| `commerce.ucp-valid` | UCP profile lists capabilities and reachable endpoints | 1 | [Universal Commerce Protocol](https://ucp.dev/specification/overview/): Dated spec (Lodging: draft), 2026 | 12 | — | http · when commerce | capabilities array, services with transport endpoints, endpoints on https |
| `commerce.acp` | ACP discovery document | 1 | [Agentic Commerce Protocol](https://agenticcommerce.dev): Beta (discovery path is the scanner's convention), 2026-04-17 | 12 | IIAR `acp` | http · when commerce | /.well-known/acp.json with protocol.name/version, api_base_url, transports, capabilities.services (isitagentready rule) |
| `commerce.x402` | x402 payment-required responses | 1 | [x402](https://x402.org): Dated spec, 2026 | 12 | IIAR `x402` | http · when commerce | Paid API routes (from OpenAPI/catalog) answer 402 with x402 payment requirements (isitagentready rule) |
| `commerce.mpp` | MPP payment info in OpenAPI | 1 | [Machine Payments Protocol](https://mpp.dev): Vendor-led open protocol, 2026-03-18 | 12 | IIAR `mpp` | http · when commerce | /openapi.json operations with x-payment-info (isitagentready rule) |
| `commerce.ap2` | AP2 extension in the A2A card | 1 | [Agent Payments Protocol (AP2)](https://ap2-protocol.org/): Extension of A2A and UCP, 2026 | 12 | IIAR `ap2` | http · when commerce | A2A Agent Card extensions include AP2 with a role (isitagentready rule) |
| `commerce.vrp` | Vacation Rental Protocol offers (informational) | 1 | [Vacation Rental Protocol](https://www.iana.org/assignments/well-known-uris/): Single-maintainer draft, 2026-11-01 | 12 | — | http · when commerce | /.well-known/vacation-rental.json; informational for lodging sites |

### Identity & auth (`identity`, layer weight 1, book ch. 14,15)

OAuth AS/PRM metadata, PKCE, CIMD, auth.md, Web Bot Auth.

| id | check | sev | standard (status, date) | ch | grader map | runs on | how it is tested |
|---|---|---|---|---|---|---|---|
| `identity.oauth-discovery` | OAuth/OIDC authorization server metadata | 2 | [OAuth 2.0 Authorization Server Metadata / OIDC Discovery](https://www.rfc-editor.org/rfc/rfc8414): RFC (Standards Track), 2018-06 | 14 | IIAR `oauthDiscovery` | http · when auth | /.well-known/oauth-authorization-server or openid-configuration with issuer, endpoints, grant types (isitagentready rule) |
| `identity.protected-resource` | OAuth Protected Resource Metadata | 2 | [OAuth 2.0 Protected Resource Metadata](https://www.rfc-editor.org/rfc/rfc9728): RFC (Standards Track), 2025-04 | 14 | IIAR `oauthProtectedResource` | http · when auth | /.well-known/oauth-protected-resource (and path-suffixed for the MCP endpoint) with resource and authorization_servers (isitagentready rule) |
| `identity.pkce-s256` | Authorization server supports PKCE S256 | 2 | [OAuth 2.1 (PKCE S256)](https://datatracker.ietf.org/doc/draft-ietf-oauth-v2-1/): IETF WG draft (normative in MCP), 2026-10-31 | 14 | — | http · when auth | code_challenge_methods_supported includes S256 (required by MCP authorization) |
| `identity.client-registration` | Agent clients can register (CIMD preferred over DCR) | 1 | [Client ID Metadata Document](https://datatracker.ietf.org/doc/draft-ietf-oauth-client-id-metadata-document/): IETF WG draft (required path in MCP 2026-07-28), 2026-07-06 | 14 | — | http · when auth | client_id_metadata_document_supported true (MCP 2026-07-28); registration_endpoint only = warn (DCR deprecated for MCP) |
| `identity.auth-md` | auth.md agent registration | 1 | [auth.md](https://workos.com/auth-md): Vendor proposal, 2026 | 14 | IIAR `authMd` | http · when auth | /auth.md exists, PRM discoverable, AS metadata has agent_auth (isitagentready rule) |
| `identity.web-bot-auth` | Web Bot Auth key directory (for sites that send bots) | 1 | [Web Bot Auth (HTTP Message Signatures directory)](https://datatracker.ietf.org/wg/webbotauth/about/): IETF WG draft, 2026-10-29 | 15 | IIAR `webBotAuth` | http · when optin | /.well-known/http-message-signatures-directory: JWKS with Ed25519 keys, correct media type; informational like isitagentready |

### Security (`security`, layer weight 2, book ch. 16)

Hidden prompt injection, tool annotations, HTTPS, headers.

| id | check | sev | standard (status, date) | ch | grader map | runs on | how it is tested |
|---|---|---|---|---|---|---|---|
| `security.hidden-injection` | No hidden prompt-injection text | 3 | [OWASP Top 10 for LLM Applications (LLM01 prompt injection)](https://genai.owasp.org/llm-top-10/): Community guidance, 2025 | 16 | — | http | Static + browser: text hidden by CSS/aria-hidden/off-screen/zero-size/same-colour that matches instruction patterns (ignore previous, you are an AI, system prompt...) |
| `security.injection-in-machine-files` | Machine-readable files carry no instructions to agents | 2 | [OWASP Top 10 for LLM Applications (LLM01 prompt injection)](https://genai.owasp.org/llm-top-10/): Community guidance, 2025 | 16 | — | http | Scan llms.txt, Markdown twin, JSON-LD and meta for instruction-like patterns aimed at models |
| `security.tool-annotations` | Destructive tools are marked as such | 2 | [Model Context Protocol](https://modelcontextprotocol.io/specification/2026-07-28): Dated spec, 2026-07-28 | 16 | — | http | MCP + WebMCP tools with write verbs (delete, book, pay, send) have destructiveHint/readOnlyHint false; read tools readOnlyHint |
| `security.https` | HTTPS with HSTS | 2 | [HTTP Strict Transport Security](https://www.rfc-editor.org/rfc/rfc6797): RFC (Standards Track), 2012-11 | 16 | — | http | http:// redirects to https://; Strict-Transport-Security max-age >= 1 year |
| `security.headers` | Baseline security headers | 1 | [Content Security Policy Level 3](https://www.w3.org/TR/CSP3/): W3C WD (CSP2 Rec), continuous | 16 | — | http | Content-Security-Policy, X-Content-Type-Options nosniff, frame-ancestors/X-Frame-Options |
| `security.security-txt` | security.txt contact | 1 | [security.txt](https://www.rfc-editor.org/rfc/rfc9116): RFC (Informational), 2022-04 | 16 | — | http | /.well-known/security.txt with Contact and Expires in the future |

### Privacy & consent (`privacy`, layer weight 1, book ch. 17)

Policy links, consent overlays, GPC, human confirmation.

| id | check | sev | standard (status, date) | ch | grader map | runs on | how it is tested |
|---|---|---|---|---|---|---|---|
| `privacy.policy-link` | Privacy policy and terms are linked machine-readably | 1 | [IANA link relations (privacy-policy, terms-of-service)](https://www.iana.org/assignments/link-relations/): RFC (Informational) + IANA registry, 2013-03 | 17 | — | http | link rel=privacy-policy / terms-of-service, or anchors named privacy/terms on the homepage |
| `privacy.consent-overlay` | Consent banner does not block content for agents | 2 | [The Agent-Ready Web (book guidance)](https://github.com/webmaxru/agent-ready-web-demos): Book recommendation (opinion, sourced per chapter), 2026-11-02 | 17 | — | browser | Browser: fixed/sticky overlays with consent words covering >30% of the viewport, and whether content is readable without clicking (heuristic) |
| `privacy.gpc` | Global Privacy Control support declared | 1 | [Global Privacy Control](https://www.w3.org/TR/gpc/): W3C WG draft (legally recognised in some US states), 2026 | 17 | — | http | /.well-known/gpc.json with gpc: true; informational |
| `privacy.human-confirmation` | Risky tools ask a human to confirm | 1 | [WebMCP](https://webmachinelearning.github.io/webmcp/): W3C CG draft, Chrome origin trial, 2026-11-02 | 17 | — | http | WebMCP/MCP write tools: annotations or descriptions show a confirmation step (requestUserInteraction / elicitation); informational heuristic (heuristic) |

### Performance & stability (`performance`, layer weight 1, book ch. 3,19)

CLS, TTFB, compression, redirects, page weight.

| id | check | sev | standard (status, date) | ch | grader map | runs on | how it is tested |
|---|---|---|---|---|---|---|---|
| `performance.cls` | Layout is stable (CLS) | 2 | [Cumulative Layout Shift](https://web.dev/articles/cls): Metric (W3C draft API), continuous | 3 | LH `cumulative-layout-shift` | browser | Browser: PerformanceObserver layout-shift (buffered) over load + 3 s; good <= 0.1, poor > 0.25 (web.dev thresholds) |
| `performance.ttfb` | Server responds quickly (TTFB) | 1 | [Web Vitals (TTFB guidance)](https://web.dev/articles/ttfb): Guidance, continuous | 19 | — | http | Homepage time to first byte from the checker; good <= 0.8 s, poor > 1.8 s (web.dev) |
| `performance.compression` | Text responses are compressed | 1 | [HTTP content coding (gzip, br, zstd)](https://www.rfc-editor.org/rfc/rfc9110#section-8.4): RFC (Standards Track), 2022-06 | 19 | — | http | Homepage with Accept-Encoding: gzip, br; Content-Encoding present |
| `performance.redirects` | Few redirects to the homepage | 1 | [HTTP Semantics (content negotiation, Vary)](https://www.rfc-editor.org/rfc/rfc9110): RFC (Standards Track), 2022-06 | 19 | — | http | Redirect chain length from the entered URL; warn above 2 |
| `performance.page-weight` | HTML is a reasonable size | 1 | [The Agent-Ready Web (book guidance)](https://github.com/webmaxru/agent-ready-web-demos): Book recommendation (opinion, sourced per chapter), 2026-11-02 | 3 | — | http | Server HTML bytes and DOM node count reported; informational, warns only past Googlebot's documented 15 MB HTML fetch limit |

Counts: 113 checks; 23/23 isitagentready checks mirrored; 7/7 Lighthouse Agentic audits mirrored; 9 browser-only.

## 4. Scoring model

- Check status: `pass` (1), `warn` (0.5), `fail` (0); `info`, `neutral` (not applicable), `skipped` (could not run here)
  and `error` (network) do not count.
- Effective weight = severity (1–3) × maturity of the standard: standard/RFC/Recommendation/book guidance 1.0,
  draft 0.6, proposal or convention 0.4. So a missing RFC 9727 catalog costs more than a missing ARD manifest.
  The maturity factor is an opinion and the report says so.
- Layer score = weighted credit / weighted total, 0–100. Capability layers (APIs, MCP, commerce, identity) score only
  when the site shows that capability (an API, an MCP card, shop signals, OAuth metadata); otherwise the layer shows
  "not applicable" plus advice. `api.actionable-interface` makes sure a site with forms but no machine interface is
  still penalised.
- Overall Agent-Ready score = layer scores weighted by layer weight (perception 3; crawler, structured data, content,
  security 2; APIs 1.5; the rest 1).
- isitagentready-compatible Level 0–5: computed only from the 23 compat results with Cloudflare's published rules
  (L1 two of robots/sitemap/Link headers; L2 + AI rules and Content Signals; L3 + Markdown negotiation; L4 + one of
  MCP card/A2A/Agent Skills/API catalog; L5 + two of Web Bot Auth, all four, auth metadata). Commerce is scored only
  when commerce signals are detected; webBotAuth fail shows as neutral, as Cloudflare does.
- Lighthouse Agentic view: the 7 audits with Lighthouse's own scoring (binary a11y tree, CLS metric, WebMCP schema
  0/0.5/1, llms-txt N/A on 4xx, ard-schema N/A when absent) and the mean of scored audits.
- Role view: each check is tagged with the Appendix A roles (developer, designer, content/SEO, PM, architect, QA,
  security, analytics); the report filters by role.

### Where we differ from Cloudflare (stated in every report)
- Our checks are often stricter than their compat twin: Markdown without `Vary: Accept` is a warn; a robots.txt that
  blocks search and user fetchers while allowing training is a warn even though IIAR passes it; a soft-404 site gets
  flagged because it makes every well-known probe ambiguous.
- We score drafts lower (maturity factor) and do not need commerce/OAuth on sites that have no shop or API.
- We add layers IIAR does not look at: perception, structured data, security, privacy, performance.
- Compat results are our re-implementation of the published rules. When Cloudflare's live scanner disagrees, the report
  says so (the comparison table in milestone 2 measures how often).

## 5. Report design

Each finding: status, message, evidence (request line, key response headers, status, a 2 KB body excerpt), why it matters
(one paragraph + chapter link), how to fix it (copy-paste snippet) and a "fix prompt" for coding agents. The standard's
status badge (RFC / W3C Rec / draft / proposal / convention) sits on every finding. Report header: overall score, 13 layer
bars, IIAR level with what is needed for the next level, Lighthouse Agentic view, role filter, "copy all fix prompts".
Formats: HTML, JSON, Markdown (also via `Accept: text/markdown`), SVG badge.

## 6. Surfaces (the service is itself agent-ready)

- JSON API: `POST /api/scan` {url, browser?, format?} and `GET /api/scan?url=`; `GET /api/checks`, `GET /api/checks/{id}`,
  `GET /api/reports/{id}`; problem+json errors; RateLimit headers. OpenAPI 3.1 at `/openapi.json`, RFC 9727 catalog.
- MCP: stateless Streamable HTTP at `/mcp` (protocol 2026-07-28, also accepts 2025-06-18/2025-11-25): tools `scan_site`,
  `list_checks`, `explain_check`, `get_report`; server card at the SEP-2127 and IIAR paths.
- WebMCP on the page: imperative `scan_site` (registerTool) plus the declarative scan form (`toolname`).
- Agent Skill: `/.well-known/agent-skills/index.json` + `SKILL.md` with sha256 digest. ARD manifest, llms.txt,
  llms-full.txt, robots.txt with AI rules + Content-Signal + Agentmap, sitemap, Markdown negotiation with Vary, Link
  headers, security.txt.
- Shareable reports `/r/{id}` (stored 30 days), badges `/badge/{host}.svg`.
- CLI: `npx agent-ready-check <url> [--json|--md] [--browser] [--allow-private] [--fail-under N]` for CI gates.

## 7. Safe fetching

SSRF guard on every hop: http/https only, ports 80/443 (CLI can allow others), DNS resolved and every address checked
against private, loopback, link-local, CGNAT, multicast, reserved and IPv6 ULA/mapped ranges; redirects followed by hand
(max 5) with the guard re-run on each hop; Node pins the connection to the checked address (no DNS rebinding); the Worker
resolves through DNS-over-HTTPS. Per request 10 s timeout and a byte cap (HTML 3 MB, other 1 MB); per scan max 120
requests, 8 at a time, 60 s deadline. User-Agent `AgentReadyCheck/<v> (+<service>/about)`. The crawl part (sitemap
samples, llms.txt link checks) obeys robots.txt for our token; single user-requested fetches of the entered URL and
well-known metadata behave like a user agent. Per-IP rate limit (10 scans / 10 min) and a 10-minute result cache per URL.

## 8. Deploy

- Live (Tab can do this itself): Cloudflare Worker on Tab's own `agent-ready-check.sites.tab.bot`, with a D1 database for
  reports and rate limits. Probed on 3 Nov 2026: 200 parallel subrequests and D1 both work there. All HTTP, DNS and static
  HTML checks run there; browser checks show `skipped` unless a browser runner is configured.
- Azure kit for Maxim (he runs it): `infra/` with Bicep, `deploy.sh` and ASCII-only `deploy.ps1`
  (`-UploadOnly -NoBuild -CustomDomain`, Invoke-Native and the py/python/python3 probe from webmcp-book). Target: Azure
  Container Apps, consumption plan, scale to zero, image built in ACR from the Playwright base image so browser checks run;
  reports on an Azure Files mount. Cost is measured from the Azure retail prices API before it is quoted.
- Tab takes no action in Maxim's Azure, Cloudflare or DNS.

## 9. Tests and CI

- Unit (node:test): parsers (robots groups, Content-Signal, sitemap, llms.txt, linkset, JSON-LD, OpenAPI), each check
  against canned responses, SSRF ranges and redirect hops, scoring and the IIAR level table.
- Graded fixtures: Nordlys Cabins from the demos repo at `--upto` 0, 2, 4, 6, 7, 8, 9, 11, 12, 15, 20 and the legacy
  baseline; expected IIAR level and layer scores are snapshot files, so any drift fails CI.
- E2E (Playwright): UI scan flow, WebMCP tool on our own page, MCP `tools/list` and `scan_site`, self-scan thresholds.
- GitHub Actions: lint, unit, fixture regression, e2e. Node 22 and 24.

## 10. Work split

Lead: core (fetcher, context, scan runner, scoring, catalog), integration, comparison with IIAR, deploy, releases.
Helpers: H1 checks A (perception static, crawl, structured, content, performance), H2 checks B (api, mcp, discovery,
commerce, identity, security, privacy static), H3 browser collector + browser checks + UI/report, H4 server/API/MCP/
WebMCP/CLI/Worker bundle/Azure kit/CI.

## 11. Risks and unverified
- MCP server-card location is contested (three paths live); we read all three and say which one we found.
- WebMCP needs Chromium with `WebMCPTesting`; the live Worker cannot run a browser.
- Thresholds marked heuristic are ours, not a standard's.
- Standards move weekly; every check carries the date its source was read, and `src/catalog.json` is the one place to update.
