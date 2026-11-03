---
name: agent-ready-check
description: Scan a website for agent-readiness with Agent-Ready Check (113 checks in 13 layers) and turn the findings into fixes. Use it when someone asks whether a site works for AI agents, why an agent cannot use a site, or how to raise an isitagentready level or a Lighthouse Agentic Browsing score.
license: MIT
---

# Agent-Ready Check

Agent-Ready Check scans one public URL and reports, layer by layer, how well AI agents can find, read and use the site. Every finding has evidence (the request and the response), the reason it matters with a chapter of the book "The Agent-Ready Web" by Maxim Salnikov, a copy-paste fix and a fix prompt for coding agents. The report also shows an isitagentready-compatible level (0 to 5) and a Lighthouse Agentic Browsing view.

Base URL: https://agent-ready-check.sites.tab.bot

## When to use it

- Someone asks "is this site agent-ready?", "why can't an agent book on my site?" or "how do we reach isitagentready Level 4?".
- You changed robots.txt, llms.txt, Markdown negotiation, an API catalog, an MCP server or WebMCP tools and want to verify the change.
- You need a list of concrete fixes, with prompts, for a coding agent.

## Option 1: MCP (preferred for agents)

Connect to the stateless Streamable HTTP MCP server at `https://agent-ready-check.sites.tab.bot/mcp` (protocol 2026-07-28; 2025-11-25 and 2025-06-18 also work). Tools:

- `scan_site` {"url": "https://example.com"}: runs a scan (about 10 to 60 seconds) and returns a summary, the report URL and the full report as structured content.
- `list_checks` {"layer": "crawl"}: the check catalogue, optionally for one layer.
- `explain_check` {"id": "content.markdown-negotiation"}: what a check tests, its standard and status, why it matters and how to fix it.
- `get_report` {"id": "<report id>"}: a stored report (kept 30 days).

## Option 2: HTTP API

```bash
# JSON report
curl -s -X POST https://agent-ready-check.sites.tab.bot/api/scan -H 'content-type: application/json' -d '{"url":"https://example.com"}'

# Only the failing and warning checks as Markdown fix prompts, ready for a coding agent
curl -s -X POST https://agent-ready-check.sites.tab.bot/api/scan -H 'content-type: application/json' -d '{"url":"https://example.com","format":"agent"}'

# One check explained
curl -s https://agent-ready-check.sites.tab.bot/api/checks/content.markdown-negotiation
```

The OpenAPI description is at https://agent-ready-check.sites.tab.bot/openapi.json. Errors are `application/problem+json` (RFC 9457). Scans are rate limited per client (the `RateLimit-Policy` and `RateLimit` headers say how many are left; a 429 carries `Retry-After`). The same URL is served from a 10-minute cache.

## Option 3: CLI (local, CI gates)

```bash
npx agent-ready-check https://example.com            # table
npx agent-ready-check https://example.com --prompts  # fix prompts for a coding agent
npx agent-ready-check https://example.com --fail-under 70 --level-at-least 3   # exit code 1 when a gate fails
```

## How to read the result

- `score` (0 to 100) is the weighted mean of the applicable layers. Drafts and proposals weigh less than RFCs and W3C Recommendations.
- `compat.isitagentready.level` is computed from the 23 isitagentready checks with Cloudflare's published rules, so it can be compared with isitagentready.com.
- Each check has `status`: pass, warn, fail, info, neutral (not applicable), skipped (needs a browser) or error (network).
- Checks marked `heuristic` are this checker's judgement, not a standard's rule.
- Fix in this order: failing checks with severity 3 and a standard status of RFC or Recommendation first.

## Rules for agents

- Scan only sites the user asked about; private and local addresses are refused.
- Do not rescan the same URL in a loop: results are cached for 10 minutes.
- Quote findings with their evidence, and say when a standard is only a draft or a proposal.
