#!/usr/bin/env bash
# One command to run Agent-Ready Check on Azure Container Apps (consumption plan, scale to zero).
# macOS / Linux / WSL. Windows: infra/deploy.ps1 does the same.
#
#   ./infra/deploy.sh                                              # infra + image build + deploy + smoke test
#   ./infra/deploy.sh --upload-only                                # rebuild the image and roll it out (no Bicep)
#   ./infra/deploy.sh --upload-only --no-build --custom-domain agent-ready-check.salnikov.no   # only bind the domain
#
# Safe to re-run: the resource group and every resource are created once and updated in place.
# The image is built in Azure Container Registry (az acr build): no local Docker needed.
#
# Options (defaults in brackets):
#   --resource-group NAME  [rg-agent-ready-check]   --app-name NAME [agent-ready-check]
#   --location REGION      [westeurope]             --subscription ID  switch the Azure subscription first
#   --custom-domain HOST   bind HOST with a free managed certificate (CNAME + TXT records first, DEPLOY.md)
#   --base-url URL         public origin for absolute links (default: taken from each request)
#   --max-replicas N       [2]                      --rate-limit N [10] scans per client per --rate-window S [600]
#   --upload-only          the app must exist: build the image and roll it out (no Bicep deployment)
#   --no-build             do not build a new image (re-deploy the current one)
#   --skip-smoke           do not run infra/check_site.py at the end
#   --yes, -y              don't ask before changing Azure
#   -h, --help
set -euo pipefail

RG=rg-agent-ready-check; APP=agent-ready-check; LOCATION=westeurope; SUBSCRIPTION=""; CUSTOM_DOMAIN=""; BASE_URL=""
MAX_REPLICAS=2; RATE_LIMIT=10; RATE_WINDOW=600
YES=0; UPLOAD_ONLY=0; NO_BUILD=0; SKIP_SMOKE=0
IMAGE_REPO=agent-ready-check

need_arg() { [ $# -ge 2 ] && [ -n "$2" ] || { echo "Option $1 needs a value" >&2; exit 2; }; }
while [ $# -gt 0 ]; do
  case "$1" in
    --resource-group) need_arg "$@"; RG=$2; shift 2;;
    --app-name) need_arg "$@"; APP=$2; shift 2;;
    --location) need_arg "$@"; LOCATION=$2; shift 2;;
    --subscription) need_arg "$@"; SUBSCRIPTION=$2; shift 2;;
    --custom-domain) need_arg "$@"; CUSTOM_DOMAIN=$2; shift 2;;
    --base-url) need_arg "$@"; BASE_URL=$2; shift 2;;
    --max-replicas) need_arg "$@"; MAX_REPLICAS=$2; shift 2;;
    --rate-limit) need_arg "$@"; RATE_LIMIT=$2; shift 2;;
    --rate-window) need_arg "$@"; RATE_WINDOW=$2; shift 2;;
    --upload-only) UPLOAD_ONLY=1; shift;;
    --no-build) NO_BUILD=1; shift;;
    --skip-smoke) SKIP_SMOKE=1; shift;;
    --yes|-y) YES=1; shift;;
    -h|--help) sed -n '2,25p' "$0"; exit 0;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 2;;
  esac
done
CUSTOM_DOMAIN=$(printf '%s' "$CUSTOM_DOMAIN" | tr '[:upper:]' '[:lower:]' | sed 's#^https\?://##; s#/.*$##; s#\.$##')
BASE_URL=${BASE_URL%/}

INFRA_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$INFRA_DIR/.." && pwd)"
STAMP=$(date +%Y%m%d-%H%M%S)

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then c() { printf '\033[%sm%s\033[0m\n' "$1" "$2"; }
else c() { printf '%s\n' "$2"; }; fi
step() { echo; c 36 "== $1"; }
ok()   { c 32 "   OK   $1"; }
info() { c 90 "   ..   $1"; }
warn() { c 33 "   WARN $1"; }
die()  { echo; c 31 "ERROR: $1"; [ -n "${2:-}" ] && c 33 "Next:  $2"; exit 1; }

DO_INFRA=1; DO_BUILD=1
[ $UPLOAD_ONLY = 1 ] && DO_INFRA=0
[ $NO_BUILD = 1 ] && DO_BUILD=0

c 1 "Agent-Ready Check -> Azure Container Apps (consumption, scale to zero)"

# --------------------------------------------------------------------------------------
step "Checking tools"
command -v az >/dev/null || die "Azure CLI (az) is not installed." \
  "macOS: brew install azure-cli | Linux: https://learn.microsoft.com/cli/azure/install-azure-cli | then az login"
