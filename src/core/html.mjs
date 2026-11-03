// HTML helpers on top of linkedom (pure JS, runs in Node and Workers).
import { parseHTML } from 'linkedom';

export function parseDocument(html) {
  try { return parseHTML(String(html || '')).document; } catch { return parseHTML('<!doctype html><html><body></body></html>').document; }
}

const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'HEAD', 'IFRAME', 'OBJECT']);
const isHiddenStyle = (s) => /display\s*:\s*none|visibility\s*:\s*hidden/i.test(s || '');

/** Visible text of a server-rendered document (ignores script/style/template, [hidden], inline display:none). */
export function visibleText(doc) {
  if (!doc?.body) return '';
  const parts = [];
  const walk = (node) => {
    for (const n of node.childNodes || []) {
      if (n.nodeType === 3) { const t = n.textContent; if (t && t.trim()) parts.push(t.trim()); continue; }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName?.toUpperCase();
      if (SKIP.has(tag)) continue;
      if (n.hasAttribute?.('hidden') || isHiddenStyle(n.getAttribute?.('style'))) continue;
      if (tag === 'IMG' && n.getAttribute('alt')) parts.push(n.getAttribute('alt'));
      walk(n);
    }
  };
  walk(doc.body);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/** Accessible-name approximation for static HTML (not the full accname algorithm; the browser run does that). */
export function staticName(el, doc) {
  const lb = el.getAttribute?.('aria-labelledby');
  if (lb) { const t = lb.split(/\s+/).map((id) => doc.getElementById(id)?.textContent || '').join(' ').trim(); if (t) return t; }
  const al = el.getAttribute?.('aria-label'); if (al && al.trim()) return al.trim();
  const tag = el.tagName?.toUpperCase();
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) {
    const id = el.getAttribute('id');
    if (id) { const l = doc.querySelector(`label[for="${cssEscape(id)}"]`); if (l && l.textContent.trim()) return l.textContent.trim(); }
    let p = el.parentElement; while (p) { if (p.tagName?.toUpperCase() === 'LABEL') return p.textContent.trim(); p = p.parentElement; }
    if (tag === 'INPUT' && ['submit', 'button', 'reset'].includes((el.getAttribute('type') || '').toLowerCase())) return (el.getAttribute('value') || '').trim() || (el.getAttribute('type') === 'submit' ? 'Submit' : '');
    if (tag === 'INPUT' && (el.getAttribute('type') || '').toLowerCase() === 'image') return (el.getAttribute('alt') || '').trim();
    return (el.getAttribute('title') || el.getAttribute('placeholder') || '').trim();
  }
  let t = (el.textContent || '').replace(/\s+/g, ' ').trim();
  if (!t) t = [...(el.querySelectorAll?.('img[alt],svg title') || [])].map((i) => i.getAttribute?.('alt') || i.textContent).join(' ').trim();
  return t || (el.getAttribute?.('title') || '').trim();
}

export const cssEscape = (s) => String(s).replace(/["\\]/g, '\\$&');

/** A short CSS-ish path for evidence: tag#id.class */
export function describe(el) {
  if (!el?.tagName) return '';
  const id = el.getAttribute('id'); const cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
  return el.tagName.toLowerCase() + (id ? `#${id}` : '') + (cls.length ? '.' + cls.join('.') : '');
}

export function outer(el, max = 200) {
  const s = el?.outerHTML || ''; return s.length > max ? s.slice(0, max) + '…' : s;
}
