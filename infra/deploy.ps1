<#
.SYNOPSIS
  Agent-Ready Check on Azure Static Web Apps: one-time setup (and safe re-runs).

.DESCRIPTION
  Creates or updates, in one resource group (infra/main.bicep):
    - the Static Web App (Free plan) that serves the site and runs the API as managed Azure Functions
    - a storage account with a "reports" blob container (reports are deleted after 30 days)
    - optionally the browser runner: a Container App that scales to zero (Chromium for the browser checks)
  and, unless -SkipOidc, the GitHub Actions sign-in: an Entra app registration with a federated credential for
  OWNER/REPO, environment "production", with Contributor on the resource group. No secret is created for GitHub;
  the workflows sign in with OIDC. At the end it prints the GitHub repository variables to set.

  Runs in Azure Cloud Shell (PowerShell) as is, and in PowerShell 7+ or Windows PowerShell 5.1 with the Azure CLI.
  Bash twin: infra/deploy.sh.

.EXAMPLE
  ./infra/deploy.ps1 -GitHubRepo webmaxru/agent-ready-check -CustomDomain agent.isainative.dev
.EXAMPLE
  ./infra/deploy.ps1 -GitHubRepo webmaxru/agent-ready-check -NoBrowserRunner -Yes
#>
[CmdletBinding()]
param(
  [string]$GitHubRepo = '',
  [string]$CustomDomain = '',
  [string]$ResourceGroup = 'rg-agent-ready-check',
  [string]$Location = 'westeurope',
  [ValidateSet('westeurope', 'eastus2', 'centralus', 'westus2', 'eastasia')]
  [string]$SwaLocation = 'westeurope',
  [string]$Name = 'agent-ready-check',
  [ValidateSet('Free', 'Standard')]
  [string]$Sku = 'Free',
  [string]$Subscription = '',
  [string]$RunnerImage = '',
  [switch]$NoBrowserRunner,
  [switch]$SkipOidc,
  [switch]$SetGitHubVariables,
  [switch]$Yes
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$EnvironmentName = 'production'
$PlaceholderImage = 'mcr.microsoft.com/k8se/quickstart:latest'
$InfraDir = $PSScriptRoot
$Runner = -not $NoBrowserRunner

function Write-Step([string]$Text) { Write-Host ''; Write-Host ("== {0}" -f $Text) -ForegroundColor Cyan }
function Write-Ok([string]$Text) { Write-Host ("    OK   {0}" -f $Text) -ForegroundColor Green }
function Write-Info([string]$Text) { Write-Host ("    ..   {0}" -f $Text) -ForegroundColor Gray }
function Write-Warn2([string]$Text) { Write-Host ("    WARN {0}" -f $Text) -ForegroundColor Yellow }
function Exit-WithHint([string]$Text, [string]$Hint) {
  Write-Host ''
  Write-Host ("ERROR: {0}" -f $Text) -ForegroundColor Red
  if ($Hint) { Write-Host ("Next:  {0}" -f $Hint) -ForegroundColor Yellow }
  exit 1
}

# Run az and return its trimmed stdout; throw with stderr when it fails.
function Invoke-Az {
  param([Parameter(Mandatory = $true)][string[]]$Arguments, [switch]$AllowFail)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $out = & az @Arguments 2>&1; $code = $LASTEXITCODE } finally { $ErrorActionPreference = $prev }
  $text = (@($out) | ForEach-Object { "$_" }) -join "`n"
  if ($code -ne 0) {
    if ($AllowFail) { return $null }
    throw ("az {0} failed: {1}" -f ($Arguments[0..1] -join ' '), $text)
  }
  return $text.Trim()
}

if (-not $SkipOidc -and $GitHubRepo -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') {
  Exit-WithHint '-GitHubRepo OWNER/REPO is required for the GitHub sign-in' './infra/deploy.ps1 -GitHubRepo webmaxru/agent-ready-check (or -SkipOidc)'
}
$CustomDomain = ($CustomDomain.ToLowerInvariant() -replace '^https?://', '' -replace '/.*$', '').TrimEnd('.')
$OwnerLc = ''
if ($GitHubRepo) { $OwnerLc = $GitHubRepo.Split('/')[0].ToLowerInvariant() }

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
  Exit-WithHint 'Azure CLI (az) not found' 'use Azure Cloud Shell (shell.azure.com), where az is installed and signed in'
}

Write-Step 'Azure account'
if ($Subscription) { Invoke-Az @('account', 'set', '--subscription', $Subscription) | Out-Null }
$subId = Invoke-Az @('account', 'show', '--query', 'id', '-o', 'tsv') -AllowFail
if (-not $subId) { Exit-WithHint 'not signed in to Azure' 'az login' }
$tenantId = Invoke-Az @('account', 'show', '--query', 'tenantId', '-o', 'tsv')
Write-Ok ("subscription {0} ({1})" -f (Invoke-Az @('account', 'show', '--query', 'name', '-o', 'tsv')), $subId)

