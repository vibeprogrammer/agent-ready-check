// The renderers the server uses: H3's src/report (runtime-neutral). render-fallback.mjs keeps minimal versions
// with the same signatures for tests that want to avoid the full renderer.
export { renderReportHtml, renderReportMarkdown, renderFixPrompts, renderBadge, renderHomeHtml, shell, parseFilter, ASSETS } from '../src/report/index.mjs';
