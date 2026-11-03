// Prompt-injection patterns: text that addresses an AI system instead of a person.
// Shared by security.hidden-injection, security.injection-in-machine-files (H2) and the browser collector (H3).
// The first four signals are adapted from agent-ready-web-demos (MIT, Maxim Salnikov),
// nordlys-cabins/layers/16-security/untrusted.js; the rest are checker heuristics (book chapter 16 describes the class).
// A match is a hint for a person to review, never proof of an attack.

/** Invisible / bidi / tag characters used to hide instructions (from the same demo file). */
export const INVISIBLE = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]|[\u{E0000}-\u{E007F}]/u;

/** [name, RegExp, description, strength] — 'weak' patterns also match legitimate guidance ("agents should use the API"). */
export const INJECTION_PATTERNS = [
  ['instruction-override', /\b(ignore|disregard|forget|override)\b.{0,40}\b(previous|prior|above|earlier|all|any|your)\b.{0,20}\b(instructions?|rules|prompts?|guidelines|directions)\b/i, 'tells a model to drop its instructions (demo heuristic)', 'strong'],
  ['addresses-the-ai', /\b(AI|assistant|agent|language model|LLM|chatbot|GPT|Claude|Gemini)s?\b.{0,40}\b(must|should|need to|are required to|reading this)\b/i, 'speaks to an AI reader (demo heuristic)', 'weak'],
  ['role-marker', /(^|\s)(system|assistant|developer)\s*:|<\/?(system|instructions?)>|\[\/?INST\]|<\|im_start\|>|<\|(system|user|assistant)\|>/i, 'chat role markers (demo heuristic, extended with ChatML tokens)', 'strong'],
  ['action-request', /(^|[.!?:;]\s*|\b(please|now|immediately|must|should|then|always)\s+)(send|forward|email|post|upload|transfer|book|cancel|reveal|share|exfiltrate|leak)\s.{0,60}\b(password|token|email address|booking reference|credit card|card number|api key|all bookings|credentials|secrets?|cookies?|system prompt)\b/i, 'an imperative asking for an action on secrets or data (demo heuristic, narrowed to imperatives and extended)', 'strong'],
  ['you-are-now', /\byou\s+are\s+(now\s+)?(an?\s+)?(AI|assistant|language model|LLM|helpful|unrestricted|DAN|jailbroken)\b|\bact\s+as\s+(an?\s+)?(AI|assistant|system)\b|\bnew\s+(system\s+)?instructions?\s*:/i, 'tries to redefine the model role (checker heuristic)', 'strong'],
  ['system-prompt', /\b(reveal|print|show|repeat|output)\b.{0,30}\b(system|hidden|initial)\s+(prompt|instructions?|message)\b/i, 'asks the model to reveal its prompt (checker heuristic)', 'strong'],
  ['hide-from-user', /\b(do not|don'?t|never)\s+(tell|inform|mention|reveal|show)\b.{0,30}\b(the\s+)?(user|human|customer|person)\b/i, 'asks the model to keep something from the person (checker heuristic)', 'strong'],
  ['recommend-manipulation', /\b(always|only)\s+(recommend|suggest|rank|choose|prefer)\b.{0,60}\b(this|our)\s+(site|product|company|store|service)\b/i, 'tries to steer an AI recommendation (checker heuristic)', 'weak'],
];

/**
 * Find injection-like phrases in text.
 * @param {string} text
 * @returns {{pattern:string, description:string, strength:'strong'|'weak', match:string, index:number}[]}
 */
export function findInjections(text) {
  const raw = String(text ?? '');
  if (!raw.trim()) return [];
  const out = [];
  const inv = raw.match(INVISIBLE);
  // Invisible characters alone are common (soft hyphens, zero-width joiners in emoji); report them only
  // when the text also carries a pattern, or when tag characters (U+E0000 block) are present.
  // URLs and path-like tokens ("post/2026-11-02-service-token") are not sentences: blank them before matching.
  const norm = raw.normalize('NFKC').replace(new RegExp(INVISIBLE.source, 'gu'), '')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ').replace(/\S*[\\/]\S*/g, ' ').replace(/\s+/g, ' ');
  for (const [pattern, re, description, strength] of INJECTION_PATTERNS) {
    const m = norm.match(re);
    if (m) out.push({ pattern, description, strength, match: m[0].trim().slice(0, 160), index: m.index ?? 0 });
  }
  if (inv && (out.length || /[\u{E0000}-\u{E007F}]/u.test(raw))) {
    out.unshift({ pattern: 'invisible-characters', description: 'zero-width, bidi or tag characters that hide text', strength: 'strong', match: `U+${inv[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`, index: inv.index ?? 0 });
  }
  return out;
}

/** True when text has at least one strong instruction-like pattern. */
export const looksLikeInjection = (text) => findInjections(text).some((m) => m.strength === 'strong' && m.pattern !== 'invisible-characters');