if (-not $Yes) {
  $what = "resource group $ResourceGroup in $Location (Static Web App $Name, $Sku plan"
  if ($Runner) { $what += ', browser runner' }
  $answer = Read-Host ("This creates or updates {0}). Continue? [y/N]" -f $what)
  if ($answer -notmatch '^(y|yes)$') { exit 1 }
}

Write-Step 'Resource providers'
foreach ($ns in @('Microsoft.Web', 'Microsoft.Storage', 'Microsoft.App')) {
  if ($ns -eq 'Microsoft.App' -and -not $Runner) { continue }
  $state = Invoke-Az @('provider', 'show', '-n', $ns, '--query', 'registrationState', '-o', 'tsv') -AllowFail
  if ($state -ne 'Registered') { Invoke-Az @('provider', 'register', '-n', $ns, '--wait') | Out-Null }
  Write-Ok $ns
}

Write-Step 'Resource group'
Invoke-Az @('group', 'create', '-n', $ResourceGroup, '-l', $Location, '-o', 'none') | Out-Null
Write-Ok $ResourceGroup

$spObjectId = ''
$clientId = ''
if (-not $SkipOidc) {
  Write-Step 'GitHub sign-in (Entra app + federated credential)'
  $appDisplay = "$Name-github"
  $clientId = Invoke-Az @('ad', 'app', 'list', '--display-name', $appDisplay, '--query', '[0].appId', '-o', 'tsv')
  if (-not $clientId) {
    $clientId = Invoke-Az @('ad', 'app', 'create', '--display-name', $appDisplay, '--sign-in-audience', 'AzureADMyOrg', '--query', 'appId', '-o', 'tsv')
    Write-Ok "app registration $appDisplay created"
  } else { Write-Ok "app registration $appDisplay exists" }
  $spObjectId = Invoke-Az @('ad', 'sp', 'list', '--filter', "appId eq '$clientId'", '--query', '[0].id', '-o', 'tsv')
  if (-not $spObjectId) { $spObjectId = Invoke-Az @('ad', 'sp', 'create', '--id', $clientId, '--query', 'id', '-o', 'tsv') }
  $subject = "repo:${GitHubRepo}:environment:$EnvironmentName"
  $count = Invoke-Az @('ad', 'app', 'federated-credential', 'list', '--id', $clientId, '--query', "[?subject=='$subject'] | length(@)", '-o', 'tsv')
  if ($count -eq '0') {
    $credName = ("github-$EnvironmentName-$GitHubRepo" -replace '[/.]', '-')
    if ($credName.Length -gt 100) { $credName = $credName.Substring(0, 100) }
    $cred = [ordered]@{
      name        = $credName
      issuer      = 'https://token.actions.githubusercontent.com'
      subject     = $subject
      audiences   = @('api://AzureADTokenExchange')
      description = "GitHub Actions, $GitHubRepo, environment $EnvironmentName"
    }
    $tmp = [System.IO.Path]::GetTempFileName()
    try {
      [System.IO.File]::WriteAllText($tmp, ($cred | ConvertTo-Json -Compress))
      Invoke-Az @('ad', 'app', 'federated-credential', 'create', '--id', $clientId, '--parameters', "@$tmp", '-o', 'none') | Out-Null
    } finally { Remove-Item -Force $tmp -ErrorAction SilentlyContinue }
    Write-Ok "federated credential for $subject"
  } else { Write-Ok "federated credential for $subject exists" }
}

