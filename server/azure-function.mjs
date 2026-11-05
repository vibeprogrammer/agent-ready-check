// Azure Functions (v4 Node.js programming model) registration for Static Web Apps managed functions.
// One HTTP function, route "{*path}" under the fixed /api prefix, anonymous: it serves /api/* directly and every
// page that Static Web Apps rewrites to /api/__site (see server/azure.mjs). scripts/build-azure.mjs bundles this
// file into api/dist/index.mjs; @azure/functions stays an installed dependency of api/.
import { app } from '@azure/functions';
import { createAzureHandler } from './azure.mjs';

let handler = null;

app.http('site', {
  route: '{*path}',
  methods: ['GET', 'HEAD', 'POST', 'OPTIONS', 'PUT', 'DELETE', 'PATCH'],
  authLevel: 'anonymous',
  handler: async (request) => {
    handler ||= createAzureHandler(process.env);
    const res = await handler(request);
    const headers = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    const body = request.method === 'HEAD' || res.status === 204 || res.status === 304 ? undefined : new Uint8Array(await res.arrayBuffer());
    return { status: res.status, headers, body };
  },
});