ok "Azure CLI $(az version --query '"azure-cli"' -o tsv 2>/dev/null || echo '?')"
if [ $DO_INFRA = 1 ]; then
  az bicep version --only-show-errors >/dev/null 2>&1 || { info "installing Bicep"; az bicep install --only-show-errors; }
  ok "Bicep"
fi
az extension show --name containerapp >/dev/null 2>&1 || { info "adding the containerapp extension"; az extension add --name containerapp --upgrade --only-show-errors >/dev/null; }
ok "containerapp extension"
command -v curl >/dev/null || die "curl is not installed."
PY=""
for cand in python3 python; do
  if command -v "$cand" >/dev/null 2>&1 && "$cand" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' >/dev/null 2>&1; then PY=$cand; break; fi
done
if [ -n "$PY" ]; then ok "$($PY -V 2>&1) (for the smoke test)"; else warn "Python 3.9+ not found: the smoke test at the end is skipped"; SKIP_SMOKE=1; fi
[ -f "$ROOT/Dockerfile" ] || die "Dockerfile not found under $ROOT." "Run this script from a full clone of the repo."

# --------------------------------------------------------------------------------------
step "Azure account"
az account show >/dev/null 2>&1 || die "Not logged in to Azure." "az login"
if [ -n "$SUBSCRIPTION" ]; then az account set --subscription "$SUBSCRIPTION" --only-show-errors || die "Cannot switch to subscription $SUBSCRIPTION."; fi
SUB_NAME=$(az account show --query name -o tsv); SUB_ID=$(az account show --query id -o tsv)
ok "$SUB_NAME ($SUB_ID)"
info "Resource group $RG | app $APP ($LOCATION) | domain: ${CUSTOM_DOMAIN:-none} | build: $([ $DO_BUILD = 1 ] && echo yes || echo no) | Bicep: $([ $DO_INFRA = 1 ] && echo yes || echo no)"
if [ $YES = 0 ]; then
  read -r -p "    Continue with this subscription? [y/N] " answer
  case "$answer" in y|Y|yes|YES) ;; *) c 33 "Stopped. Nothing changed."; exit 0;; esac
fi

current_image() { az containerapp show -g "$RG" -n "$APP" --query 'properties.template.containers[0].image' -o tsv 2>/dev/null || true; }
acr_name() { az acr list -g "$RG" --query '[0].name' -o tsv 2>/dev/null || true; }

deploy_bicep() { # $1 = image ('' = placeholder)
  az deployment group create -g "$RG" -n "agent-ready-check-$STAMP-$2" -f "$INFRA_DIR/main.bicep" \
    -p appName="$APP" image="$1" baseUrl="$BASE_URL" maxReplicas="$MAX_REPLICAS" rateLimit="$RATE_LIMIT" rateWindowSeconds="$RATE_WINDOW" \
    --only-show-errors --query properties.outputs -o json >/dev/null || die "Bicep deployment failed." "Read the error above, fix it, re-run (safe to re-run)."
}

# --------------------------------------------------------------------------------------
IMAGE=""
if [ $DO_INFRA = 1 ]; then
  step "Resource group $RG"
  if [ "$(az group exists -n "$RG")" = true ]; then ok "exists"; else az group create -n "$RG" -l "$LOCATION" --only-show-errors -o none; ok "created in $LOCATION"; fi
  for ns in Microsoft.App Microsoft.ContainerRegistry Microsoft.OperationalInsights Microsoft.Storage Microsoft.ManagedIdentity; do
    state=$(az provider show -n "$ns" --query registrationState -o tsv 2>/dev/null || echo NotRegistered)
    [ "$state" = Registered ] || { info "registering $ns"; az provider register -n "$ns" --wait --only-show-errors; }
  done
  ok "resource providers registered"
  IMAGE=$(current_image)
  case "$IMAGE" in *k8se/quickstart*) IMAGE="";; esac
  if [ -z "$(acr_name)" ]; then
    step "Creating the infrastructure (first run, placeholder image)"
    info "Container Apps environment, registry, storage, logs: 2-5 minutes"
    deploy_bicep "$IMAGE" infra
    ok "infrastructure ready"
  fi
fi

ACR=$(acr_name)
[ -n "$ACR" ] || die "No container registry found in $RG." "Run without --upload-only first: ./infra/deploy.sh"

if [ $DO_BUILD = 1 ]; then
  step "Building the image in Azure Container Registry ($ACR)"
  info "uploads the repo (see .dockerignore) and builds FROM the Playwright image: 3-6 minutes"
  az acr build -r "$ACR" -t "$IMAGE_REPO:$STAMP" -t "$IMAGE_REPO:latest" --platform linux/amd64 --only-show-errors "$ROOT" \
    || die "Image build failed." "Read the build log above. A failing npm ci usually means package-lock.json is out of date."
  IMAGE="$(az acr show -n "$ACR" --query loginServer -o tsv)/$IMAGE_REPO:$STAMP"
  ok "built $IMAGE"
