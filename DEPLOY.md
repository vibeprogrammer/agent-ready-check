# Deploying Agent-Ready Check

Four ways to run it, from the simplest:

| Where | Browser checks | What you run |
| --- | --- | --- |
| Your machine (Node 22+) | yes, with Chromium | `npm ci && npm start` (add `BROWSER=1`) |
| Docker | yes (Playwright base image) | `docker build -t agent-ready-check . && docker run -p 8080:8080 agent-ready-check` |
| **Azure Container Apps** (this kit) | yes | `./infra/deploy.sh` or `pwsh ./infra/deploy.ps1` |
| Cloudflare Worker + D1 | no (shown as "skipped") | `npm run build:worker`, then publish `dist/worker/` |

## Azure: the one command

```bash
./infra/deploy.sh                 # macOS, Linux, WSL
```

```powershell
pwsh ./infra/deploy.ps1           # Windows PowerShell 5.1 or PowerShell 7+
```

What it does, safe to re-run:

1. Checks the tools (Azure CLI, Bicep, the `containerapp` extension; Python 3.9+ only for the smoke test) and asks before it touches the subscription you are logged in to (`-Yes` / `--yes` skips the question).
2. Creates the resource group `rg-agent-ready-check` and deploys `infra/main.bicep`:
   - a Container Apps environment on the **consumption plan**, and the app `agent-ready-check` with **min 0, max 2 replicas** (scale to zero), 1 vCPU and 2 GiB each, HTTP scaling at 10 concurrent requests;
   - an **Azure Container Registry, Basic**; the app pulls from it with a **user-assigned managed identity** (AcrPull), so there is no registry password;
   - a storage account with an **Azure Files share mounted at `/data`** for stored reports (kept 30 days, survive restarts and scale-to-zero);
   - a **Log Analytics** workspace with 30-day retention and a 0.5 GB daily ingestion cap.
3. Builds the image **in the registry** with `az acr build` (no local Docker) from the `Dockerfile`, which starts `FROM mcr.microsoft.com/playwright:v1.64.1-noble`, so Chromium is there for the browser checks.
4. Rolls the image out, waits for `/api/health` and runs `infra/check_site.py` (14 smoke checks: Link headers, Markdown negotiation, robots.txt, llms.txt, API catalog, MCP card and tools/list, Agent Skills digest, ARD, Origin check, problem+json, security headers).

No secret is printed, put on a command line or written to a file. The storage and Log Analytics keys are read by Bicep at deployment time (`listKeys()`).

Options (bash / PowerShell):

| bash | PowerShell | Default | Meaning |
| --- | --- | --- | --- |
| `--resource-group` | `-ResourceGroup` | `rg-agent-ready-check` | resource group |
| `--app-name` | `-AppName` | `agent-ready-check` | base name of the resources |
| `--location` | `-Location` | `westeurope` | region |
| `--subscription` | `-Subscription` | current | switch subscription first |
| `--custom-domain HOST` | `-CustomDomain HOST` | none | bind a domain with a free managed certificate |
| `--base-url URL` | `-BaseUrl URL` | from each request | public origin for absolute links |
| `--max-replicas N` | `-MaxReplicas N` | 2 | upper bound on replicas (and on cost) |
| `--rate-limit N` / `--rate-window S` | `-RateLimit N` / `-RateWindow S` | 10 / 600 | scans per client per window |
| `--upload-only` | `-UploadOnly` | | the app exists: build the image and roll it out, no Bicep |
| `--no-build` | `-NoBuild` | | do not build an image, re-use the current one |
| `--skip-smoke` | `-SkipSmoke` | | skip `check_site.py` |
| `--yes` | `-Yes` | | do not ask |

Everyday commands:

```bash
./infra/deploy.sh --upload-only                       # ship a new version (about 4-7 minutes)
az containerapp logs show -g rg-agent-ready-check -n agent-ready-check --follow
az group delete -n rg-agent-ready-check               # remove everything the script created
```

## Custom domain

Example: `agent-ready-check.salnikov.no`.

1. Run the deploy once without a domain. It prints the app's address, `<app>.<hash>.<region>.azurecontainerapps.io`.
2. In your DNS (for Cloudflare: **proxy off, grey cloud**, so the certificate can be validated), create:
   - `CNAME agent-ready-check` → the app's address;
   - `TXT asuid.agent-ready-check` → the environment's domain verification id. The script prints the exact value when the records are missing; it is also `az containerapp env show -g rg-agent-ready-check -n cae-agent-ready-check --query properties.customDomainConfiguration.customDomainVerificationId -o tsv`.
3. Bind it (and get a free managed certificate):

```bash
./infra/deploy.sh --upload-only --no-build --custom-domain agent-ready-check.salnikov.no
```

