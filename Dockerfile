# Agent-Ready Check: Node server + Chromium for the browser checks.
# Base: the official Playwright image. Its tag must match the playwright-core version in package-lock.json
# (1.64.1), so the bundled browsers are the ones playwright-core expects. Tag verified on mcr.microsoft.com on 2026-11-03.
FROM mcr.microsoft.com/playwright:v1.64.1-noble

ENV NODE_ENV=production \
    PORT=8080 \
    BROWSER=1 \
    REPORTS_DIR=/data \
    TRUST_PROXY=1

WORKDIR /app
COPY package.json package-lock.json ./
# playwright-core is only a dev dependency in some lockfiles; the browser checks need it at run time, at the image's version.
RUN npm ci --omit=dev --no-audit --no-fund \
 && (node -e "require.resolve('playwright-core')" 2>/dev/null || npm install --no-save --no-audit --no-fund playwright-core@1.64.1) \
 && npm cache clean --force
COPY . .
RUN mkdir -p /data && chown -R pwuser:pwuser /data /app

USER pwuser
EXPOSE 8080
CMD ["node", "server/node.mjs"]
