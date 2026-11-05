# Deploying Agent-Ready Check

The production target is **Azure Static Web Apps** with the API as **Azure Functions**, set up once and then deployed by GitHub Actions on every push to `main`. The one-time setup, click by click, is in [docs/PUBLISHING.md](docs/PUBLISHING.md). This page explains the architecture, the decisions and the costs.

Other ways to run it (Node, Docker, a Cloudflare-style Worker) are at the end.

## Architecture on Azure

```
visitor / agent
      |
      v
Azure Static Web Apps (Free plan, global edge, free TLS certificate, custom domain agent.isainative.dev)
  |-- /assets/*  -> static files (CSS, JS, pixel font, favicon) from the Static Web Apps CDN
  |-- /api/*     -> managed Azure Function "site" (Node 22)
  `-- every other path -> rewritten to /api/__site -> the same function
                               |
                               |-- reports: Azure Blob Storage, container "reports" (30-day lifecycle rule)
                               `-- browser checks: POST /collect -> browser runner (Azure Container Apps, scales to zero)
```

- **One function serves the whole site.** Static Web Apps only routes `/api/*` to functions, so `staticwebapp.config.json` rewrites every non-asset path to `/api/__site`. The function reads the visitor's address from the `x-ms-original-url` header and hands the request to the same Hono app the Node server and the Worker use (`server/azure.mjs`). That keeps everything that makes the service agent-ready: Markdown negotiation with `Vary: Accept`, `Link` headers, `robots.txt`, `llms.txt`, the API catalog, `/.well-known/*`, `/mcp`, report pages and badges. Static Web Apps passes API response headers through unchanged ("Headers in API responses are preserved", [configuration docs](https://learn.microsoft.com/en-us/azure/static-web-apps/configuration)).
- **Code:** `server/azure-function.mjs` (registration, Azure Functions v4 Node.js model), `server/azure.mjs` (handler), `src/store/azure-blob.mjs` (reports), `scripts/build-azure.mjs` (builds `dist/azure/web` and `api/dist/index.mjs`), `scripts/swa-config.mjs` (routing), `api/` (function app manifest), `Dockerfile.runner` (browser runner image).
- **Infra:** `infra/main.bicep`, wrapped by `infra/deploy.sh` and `infra/deploy.ps1`.
- **Pipelines:** `.github/workflows/deploy-azure.yml` (push to `main`), `deploy-infra.yml` (on demand, for example to bind the domain), `npm-publish.yml` (on a GitHub release), `ci.yml` (every PR).

## Decisions

### Static Web Apps plan: Free

| | Free | Standard |
|---|---|---|
| Price | 0 | 9 USD per app per month (retail price API, West Europe, read 5 Nov 2026) |
| Managed functions (the API) | yes | yes |
| Bring your own Functions app (linked) | no | yes |
| Custom domains | 2 per app | 5 per app |
| Bandwidth | 100 GB per subscription included; over quota the site is not served | 100 GB included, then 0.20 USD per GB |
| SLA | none | yes |