```powershell
pwsh ./infra/deploy.ps1 -UploadOnly -NoBuild -CustomDomain agent-ready-check.salnikov.no
```

The script checks both records against 1.1.1.1 first and stops with the values to create when they are not there yet. Issuing the certificate can take 10 to 20 minutes. The app needs no configuration change: it builds its absolute links from the request's host (`TRUST_PROXY=1` is set). Pass `--base-url https://agent-ready-check.salnikov.no` if you want the links pinned.

## What it costs

Prices from the Azure retail prices API, region `westeurope`, USD, read on **3 November 2026**. Queries:

- Container Apps: `https://prices.azure.com/api/retail/prices?$filter=serviceName eq 'Azure Container Apps' and armRegionName eq 'westeurope' and priceType eq 'Consumption'`
- Container Registry: `https://prices.azure.com/api/retail/prices?$filter=serviceName eq 'Container Registry' and armRegionName eq 'westeurope' and priceType eq 'Consumption'`
- Log Analytics: `https://prices.azure.com/api/retail/prices?$filter=serviceName eq 'Log Analytics' and armRegionName eq 'westeurope' and priceType eq 'Consumption'`
- Storage (Azure Files): `https://prices.azure.com/api/retail/prices?$filter=serviceName eq 'Storage' and armRegionName eq 'westeurope' and priceType eq 'Consumption' and productName eq 'Files v2'`

| Item | Price (retail API) | Notes |
| --- | --- | --- |
| Container Apps vCPU, active | $0.000034 per vCPU-second | "Standard vCPU Active Usage" |
| Container Apps memory, active | $0.000004 per GiB-second | "Standard Memory Active Usage" |
| Container Apps vCPU / memory, idle | $0.000004 per vCPU-second / GiB-second | only for replicas kept warm by a minimum; this kit uses min 0 |
| Container Apps requests | $0.56 per million | |
| Free grant | 180,000 vCPU-seconds, 360,000 GiB-seconds and 2 million requests per subscription per month | from the Container Apps pricing page, same day |
| Container Registry, Basic | $0.1666 per day (about $5.00 for 30 days) | 10 GB storage included (pricing page); build time: the retail API lists the first 6,000 task vCPU-seconds a month at $0, then $0.0001 per second |
| Log Analytics ingestion | $0 for the first 5 GB a month, then $2.99 per GB | the daily cap stops runaway logs |
| Azure Files, Hot LRS | $0.0271 per GB-month, writes $0.0702 / reads $0.0056 per 10,000 | a report is tens to a few hundred KB |

What that means (our arithmetic, not a quote):

- **Idle**: the app scales to zero, so compute costs nothing. The fixed cost is the registry, about **$5 a month**, plus cents for storage.
- **A burst of scans**: a replica (1 vCPU, 2 GiB) that wakes up, scans for about 30 seconds and stays up for the scale-down cool-down (300 seconds is the Container Apps default in its scaling docs; not re-checked on 3 November) is about 330 seconds at the active rate, roughly **$0.014**. The free grant covers about **545 such bursts a month**; scans that arrive while a replica is up share it.
- **Heavy use**: 2,000 separate bursts a month would be about $20 of compute above the free grant. The worst case, one replica busy around the clock for 30 days, is about $82 (vCPU) + $19 (memory) ≈ **$101 a month**; `--max-replicas` caps the multiple of that.
- The rate limit (10 scans per client per 10 minutes) and the 10-minute result cache keep a single client from running up the bill.

Not included: outbound data transfer (small: reports are JSON), and anything you add (Front Door, a budget alert). To get an email when spending passes a limit, add a budget in Cost Management for the resource group.

## Cloudflare Worker (no browser)

```bash
npm run build:worker            # dist/worker/_worker.mjs + tab-site.json (D1 binding "DB")
```

`dist/worker/` is a Worker with static assets: bind a D1 database as `DB` (reports and rate limits; the tables are created on first use). Browser checks report "skipped" there. The landing page is rendered by the Worker, so `/` keeps its Link headers and Markdown negotiation.

## Environment variables (Node and Docker)

| Name | Default | Meaning |
| --- | --- | --- |
| `PORT` / `HOST` | 8080 / 0.0.0.0 | listen address |
| `BASE_URL` | from the request | public origin for absolute links |
| `REPORTS_DIR` | none (memory) | directory for stored reports |
| `BROWSER` | off | `1` runs the browser checks (needs playwright-core and Chromium; `CHROMIUM_PATH` overrides the executable) |
| `RATE_LIMIT` / `RATE_WINDOW` | 10 / 600 | scans per client per window (seconds) |
| `TRUST_PROXY` | off | `1` behind a proxy: use X-Forwarded-For/Proto/Host |
| `ALLOW_PRIVATE` | off | `1` allows private and local targets. Local testing only, never on a public deployment |
