#!/usr/bin/env bash
# Start script for the browser runner box (server/runner.mjs). Idempotent: skips steps already done.
# Needs: internet, sudo for Chromium's system libraries. Env: RUNNER_TOKEN (required), PORT (default 8080).
set -euo pipefail
cd "$(dirname "$0")/.."
NODE_VERSION="${NODE_VERSION:-24.11.1}"
need_node() { ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; }
if need_node; then
  if [ ! -x "$HOME/node/bin/node" ]; then
    echo "installing Node $NODE_VERSION"
    curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" -o /tmp/node.tar.xz
    mkdir -p "$HOME/node" && tar -xJf /tmp/node.tar.xz -C "$HOME/node" --strip-components=1 && rm -f /tmp/node.tar.xz
  fi
  export PATH="$HOME/node/bin:$PATH"
fi
if [ ! -d node_modules/playwright-core ]; then
  npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund
  [ -d node_modules/playwright-core ] || npm install --no-save --no-audit --no-fund playwright-core@1.64.1
fi
if [ ! -f "$HOME/.runner-browser-ok" ]; then
  npx --yes playwright@1.64.1 install --with-deps chromium-headless-shell
  touch "$HOME/.runner-browser-ok"
fi
# Small boxes: V8 reserves a large virtual CodeRange per renderer; strict overcommit or a ulimit -v makes
# Chromium's renderer die with "V8 process OOM (Failed to reserve virtual memory for CodeRange)".
sudo -n sysctl -w vm.overcommit_memory=1 >/dev/null 2>&1 || true
ulimit -v unlimited 2>/dev/null || true
# No swap on small boxes: a heavy page can push the box into an out-of-memory stall. Add 1 GB of swap once.
if ! /sbin/swapon --show 2>/dev/null | grep -q /swapfile; then
  (sudo -n fallocate -l 1G /swapfile && sudo -n chmod 600 /swapfile && sudo -n /sbin/mkswap /swapfile >/dev/null && sudo -n /sbin/swapon /swapfile) 2>/dev/null || echo "swap not available here"
fi
export PLAYWRIGHT_CHROMIUM_HEADLESS_SHELL=1
exec node server/runner.mjs
