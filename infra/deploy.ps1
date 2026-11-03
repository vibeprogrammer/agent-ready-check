<#
.SYNOPSIS
  One command to run Agent-Ready Check on Azure Container Apps (consumption plan, scale to zero).

.DESCRIPTION
  Creates (or updates) the resource group rg-agent-ready-check with a Container Apps environment,
  the container app, an Azure Container Registry (Basic), a storage account with an Azure Files share
  for stored reports and a Log Analytics workspace (infra/main.bicep). Builds the image in the
  registry with `az acr build` (no local Docker needed), rolls it out, optionally binds a custom
  domain with a free managed certificate and runs the smoke test (infra/check_site.py).

  Safe to re-run: existing resources are updated in place. No secret is printed, put on a command
  line or written to a file: the app pulls its image with a managed identity.

  Works in Windows PowerShell 5.1 and PowerShell 7+ (Windows, macOS, Linux).
  macOS/Linux bash twin: infra/deploy.sh.

.EXAMPLE
  pwsh ./infra/deploy.ps1
.EXAMPLE
  pwsh ./infra/deploy.ps1 -UploadOnly
.EXAMPLE
  pwsh ./infra/deploy.ps1 -UploadOnly -NoBuild -CustomDomain agent-ready-check.salnikov.no
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\infra\deploy.ps1 -Yes
#>
[CmdletBinding()]
param(
  [string]$ResourceGroup = 'rg-agent-ready-check',
  [string]$AppName = 'agent-ready-check',
  [string]$Location = 'westeurope',
  [string]$Subscription = '',
  [string]$CustomDomain = '',
  [string]$BaseUrl = '',
  [ValidateRange(1, 10)]
  [int]$MaxReplicas = 2,
  [ValidateRange(1, 100000)]
  [int]$RateLimit = 10,
  [ValidateRange(10, 86400)]
  [int]$RateWindow = 600,
  [switch]$UploadOnly,
  [switch]$NoBuild,
  [switch]$SkipSmoke,
  [switch]$Yes
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ImageRepo = 'agent-ready-check'
$InfraDir = $PSScriptRoot
$Root = Split-Path -Parent $InfraDir
$stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
$IsWin = ($env:OS -eq 'Windows_NT')
# az acr build streams build logs; on Windows consoles a non-ASCII log line can crash the CLI without this.
$env:PYTHONIOENCODING = 'utf-8'

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
# Runs a native program and captures stdout/stderr. A program that cannot even be started (for example the
# Windows Store 'python3.exe' alias, which PowerShell cannot start with redirected output) is reported as
# exit code 9009 instead of throwing.
function Invoke-Native {
  param([Parameter(Mandatory = $true)][string]$Exe, [string[]]$Arguments = @())
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $all = & $Exe @Arguments 2>&1; $code = $LASTEXITCODE
  } catch {
    return [pscustomobject]@{ Code = 9009; Out = ''; Err = $_.Exception.Message }
  } finally { $ErrorActionPreference = $prev }
  $outLines = @(); $errLines = @()
  foreach ($line in @($all)) {
    if ($line -is [System.Management.Automation.ErrorRecord]) { $errLines += $line.ToString() } else { $outLines += [string]$line }
  }
  return [pscustomobject]@{ Code = $code; Out = (($outLines -join "`n").Trim()); Err = (($errLines -join "`n").Trim()) }
}
function Invoke-Az {
  param([string[]]$Arguments, [string]$What, [switch]$AllowFail)
  $r = Invoke-Native -Exe 'az' -Arguments ($Arguments + @('--only-show-errors'))
  if ($r.Code -ne 0 -and -not $AllowFail) { Exit-WithHint ("{0} failed: {1}" -f $What, $r.Err) 'Fix the cause above, then re-run (safe to re-run).' }
  return $r
}
function Get-DnsValue([string]$Name, [string]$Type) {
  try {
    $rec = Resolve-DnsName -Name $Name -Type $Type -Server 1.1.1.1 -DnsOnly -ErrorAction Stop | Where-Object { $_.QueryType -eq $Type } | Select-Object -First 1
    if (-not $rec) { return '' }
    if ($Type -eq 'CNAME') { return ([string]$rec.NameHost).TrimEnd('.') }
    return (@($rec.Strings) -join '')
  } catch {
    if (Get-Command nslookup -ErrorAction SilentlyContinue) {
      $out = (& nslookup "-type=$Type" $Name 1.1.1.1 2>$null) -join "`n"
      if ($Type -eq 'CNAME') { $m = [regex]::Match($out, 'canonical name\s*=\s*(\S+)'); if ($m.Success) { return $m.Groups[1].Value.TrimEnd('.') } }
      else { $m = [regex]::Match($out, 'text\s*=\s*"([^"]*)"'); if ($m.Success) { return $m.Groups[1].Value } }
    }
    return ''
  }
}
function Get-CurrentImage {
  $r = Invoke-Az -Arguments @('containerapp', 'show', '-g', $ResourceGroup, '-n', $AppName, '--query', 'properties.template.containers[0].image', '-o', 'tsv') -What 'Reading the app' -AllowFail
  if ($r.Code -ne 0) { return '' }
  return $r.Out
}
function Get-AcrName {
  $r = Invoke-Az -Arguments @('acr', 'list', '-g', $ResourceGroup, '--query', '[0].name', '-o', 'tsv') -What 'Listing registries' -AllowFail
  if ($r.Code -ne 0) { return '' }
  return $r.Out
}
function Invoke-Bicep([string]$Image, [string]$Tag) {
  $args2 = @('deployment', 'group', 'create', '-g', $ResourceGroup, '-n', ("agent-ready-check-{0}-{1}" -f $stamp, $Tag),
    '-f', (Join-Path $InfraDir 'main.bicep'),
    '-p', ("appName={0}" -f $AppName), ("image={0}" -f $Image), ("baseUrl={0}" -f $BaseUrl),
    ("maxReplicas={0}" -f $MaxReplicas), ("rateLimit={0}" -f $RateLimit), ("rateWindowSeconds={0}" -f $RateWindow),
    '--query', 'properties.outputs', '-o', 'json')
  Invoke-Az -Arguments $args2 -What 'Bicep deployment' | Out-Null
}