else
  [ -n "$IMAGE" ] || IMAGE=$(current_image)
  case "$IMAGE" in ""|*k8se/quickstart*) die "No built image to deploy yet." "Run without --no-build.";; esac
  ok "re-using $IMAGE"
fi

if [ $DO_INFRA = 1 ]; then
  step "Deploying the app (Bicep)"
  deploy_bicep "$IMAGE" app
  ok "deployed"
elif [ $DO_BUILD = 1 ]; then
  step "Rolling out the new image"
  az containerapp update -g "$RG" -n "$APP" --image "$IMAGE" --only-show-errors -o none || die "Update failed."
  ok "rolled out"
fi

FQDN=$(az containerapp show -g "$RG" -n "$APP" --query properties.configuration.ingress.fqdn -o tsv)
URL="https://$FQDN"

# --------------------------------------------------------------------------------------
if [ -n "$CUSTOM_DOMAIN" ]; then
  step "Custom domain $CUSTOM_DOMAIN"
  ENV_NAME=$(az containerapp show -g "$RG" -n "$APP" --query properties.managedEnvironmentId -o tsv | sed 's#.*/##')
  VERIFY_ID=$(az containerapp env show -g "$RG" -n "$ENV_NAME" --query properties.customDomainConfiguration.customDomainVerificationId -o tsv)
  if command -v dig >/dev/null; then
    CNAME=$(dig +short CNAME "$CUSTOM_DOMAIN" @1.1.1.1 | sed 's/\.$//' | head -1)
    TXT=$(dig +short TXT "asuid.$CUSTOM_DOMAIN" @1.1.1.1 | tr -d '"' | head -1)
  else
    CNAME=$(nslookup -type=CNAME "$CUSTOM_DOMAIN" 1.1.1.1 2>/dev/null | sed -n 's/.*canonical name = \(.*\)\.$/\1/p' | head -1)
    TXT=$(nslookup -type=TXT "asuid.$CUSTOM_DOMAIN" 1.1.1.1 2>/dev/null | sed -n 's/.*text = "\(.*\)"/\1/p' | head -1)
  fi
  if [ "$CNAME" != "$FQDN" ] || [ "$TXT" != "$VERIFY_ID" ]; then
    warn "DNS is not ready yet. Create these two records (Cloudflare: proxy OFF, grey cloud), then re-run:"
    echo "        CNAME  $CUSTOM_DOMAIN  ->  $FQDN        (now: ${CNAME:-none})"
    echo "        TXT    asuid.$CUSTOM_DOMAIN  =  $VERIFY_ID   (now: ${TXT:-none})"
    echo "        ./infra/deploy.sh --upload-only --no-build --custom-domain $CUSTOM_DOMAIN"
  else
    ok "CNAME and TXT records found"
    az containerapp hostname add -g "$RG" -n "$APP" --hostname "$CUSTOM_DOMAIN" --only-show-errors -o none 2>/dev/null || info "hostname already added"
    info "issuing a free managed certificate: up to 10-20 minutes"
    az containerapp hostname bind -g "$RG" -n "$APP" --hostname "$CUSTOM_DOMAIN" --environment "$ENV_NAME" --validation-method CNAME --only-show-errors -o none \
      || die "Binding $CUSTOM_DOMAIN failed." "Check that the CNAME is DNS-only (not proxied), wait a few minutes, re-run the same command."
    ok "https://$CUSTOM_DOMAIN is bound"
    URL="https://$CUSTOM_DOMAIN"
  fi
fi

# --------------------------------------------------------------------------------------
step "Checking $URL"
code=0
for _ in $(seq 1 18); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$URL/api/health" || true)
  [ "$code" = 200 ] && break
  info "waiting for the first replica (cold start pulls the image): HTTP $code"
  sleep 10
done
[ "$code" = 200 ] && ok "$URL/api/health -> 200" || warn "$URL/api/health -> $code (the app may still be starting; check: az containerapp logs show -g $RG -n $APP)"
if [ $SKIP_SMOKE = 0 ] && [ "$code" = 200 ]; then
  EXPECT_BROWSER=1 "$PY" "$INFRA_DIR/check_site.py" "$URL" || warn "some smoke checks failed (see above)"
fi

echo
c 1 "Done."
echo "   Site:   $URL"
echo "   API:    $URL/openapi.json"
echo "   MCP:    $URL/mcp"
echo "   Logs:   az containerapp logs show -g $RG -n $APP --follow"
echo "   Remove: az group delete -n $RG   (deletes everything this script created)"