Sources: [Static Web Apps plans](https://learn.microsoft.com/en-us/azure/static-web-apps/plans) and [pricing](https://azure.microsoft.com/en-us/pricing/details/app-service/static/), read 5 November 2026.

Free is enough: the API runs as **managed functions**, which every plan includes, and one custom domain is needed. Standard would only be needed for a linked Function App (bring your own functions), managed identity in the API, private endpoints or the SLA. The plan is one parameter (`swaSku`, or the `-Sku` / `--sku` flag, or the Deploy infra workflow input) if that changes.

Managed-function limits that shape the design ([API overview](https://learn.microsoft.com/en-us/azure/static-web-apps/apis-overview), [Functions in Static Web Apps](https://learn.microsoft.com/en-us/azure/static-web-apps/apis-functions), read 5 Nov 2026): HTTP triggers only, the `/api` prefix is fixed, and **each API request may last at most 45 seconds**. The function therefore gives each scan a 30-second network budget (`SCAN_TIMEOUT_MS`) and the browser runner the same, so a scan answers before the limit.

### API: managed functions, not a linked Function App

Managed functions cost nothing extra on the Free plan beyond Functions consumption rates, need no second resource and deploy in the same step as the site. A linked Flex Consumption app would require Standard (+9 USD/month) and a second deployment for no gain here: the API is HTTP-only and stateless.

### Storage: Blob Storage instead of D1

Reports are JSON documents of tens to hundreds of KB, read by id, plus two small pointers (newest report per host for badges, newest per URL for the 10-minute cache). Blob Storage fits that exactly, and a lifecycle rule deletes blobs 30 days after their last write, matching the 30-day retention without a cleanup job. Table Storage was the other cheap option, but its 1 MB entity limit and 64 KB property limit would force splitting large reports. Dropping persistence was rejected because shareable report links and badges are features.

The store talks to the Blob REST API directly with Shared Key signing (no SDK; tested against the Azurite emulator, including a wrong-key rejection). The connection string lives only in the Static Web App's application settings, written by Bicep from the storage account's keys; it never appears in the repository, the workflow logs or GitHub.

Rate limiting is per function instance (in memory), so with several instances the effective limit is a multiple of `RATE_LIMIT`. That is acceptable for a free checker; a shared limiter would need a store write per request.

### Browser checks: a small Container App, optional

Chromium cannot run comfortably inside Functions. The three options:

| Option | Works? | Cost | Verdict |
|---|---|---|---|
| Functions on Flex Consumption with Playwright | Flex does not support custom containers, so Chromium's system libraries are not there | consumption rates | rejected |
| Functions Premium (EP1) with a custom container | yes | always on: 0.169 USD per vCPU-hour + 0.0121 USD per GiB-hour (West Europe), about 154 USD/month for EP1 (1 vCPU, 3.5 GB) | rejected on cost |
| Azure Playwright Workspaces (remote browsers) | built for running test suites against your own apps; no control over the Chromium build or the `--enable-features=WebMCPTesting` flag the WebMCP checks need | the pricing page shows "30 day free trial (first 100 test minutes)" and a per-minute rate that did not render on 5 Nov 2026; the retail price API still lists only the old Microsoft Playwright Testing meters | rejected |
| **Container App for the browser runner only** | yes: the existing `server/runner.mjs` in a slim Node 24 image with Chromium's headless shell | scales to zero; inside the monthly free grant for typical use (below) | **chosen** |

The runner is **optional** (`--no-browser-runner` / `-NoBrowserRunner`). Without it the API still runs the 104 checks that need only HTTP or DNS and reports the 9 browser-only checks as "skipped".

The image is built by GitHub Actions and pushed to GitHub Container Registry (free for public images), so no Azure Container Registry is needed (the v0.1.0 kit paid about 5 USD a month for one). The Container App pulls it anonymously, which needs the package to be public (one click, see PUBLISHING.md).

Cold start: when the runner has scaled to zero, the first browser scan waits for a replica to start and pull the image. If that pushes the scan past the 45-second API limit, the report shows the browser checks as failed with the runner's error and a second scan a minute later succeeds. Setting `minReplicas` to 1 removes the cold start at idle rates (see the table). This is a known trade-off, not measured on Azure yet.

## Monthly cost

Prices: [Container Apps pricing](https://azure.microsoft.com/en-us/pricing/details/container-apps/) (free grant) and [Static Web Apps pricing](https://azure.microsoft.com/en-us/pricing/details/app-service/static/), read 5 November 2026; per-unit rates from the Azure retail prices API (`prices.azure.com`), West Europe, read 5 November 2026. Usage figures marked "assumed" are estimates, not measurements on Azure.

| Item | Rate | Free each month | Estimate |
|---|---|---|---|
| Static Web Apps, Free plan | 0 | 100 GB bandwidth per subscription | 0 USD |
| Managed functions (consumption rates) | 0.000016 USD per GB-s, 0.20 USD per million executions | 400,000 GB-s and 1 million executions | 0 USD up to about 160,000 scans (assumed 256 MB for 10 s = 2.5 GB-s per scan) |
| Blob Storage, Hot LRS | 0.0196 USD per GB-month, 0.054 USD per 10,000 writes, 0.0043 USD per 10,000 reads | none | about 0.02 USD for 1,000 scans (assumed 0.5 MB per report, 3 writes per scan) |
| Browser runner, Container Apps consumption, 1 vCPU / 2 GiB | active 0.000034 USD per vCPU-s and 0.000004 USD per GiB-s | 180,000 vCPU-s, 360,000 GiB-s, 2 million requests per subscription | 0 USD up to about 1,300 browser scans that each wake the runner alone (assumed 15 s job + 120 s cooldown = 135 s); then about 0.006 USD per such scan; back-to-back scans share one wake-up |
| Runner kept warm instead (`minReplicas: 1`) | idle 0.000004 USD per vCPU-s and per GiB-s | same grant | about 31 USD/month at 1 vCPU / 2 GiB (2.63 million seconds x (0.000004 + 2 x 0.000004)), before the grant |
| GitHub Container Registry, public image | 0 | | 0 USD |
| **Total at idle or light use** | | | **about 0 USD per month (cents for storage)** |

For comparison: Standard plan +9 USD/month; Functions Premium EP1 for browser checks about 154 USD/month.

## What `infra/deploy.sh` / `infra/deploy.ps1` do

Run once from Azure Cloud Shell (nothing to install). Both scripts take the same options:

| bash | PowerShell | Default | Meaning |
|---|---|---|---|
| `--github-repo OWNER/REPO` | `-GitHubRepo` | (required) | the repository whose workflows may deploy |
| `--custom-domain HOST` | `-CustomDomain` | | bind it once its CNAME is live (checked first) |
| `--resource-group` | `-ResourceGroup` | `rg-agent-ready-check` | |
| `--location` | `-Location` | `westeurope` | storage and runner region |
| `--swa-location` | `-SwaLocation` | `westeurope` | Static Web App region |
| `--name` | `-Name` | `agent-ready-check` | name prefix |
| `--sku Free\|Standard` | `-Sku` | `Free` | Static Web Apps plan |
| `--subscription` | `-Subscription` | current | |
| `--runner-image` | `-RunnerImage` | `ghcr.io/<owner>/agent-ready-check-runner:latest` | a placeholder until the image exists |
| `--no-browser-runner` | `-NoBrowserRunner` | | skip the runner |
| `--skip-oidc` | `-SkipOidc` | | skip the Entra app and federated credential |
| `--set-github-variables` | `-SetGitHubVariables` | | write the variables with `gh` |
| `-y` | `-Yes` | | no prompt |

Steps: register the resource providers, create the resource group, create the Entra app registration `agent-ready-check-github` with a federated credential for `repo:OWNER/REPO:environment:production` and Contributor on the resource group, deploy `infra/main.bicep`, check the CNAME and bind the custom domain if it is live, then print the DNS record and the GitHub variables. Safe to re-run. No secret is printed or written.

Checked offline on 5 November 2026: Bicep CLI 0.48.1 builds `main.bicep` with 0 warnings; `deploy.sh` passes `bash -n` and shellcheck; `deploy.ps1` parses in PowerShell 7.6.9 and is ASCII-only; both scripts ran end to end against a stand-in `az`. Not yet run against Azure.

## The Container Apps kit from v0.1.0 is retired

v0.1.0 ran the whole app in one Azure Container App with a container registry, a file share and Log Analytics (about 5 USD/month idle). It is superseded by Static Web Apps + Functions and removed from `infra/`. It remains available at the [v0.1.0 tag](https://github.com/vibeprogrammer/agent-ready-check/tree/v0.1.0/infra) for anyone who prefers one container.

## Other ways to run it

- **Node 22+**: `npm ci && npm start` (port 8080; `BROWSER=1` for browser checks with a local Chromium, `REPORTS_DIR=./reports` to keep reports).
- **Docker**: `docker build -t agent-ready-check . && docker run -p 8080:8080 agent-ready-check` (Playwright base image, browser checks on).
- **Browser runner alone**: `docker build -f Dockerfile.runner -t agent-ready-check-runner .` then `docker run -p 8080:8080 -e RUNNER_TOKEN=... agent-ready-check-runner`; or `RUNNER_TOKEN=... bash scripts/runner-start.sh` on any small Linux host.
- **Cloudflare-style Worker + D1**: `npm run build:worker`, then publish `dist/worker/`. Set `BROWSER_RUNNER_URL` and `RUNNER_TOKEN` to use a runner.
