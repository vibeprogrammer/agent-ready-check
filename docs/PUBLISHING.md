# Publishing and managed deployment

After a one-time setup of about an hour, nothing runs on your computer:

- **Merge to `main`** and GitHub Actions deploys the site and the API to Azure Static Web Apps (and the browser runner image to Azure Container Apps), then smoke-tests the live site.
- **Publish a GitHub release** and GitHub Actions publishes the package to npm with a provenance statement.

Both sign in with **OIDC**: Azure trusts this repository's workflow through a federated credential, and npm trusts it through Trusted Publishing. There is no Azure secret and no `NPM_TOKEN` in the repository or in GitHub's secret store.

This page is the click-by-click setup. The architecture, the decisions and the cost table are in [DEPLOY.md](../DEPLOY.md). Prices and facts were read on 5 November 2026.

## The one-time steps at a glance

| # | Step | Where | Time | Cost |
|---|---|---|---|---|
| 0 | Decide where the repository lives (transfer to `webmaxru` or not) | GitHub | 5 min | free |
| 1 | Create the Azure resources and the GitHub sign-in (one Cloud Shell run) | Azure portal, Cloud Shell | 15 min | about 0 USD/month (see DEPLOY.md) |
| 2 | Add the repository variables | GitHub | 5 min | free |
| 3 | First deploy, then make the runner image public | GitHub | 10 min (mostly waiting) | free |
| 4 | DNS record for agent.isainative.dev | Cloudflare (your DNS host) | 5 min + propagation | free |
| 5 | Bind the domain | GitHub (Deploy infra workflow) | 5 min + certificate | free |
| 6 | npm: account, first publish, trusted publisher | npmjs.com, a Codespace | 15 min | free (public package) |
| 7 | Turn on npm publishing | GitHub | 1 min | free |

Then every release is: merge a PR that bumps the version, and publish a release (about 2 minutes of your time).

---

## Step 0. Decide where the repository lives

The repository is `github.com/vibeprogrammer/agent-ready-check`. Both trust relationships set up below name the repository owner and name:

- the Azure federated credential's subject is `repo:OWNER/REPO:environment:production`;
- the npm trusted publisher is configured with the GitHub user, the repository and the workflow file name.

**Recommendation: transfer the repository to `webmaxru` first, then do steps 1 to 7.** It sits with your other projects, the npm package's provenance will point at your account, and you avoid redoing the two trust bindings later. GitHub redirects the old web and git URLs after a transfer, so existing links keep working.

### If you transfer (recommended)

