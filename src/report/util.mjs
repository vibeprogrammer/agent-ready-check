// Small helpers shared by the renderers. Runtime-neutral (Node and Workers).

/** Escape for HTML text and attribute values. Every site-controlled string goes through this. */
export function esc(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Only http(s) URLs may become href values; anything else is shown as text. */
export function safeHref(u) {
  try { const x = new URL(String(u)); return ['http:', 'https:'].includes(x.protocol) ? x.href : null; } catch { return null; }
}

/** Markdown inline text: neutralise characters that would start markup, links or HTML. */
export function mdText(v) {
  return String(v ?? '').replace(/\r?\n/g, ' ').replace(/([\\`*_[\]<>|#])/g, '\\$1');
}

/** A fenced code block whose fence cannot be closed by the content. */
export function mdFence(body, lang = '') {
  const s = String(body ?? '');
  const longest = Math.max(2, ...(s.match(/`+/g) || []).map((m) => m.length));
  const f = '`'.repeat(longest + 1);
  return `${f}${lang}\n${s}\n${f}`;
}

export const STATUS_LABEL = { pass: 'Pass', warn: 'Warning', fail: 'Fail', info: 'Info', neutral: 'Not applicable', skipped: 'Skipped', error: 'Error' };
export const STATUS_ORDER = { fail: 0, warn: 1, error: 2, info: 3, pass: 4, skipped: 5, neutral: 6 };
export const STATUS_ICON = { pass: '✓', warn: '!', fail: '✕', info: 'i', neutral: '–', skipped: '○', error: '?' };

/** Maturity legend for the standard badge (factor from src/core/score.mjs MATURITY). */
export const MATURITY_LABEL = {
  standard: { label: 'Standard', text: 'RFC, W3C Recommendation, living standard or a shipped tool audit. Full weight (1.0).' },
  guidance: { label: 'Guidance', text: 'Recommendation from the book or vendor guidance. Full weight (1.0).' },
  draft: { label: 'Draft', text: 'Internet-Draft, W3C community draft or origin trial: may still change. Weight 0.6.' },
  proposal: { label: 'Proposal', text: 'Vendor or single-author proposal. Weight 0.4.' },
  convention: { label: 'Convention', text: 'De-facto convention with no spec body. Weight 0.4.' },
};

export const ROLE_NAMES = { dev: 'Developers', design: 'Designers', content: 'Content and SEO', pm: 'Product managers', arch: 'Architects', qa: 'QA', security: 'Security', analytics: 'Analytics' };

export function grade(score) {
  if (score == null) return 'Not scored';
  if (score >= 90) return 'Agent-ready';
  if (score >= 70) return 'Mostly ready';
  if (score >= 40) return 'Partly ready';
  return 'Not ready';
}

export const hostOf = (u) => { try { return new URL(u).host; } catch { return String(u || ''); } };
export const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms || 0)} ms`);
