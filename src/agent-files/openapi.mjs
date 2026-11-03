// OpenAPI 3.1 description of the HTTP API. Every operation has an operationId, a summary, a description,
// described parameters, response schemas and problem+json errors (RFC 9457).
import catalog from '../catalog.json' with { type: 'json' };
import { SITE } from './site.mjs';

const problem = (description) => ({ description, content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } });
const rlHeaders = {
  'RateLimit-Policy': { $ref: '#/components/headers/RateLimit-Policy' },
  RateLimit: { $ref: '#/components/headers/RateLimit' },
};

export function openapi(base) {
  const layers = catalog.layers.map((l) => l.id);
  return {
    openapi: '3.1.0',
    info: {
      title: `${SITE.name} API`,
      version: SITE.version,
      summary: 'Scan a website for agent-readiness and read the check catalogue.',
      description: `${SITE.description}\n\nBuilt on the book "${SITE.book}" by ${SITE.author}. Scans are rate limited per client and cached for 10 minutes per URL. Reports are stored for 30 days. Errors use application/problem+json (RFC 9457).`,
      license: { name: 'MIT', identifier: 'MIT' },
      contact: { name: SITE.name, url: SITE.issues },
    },
    servers: [{ url: base, description: 'This deployment' }],
    externalDocs: { description: 'Source code and self-hosting', url: SITE.repo },
    tags: [
      { name: 'scan', description: 'Run scans and read stored reports' },
      { name: 'checks', description: 'The check catalogue' },
      { name: 'badges', description: 'SVG badges for READMEs' },
    ],
    paths: {
      '/api/scan': {
        post: {
          operationId: 'scanSite',
          tags: ['scan'],
          summary: 'Scan a URL',
          description: 'Runs every check against the URL and returns the report. Takes about 10 to 60 seconds. The same URL is answered from a 10-minute cache. Private, loopback and link-local addresses are refused.',
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ScanRequest' }, examples: { basic: { value: { url: 'https://example.com' } }, agent: { value: { url: 'https://example.com', format: 'agent' } } } } } },
          responses: {
            200: {
              description: 'The report (JSON), or Markdown when format is markdown or agent.',
              headers: rlHeaders,
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Report' } }, 'text/markdown': { schema: { type: 'string', description: 'The report as Markdown, or only the fix prompts when format is agent.' } } },
            },
            400: problem('The URL or the body is not valid.'),
            413: problem('The request body is too large.'),
            415: problem('The body is not JSON.'),
            422: problem('The URL points to an address that may not be scanned (private network or blocked port).'),
            429: { ...problem('Too many scans from this client. Retry after the number of seconds in Retry-After.'), headers: { ...rlHeaders, 'Retry-After': { schema: { type: 'integer' }, description: 'Seconds until a new scan is allowed.' } } },
            500: problem('The scan failed unexpectedly.'),
          },
        },
        get: {
          operationId: 'scanSiteGet',
          tags: ['scan'],
          summary: 'Scan a URL (GET)',
          description: 'The same as POST /api/scan, with the URL in the query string. Handy for links and quick curl calls.',
          parameters: [
            { $ref: '#/components/parameters/url' },
            { name: 'format', in: 'query', required: false, description: 'json (default), markdown, or agent (only the fixes as Markdown prompts).', schema: { type: 'string', enum: ['json', 'markdown', 'agent'], default: 'json' } },
            { name: 'browser', in: 'query', required: false, description: 'Run the browser checks too, when this deployment has a browser (true or false).', schema: { type: 'boolean', default: false } },
          ],
          responses: {
            200: { description: 'The report.', headers: rlHeaders, content: { 'application/json': { schema: { $ref: '#/components/schemas/Report' } }, 'text/markdown': { schema: { type: 'string', description: 'The report as Markdown.' } } } },
            400: problem('The URL is missing or not valid.'),
            422: problem('The URL points to an address that may not be scanned.'),
            429: problem('Too many scans from this client.'),
          },
        },
      },
      '/api/checks': {
        get: {
          operationId: 'listChecks',
          tags: ['checks'],
          summary: 'List the checks',
          description: `The catalogue of ${catalog.checks.length} checks with their layer, severity, standard and status, book chapter and isitagentready or Lighthouse mapping.`,
          parameters: [{ name: 'layer', in: 'query', required: false, description: 'Only the checks of this layer.', schema: { type: 'string', enum: layers } }],
          responses: { 200: { description: 'The checks and the layers.', content: { 'application/json': { schema: { $ref: '#/components/schemas/CheckList' } } } }, 400: problem('Unknown layer.') },
        },
      },
      '/api/checks/{id}': {
        get: {
          operationId: 'getCheck',
          tags: ['checks'],
          summary: 'Explain one check',
          description: 'What the check tests, the standard behind it and its status, why it matters and how to fix it.',
          parameters: [{ name: 'id', in: 'path', required: true, description: 'Check id, for example content.markdown-negotiation.', schema: { type: 'string', pattern: '^[a-z0-9]+\\.[a-z0-9-]+$' } }],
          responses: { 200: { description: 'The check.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Check' } } } }, 404: problem('No check with that id.') },
        },
      },
      '/api/reports/{id}': {
        get: {
          operationId: 'getReport',
          tags: ['scan'],
          summary: 'Get a stored report',
          description: 'A report saved by an earlier scan. Reports are kept for 30 days. The HTML version is at /r/{id}.',
          parameters: [{ name: 'id', in: 'path', required: true, description: 'Report id from a scan response (id or report_url).', schema: { type: 'string', pattern: '^[a-z0-9]{6,32}$' } }],
          responses: { 200: { description: 'The report.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Report' } } } }, 404: problem('Unknown or expired report.') },
        },
      },
      '/badge/{host}.svg': {
        get: {
          operationId: 'getBadge',
          tags: ['badges'],
          summary: 'SVG badge for a host',
          description: 'A badge with the score and isitagentready-compatible level of the latest stored report for the host. Shows "not scanned" when there is none. It never starts a scan.',
          parameters: [{ name: 'host', in: 'path', required: true, description: 'Host name, for example example.com.', schema: { type: 'string' } }],
          responses: { 200: { description: 'The badge.', content: { 'image/svg+xml': { schema: { type: 'string' } } } } },
        },
      },
      '/badge': {
        get: {
          operationId: 'getBadgeByUrl',
          tags: ['badges'],
          summary: 'SVG badge for a URL',
          description: 'The same badge as /badge/{host}.svg, looked up from a URL.',
          parameters: [{ $ref: '#/components/parameters/url' }],
          responses: { 200: { description: 'The badge.', content: { 'image/svg+xml': { schema: { type: 'string' } } } }, 400: problem('The URL is missing or not valid.') },
        },
      },
    },
    components: {
      parameters: {
        url: { name: 'url', in: 'query', required: true, description: 'The page to scan, for example https://example.com (https:// is added when missing).', schema: { type: 'string', maxLength: 2048 } },
      },
      headers: {
        'RateLimit-Policy': { description: 'Quota policy (draft-ietf-httpapi-ratelimit-headers-11), for example "scans";q=10;w=600.', schema: { type: 'string' } },
        RateLimit: { description: 'Remaining quota and seconds to reset (draft-ietf-httpapi-ratelimit-headers-11), for example "scans";r=9;t=600.', schema: { type: 'string' } },
      },
      schemas: {
        ScanRequest: {
          type: 'object',
          required: ['url'],
          additionalProperties: false,
          properties: {
            url: { type: 'string', maxLength: 2048, description: 'The page to scan. http or https; https:// is added when no scheme is given.' },
            browser: { type: 'boolean', default: false, description: 'Run the browser checks (accessibility tree, axe, WebMCP, CLS, consent overlays) when this deployment has a browser.' },
            format: { type: 'string', enum: ['json', 'markdown', 'agent'], default: 'json', description: 'json: the full report. markdown: the report as Markdown. agent: only the failing and warning checks as Markdown fix prompts.' },
          },
        },
        Problem: {
          type: 'object',
          description: 'Problem details (RFC 9457).',
          required: ['type', 'title', 'status'],
          properties: {
            type: { type: 'string', description: 'A URI that identifies the problem type.' },
            title: { type: 'string', description: 'Short summary of the problem type.' },
            status: { type: 'integer', description: 'HTTP status code.' },
            detail: { type: 'string', description: 'What went wrong with this request.' },
            instance: { type: 'string', description: 'The request path.' },
          },
        },
        Standard: {
          type: 'object',
          description: 'The specification a check is based on and how settled it is.',
          properties: {
            key: { type: 'string' }, name: { type: 'string' }, body: { type: 'string' }, version: { type: 'string' }, date: { type: 'string' },
            status: { type: 'string', description: 'For example RFC, W3C Recommendation, Internet-Draft, vendor proposal.' },
            maturity: { type: 'string', enum: ['standard', 'guidance', 'draft', 'proposal', 'convention'] },
            url: { type: 'string' },
          },
        },
        Check: {
          type: 'object',
          required: ['id', 'layer', 'title', 'severity'],
          properties: {
            id: { type: 'string', description: 'Stable check id, layer.name.' },
            layer: { type: 'string', enum: layers },
            title: { type: 'string' },
            severity: { type: 'integer', minimum: 1, maximum: 3, description: '1 nice to have, 2 important, 3 essential.' },
            standard: { $ref: '#/components/schemas/Standard' },
            chapter: { type: ['integer', 'null'], description: 'Chapter of the book that explains it.' },
            test: { type: 'string', description: 'How the check is tested.' },
            iia: { type: ['string', 'null'], description: 'The isitagentready check it mirrors.' },
            lh: { type: ['string', 'null'], description: 'The Lighthouse Agentic Browsing audit it mirrors.' },
            requires: { type: 'string', enum: ['http', 'browser', 'dns'], description: 'What the check needs to run.' },
            applies: { type: 'string', description: 'always, or the capability the site must show (api, mcp, auth, commerce, forms), or optin.' },
            heuristic: { type: 'boolean', description: 'True when the threshold is this checker\'s judgement, not a standard\'s rule.' },
            why: { type: ['string', 'null'] },
            fix: { type: 'object', properties: { snippet: { type: ['string', 'null'] }, prompt: { type: ['string', 'null'] } } },
          },
        },
        CheckList: {
          type: 'object',
          properties: {
            version: { type: 'string' }, checked: { type: 'string', description: 'Date the standards were last read.' }, count: { type: 'integer' },
            layers: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, summary: { type: 'string' }, weight: { type: 'number' }, chapters: { type: 'string' } } } },
            checks: { type: 'array', items: { $ref: '#/components/schemas/Check' } },
          },
        },
        CheckResult: {
          type: 'object',
          properties: {
            id: { type: 'string' }, layer: { type: 'string' }, title: { type: 'string' },
            status: { type: 'string', enum: ['pass', 'warn', 'fail', 'info', 'neutral', 'skipped', 'error'] },
            message: { type: 'string', description: 'One sentence about this site.' },
            severity: { type: 'integer' }, weight: { type: 'number' }, standard: { $ref: '#/components/schemas/Standard' },
            evidence: { type: 'array', items: { type: ['integer', 'string', 'object'] }, description: 'Ids of the exchanges in report.exchanges.' },
            compat: { type: ['object', 'null'], description: 'The isitagentready-rule result for checks that mirror one.' },
            fix: { type: 'object', properties: { snippet: { type: ['string', 'null'] }, prompt: { type: ['string', 'null'] }, hint: { type: ['string', 'null'] } } },
          },
        },
        Report: {
          type: 'object',
          description: 'A scan report. See the README for every field.',
          required: ['url', 'scanned_at', 'score', 'layers', 'checks'],
          properties: {
            id: { type: 'string', description: 'Report id when stored.' },
            report_url: { type: 'string', description: 'Shareable HTML report, kept 30 days.' },
            url: { type: 'string' }, final_url: { type: 'string' }, scanned_at: { type: 'string', format: 'date-time' }, duration_ms: { type: 'integer' },
            mode: { type: 'object', properties: { runtime: { type: 'string' }, browser: { type: 'boolean' }, browser_error: { type: ['string', 'null'] } } },
            requests: { type: 'integer', description: 'HTTP requests the scan made.' },
            score: { type: 'integer', minimum: 0, maximum: 100 },
            layers: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, score: { type: ['integer', 'null'] }, applicable: { type: 'boolean' }, weight: { type: 'number' } } } },
            compat: {
              type: 'object',
              properties: {
                isitagentready: { type: 'object', properties: { level: { type: 'integer', minimum: 0, maximum: 5 }, level_name: { type: 'string' }, next_level: { type: ['object', 'null'] } } },
                lighthouse_agentic: { type: 'object', properties: { score: { type: ['number', 'null'] }, audits: { type: 'array', items: { type: 'object' } } } },
              },
            },
            checks: { type: 'array', items: { $ref: '#/components/schemas/CheckResult' } },
            exchanges: { type: 'object', additionalProperties: { type: 'object' }, description: 'The HTTP evidence, keyed by id.' },
          },
        },
      },
    },
  };
}
