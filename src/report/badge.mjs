// SVG badge: "agent-ready | 87 · L4". Shields-style, flat, with an accessible title.
import { esc } from './util.mjs';

const COLORS = [[90, '#1a7f37'], [70, '#4c8a12'], [40, '#b35900'], [0, '#c62828']];
// Average glyph width of 11px Verdana, close enough for layout (shields.io uses the same approach).
const width = (s) => Math.round([...String(s)].reduce((w, ch) => w + (/[il.,:|!']/.test(ch) ? 3.6 : /[mwMW@]/.test(ch) ? 9.5 : /[A-Z0-9]/.test(ch) ? 7.4 : 6.4), 0)) + 12;

/** Pixel width of the badge for these values (for width/height attributes that prevent layout shift). */
export function badgeWidth({ score = null, level = null, label = 'agent-ready' } = {}) {
  return Number(/width="(\d+)"/.exec(renderBadge({ score, level, label }))[1]);
}

/**
 * @param {{ score?: number|null, level?: number|null, label?: string }} o
 * @returns {string} SVG document
 */
export function renderBadge({ score = null, level = null, label = 'agent-ready' } = {}) {
  const s = Number.isFinite(Number(score)) && score !== null ? Math.max(0, Math.min(100, Math.round(Number(score)))) : null;
  const lv = Number.isFinite(Number(level)) && level !== null ? Math.max(0, Math.min(5, Math.round(Number(level)))) : null;
  const value = s === null ? 'not scanned' : `${s}/100${lv === null ? '' : ` · L${lv}`}`;
  const color = s === null ? '#6e7681' : COLORS.find(([min]) => s >= min)[1];
  const lw = width(label); const vw = width(value); const w = lw + vw;
  const title = s === null ? `${label}: not scanned` : `${label}: score ${s} of 100${lv === null ? '' : `, isitagentready-compatible level ${lv}`}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${esc(title)}"><title>${esc(title)}</title>` +
    `<linearGradient id="g" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>` +
    `<clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath><g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#1f2a44"/>` +
    `<rect x="${lw}" width="${vw}" height="20" fill="${color}"/><rect width="${w}" height="20" fill="url(#g)"/></g>` +
    `<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">` +
    `<text x="${lw / 2}" y="14">${esc(label)}</text><text x="${lw + vw / 2}" y="14">${esc(value)}</text></g></svg>`;
}
