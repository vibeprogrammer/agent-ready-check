// Checks for the privacy layer (static ones; privacy.consent-overlay is browser-only and lives in browser.mjs, H3).
// Ids and metadata: src/catalog.json. Owner: H2.
import { pass, warn, fail, info, neutral } from '../core/result.mjs';
import { allTools, toolKind } from './security.mjs';
import { wk } from './discovery.mjs';

const PRIVACY_WORDS = /privacy|personvern|datenschutz|confidentialit|privacidad|privacit|integritet/i;
const TERMS_WORDS = /terms|conditions|vilk[aå]r|agb|nutzungsbedingungen|conditions g[eé]n[eé]rales|t[eé]rminos|condizioni|legal/i;
const CONFIRM_WORDS = /\b(confirm|confirmation|ask (the )?(user|person|customer)|asks? for approval|requires? approval|human[- ]in[- ]the[- ]loop|user must|review (and|before)|requestUserInteraction|requestUserInput|elicitation)\b/i;

export default {
  'privacy.policy-link': {
    why: 'Agents acting for people check what a site does with their data before sharing it. rel="privacy-policy" and rel="terms-of-service" (IANA-registered, RFC 6903) make those pages findable without guessing (book chapter 17).',
    fix: { snippet: '<link rel="privacy-policy" href="/privacy">\n<link rel="terms-of-service" href="/terms">', prompt: 'Add <link rel="privacy-policy" href="..."> and <link rel="terms-of-service" href="..."> to the <head> of every page (or the same as Link headers), pointing at the existing privacy and terms pages.' },
    async run(ctx) {
      const links = await ctx.links();
      const doc = await ctx.dom();
      const relA = (rel) => [...doc.querySelectorAll('a[rel][href]')].filter((a) => a.getAttribute('rel').toLowerCase().split(/\s+/).includes(rel)).map((a) => a.getAttribute('href'));
      const privacy = [...links.filter((l) => l.rel === 'privacy-policy').map((l) => l.href), ...relA('privacy-policy')];
      const terms = [...links.filter((l) => l.rel === 'terms-of-service').map((l) => l.href), ...relA('terms-of-service')];
      const anchors = [...doc.querySelectorAll('a[href]')];
      const anchorPrivacy = anchors.find((a) => PRIVACY_WORDS.test(a.textContent || '') || PRIVACY_WORDS.test(a.getAttribute('href')));
      const anchorTerms = anchors.find((a) => TERMS_WORDS.test(a.textContent || '') || /terms|tos|vilkar|agb/i.test(a.getAttribute('href')));
      const details = { relPrivacy: privacy[0] || null, relTerms: terms[0] || null, anchorPrivacy: anchorPrivacy?.getAttribute('href') || null, anchorTerms: anchorTerms?.getAttribute('href') || null };
      const home = await ctx.home();
      if (privacy.length && terms.length) return pass('The page links its privacy policy and terms with rel="privacy-policy" and rel="terms-of-service".', { evidence: [home], details });
      if (privacy.length || terms.length) return warn(`Only ${privacy.length ? 'rel="privacy-policy"' : 'rel="terms-of-service"'} is declared; add the other${(privacy.length ? anchorTerms : anchorPrivacy) ? ' (an ordinary link to it exists)' : ''}.`, { evidence: [home], details });
      if (anchorPrivacy || anchorTerms) return warn(`The page links ${[anchorPrivacy && 'a privacy page', anchorTerms && 'terms'].filter(Boolean).join(' and ')} by link text only; agents have to guess. Add rel="privacy-policy" / rel="terms-of-service".`, { evidence: [home], details });
      return fail('No privacy policy or terms link was found in the server HTML of the page.', { evidence: [home], details });
    },
  },

  'privacy.gpc': {
    why: 'Global Privacy Control lets a person (or an agent acting for them) signal "do not sell or share my data"; /.well-known/gpc.json says your site honours it. It is a W3C Working Draft, legally recognised in some US states, and not covered by the book itself; consent signals are (book chapter 17).',
    fix: { snippet: '{ "gpc": true, "lastUpdate": "2026-11-01" }', prompt: 'If the site honours the Sec-GPC: 1 request header, serve /.well-known/gpc.json as application/json with { "gpc": true, "lastUpdate": "<YYYY-MM-DD>" } (W3C Global Privacy Control).' },
    async run(ctx) {
      const r = await wk(ctx, '/.well-known/gpc.json', 'global privacy control');
      if (r.json?.gpc === true) return pass(`/.well-known/gpc.json declares GPC support${r.json.lastUpdate ? ` (last updated ${r.json.lastUpdate})` : ''}.`, { evidence: [r.ex], details: r.json });
      if (r.json && 'gpc' in r.json) return info('/.well-known/gpc.json says the site does not honour GPC (gpc: false).', { evidence: [r.ex], details: r.json });
      if (r.json) return warn('/.well-known/gpc.json exists but has no boolean "gpc" member.', { evidence: [r.ex] });
      return info('No /.well-known/gpc.json, so support for Global Privacy Control is unknown (informational).', { evidence: [r.ex] });
    },
  },

  'privacy.human-confirmation': {
    why: 'Tools that book, pay, send or delete should leave the final yes to the person. Declarative WebMCP forms do this unless toolautosubmit is set; imperative and MCP tools need a confirmation step (book chapters 9 and 17).',
    fix: { snippet: '<form toolname="book_cabin" tooldescription="Book a cabin. The guest reviews and submits the form.">  <!-- no toolautosubmit -->', prompt: 'For every tool that books, pays, sends or deletes: keep declarative WebMCP forms without toolautosubmit so the person submits, mark imperative tools consequentialHint: true (WebMCP) or destructiveHint: true (MCP), and say in the description that the person confirms before the action happens; on MCP use elicitation for the confirmation.' },
    async run(ctx) {
      const tools = (await allTools(ctx)).filter((t) => toolKind(t.name) === 'write');
      if (!tools.length) return neutral('No write tools (book, pay, send, delete...) were found among MCP and WebMCP tools.');
      const rows = tools.map((t) => {
        const a = t.annotations || {};
        const signals = [];
        if (t.declarative && !t.autosubmit) signals.push('declarative form without toolautosubmit (the person submits)');
        if (a.consequentialHint === true) signals.push('consequentialHint');
        if (t.origin === 'MCP' && a.destructiveHint !== false && a.readOnlyHint !== true) signals.push('MCP destructive by default');
        if (CONFIRM_WORDS.test(t.description)) signals.push('description mentions confirmation');
        return { origin: t.origin, name: t.name, signals };
      });
      const none = rows.filter((r) => !r.signals.length);
      const details = { tools: rows, heuristic: 'write tools are inferred from name verbs; signals are annotations, toolautosubmit and description words' };
      if (!none.length) return pass(`All ${rows.length} write tool(s) show a human-confirmation signal (${[...new Set(rows.flatMap((r) => r.signals))].slice(0, 3).join('; ')}).`, { details });
      return warn(`${none.length} of ${rows.length} write tool(s) show no human-confirmation signal: ${none.slice(0, 4).map((r) => `${r.origin} ${r.name}`).join(', ')}.`, { details });
    },
  },
};
