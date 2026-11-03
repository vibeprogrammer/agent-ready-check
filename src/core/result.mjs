// Check result helpers. Every check returns one of these objects.
// status: pass | warn | fail | info | neutral (not applicable) | skipped (could not run here) | error
export const STATUSES = ['pass', 'warn', 'fail', 'info', 'neutral', 'skipped', 'error'];
export const CREDIT = { pass: 1, warn: 0.5, fail: 0 };

/**
 * @param {string} status
 * @param {string} message  one sentence, specific to this site ("robots.txt names 4 of 17 AI crawlers")
 * @param {{details?:any, evidence?:any[], compat?:{status:'pass'|'fail'|'neutral'|'unableToCheck', message:string, details?:any}, fix?:string}} [extra]
 *   evidence: Exchange objects from ctx.fetch (or plain {note} objects); compat: the isitagentready-rule result
 *   for checks that mirror one; fix: an optional site-specific fix hint appended to the static fix.
 */
export function result(status, message, extra = {}) {
  if (!STATUSES.includes(status)) throw new Error(`bad status ${status}`);
  return { status, message, details: extra.details, evidence: (extra.evidence || []).filter(Boolean), compat: extra.compat, fix: extra.fix };
}
export const pass = (m, e) => result('pass', m, e);
export const warn = (m, e) => result('warn', m, e);
export const fail = (m, e) => result('fail', m, e);
export const info = (m, e) => result('info', m, e);
export const neutral = (m, e) => result('neutral', m, e);
export const skipped = (m, e) => result('skipped', m, e);
export const error = (m, e) => result('error', m, e);
