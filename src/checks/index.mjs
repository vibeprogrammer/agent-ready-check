// Registry: catalog metadata (src/catalog.json) + the implementation of each check.
// A layer module default-exports { '<check id>': { run(ctx), why, fix: { snippet, prompt } } }.
import catalog from '../catalog.json' with { type: 'json' };
import perception from './perception.mjs';
import crawl from './crawl.mjs';
import structured from './structured.mjs';
import content from './content.mjs';
import api from './api.mjs';
import mcp from './mcp.mjs';
import webmcp from './webmcp.mjs';
import discovery from './discovery.mjs';
import commerce from './commerce.mjs';
import identity from './identity.mjs';
import security from './security.mjs';
import privacy from './privacy.mjs';
import performance from './performance.mjs';
import browser from './browser.mjs';

const IMPL = { ...perception, ...crawl, ...structured, ...content, ...api, ...mcp, ...webmcp, ...discovery, ...commerce, ...identity, ...security, ...privacy, ...performance, ...browser };

export { catalog };
export const CHECKS = catalog.checks.map((meta) => ({ ...meta, standardInfo: catalog.standards[meta.standard], impl: IMPL[meta.id] || null }));
export const LAYERS = catalog.layers;
export const unknownImpl = Object.keys(IMPL).filter((id) => !catalog.checks.some((c) => c.id === id));