$CustomDomain = ($CustomDomain.ToLowerInvariant() -replace '^https?://', '' -replace '/.*$', '').TrimEnd('.')
$BaseUrl = $BaseUrl.TrimEnd('/')
$doInfra = -not $UploadOnly
$doBuild = -not $NoBuild

Write-Host 'Agent-Ready Check -> Azure Container Apps (consumption, scale to zero)' -ForegroundColor White

# ---------------------------------------------------------------------------------------
Write-Step 'Checking tools'
if (-not (Get-Command az -CommandType Application -ErrorAction SilentlyContinue)) {
  Exit-WithHint 'Azure CLI (az) is not installed.' 'winget install -e --id Microsoft.AzureCLI (macOS: brew install azure-cli), then az login'
}
$azv = Invoke-Native -Exe 'az' -Arguments @('version', '--query', '"azure-cli"', '-o', 'tsv')
Write-Ok ("Azure CLI {0}" -f $azv.Out)
if ($doInfra) {
  $bv = Invoke-Native -Exe 'az' -Arguments @('bicep', 'version', '--only-show-errors')
  if ($bv.Code -ne 0) { Write-Info 'installing Bicep'; Invoke-Az -Arguments @('bicep', 'install') -What 'Installing Bicep' | Out-Null }
  Write-Ok 'Bicep'
}
$ext = Invoke-Native -Exe 'az' -Arguments @('extension', 'show', '--name', 'containerapp')
if ($ext.Code -ne 0) { Write-Info 'adding the containerapp extension'; Invoke-Az -Arguments @('extension', 'add', '--name', 'containerapp', '--upgrade') -What 'Adding the containerapp extension' | Out-Null }
Write-Ok 'containerapp extension'
# Python is only needed for the smoke test. -CommandType Application skips aliases and functions; the
# Windows Store 'python3' alias is caught by Invoke-Native (exit 9009) and does not count.
$py = $null
$cands = if ($IsWin) { @('py', 'python', 'python3') } else { @('python3', 'python') }
foreach ($cand in $cands) {
  $cmd = Get-Command $cand -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cmd) {
    $v = Invoke-Native -Exe $cand -Arguments @('-c', 'import sys; print(1 if sys.version_info >= (3, 9) else 0)')
    if ($v.Code -eq 0 -and $v.Out -eq '1') { $py = $cand; break }
  }
}
if ($py) { $pv = Invoke-Native -Exe $py -Arguments @('-V'); Write-Ok ("{0} (for the smoke test)" -f $pv.Out) }
else { Write-Warn2 'Python 3.9+ not found: the smoke test at the end is skipped (winget install -e --id Python.Python.3.12)'; $SkipSmoke = $true }
if (-not (Test-Path (Join-Path $Root 'Dockerfile'))) { Exit-WithHint "Dockerfile not found under $Root." 'Run this script from a full clone of the repo.' }

