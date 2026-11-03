// AI user agents and robots.txt control tokens, grouped by purpose.
// Adapted from agent-ready-web-demos (MIT), nordlys-cabins/layers/04-crawler-controls/agents.js,
// checked by the book on 2 November 2026 (re-check vendor pages before relying on a token).
export const CRAWLERS_CHECKED = '2026-11-02';
export const AI_CRAWLERS = {
  training: ['GPTBot', 'ClaudeBot', 'Google-Extended', 'Applebot-Extended', 'CCBot', 'MistralAI-Training', 'Meta-ExternalAgent'],
  search: ['OAI-SearchBot', 'Claude-SearchBot', 'PerplexityBot', 'Amzn-SearchBot', 'MistralAI-Index'],
  user: ['ChatGPT-User', 'Claude-User', 'Perplexity-User', 'Amzn-User', 'MistralAI-User'],
};