# Runner image: the deploy workflow publishes ghcr.io/<owner>/agent-ready-check-runner. Until it has run once,
# a public placeholder keeps the Container App deployable; the workflow swaps in the real image.
if ($Runner -and -not $RunnerImage) {
  $RunnerImage = $PlaceholderImage
  if ($OwnerLc) {
    $candidate = "ghcr.io/$OwnerLc/agent-ready-check-runner:latest"
    try {
      $tok = (Invoke-RestMethod -Uri "https://ghcr.io/token?scope=repository:${OwnerLc}/agent-ready-check-runner:pull" -TimeoutSec 20).token
      $hdr = @{ Authorization = "Bearer $tok"; Accept = 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json' }
      $r = Invoke-WebRequest -Uri "https://ghcr.io/v2/$OwnerLc/agent-ready-check-runner/manifests/latest" -Method Head -Headers $hdr -TimeoutSec 20 -UseBasicParsing
      if ($r.StatusCode -eq 200) { $RunnerImage = $candidate }
    } catch { $RunnerImage = $PlaceholderImage }
    if ($RunnerImage -eq $PlaceholderImage) { Write-Info 'runner image not published yet (or not public); using a placeholder until the deploy workflow runs' }
  }
}

function Invoke-Deploy([string]$Domain) {
  $deployName = 'agent-ready-check-' + (Get-Date).ToString('yyyyMMddHHmmss')
  $runnerFlag = 'false'
  if ($Runner) { $runnerFlag = 'true' }
  $json = Invoke-Az @('deployment', 'group', 'create', '-g', $ResourceGroup, '-n', $deployName, '-f', (Join-Path $InfraDir 'main.bicep'),
    '-p', "appName=$Name", "location=$Location", "swaLocation=$SwaLocation", "swaSku=$Sku", "customDomain=$Domain",
    "deployBrowserRunner=$runnerFlag", "runnerImage=$RunnerImage", "deployerPrincipalId=$spObjectId",
    '--query', 'properties.outputs', '-o', 'json')
  return ($json | ConvertFrom-Json)
}

Write-Step 'Deploy infra/main.bicep'
# A domain is bound only when DNS already points at the app, so the first pass deploys without it (the public origin
# is then the default host name; it switches to https://<domain> once the domain is bound).
$out = Invoke-Deploy ''
$swaName = $out.staticWebAppName.value
$swaHost = $out.defaultHostname.value
$runnerApp = $out.runnerAppName.value
$origin = $out.publicOrigin.value
Write-Ok "Static Web App $swaName at https://$swaHost"
if ($runnerApp) { Write-Ok ("browser runner {0} ({1})" -f $runnerApp, $out.runnerFqdn.value) }

$bound = $false
if ($CustomDomain) {
  Write-Step "Custom domain $CustomDomain"
  $cname = ''
  if (Get-Command Resolve-DnsName -ErrorAction SilentlyContinue) {
    try { $cname = (Resolve-DnsName -Name $CustomDomain -Type CNAME -ErrorAction Stop | Where-Object { $_.Type -eq 'CNAME' } | Select-Object -First 1).NameHost } catch { $cname = '' }
  } elseif (Get-Command dig -ErrorAction SilentlyContinue) {
    $cname = ((& dig +short CNAME $CustomDomain) | Select-Object -First 1)
  } elseif (Get-Command nslookup -ErrorAction SilentlyContinue) {
    $line = (& nslookup -type=CNAME $CustomDomain 2>$null) | Where-Object { $_ -match 'canonical name = ' } | Select-Object -First 1
    if ($line) { $cname = ($line -split 'canonical name = ')[1] }
  }
  if ($cname) { $cname = "$cname".Trim().TrimEnd('.') }
  if ($cname -eq $swaHost) {
    Write-Info "CNAME $CustomDomain -> $swaHost found; binding (Azure validates it and issues the certificate, a few minutes)"
    try {
      $out = Invoke-Deploy $CustomDomain
      $origin = $out.publicOrigin.value
      $bound = $true
      Write-Ok "bound https://$CustomDomain"
    } catch { Write-Warn2 'binding failed; DNS may still be propagating. Re-run this script later.' }
  } else {
    $seen = $cname
    if (-not $seen) { $seen = 'missing' }
    Write-Warn2 ("CNAME for {0} is '{1}', expected {2}. Add the record below, wait for DNS, then re-run (or run the Deploy infra workflow)." -f $CustomDomain, $seen, $swaHost)
  }
}

Write-Step 'Done'
$hostLabel = 'your subdomain'
if ($CustomDomain) { $hostLabel = $CustomDomain.Split('.')[0] }
Write-Host ''
Write-Host 'DNS record to add at the registrar of your domain:'
Write-Host ("  Type CNAME   Host {0}   Value {1}   TTL 3600" -f $hostLabel, $swaHost)
Write-Host ''
Write-Host 'GitHub repository variables (Settings > Secrets and variables > Actions > Variables):'
$vars = [ordered]@{
  AZURE_CLIENT_ID       = $clientId
  AZURE_TENANT_ID       = $tenantId
  AZURE_SUBSCRIPTION_ID = $subId
  AZURE_RESOURCE_GROUP  = $ResourceGroup
  AZURE_STATIC_WEB_APP  = $swaName
  AZURE_RUNNER_APP      = $runnerApp
  PUBLIC_BASE_URL       = $origin
}
foreach ($k in $vars.Keys) { Write-Host ("  {0,-22} {1}" -f $k, $vars[$k]) }

if ($SetGitHubVariables -and -not $SkipOidc) {
  if ((Get-Command gh -ErrorAction SilentlyContinue)) {
    foreach ($k in $vars.Keys) {
      if (-not $vars[$k]) { continue }
      & gh variable set $k --repo $GitHubRepo --body $vars[$k]
      if ($LASTEXITCODE -eq 0) { Write-Ok "variable $k" } else { Write-Warn2 "could not set $k with gh" }
    }
  } else { Write-Warn2 'gh is not installed; set the variables by hand (docs/PUBLISHING.md)' }
}
if ($CustomDomain -and -not $bound) { Write-Info "custom domain not bound yet: add the CNAME, then re-run with -CustomDomain $CustomDomain" }
exit 0