# ---------------------------------------------------------------------------------------
Write-Step 'Azure account'
$acct = Invoke-Native -Exe 'az' -Arguments @('account', 'show', '-o', 'json')
if ($acct.Code -ne 0) { Exit-WithHint 'Not logged in to Azure.' 'az login' }
if ($Subscription) { Invoke-Az -Arguments @('account', 'set', '--subscription', $Subscription) -What 'Switching subscription' | Out-Null; $acct = Invoke-Native -Exe 'az' -Arguments @('account', 'show', '-o', 'json') }
$a = $acct.Out | ConvertFrom-Json
Write-Ok ("{0} ({1})" -f $a.name, $a.id)
$dom = if ($CustomDomain) { $CustomDomain } else { 'none' }
Write-Info ("Resource group {0} | app {1} ({2}) | domain: {3} | build: {4} | Bicep: {5}" -f $ResourceGroup, $AppName, $Location, $dom, $doBuild, $doInfra)
if (-not $Yes) {
  $answer = Read-Host '    Continue with this subscription? [y/N]'
  if ($answer -notmatch '^(y|yes)$') { Write-Host 'Stopped. Nothing changed.' -ForegroundColor Yellow; exit 0 }
}

# ---------------------------------------------------------------------------------------
$image = ''
if ($doInfra) {
  Write-Step "Resource group $ResourceGroup"
  $ex = Invoke-Az -Arguments @('group', 'exists', '-n', $ResourceGroup) -What 'Checking the resource group'
  if ($ex.Out -eq 'true') { Write-Ok 'exists' }
  else { Invoke-Az -Arguments @('group', 'create', '-n', $ResourceGroup, '-l', $Location, '-o', 'none') -What 'Creating the resource group' | Out-Null; Write-Ok ("created in {0}" -f $Location) }
  foreach ($ns in @('Microsoft.App', 'Microsoft.ContainerRegistry', 'Microsoft.OperationalInsights', 'Microsoft.Storage', 'Microsoft.ManagedIdentity')) {
    $st = Invoke-Az -Arguments @('provider', 'show', '-n', $ns, '--query', 'registrationState', '-o', 'tsv') -What 'Reading providers' -AllowFail
    if ($st.Out -ne 'Registered') { Write-Info ("registering {0}" -f $ns); Invoke-Az -Arguments @('provider', 'register', '-n', $ns, '--wait') -What ("Registering {0}" -f $ns) | Out-Null }
  }
  Write-Ok 'resource providers registered'
  $image = Get-CurrentImage
  if ($image -like '*k8se/quickstart*') { $image = '' }
  if (-not (Get-AcrName)) {
    Write-Step 'Creating the infrastructure (first run, placeholder image)'
    Write-Info 'Container Apps environment, registry, storage, logs: 2-5 minutes'
    Invoke-Bicep -Image $image -Tag 'infra'
    Write-Ok 'infrastructure ready'
  }
}

$acr = Get-AcrName
if (-not $acr) { Exit-WithHint ("No container registry found in {0}." -f $ResourceGroup) 'Run without -UploadOnly first: pwsh ./infra/deploy.ps1' }

if ($doBuild) {
  Write-Step ("Building the image in Azure Container Registry ({0})" -f $acr)
  Write-Info 'uploads the repo (see .dockerignore) and builds FROM the Playwright image: 3-6 minutes, output follows when done'
  $b = Invoke-Native -Exe 'az' -Arguments @('acr', 'build', '-r', $acr, '-t', ("{0}:{1}" -f $ImageRepo, $stamp), '-t', ("{0}:latest" -f $ImageRepo), '--platform', 'linux/amd64', '--only-show-errors', $Root)
  if ($b.Code -ne 0) {
    $tail = (($b.Out -split "`n") | Select-Object -Last 30) -join "`n"
    Write-Host $tail
    Exit-WithHint ("Image build failed: {0}" -f $b.Err) 'Read the build log above. A failing npm ci usually means package-lock.json is out of date.'
  }
  $login = (Invoke-Az -Arguments @('acr', 'show', '-n', $acr, '--query', 'loginServer', '-o', 'tsv') -What 'Reading the registry').Out
  $image = "{0}/{1}:{2}" -f $login, $ImageRepo, $stamp
  Write-Ok ("built {0}" -f $image)
} else {
  if (-not $image) { $image = Get-CurrentImage }
  if (-not $image -or $image -like '*k8se/quickstart*') { Exit-WithHint 'No built image to deploy yet.' 'Run without -NoBuild.' }
  Write-Ok ("re-using {0}" -f $image)
}

if ($doInfra) {
  Write-Step 'Deploying the app (Bicep)'
  Invoke-Bicep -Image $image -Tag 'app'
  Write-Ok 'deployed'
} elseif ($doBuild) {
  Write-Step 'Rolling out the new image'
  Invoke-Az -Arguments @('containerapp', 'update', '-g', $ResourceGroup, '-n', $AppName, '--image', $image, '-o', 'none') -What 'Updating the app' | Out-Null
  Write-Ok 'rolled out'
}

