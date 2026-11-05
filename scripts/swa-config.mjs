// staticwebapp.config.json for the Azure Static Web Apps deployment (written by scripts/build-azure.mjs).
// https://learn.microsoft.com/en-us/azure/static-web-apps/configuration
// - /assets/* are static files on the Static Web Apps CDN.
// - /api/* goes to the managed function as usual (the API route prefix is fixed at /api).
// - Every other path is rewritten to the function at /api/__site, which reads the visitor's address from the
//   x-ms-original-url header and answers with the same app as on Node (pages, Markdown negotiation, /mcp,
//   robots.txt, llms.txt, /.well-known/*, reports, badges). navigationFallback catches anything the routes miss.
export const SITE_FUNCTION = '/api/__site';

export function swaConfig() {
  const assetHeaders = { 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' };
  return {
    platform: { apiRuntime: 'node:22' },
    routes: [
      { route: '/assets/*', headers: assetHeaders },
      { route: '/api/*', allowedRoles: ['anonymous'] },
      { route: '/*', rewrite: SITE_FUNCTION },
    ],
    navigationFallback: { rewrite: SITE_FUNCTION, exclude: ['/assets/*'] },
    mimeTypes: { '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' },
    globalHeaders: {
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'strict-transport-security': 'max-age=31536000; includeSubDomains',
    },
  };
}
