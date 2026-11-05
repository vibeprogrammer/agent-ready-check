#!/usr/bin/env bash
# Agent-Ready Check on Azure Static Web Apps: one-time setup (and safe re-runs).
#
# Creates or updates, in one resource group (infra/main.bicep):
#   - the Static Web App (Free plan) that serves the site and runs the API as managed Azure Functions
#   - a storage account with a "reports" blob container (reports are deleted after 30 days)
#   - optionally the browser runner: a Container App that scales to zero (Chromium for the browser checks)
# and, unless --skip-oidc, the GitHub Actions sign-in: an Entra app registration with a federated credential for
# <owner>/<repo>, environment "production", with Contributor on the resource group. No secret is created for
# GitHub; the workflows sign in with OIDC. At the end it prints the GitHub repository variables to set.
#
# Runs in Azure Cloud Shell (Bash) as is. Needs az (signed in), curl and python3. PowerShell twin: infra/deploy.ps1.
#
#   ./infra/deploy.sh --github-repo webmaxru/agent-ready-check --custom-domain agent.isainative.dev
#
# Options
#   --github-repo OWNER/REPO   repository whose workflows may deploy (required unless --skip-oidc)
#   --custom-domain HOST       bind this domain (only once its CNAME points at the app; the script checks)
#   --resource-group NAME      default rg-agent-ready-check
#   --location REGION          storage and runner region, default westeurope
#   --swa-location REGION      Static Web App region (westeurope, eastus2, centralus, westus2, eastasia)
#   --name NAME                app name prefix, default agent-ready-check
#   --sku Free|Standard        Static Web Apps plan, default Free
#   --subscription ID          subscription to use (default: the current one)
#   --runner-image IMAGE       browser runner image (default ghcr.io/<owner>/agent-ready-check-runner:latest)
#   --no-browser-runner        skip the runner; browser checks then show as "skipped"
#   --skip-oidc                do not create the Entra app / federated credential / role assignment
#   --set-github-variables     also write the repository variables with the GitHub CLI (gh, logged in)
#   -y, --yes                  no confirmation prompt
set -euo pipefail

RG="rg-agent-ready-check"; LOCATION="westeurope"; SWA_LOCATION="westeurope"; NAME="agent-ready-check"; SKU="Free"
SUBSCRIPTION=""; DOMAIN=""; REPO=""; RUNNER_IMAGE=""; RUNNER=1; OIDC=1; SET_VARS=0; YES=0
ENVIRONMENT="production"
PLACEHOLDER_IMAGE="mcr.microsoft.com/k8se/quickstart:latest"
INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

step() { printf '\n== %s\n' "$1"; }
ok()   { printf '    OK   %s\n' "$1"; }
info() { printf '    ..   %s\n' "$1"; }
warn() { printf '    WARN %s\n' "$1" >&2; }
die()  { printf '\nERROR: %s\n' "$1" >&2; [ -n "${2:-}" ] && printf 'Next:  %s\n' "$2" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --github-repo) REPO="${2:-}"; shift 2 ;;
    --custom-domain) DOMAIN="${2:-}"; shift 2 ;;
    --resource-group) RG="${2:-}"; shift 2 ;;
    --location) LOCATION="${2:-}"; shift 2 ;;
    --swa-location) SWA_LOCATION="${2:-}"; shift 2 ;;
    --name) NAME="${2:-}"; shift 2 ;;
    --sku) SKU="${2:-}"; shift 2 ;;
    --subscription) SUBSCRIPTION="${2:-}"; shift 2 ;;
    --runner-image) RUNNER_IMAGE="${2:-}"; shift 2 ;;
    --no-browser-runner) RUNNER=0; shift ;;
    --skip-oidc) OIDC=0; shift ;;
    --set-github-variables) SET_VARS=1; shift ;;
    -y|--yes) YES=1; shift ;;
    -h|--help) sed -n '2,31p' "$0"; exit 0 ;;
    *) die "unknown option $1" "./infra/deploy.sh --help" ;;
  esac
done

case "$SKU" in Free|Standard) ;; *) die "--sku must be Free or Standard" ;; esac
if [ "$OIDC" = 1 ] && ! printf '%s' "$REPO" | grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'; then
  die "--github-repo OWNER/REPO is required for the GitHub sign-in" "./infra/deploy.sh --github-repo webmaxru/agent-ready-check (or --skip-oidc)"