1. Signed in as the current owner, open the repository > **Settings** > **General**, scroll to **Danger Zone** > **Transfer**.
2. New owner: `webmaxru`. Type the repository name to confirm, click **I understand, transfer this repository**.
3. As `webmaxru`, accept the transfer from the e-mail GitHub sends (a transfer to a personal account needs the recipient's acceptance).
4. Run every step below with `webmaxru/agent-ready-check`.
5. Afterwards, update the links that name the old owner (the footer link, the crawler user agent's contact URL, `package.json` and the README). That is one small PR; Tab can make it. The npm workflow already sets `repository.url` to the current repository at publish time, because npm checks that it matches the provenance.

What moves with the repository: code, issues, PRs, releases, Actions workflows, variables and environments. What does not: the container image in GitHub Container Registry, which belongs to the account that pushed it. After a transfer the deploy workflow pushes a new image under `ghcr.io/webmaxru/...` automatically; make that one public (step 3) and delete the old one if you like.

### If you keep it under the current account

Run every step with `vibeprogrammer/agent-ready-check`. If you transfer later, redo step 1 (re-run the script with the new `--github-repo`; it adds a second federated credential), the trusted publisher in step 6c (delete and re-add it with the new owner), and the image visibility in step 3.

---

## Step 1. Create the Azure resources and the GitHub sign-in

One run of `infra/deploy.sh` in Azure Cloud Shell does all of it. You need an Azure subscription where you are **Owner** (the script assigns a role) and can register an app in Microsoft Entra ID.

1. Open **https://shell.azure.com** and sign in. Choose **Bash** (PowerShell works too, with `deploy.ps1`). The first time, Cloud Shell asks for storage; accept the default, or pick "No storage account required" on the newer ephemeral sessions.
2. Paste (replace the owner if you did not transfer):

   ```bash
   git clone https://github.com/webmaxru/agent-ready-check && cd agent-ready-check
   ./infra/deploy.sh --github-repo webmaxru/agent-ready-check --custom-domain agent.isainative.dev
   ```

   PowerShell twin: `./infra/deploy.ps1 -GitHubRepo webmaxru/agent-ready-check -CustomDomain agent.isainative.dev`.

3. Type `y` at the prompt. In about 5 to 10 minutes it:
   - registers the resource providers `Microsoft.Web`, `Microsoft.Storage`, `Microsoft.App`;
   - creates resource group `rg-agent-ready-check` (West Europe);
   - creates the Entra app registration **agent-ready-check-github** with a federated credential for `repo:webmaxru/agent-ready-check:environment:production` (issuer `https://token.actions.githubusercontent.com`, audience `api://AzureADTokenExchange`), no client secret;
   - deploys `infra/main.bicep`: the Static Web App **agent-ready-check** (Free plan), a storage account with the `reports` container and a 30-day lifecycle rule, the Container Apps environment and the **agent-ready-check-runner** app (scale 0 to 1, a placeholder image until step 3), the application settings, and **Contributor** on the resource group for the app registration;
   - checks DNS for agent.isainative.dev. The first time there is no record yet, so it prints the record to add and does not bind the domain (that is step 5).
4. Copy the block it prints at the end. It looks like this (your values differ):

   ```
   DNS record to add at the registrar of agent.isainative.dev:
     Type CNAME   Host agent   Value <name>.azurestaticapps.net   TTL 3600

   GitHub repository variables:
     AZURE_CLIENT_ID          <guid>
     AZURE_TENANT_ID          <guid>
     AZURE_SUBSCRIPTION_ID    <guid>
     AZURE_RESOURCE_GROUP     rg-agent-ready-check
     AZURE_STATIC_WEB_APP     agent-ready-check
     AZURE_RUNNER_APP         agent-ready-check-runner
     PUBLIC_BASE_URL          https://<name>.azurestaticapps.net
   ```

   None of these values is a secret: they are identifiers. The sign-in works only from this repository's workflows in the `production` environment.

**Cost:** about 0 USD a month at light use (Free plan, consumption billing, storage in cents; table in DEPLOY.md).

### Doing step 1 in the portal instead (no script)

The script is the shortest path. If you prefer clicking, the same result is:

1. **Resource group:** Portal > Resource groups > Create > `rg-agent-ready-check`, West Europe.
2. **Static Web App:** Create a resource > Static Web App > resource group above, name `agent-ready-check`, plan **Free**, region West Europe, deployment source **Other** (the workflow deploys with a token it reads at run time). Create.
3. **Storage account:** Create > Storage account > name `arc` plus a few letters, Standard, LRS. After creation: Data storage > Containers > + Container `reports` (private). Data management > Lifecycle management > Add rule "expire-reports": base blobs, last modified more than 30 days ago > delete, filter prefix `reports/`. Security + networking > Access keys > copy the connection string.
4. **Browser runner (optional):** Create > Container App > name `agent-ready-check-runner`, new Container Apps environment (Consumption only), image source **Docker Hub or other registries**, image `mcr.microsoft.com/k8se/quickstart:latest` for now, CPU 1, memory 2 Gi, Ingress enabled, accepting traffic from anywhere, target port **8080**. After creation: Secrets > add `runner-token` with a long random value; Containers > Edit > environment variable `RUNNER_TOKEN` from secret `runner-token`; Scale > min 0, max 1. Note the application URL.
5. **App settings of the Static Web App:** Settings > Environment variables > add `BASE_URL` (the site's URL), `REPORTS_CONNECTION_STRING` (from 3), `REPORTS_CONTAINER` = `reports`, `BROWSER_RUNNER_URL` = `<runner URL>/collect`, `RUNNER_TOKEN` (same value as the secret), `SCAN_TIMEOUT_MS` = `30000`. Save.
6. **App registration:** Microsoft Entra ID > App registrations > New registration > `agent-ready-check-github`, single tenant, no redirect URI. Copy the **Application (client) ID** and the **Directory (tenant) ID**.
7. **Federated credential:** in that app > Certificates & secrets > Federated credentials > Add credential > scenario **GitHub Actions deploying Azure resources** > Organization `webmaxru`, Repository `agent-ready-check`, Entity type **Environment**, environment name `production`, name `github-production`. Add.
8. **Role assignment:** the resource group > Access control (IAM) > Add role assignment > **Contributor** > Members: User, group, or service principal > select `agent-ready-check-github` > Review + assign.

---

## Step 2. Add the repository variables

GitHub > the repository > **Settings** > **Secrets and variables** > **Actions** > **Variables** tab > **New repository variable**, once per line of the block from step 1:

| Name | Value |
|---|---|
| `AZURE_CLIENT_ID` | from step 1 |
| `AZURE_TENANT_ID` | from step 1 |
| `AZURE_SUBSCRIPTION_ID` | from step 1 |
| `AZURE_RESOURCE_GROUP` | `rg-agent-ready-check` |
| `AZURE_STATIC_WEB_APP` | `agent-ready-check` |
| `AZURE_RUNNER_APP` | `agent-ready-check-runner` (leave unset to run without browser checks) |
| `PUBLIC_BASE_URL` | the `https://<name>.azurestaticapps.net` URL for now; `https://agent.isainative.dev` after step 5 |

Use **Variables**, not Secrets: these are identifiers. (If the GitHub CLI is signed in in Cloud Shell, `--set-github-variables` on the script writes them for you.)

Optional: Settings > **Environments** > `production` (created by the first run) > add yourself as a **required reviewer** if you want to approve each production deploy.

Until `AZURE_CLIENT_ID` exists, the deploy workflows skip their jobs, so merges stay green.

## Step 3. First deploy, then make the runner image public

1. Repository > **Actions** > **Deploy to Azure** > **Run workflow** (branch `main`). It runs two jobs:
   - **Browser runner image**: builds `Dockerfile.runner`, pushes `ghcr.io/<owner>/agent-ready-check-runner` with the commit sha and `latest`, signs in to Azure with OIDC and points the Container App at the new image.
   - **Static Web App and API**: runs the unit tests, builds the site and the function bundle, reads the Static Web Apps deployment token with the OIDC sign-in (masked, never stored), deploys, then smoke-tests the live site and records a self-scan in the run summary.
2. The first run's runner rollout fails if the new image is private, because the Container App pulls it anonymously. Make it public once: your GitHub profile > **Packages** > `agent-ready-check-runner` > **Package settings** > **Danger Zone** > **Change visibility** > **Public**. While there, under **Manage Actions access**, check the repository has write access (it does when the workflow created the package).
3. Re-run the failed job. Open the `PUBLIC_BASE_URL`; the site is live on the default host name.

**Cost:** GitHub Actions minutes are free for public repositories; GitHub Container Registry is free for public images.

## Step 4. DNS record for agent.isainative.dev

isainative.dev's DNS is hosted on Cloudflare (its name servers are `gina.ns.cloudflare.com` and `stan.ns.cloudflare.com`, checked 5 Nov 2026). In the Cloudflare dashboard > isainative.dev > **DNS** > **Records** > **Add record**:

| Type | Name | Target | Proxy status | TTL |
|---|---|---|---|---|
| CNAME | `agent` | `<name>.azurestaticapps.net` (the default host name from step 1, without `https://`) | **DNS only** (grey cloud) | Auto |

- **DNS only matters.** With the orange cloud (proxied), Cloudflare answers with its own addresses, Azure cannot see the CNAME, the domain validation fails and Azure cannot issue its certificate.
- **No TXT record is needed.** Static Web Apps validates a subdomain by its CNAME ([custom domains on other DNS](https://learn.microsoft.com/en-us/azure/static-web-apps/custom-domain-external)). TXT validation is only for apex domains, or for the Enterprise-grade edge add-on, which this setup does not use.
- **CAA:** isainative.dev has CAA records. They already allow `digicert.com`, the authority Static Web Apps certificates have been reported to come from, so nothing to change. If the certificate stays "pending" for hours, check this first.

Check from any terminal or https://dnschecker.org: `agent.isainative.dev` CNAME should show the azurestaticapps.net name. Usually minutes on Cloudflare.

## Step 5. Bind the domain

Repository > **Actions** > **Deploy infra** > **Run workflow**: custom domain `agent.isainative.dev`, plan `Free`, browser runner on. The workflow checks the CNAME first (it stops with a clear error if the record is missing or proxied), then re-applies `infra/main.bicep` with the domain. Azure validates it and issues a free certificate, usually within minutes.

Then set the variable `PUBLIC_BASE_URL` to `https://agent.isainative.dev` (step 2 page) and run **Deploy to Azure** once more, so the smoke test and the self-scan use the real domain. The function already uses the domain in its links: Bicep sets its `BASE_URL` setting when the domain is bound.

(Re-running the Cloud Shell script with `--custom-domain agent.isainative.dev` does the same.)

## Step 6. npm

The package name **`agent-ready-check` is free** (the registry answered 404 for it on 5 November 2026, and for the look-alikes `agentreadycheck`, `agent_ready_check` and `agent.ready.check`, which npm would treat as too similar).

### 6a. Account

1. Sign in at https://www.npmjs.com (or **Sign up**). Use the account that should own the package.
2. Avatar > **Account** > **Two-Factor Authentication**: turn it on (an authenticator app or a security key).

### 6b. First publish, once, by hand

npm's documentation describes the Trusted Publisher form only in an existing package's settings ([Trusted publishing](https://docs.npmjs.com/trusted-publishers)), and other projects document that the first version of a new package cannot be published through it. So version 0.2.0 is published once by hand, from a browser terminal, with nothing installed locally:

1. On GitHub, open the repository > **Code** > **Codespaces** > **Create codespace on main** (free monthly hours cover this).
2. In its terminal:

   ```bash
   git checkout v0.2.0
   npm login            # opens a browser sign-in; approve it
   npm publish --access public
   ```

   npm asks for your 2FA code. This first version has no provenance statement (only CI can create one); every later version will.
3. Delete the codespace (GitHub > Codespaces > ... > Delete).

### 6c. Add the trusted publisher

1. https://www.npmjs.com/package/agent-ready-check > **Settings** > **Trusted Publisher** > **GitHub Actions**.
2. Fill in:
   - Organization or user: `webmaxru` (or the current owner if you did not transfer)
   - Repository: `agent-ready-check`
   - Workflow filename: `npm-publish.yml`
   - Environment name: leave empty
   - Allowed actions: allow `npm publish`
3. Save. npm notes that a new trusted publisher must complete its first successful publish within 2 days or it expires; if that happens, delete it and add it again before the next release.
4. Recommended, same page > **Publishing access** > **Require two-factor authentication and disallow tokens** > **Update Package Settings**. Trusted publishing keeps working; tokens stop working.

Requirements on npm's side (npm CLI 11.5.1 or later, Node 22.14 or later, a GitHub-hosted runner, a public repository for provenance) are met by the workflow.

### 7. Turn on npm publishing

Repository > Settings > Secrets and variables > Actions > Variables > **New repository variable** `NPM_TRUSTED_PUBLISHING` = `true`.

Until this variable is `true`, the **Publish to npm** workflow skips its job. That is why release v0.2.0, cut before this setup, did not try to publish.

---

## How a release flows from now on

1. A PR changes the code and bumps `"version"` in `package.json` (for example to 0.2.1). CI runs: lint, unit tests on Node 22 and 24, the graded fixtures, the browser end-to-end tests, the Azure build and bundle smoke test, the runner image build with one real browser job, and the offline infra checks.
2. **Merge** to `main`: **Deploy to Azure** builds and rolls out the runner image and the site and API, then smoke-tests https://agent.isainative.dev.
3. On GitHub > **Releases** > **Draft a new release** > tag `v0.2.1` (create it on `main`) > title `v0.2.1` > notes > **Publish release**.
4. **Publish to npm** runs: it checks that the tag matches `package.json`, runs the tests and publishes with provenance. The npm page then shows a "Provenance" badge linking to the exact workflow run.

Nothing in this flow runs on your computer.

## Rolling back

- Site: Actions > a previous successful **Deploy to Azure** run > **Re-run all jobs** redeploys that commit.
- npm: `npm deprecate agent-ready-check@<version> "<reason>"` from a codespace; publish a fixed version. (npm allows unpublishing only within 72 hours, under its policy.)

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Deploy job: `AADSTS70021: No matching federated identity record found` | The federated credential's subject must be exactly `repo:<owner>/<repo>:environment:production`. After a repository transfer or rename, re-run step 1 with the new name. |
| Deploy job: `AuthorizationFailed` on `staticSites/listSecrets` | The app registration lacks Contributor on the resource group (step 1, role assignment). |
| Runner rollout: image pull fails | Make the GHCR package public (step 3). |
| Domain stuck in "Validating" | The CNAME is proxied (orange cloud) or missing. Set it to DNS only. |
| npm publish: `E404` or `ENEEDAUTH` | The trusted publisher's user, repository or workflow file name does not match, or the npm CLI is older than 11.5.1. |
| npm publish: `E422` provenance mismatch | `repository.url` must match the repository; the workflow sets it, so check the trusted publisher points at the same repository. |
| Browser checks fail on the first scan after a quiet period | The runner was scaled to zero and its cold start passed the 45-second API limit. Scan again; or set the runner's minimum replicas to 1 (about 31 USD/month, DEPLOY.md). |