$fqdn = (Invoke-Az -Arguments @('containerapp', 'show', '-g', $ResourceGroup, '-n', $AppName, '--query', 'properties.configuration.ingress.fqdn', '-o', 'tsv') -What 'Reading the app').Out
$url = "https://$fqdn"

# ---------------------------------------------------------------------------------------
if ($CustomDomain) {
  Write-Step "Custom domain $CustomDomain"
  $envId = (Invoke-Az -Arguments @('containerapp', 'show', '-g', $ResourceGroup, '-n', $AppName, '--query', 'properties.managedEnvironmentId', '-o', 'tsv') -What 'Reading the app').Out
  $envName = ($envId -split '/')[-1]
  $verifyId = (Invoke-Az -Arguments @('containerapp', 'env', 'show', '-g', $ResourceGroup, '-n', $envName, '--query', 'properties.customDomainConfiguration.customDomainVerificationId', '-o', 'tsv') -What 'Reading the environment').Out
  $cname = Get-DnsValue -Name $CustomDomain -Type 'CNAME'
  $txt = Get-DnsValue -Name ("asuid.{0}" -f $CustomDomain) -Type 'TXT'
  if ($cname -ne $fqdn -or $txt -ne $verifyId) {
    Write-Warn2 'DNS is not ready yet. Create these two records (Cloudflare: proxy OFF, grey cloud), then re-run:'
    $nowC = if ($cname) { $cname } else { 'none' }
    $nowT = if ($txt) { $txt } else { 'none' }
    Write-Host ("        CNAME  {0}  ->  {1}        (now: {2})" -f $CustomDomain, $fqdn, $nowC)
    Write-Host ("        TXT    asuid.{0}  =  {1}   (now: {2})" -f $CustomDomain, $verifyId, $nowT)
    Write-Host ("        pwsh ./infra/deploy.ps1 -UploadOnly -NoBuild -CustomDomain {0}" -f $CustomDomain)
  } else {
    Write-Ok 'CNAME and TXT records found'
    Invoke-Az -Arguments @('containerapp', 'hostname', 'add', '-g', $ResourceGroup, '-n', $AppName, '--hostname', $CustomDomain, '-o', 'none') -What 'Adding the hostname' -AllowFail | Out-Null
    Write-Info 'issuing a free managed certificate: up to 10-20 minutes'
    Invoke-Az -Arguments @('containerapp', 'hostname', 'bind', '-g', $ResourceGroup, '-n', $AppName, '--hostname', $CustomDomain, '--environment', $envName, '--validation-method', 'CNAME', '-o', 'none') -What ("Binding {0} (check that the CNAME is DNS-only, wait a few minutes, re-run)" -f $CustomDomain) | Out-Null
    Write-Ok ("https://{0} is bound" -f $CustomDomain)
    $url = "https://$CustomDomain"
  }
}

# ---------------------------------------------------------------------------------------
Write-Step "Checking $url"
$code = 0
for ($i = 0; $i -lt 18; $i++) {
  try {
    $resp = Invoke-WebRequest -Uri ("{0}/api/health" -f $url) -UseBasicParsing -TimeoutSec 30 -ErrorAction Stop
    $code = [int]$resp.StatusCode
  } catch {
    $code = 0
    if ($_.Exception.PSObject.Properties['Response'] -and $_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
  }
  if ($code -eq 200) { break }
  Write-Info ("waiting for the first replica (cold start pulls the image): HTTP {0}" -f $code)
  Start-Sleep -Seconds 10
}
if ($code -eq 200) { Write-Ok ("{0}/api/health -> 200" -f $url) }
else { Write-Warn2 ("{0}/api/health -> {1} (the app may still be starting; check: az containerapp logs show -g {2} -n {3})" -f $url, $code, $ResourceGroup, $AppName) }
if (-not $SkipSmoke -and $code -eq 200) {
  $env:EXPECT_BROWSER = '1'
  $smoke = Invoke-Native -Exe $py -Arguments @((Join-Path $InfraDir 'check_site.py'), $url)
  Write-Host $smoke.Out
  if ($smoke.Code -ne 0) { Write-Warn2 'some smoke checks failed (see above)' }
}

Write-Host ''
Write-Host 'Done.' -ForegroundColor White
Write-Host ("   Site:   {0}" -f $url)
Write-Host ("   API:    {0}/openapi.json" -f $url)
Write-Host ("   MCP:    {0}/mcp" -f $url)
Write-Host ("   Logs:   az containerapp logs show -g {0} -n {1} --follow" -f $ResourceGroup, $AppName)
Write-Host ("   Remove: az group delete -n {0}   (deletes everything this script created)" -f $ResourceGroup)