fi
DOMAIN="$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]' | sed 's#^https\?://##; s#/.*$##; s#\.$##')"
OWNER_LC="$(printf '%s' "${REPO%%/*}" | tr '[:upper:]' '[:lower:]')"

command -v az >/dev/null 2>&1 || die "Azure CLI (az) not found" "use Azure Cloud Shell (shell.azure.com), where az is installed and signed in"

step "Azure account"
[ -n "$SUBSCRIPTION" ] && az account set --subscription "$SUBSCRIPTION"
SUB_ID="$(az account show --query id -o tsv 2>/dev/null)" || die "not signed in to Azure" "az login"
TENANT_ID="$(az account show --query tenantId -o tsv)"
ok "subscription $(az account show --query name -o tsv) ($SUB_ID)"

if [ "$YES" != 1 ]; then
  printf '\nThis creates or updates resource group %s in %s (Static Web App %s, %s plan%s).\n' "$RG" "$LOCATION" "$NAME" "$SKU" "$([ "$RUNNER" = 1 ] && echo ', browser runner' || true)"
  read -r -p 'Continue? [y/N] ' a; case "$a" in y|Y|yes) ;; *) exit 1 ;; esac
fi

step "Resource providers"
for ns in Microsoft.Web Microsoft.Storage Microsoft.App; do
  [ "$ns" = Microsoft.App ] && [ "$RUNNER" = 0 ] && continue
  st="$(az provider show -n "$ns" --query registrationState -o tsv 2>/dev/null || echo NotRegistered)"
  if [ "$st" != Registered ]; then az provider register -n "$ns" --wait >/dev/null; fi
  ok "$ns"
done

step "Resource group"
az group create -n "$RG" -l "$LOCATION" -o none
ok "$RG"

SP_OBJECT_ID=""; CLIENT_ID=""
if [ "$OIDC" = 1 ]; then
  step "GitHub sign-in (Entra app + federated credential)"
  APP_DISPLAY="$NAME-github"
  CLIENT_ID="$(az ad app list --display-name "$APP_DISPLAY" --query '[0].appId' -o tsv)"
  if [ -z "$CLIENT_ID" ]; then
    CLIENT_ID="$(az ad app create --display-name "$APP_DISPLAY" --sign-in-audience AzureADMyOrg --query appId -o tsv)"
    ok "app registration $APP_DISPLAY created"
  else ok "app registration $APP_DISPLAY exists"; fi
  SP_OBJECT_ID="$(az ad sp list --filter "appId eq '$CLIENT_ID'" --query '[0].id' -o tsv)"
  [ -z "$SP_OBJECT_ID" ] && SP_OBJECT_ID="$(az ad sp create --id "$CLIENT_ID" --query id -o tsv)"
  SUBJECT="repo:$REPO:environment:$ENVIRONMENT"
  if az ad app federated-credential list --id "$CLIENT_ID" --query "[?subject=='$SUBJECT'] | length(@)" -o tsv | grep -qx 0; then
    TMP="$(mktemp)"
    printf '{"name":"github-%s","issuer":"https://token.actions.githubusercontent.com","subject":"%s","audiences":["api://AzureADTokenExchange"],"description":"GitHub Actions, %s, environment %s"}' \
      "$(printf '%s' "$ENVIRONMENT-$REPO" | tr '/.' '--' | cut -c1-100)" "$SUBJECT" "$REPO" "$ENVIRONMENT" > "$TMP"
    az ad app federated-credential create --id "$CLIENT_ID" --parameters "@$TMP" -o none
    rm -f "$TMP"
    ok "federated credential for $SUBJECT"
  else ok "federated credential for $SUBJECT exists"; fi
fi

# Runner image: the deploy workflow publishes ghcr.io/<owner>/agent-ready-check-runner. Until it has run once,
# a public placeholder keeps the Container App deployable; the workflow swaps in the real image.
if [ "$RUNNER" = 1 ] && [ -z "$RUNNER_IMAGE" ]; then
  if [ -n "$OWNER_LC" ]; then
    RUNNER_IMAGE="ghcr.io/$OWNER_LC/agent-ready-check-runner:latest"
    tok="$(curl -fsS "https://ghcr.io/token?scope=repository:$OWNER_LC/agent-ready-check-runner:pull" 2>/dev/null | sed -n 's/.*"token":"\([^"]*\)".*/\1/p' || true)"
    code="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $tok" -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json' "https://ghcr.io/v2/$OWNER_LC/agent-ready-check-runner/manifests/latest" || true)"
    if [ "$code" != 200 ]; then
      info "runner image not published yet (or not public); using a placeholder until the deploy workflow runs"
      RUNNER_IMAGE="$PLACEHOLDER_IMAGE"
    fi
  else RUNNER_IMAGE="$PLACEHOLDER_IMAGE"; fi
fi

deploy() { # $1 = custom domain or empty
  az deployment group create -g "$RG" -n "agent-ready-check-$(date +%Y%m%d%H%M%S)" -f "$INFRA_DIR/main.bicep" \
    -p appName="$NAME" location="$LOCATION" swaLocation="$SWA_LOCATION" swaSku="$SKU" customDomain="$1" \
       deployBrowserRunner="$([ "$RUNNER" = 1 ] && echo true || echo false)" runnerImage="$RUNNER_IMAGE" \
       deployerPrincipalId="$SP_OBJECT_ID" \
    --query properties.outputs -o json
}

step "Deploy infra/main.bicep"
# A domain is bound only when DNS already points at the app, so the first pass deploys without it (the public origin
# is then the default host name; it switches to https://<domain> once the domain is bound).
OUT="$(deploy "")"
val() { printf '%s' "$OUT" | python3 -c "import json,sys; print(json.load(sys.stdin)['$1']['value'])"; }
SWA_NAME="$(val staticWebAppName)"; HOST="$(val defaultHostname)"; RUNNER_APP="$(val runnerAppName)"; ORIGIN="$(val publicOrigin)"
ok "Static Web App $SWA_NAME at https://$HOST"
[ -n "$RUNNER_APP" ] && ok "browser runner $RUNNER_APP ($(val runnerFqdn))"

BOUND=0
if [ -n "$DOMAIN" ]; then
  step "Custom domain $DOMAIN"
  cname="$( (command -v dig >/dev/null && dig +short CNAME "$DOMAIN") || (nslookup -type=CNAME "$DOMAIN" 2>/dev/null | sed -n 's/.*canonical name = //p') || true)"
  cname="${cname%.}"
  if [ "$cname" = "$HOST" ]; then
    info "CNAME $DOMAIN -> $HOST found; binding (Azure validates it and issues the certificate, a few minutes)"
    if OUT="$(deploy "$DOMAIN")"; then BOUND=1; ORIGIN="$(val publicOrigin)"; ok "bound https://$DOMAIN"; else warn "binding failed; DNS may still be propagating. Re-run this script later."; fi
  else
    warn "CNAME for $DOMAIN is '${cname:-missing}', expected $HOST. Add the record below, wait for DNS, then re-run (or run the Deploy infra workflow)."
  fi
fi

step "Done"
cat <<EOF

DNS record to add at the registrar of ${DOMAIN:-your domain}:
  Type CNAME   Host ${DOMAIN%%.*}   Value $HOST   TTL 3600
  (full name ${DOMAIN:-<subdomain>.<domain>}; Static Web Apps validates a subdomain by this CNAME, no TXT record needed)

GitHub repository variables (Settings > Secrets and variables > Actions > Variables):
  AZURE_CLIENT_ID          $CLIENT_ID
  AZURE_TENANT_ID          $TENANT_ID
  AZURE_SUBSCRIPTION_ID    $SUB_ID
  AZURE_RESOURCE_GROUP     $RG
  AZURE_STATIC_WEB_APP     $SWA_NAME
  AZURE_RUNNER_APP         ${RUNNER_APP:-(none)}
  PUBLIC_BASE_URL          $ORIGIN
EOF

if [ "$SET_VARS" = 1 ] && [ "$OIDC" = 1 ]; then
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    for kv in "AZURE_CLIENT_ID=$CLIENT_ID" "AZURE_TENANT_ID=$TENANT_ID" "AZURE_SUBSCRIPTION_ID=$SUB_ID" "AZURE_RESOURCE_GROUP=$RG" \
              "AZURE_STATIC_WEB_APP=$SWA_NAME" "AZURE_RUNNER_APP=$RUNNER_APP" "PUBLIC_BASE_URL=$ORIGIN"; do
      [ -z "${kv#*=}" ] && continue
      gh variable set "${kv%%=*}" --repo "$REPO" --body "${kv#*=}" && ok "variable ${kv%%=*}"
    done
  else warn "gh is not installed or not logged in; set the variables by hand (docs/PUBLISHING.md)"; fi
fi
[ -n "$DOMAIN" ] && [ "$BOUND" = 0 ] && info "custom domain not bound yet: add the CNAME, then re-run with --custom-domain $DOMAIN"
exit 0
