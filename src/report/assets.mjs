// Static assets for the HTML pages, as strings so the Node server and the Worker serve them the same way.
// The server answers GET <path> with { type, body } and a long cache (the HTML references them with ?v=ASSET_VERSION).
// Entries with encoding: 'base64' are binary (the fonts): the server decodes body to bytes before sending it.
import { SILKSCREEN_400, SILKSCREEN_700 } from './fonts.mjs';

export const APP_CSS = String.raw`/* Agent-Ready Check, pixel theme. Tokens and contrast pairs are documented in docs/DESIGN.md.
   Palette read from the GitHub Universe recap page (computed CSS and the hero canvas) on 2026-11-05.
   One light scheme, as on the source page. No rounded corners, no gradients, no blur: square 2px borders on an 8px grid. */
@font-face{font-family:"Silkscreen";font-style:normal;font-weight:400;font-display:block;src:url(/assets/fonts/silkscreen-400.woff2) format("woff2")}
@font-face{font-family:"Silkscreen";font-style:normal;font-weight:700;font-display:block;src:url(/assets/fonts/silkscreen-700.woff2) format("woff2")}
:root{
  /* palette (source values) */
  --paper:#f2f5f3;--panel:#ffffff;--ink:#1e162b;--ink-deep:#180e27;--text:#1f2328;--muted:#58635b;
  --rule:#b6bfb8;--rule-soft:#e4ebe6;--green:#08872b;--green-deep:#0d6731;--mint:#5fed83;--violet:#583af7;
  --lavender:#ae85ff;--pink:#f73678;--blue:#168ffb;--olive:#bba00a;--orange:#c05200;--cream:#f5f0eb;--plum:#3d274f;
  /* derived for text contrast (lightness lowered until >= 4.5:1 on --paper) */
  --pink-text:#da0950;--olive-text:#7e6c07;--blue-text:#046ece;
  /* status tokens: fill (chip, with --ink text) and text colour on light surfaces */
  --pass-fill:var(--mint);--pass-text:var(--green-deep);
  --fail-fill:var(--pink);--fail-text:var(--pink-text);
  --warn-fill:var(--olive);--warn-text:var(--olive-text);
  --info-fill:var(--blue);--info-text:var(--blue-text);
  --error-fill:var(--orange);
  /* type and grid */
  --font-pixel:"Silkscreen",ui-monospace,"Cascadia Mono",Menlo,Consolas,monospace;
  --font-body:system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans",Helvetica,Arial,sans-serif;
  --font-mono:ui-monospace,"SFMono-Regular","Cascadia Mono","JetBrains Mono",Menlo,Consolas,"Liberation Mono",monospace;
  --u:8px;--b:2px;--wrap:1120px;
  color-scheme:light;
}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--text);font:400 17px/1.6 var(--font-body);min-height:100vh;display:flex;flex-direction:column}
body > main{flex:1 0 auto;width:100%}
img,svg{max-width:100%}
svg.px{display:inline-block;flex:none;shape-rendering:crispEdges;vertical-align:-2px}
a{color:var(--violet);text-decoration:underline;text-decoration-thickness:2px;text-underline-offset:3px}
a:hover{color:var(--ink);text-decoration-color:var(--violet)}
:focus-visible{outline:3px solid var(--violet);outline-offset:2px}
code,pre,kbd{font-family:var(--font-mono);font-size:.88em}
code{background:var(--rule-soft);color:var(--ink);padding:1px 4px;overflow-wrap:anywhere}
pre{margin:0;padding:calc(var(--u)*2);background:var(--ink);color:var(--cream);overflow:auto;line-height:1.5;font-size:14px;border:var(--b) solid var(--ink)}
pre code{background:none;color:inherit;padding:0;font-size:inherit}
h1,h2,h3,h4{font-family:var(--font-pixel);font-weight:700;color:var(--ink);line-height:1.15;letter-spacing:0;margin:0}
h1{font-size:48px}
h2{font-size:24px;margin:0 0 calc(var(--u)*2)}
h3{font-size:18px}
h4{font-size:16px;margin:0 0 var(--u)}
p{margin:0 0 calc(var(--u)*2)}
p:last-child{margin-bottom:0}
.small{font-size:14px;color:var(--muted)}
.muted{color:var(--muted)}
.skip{position:absolute;left:var(--u);top:-80px;background:var(--ink);color:var(--paper);padding:var(--u) calc(var(--u)*2);z-index:10;font-weight:700}
.skip:focus{top:var(--u);color:var(--paper)}
.wrap,main{max-width:var(--wrap);margin:0 auto;padding:0 calc(var(--u)*3)}

/* header: brand, nav, and the stepped colour bar (the recap's category colours) */
header.site{width:100%;max-width:var(--wrap);margin:0 auto;padding:calc(var(--u)*2) calc(var(--u)*3);display:flex;align-items:center;justify-content:space-between;gap:calc(var(--u)*2);flex-wrap:wrap}
.brand{display:inline-flex;align-items:center;gap:12px;font-family:var(--font-pixel);font-weight:700;font-size:18px;color:var(--ink);text-decoration:none}
.brand:hover{color:var(--ink)}
.brand svg{width:32px;height:32px}
header.site nav{display:flex;flex-wrap:wrap;gap:0}
header.site nav a{font-family:var(--font-pixel);font-size:16px;color:var(--ink);text-decoration:none;padding:6px 12px;border:var(--b) solid transparent}
header.site nav a:hover{border-color:var(--ink)}
header.site nav a[aria-current="page"]{background:var(--ink);color:var(--paper)}
.colorbar{height:8px;display:grid;grid-template-columns:repeat(8,1fr);border-top:var(--b) solid var(--ink);border-bottom:var(--b) solid var(--ink);background:var(--ink)}
.colorbar span:nth-child(1){background:var(--mint)}.colorbar span:nth-child(2){background:var(--violet)}
.colorbar span:nth-child(3){background:var(--pink)}.colorbar span:nth-child(4){background:var(--orange)}
.colorbar span:nth-child(5){background:var(--lavender)}.colorbar span:nth-child(6){background:var(--blue)}
.colorbar span:nth-child(7){background:var(--olive)}.colorbar span:nth-child(8){background:var(--green)}
main{padding-top:calc(var(--u)*6);padding-bottom:calc(var(--u)*10)}
main > section + section{margin-top:calc(var(--u)*8)}

/* section heading with a pixel marker */
.sh{display:flex;align-items:center;gap:12px}
.sh::before{content:"";width:12px;height:12px;background:var(--violet);flex:none}

/* buttons and fields */
button,.btn{font-family:var(--font-pixel);font-weight:700;font-size:16px;line-height:1;display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;padding:0 calc(var(--u)*2);color:#fff;background:var(--green);border:var(--b) solid var(--ink);box-shadow:4px 4px 0 var(--ink);cursor:pointer;text-decoration:none;border-radius:0}
button:hover,.btn:hover{background:var(--green-deep);color:#fff}
button:active,.btn:active{transform:translate(4px,4px);box-shadow:none}
button:disabled{background:var(--muted);cursor:progress}
button.quiet,.btn.quiet{background:var(--panel);color:var(--ink);box-shadow:none;min-height:36px;font-size:14px}
button.quiet:hover,.btn.quiet:hover{background:var(--ink);color:var(--paper)}
input[type=text],input[type=url],select{font:400 18px/1.2 var(--font-mono);color:var(--ink);background:var(--panel);border:var(--b) solid var(--ink);border-radius:0;min-height:44px;padding:0 12px}
select{font:400 16px/1.2 var(--font-body);padding-right:8px}
input::placeholder{color:var(--muted);opacity:1}
label.check{display:inline-flex;align-items:center;gap:8px;font-size:15px;cursor:pointer}
input[type=checkbox]{appearance:none;-webkit-appearance:none;margin:0;width:20px;height:20px;border:var(--b) solid var(--ink);background:var(--panel);display:inline-grid;place-content:center;flex:none;cursor:pointer}
input[type=checkbox]::before{content:"";width:10px;height:10px;background:var(--ink);transform:scale(0)}
input[type=checkbox]:checked::before{transform:scale(1)}

/* the scan box */
form.scan{background:var(--panel);border:var(--b) solid var(--ink);box-shadow:8px 8px 0 var(--violet);padding:calc(var(--u)*3);max-width:760px}
form.scan > label:first-child{display:block;font-family:var(--font-pixel);font-size:16px;color:var(--ink);margin-bottom:var(--u)}
form.scan .row{display:flex;gap:calc(var(--u)*2)}
form.scan .row input{flex:1;min-width:0;min-height:56px;font-size:20px}
form.scan .row button{min-height:56px;padding:0 calc(var(--u)*4);font-size:18px}
form.scan label.check{margin-top:calc(var(--u)*2)}
form.scan .status{margin:calc(var(--u)*2) 0 0;font-family:var(--font-mono);font-size:15px;color:var(--ink);min-height:0}
form.scan .status:empty{display:none}
form.scan .status:not(:empty)::before{content:"";display:inline-block;width:10px;height:10px;margin-right:10px;background:var(--violet);vertical-align:0;animation:blink 1s steps(2,start) infinite}
@keyframes blink{to{visibility:hidden}}
form.scan.compact{max-width:none;box-shadow:none;padding:calc(var(--u)*2);display:grid;grid-template-columns:auto 1fr;align-items:center;gap:var(--u) calc(var(--u)*2)}
form.scan.compact > label:first-child{margin:0;font-size:14px}
form.scan.compact .row input,form.scan.compact .row button{min-height:44px;font-size:16px}
form.scan.compact .row button{box-shadow:none}
form.scan.compact label.check,form.scan.compact .status{grid-column:2;margin:0}

/* home */
.intro{display:grid;grid-template-columns:minmax(0,7fr) minmax(0,5fr);gap:calc(var(--u)*6);align-items:start}
.kicker{font-family:var(--font-pixel);font-size:16px;color:var(--violet);margin:0 0 calc(var(--u)*2)}
.intro h1{margin-bottom:calc(var(--u)*3)}
.lead{font-size:20px;line-height:1.5;color:var(--text);max-width:40em;margin-bottom:calc(var(--u)*4)}
.readout{background:var(--ink);color:var(--cream);border:var(--b) solid var(--ink);padding:calc(var(--u)*3);margin-top:calc(var(--u)*1)}
.readout h2{color:var(--paper);font-size:16px;margin-bottom:calc(var(--u)*2)}
.readout p{color:var(--cream);font-size:15px}
.readout .scoreline{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px;font-family:var(--font-pixel);color:var(--mint);margin-bottom:calc(var(--u)*2)}
.readout .scoreline b{font-size:32px;line-height:1;white-space:nowrap}
.layerlist{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:1fr 1fr;column-gap:calc(var(--u)*6);border-top:var(--b) solid var(--ink)}
.layerlist li{display:grid;grid-template-columns:40px 1fr auto;gap:4px 12px;padding:12px 0;border-bottom:1px solid var(--rule);align-items:baseline}
.layerlist .n{font-family:var(--font-pixel);font-size:16px;color:var(--violet)}
.layerlist .nm{font-weight:700;color:var(--ink)}
.layerlist .ct{font-family:var(--font-mono);font-size:14px;color:var(--muted);white-space:nowrap}
.layerlist .sm{grid-column:2 / 4;font-size:15px;color:var(--muted)}
.twocol{display:grid;grid-template-columns:1fr 1fr;gap:calc(var(--u)*6)}
dl.gets{margin:0;border-top:var(--b) solid var(--ink)}
dl.gets div{display:grid;grid-template-columns:150px 1fr;gap:12px;padding:12px 0;border-bottom:1px solid var(--rule)}
dl.gets dt{font-family:var(--font-pixel);font-size:16px;color:var(--ink)}
dl.gets dd{margin:0}
.weights{list-style:none;margin:0;padding:0;border-top:var(--b) solid var(--ink)}
.weights li{display:grid;grid-template-columns:120px 1fr;gap:12px;padding:12px 0;border-bottom:1px solid var(--rule);align-items:baseline}
.weights li .std{justify-self:start}
.term{background:var(--ink);color:var(--cream);border:var(--b) solid var(--ink);box-shadow:8px 8px 0 var(--mint);padding:calc(var(--u)*3)}
.term h2{color:var(--paper)}
.term h2.sh::before{background:var(--mint)}
.term p{color:var(--cream)}
.term a{color:var(--mint);text-decoration-color:var(--mint)}
.term a:hover{color:var(--paper)}
.term :focus-visible{outline-color:var(--mint)}
.term pre{background:var(--ink-deep);border-color:var(--plum);margin:0 0 calc(var(--u)*2);white-space:pre-wrap;overflow-wrap:anywhere}
.term .prompt{color:var(--mint)}
.term .dim{color:var(--lavender)}
.links{display:flex;flex-wrap:wrap;gap:8px 24px;list-style:none;margin:0;padding:0}

/* status chips: colour, a distinct pixel glyph and a text label */
.st{display:inline-flex;align-items:center;gap:6px;font:700 13px/1 var(--font-body);text-transform:uppercase;letter-spacing:.04em;padding:4px 8px 4px 6px;border:var(--b) solid var(--ink);color:var(--ink);background:var(--rule-soft);white-space:nowrap}
.st-pass{background:var(--pass-fill)}
.st-fail{background:var(--fail-fill)}
.st-warn{background:var(--warn-fill)}
.st-info{background:var(--info-fill)}
.st-error{background:var(--error-fill);color:#fff}
.st-neutral{background:var(--rule-soft)}
.st-skipped{background:var(--panel);border-style:dashed}

/* report: header, score console, level ladder */
.rhead h1{overflow-wrap:anywhere}
.console{display:grid;grid-template-columns:minmax(0,6fr) minmax(0,6fr);background:var(--ink);color:var(--cream);border:var(--b) solid var(--ink);box-shadow:8px 8px 0 var(--violet);margin-top:calc(var(--u)*4)}
.console > div{padding:calc(var(--u)*3)}
.console > div + div{border-left:var(--b) solid var(--plum)}
.console h2{color:var(--paper);font-size:16px;margin-bottom:calc(var(--u)*2)}
.console p{color:var(--cream)}
.console a{color:var(--mint);text-decoration-color:var(--mint)}
.console a:hover{color:var(--paper)}
.console :focus-visible{outline-color:var(--mint)}
.console h1{color:var(--paper);font-size:28px;margin-bottom:var(--u)}
.console h1 .host{color:var(--mint)}
.console .small,.readout .small,.term .small{color:var(--lavender)}
.console code{background:var(--plum);color:var(--paper)}
.score{display:flex;align-items:flex-end;gap:12px;font-family:var(--font-pixel);line-height:.8;margin-bottom:calc(var(--u)*2)}
.score .num{font-size:96px;font-weight:700}
.score .of{font-size:24px;color:var(--lavender);padding-bottom:6px}
.band-good{color:var(--mint)}.band-ok{color:var(--mint)}.band-mid{color:var(--olive)}.band-bad{color:var(--pink)}.band-na{color:var(--lavender)}
.grade{font-family:var(--font-pixel);font-size:24px;color:var(--paper);margin-bottom:calc(var(--u)*2)}
.meter{display:grid;grid-template-columns:repeat(20,1fr);gap:3px;height:20px;margin-bottom:calc(var(--u)*3);max-width:420px}
.meter span{background:var(--plum)}
.meter.band-good span.on,.meter.band-ok span.on{background:var(--mint)}
.meter.band-mid span.on{background:var(--olive)}
.meter.band-bad span.on{background:var(--pink)}
.tally{list-style:none;margin:0 0 calc(var(--u)*2);padding:0;display:flex;flex-wrap:wrap;gap:8px}
.tally li{display:inline-flex;align-items:center;gap:8px;font-size:15px;color:var(--cream)}
.tally .st{border-color:var(--paper)}
.ladder{list-style:none;margin:0 0 calc(var(--u)*3);padding:0;display:grid;grid-template-columns:repeat(6,1fr);gap:6px;align-items:end}
.ladder li{display:flex;flex-direction:column;gap:6px;font-size:13px;line-height:1.25;color:var(--lavender)}
.ladder .bar{display:flex;align-items:flex-start;justify-content:center;padding-top:6px;border:var(--b) dashed var(--lavender);font-family:var(--font-pixel);font-size:16px;color:var(--lavender)}
.ladder .s0 .bar{height:32px}.ladder .s1 .bar{height:48px}.ladder .s2 .bar{height:64px}.ladder .s3 .bar{height:80px}.ladder .s4 .bar{height:96px}.ladder .s5 .bar{height:112px}
.ladder .done .bar{background:var(--lavender);border:var(--b) solid var(--lavender);color:var(--ink)}
.ladder .cur .bar{background:var(--mint);border:var(--b) solid var(--paper);color:var(--ink);box-shadow:0 0 0 2px var(--mint)}
.ladder .done,.ladder .cur{color:var(--paper)}
.ladder .cur .ln{font-weight:700}
.next{border-top:1px solid var(--plum);padding-top:calc(var(--u)*2)}
.next ul{margin:var(--u) 0 0;padding:0;list-style:none}
.next li{padding-left:20px;position:relative;margin-bottom:4px}
.next li::before{content:"";position:absolute;left:0;top:.55em;width:8px;height:8px;background:var(--pink)}

/* report sections */
.band{margin-top:calc(var(--u)*8)}
.layers{list-style:none;margin:0;padding:0;columns:2;column-gap:calc(var(--u)*6);border-top:var(--b) solid var(--ink)}
.layers li{break-inside:avoid;display:grid;grid-template-columns:1fr auto 44px;gap:12px;align-items:center;padding:10px 0;border-bottom:1px solid var(--rule)}
.layers li a{font-weight:700}
.layers .val{font-family:var(--font-pixel);font-size:16px;text-align:right;color:var(--ink)}
.layers .na .val{color:var(--muted);font-family:var(--font-body);font-size:14px}
.mini{display:grid;grid-template-columns:repeat(10,10px);gap:2px;height:14px}
.mini span{background:var(--rule-soft);border:1px solid var(--rule)}
.mini.band-good span.on,.mini.band-ok span.on{background:var(--green);border-color:var(--green)}
.mini.band-mid span.on{background:var(--olive-text);border-color:var(--olive-text)}
.mini.band-bad span.on{background:var(--pink-text);border-color:var(--pink-text)}
.mini.band-na span{background:transparent;border-style:dashed}
.tables{display:grid;grid-template-columns:minmax(0,7fr) minmax(0,5fr);gap:calc(var(--u)*6);align-items:start}
.tablewrap{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:15px;background:var(--panel);border:var(--b) solid var(--ink)}
th,td{text-align:left;padding:8px 12px;border-bottom:1px solid var(--rule);vertical-align:top}
thead th{font-family:var(--font-pixel);font-weight:400;font-size:14px;background:var(--ink);color:var(--paper);border-bottom:0}
tbody th{font-weight:400;overflow-wrap:break-word}
.lhscore{font-family:var(--font-pixel);font-size:32px;color:var(--ink);margin-bottom:4px}
td.num{font-family:var(--font-mono);text-align:right}

/* findings */
.toolbar{display:flex;flex-wrap:wrap;gap:calc(var(--u)*2) calc(var(--u)*4);align-items:flex-end;justify-content:space-between;background:var(--panel);border:var(--b) solid var(--ink);padding:calc(var(--u)*2);margin-bottom:calc(var(--u)*3)}
form.filters{display:flex;flex-wrap:wrap;gap:calc(var(--u)*2) calc(var(--u)*3);align-items:flex-end;flex:1 1 560px}
form.filters .frow{display:flex;flex-direction:column;gap:4px}
form.filters .frow label,form.filters legend{font-family:var(--font-pixel);font-size:14px;color:var(--ink)}
form.filters fieldset{border:0;margin:0;padding:0;min-width:0}
form.filters fieldset label.check{margin:0 16px 6px 0;min-height:24px}
form.filters legend{padding:0;margin-bottom:6px}
form.filters button{box-shadow:none;min-height:44px}
details.legend,details.allprompts{margin:0 0 calc(var(--u)*3)}
details > summary{cursor:pointer}
details.legend > summary,details.allprompts > summary{font-weight:700;color:var(--ink)}
details.legend ul{list-style:none;padding:0;margin:var(--u) 0}
details.legend li{margin-bottom:6px}
.layersec{margin-top:calc(var(--u)*6)}
.layersec > header{display:flex;align-items:center;gap:calc(var(--u)*2);flex-wrap:wrap;border-bottom:var(--b) solid var(--ink);padding-bottom:var(--u);margin-bottom:var(--u)}
.layersec h3{font-size:20px;flex:1 1 auto}
.layersec .lscore{font-family:var(--font-pixel);font-size:16px;color:var(--ink)}
.layersec > p.small{margin:0 0 calc(var(--u)*2)}
details.finding{background:var(--panel);border:var(--b) solid var(--ink);margin-bottom:var(--u)}
details.finding > summary{list-style:none;display:grid;grid-template-columns:152px minmax(0,1fr) 20px;gap:4px 16px;align-items:start;padding:12px 16px}
details.finding > summary::-webkit-details-marker{display:none}
details.finding > summary::after{content:"";grid-column:3;grid-row:1;width:12px;height:12px;margin-top:5px;border-right:var(--b) solid var(--ink);border-bottom:var(--b) solid var(--ink);transform:rotate(45deg) translate(-3px,-3px)}
details.finding[open] > summary::after{transform:rotate(225deg) translate(-3px,-3px)}
details.finding > summary:hover{background:var(--paper)}
.sumline{display:contents}
.sumline .st{grid-column:1;grid-row:1 / 3;justify-self:stretch;align-self:start}
.sumline .title{grid-column:2;grid-row:1;font-weight:700;color:var(--ink)}
details.finding .msg{grid-column:2;grid-row:2;color:var(--muted);font-size:15px;overflow-wrap:anywhere}
details.finding .body{padding:4px 16px 16px 184px;border-top:1px solid var(--rule-soft)}
details.finding .body > * + *{margin-top:12px}
.meta{font-size:14px;color:var(--muted)}
.std{display:inline-block;font:700 12px/1 var(--font-body);text-transform:uppercase;letter-spacing:.04em;padding:3px 6px;border:var(--b) solid var(--ink);color:var(--ink);background:var(--panel)}
.std-standard{background:var(--mint)}.std-guidance{background:var(--lavender)}.std-draft{background:var(--olive)}.std-proposal,.std-convention{background:var(--rule-soft);border-style:dashed}
.heur{border-bottom:2px dotted var(--muted)}
.fix{background:var(--cream);border:var(--b) solid var(--ink);padding:calc(var(--u)*2)}
.fix.todo{box-shadow:4px 4px 0 var(--ink)}
.copyable{margin-top:12px}
.copyhead{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:4px}
button.copy{min-height:32px;font-size:13px;padding:0 10px;box-shadow:none;background:var(--panel);color:var(--ink)}
button.copy:hover{background:var(--ink);color:var(--paper)}
.copyable pre{max-height:360px;white-space:pre-wrap;overflow-wrap:anywhere}
.evidence ul{margin:0;padding-left:20px;font-size:15px}
.evidence li{margin-bottom:4px;overflow-wrap:anywhere}
details.sub{margin-top:8px}
details.sub > summary{font-size:14px;color:var(--ink);overflow-wrap:anywhere}
pre.ev{font-size:13px;max-height:420px;white-space:pre-wrap;overflow-wrap:anywhere;margin-top:6px}
.exchange .small{margin:8px 0 4px}
.nomatch{padding:8px 0}
.compat .st{vertical-align:middle}
.allprompts pre{max-height:480px;white-space:pre-wrap}
.requests details.sub{border-bottom:1px solid var(--rule);padding:6px 0;margin:0}
.share .badge{margin:calc(var(--u)*2) 0}
.live{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);margin:0;background:var(--ink);color:var(--paper);font-family:var(--font-mono);font-size:14px;padding:8px 14px;border:var(--b) solid var(--mint)}
.live:empty{display:none}

/* docs, checks, privacy, terms, errors (bodies built in server/app.mjs: h1, p.lead, div.prose) */
main > h1{font-size:40px;margin-bottom:calc(var(--u)*2);display:flex;align-items:center;gap:16px;overflow-wrap:anywhere}
main > h1::before{content:"";width:16px;height:16px;background:var(--pink);flex:none}
main > p.lead{max-width:44em;color:var(--muted);border-bottom:var(--b) solid var(--ink);padding-bottom:calc(var(--u)*3);margin-bottom:calc(var(--u)*4)}
.page-head{margin-bottom:calc(var(--u)*5)}
.page-head h1{font-size:40px;margin-bottom:calc(var(--u)*2)}
.prose{max-width:78ch}
.prose h2{font-size:24px;margin:calc(var(--u)*6) 0 calc(var(--u)*2);display:flex;align-items:center;gap:12px}
.prose h2::before{content:"";width:12px;height:12px;background:var(--violet);flex:none}
.prose h3{font-size:18px;margin:calc(var(--u)*4) 0 var(--u)}
.prose ul,.prose ol{padding-left:24px;margin:0 0 calc(var(--u)*2)}
.prose li{margin-bottom:4px}
.prose pre{margin:0 0 calc(var(--u)*2)}
.prose table{margin:0 0 calc(var(--u)*3);display:block;overflow-x:auto}
.errorbox{border:var(--b) solid var(--ink);background:var(--panel);box-shadow:8px 8px 0 var(--pink);padding:calc(var(--u)*4);max-width:760px}
.errorbox .code{font-family:var(--font-pixel);font-size:16px;color:var(--pink-text);margin-bottom:var(--u)}

/* footer */
footer.site{background:var(--ink);color:var(--cream);margin-top:0}
footer.site .wrap{padding-top:calc(var(--u)*4);padding-bottom:calc(var(--u)*4);display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:calc(var(--u)*4)}
footer.site p{font-size:15px;margin:0 0 var(--u)}
footer.site .fname{font-family:var(--font-pixel);font-size:16px;color:var(--paper)}
footer.site a{color:var(--mint);text-decoration-color:var(--mint)}
footer.site a:hover{color:var(--paper)}
footer.site :focus-visible{outline-color:var(--mint)}
footer.site ul{list-style:none;margin:0;padding:0;font-size:15px}
footer.site li{margin-bottom:4px}

/* small screens */
@media (max-width:900px){
  .intro,.twocol,.tables,.console{grid-template-columns:minmax(0,1fr)}
  .console > div + div{border-left:0;border-top:var(--b) solid var(--plum)}
  .layers,.layerlist{columns:1;grid-template-columns:1fr}
  footer.site .wrap{grid-template-columns:1fr}
}
@media (max-width:640px){
  body{font-size:16px}
  .wrap,main,header.site{padding-left:calc(var(--u)*2);padding-right:calc(var(--u)*2)}
  main{padding-top:calc(var(--u)*4)}
  h1{font-size:32px}
  main > h1{font-size:28px}
  .console h1{font-size:22px}
  h2{font-size:20px}
  .lead{font-size:18px}
  header.site nav a{font-size:14px;padding:4px 8px}
  form.scan{padding:calc(var(--u)*2);box-shadow:6px 6px 0 var(--violet)}
  form.scan .row{flex-direction:column}
  form.scan .row button{width:100%}
  form.scan.compact{grid-template-columns:1fr}
  form.scan.compact label.check,form.scan.compact .status{grid-column:1}
  .console{box-shadow:6px 6px 0 var(--violet)}
  .console > div{padding:calc(var(--u)*2)}
  .score .num{font-size:72px}
  .ladder{grid-template-columns:1fr;gap:4px}
  .ladder li{flex-direction:row;align-items:center;gap:12px}
  .ladder .bar{height:28px!important;padding:0 0 0 8px;justify-content:flex-start;align-items:center;flex:none}
  .ladder .s0 .bar{width:56px}.ladder .s1 .bar{width:76px}.ladder .s2 .bar{width:96px}.ladder .s3 .bar{width:116px}.ladder .s4 .bar{width:136px}.ladder .s5 .bar{width:156px}
  .ladder li .ln{flex:1}
  dl.gets div,.weights li{grid-template-columns:1fr;gap:4px}
  details.finding > summary{grid-template-columns:minmax(0,1fr) 20px;padding:12px}
  .sumline .st{grid-column:1;grid-row:1}
  .sumline .title{grid-column:1;grid-row:2}
  details.finding .msg{grid-column:1;grid-row:3}
  details.finding > summary::after{grid-column:2;grid-row:1}
  details.finding .body{padding:4px 12px 12px}
  .layers li{grid-template-columns:1fr auto 40px}
  .sumline .st{justify-self:start}
  table{font-size:14px}
  th,td{padding:8px}
  td .st{white-space:normal;font-size:11px;padding:3px 5px}
  .toolbar{padding:12px}
  .actions,.actions .btn{width:100%}
  .actions .btn{font-size:14px;padding:8px 12px;text-align:center}
  .term{box-shadow:6px 6px 0 var(--mint);padding:calc(var(--u)*2)}
}
@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}
  button:active,.btn:active{transform:none}
}
@media print{
  .colorbar,form.scan,.toolbar,button.copy,.skip{display:none}
  body{background:#fff}
  .console,.term,pre{box-shadow:none}
}
`;

export const APP_JS = "// Agent-Ready Check client script: progressive enhancement only (every page works without it).\n// - scan forms: fetch POST /api/scan with a progress state, then open the stored report; agents that invoke the\n//   declarative scan_site form get the summary as data through SubmitEvent.respondWith().\n// - WebMCP: imperative scan_site (only where no form declares it: the form wins, as in the book's chapter 9) and\n//   get_report_findings on report pages.\n// - copy buttons, \"copy all fix prompts\", live filters.\nconst mc = document.modelContext || navigator.modelContext;\nconst live = (el, text) => { if (el) el.textContent = text; };\n\nfunction summarize(report) {\n  const todo = (report.checks || []).filter((c) => c.status === 'fail' || c.status === 'warn')\n    .sort((a, b) => (a.status === b.status ? (b.weight || 0) - (a.weight || 0) : a.status === 'fail' ? -1 : 1));\n  return {\n    url: report.final_url || report.url, score: report.score,\n    level: report.compat?.isitagentready?.level, level_name: report.compat?.isitagentready?.level_name,\n    lighthouse_agentic: report.compat?.lighthouse_agentic?.score ?? null,\n    layers: (report.layers || []).map((l) => ({ id: l.id, score: l.applicable ? l.score : null })),\n    top_fixes: todo.slice(0, 10).map((c) => ({ id: c.id, status: c.status, message: c.message, fix: c.fix?.prompt || null })),\n    report_url: report.report_url || (report.id ? `${location.origin}/r/${encodeURIComponent(report.id)}` : null),\n  };\n}\n\nasync function apiScan(url, browser) {\n  const res = await fetch('/api/scan', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ url, browser: !!browser }) });\n  const body = await res.json().catch(() => null);\n  if (!res.ok) throw Object.assign(new Error(body?.detail || body?.title || `HTTP ${res.status}`), { status: res.status, body });\n  return body;\n}\n\nfor (const form of document.querySelectorAll('form.scan')) {\n  const status = form.querySelector('.status');\n  const button = form.querySelector('button[type=submit]');\n  form.addEventListener('submit', (event) => {\n    const url = form.elements.url.value.trim();\n    const browser = form.elements.browser?.checked;\n    if (!url || !window.fetch) return; // native GET submit\n    event.preventDefault();\n    const started = Date.now();\n    button.disabled = true;\n    live(status, 'Scanning\u2026 this usually takes 5 to 30 seconds.');\n    const tick = setInterval(() => live(status, `Scanning\u2026 ${Math.round((Date.now() - started) / 1000)} s`), 1000);\n    const job = apiScan(url, browser);\n    if (event.agentInvoked && typeof event.respondWith === 'function') {\n      event.respondWith(job.then(summarize)); // the agent gets data; the person sees a link\n      job.then((r) => { const s = summarize(r); status.innerHTML = ''; status.append(`Score ${s.score}/100, Level ${s.level}. `); if (s.report_url) { const a = document.createElement('a'); a.href = s.report_url; a.textContent = 'Open the report'; status.append(a); } })\n        .catch((e) => live(status, `The scan failed: ${e.message}`)).finally(() => { clearInterval(tick); button.disabled = false; });\n      return;\n    }\n    job.then((r) => {\n      const s = summarize(r);\n      if (s.report_url) location.assign(s.report_url); else form.submit();\n    }).catch((e) => {\n      clearInterval(tick); button.disabled = false;\n      if (e.status && e.status < 500) live(status, `Could not scan: ${e.message}`); else form.submit(); // let the server render it\n    });\n  });\n}\n\n// WebMCP imperative tools.\nif (mc && typeof mc.registerTool === 'function') {\n  const declared = new Set([...document.querySelectorAll('form[toolname]')].map((f) => f.getAttribute('toolname')));\n  const tools = [];\n  if (!declared.has('scan_site')) {\n    tools.push({\n      name: 'scan_site',\n      description: 'Scan a website for agent-readiness: 113 checks in 13 layers. Returns the score, the isitagentready-compatible level, layer scores and the top fixes with fix prompts. Use when asked how agent-ready a site is.',\n      inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'Site or page to scan, like example.com or https://example.com/page. Public addresses only.' }, browser: { type: 'boolean', description: 'Also run browser checks (slower), when the service offers them.' } }, required: ['url'] },\n      annotations: { readOnlyHint: true, untrustedContentHint: true },\n      async execute({ url, browser }) { return JSON.stringify(summarize(await apiScan(url, browser))); },\n    });\n  }\n  if (document.getElementById('findings')) {\n    tools.push({\n      name: 'get_report_findings',\n      description: 'List the findings of the report on this page, optionally only one status (fail, warn, pass) or one layer. Returns check ids, status, message and the fix prompt.',\n      inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['fail', 'warn', 'pass', 'info', 'neutral', 'skipped', 'error'], description: 'Only findings with this status' }, layer: { type: 'string', description: 'Only this layer id, for example webmcp or crawl' } } },\n      annotations: { readOnlyHint: true, untrustedContentHint: true },\n      async execute({ status, layer } = {}) {\n        const out = [...document.querySelectorAll('details.finding')].map((d) => ({\n          id: d.id.replace(/^check-/, ''), status: d.dataset.status, layer: d.closest('section.layersec')?.id.replace(/^layer-/, ''),\n          message: d.querySelector('summary .msg')?.textContent || '', fix: d.querySelector('.copyable.prompt pre')?.textContent || null,\n        })).filter((f) => (!status || f.status === status) && (!layer || f.layer === layer));\n        return JSON.stringify({ count: out.length, findings: out.slice(0, 100) });\n      },\n    });\n  }\n  (async () => {\n    const controller = new AbortController();\n    try { for (const t of tools) await mc.registerTool(t, { signal: controller.signal }); } catch (e) { controller.abort(); console.warn('WebMCP tools not registered:', e); }\n  })();\n}\n\n// Copy buttons.\nconst note = document.getElementById('live');\nasync function copyText(text, el) {\n  try { await navigator.clipboard.writeText(text); live(note, 'Copied to the clipboard.'); if (el) { const t = el.textContent; el.textContent = 'Copied'; setTimeout(() => { el.textContent = t; }, 1500); } return true; } catch { live(note, 'Copy failed: select the text and copy it by hand.'); return false; }\n}\nfor (const b of document.querySelectorAll('button.copy[data-copy]')) {\n  b.hidden = false;\n  b.addEventListener('click', () => copyText(document.getElementById(b.dataset.copy)?.textContent || '', b));\n}\nfor (const a of document.querySelectorAll('[data-copy-all]')) {\n  a.addEventListener('click', (e) => {\n    const src = document.getElementById(a.dataset.copyAll);\n    if (!src || !navigator.clipboard) return;\n    e.preventDefault();\n    copyText(src.textContent, a);\n  });\n}\n\n// Live filters (the form also works as a plain GET form).\nconst filters = document.getElementById('filters');\nfunction applyFilters() {\n  const role = filters.elements.role.value;\n  const st = [...filters.querySelectorAll('input[name=status]:checked')].map((i) => i.value);\n  for (const d of document.querySelectorAll('details.finding')) {\n    const okRole = role === 'all' || d.dataset.roles.split(' ').includes(role);\n    const okSt = !st.length || st.includes(d.dataset.status);\n    d.hidden = !(okRole && okSt);\n  }\n  for (const s of document.querySelectorAll('section.layersec')) {\n    const any = s.querySelector('details.finding:not([hidden])');\n    s.querySelector('.nomatch').hidden = !!any;\n  }\n  const q = new URLSearchParams(location.search);\n  q.delete('role'); q.delete('status');\n  if (role !== 'all') q.set('role', role);\n  for (const v of st) q.append('status', v);\n  history.replaceState(null, '', `${location.pathname}${q.toString() ? `?${q}` : ''}#findings`);\n  return { role, status: st, visible: document.querySelectorAll('details.finding:not([hidden])').length };\n}\nif (filters) {\n  filters.addEventListener('change', applyFilters);\n  filters.addEventListener('submit', (e) => {\n    e.preventDefault();\n    const r = applyFilters();\n    if (e.agentInvoked && typeof e.respondWith === 'function') e.respondWith(Promise.resolve(r));\n  });\n}\n";

export const FAVICON_SVG = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 10 10\" shape-rendering=\"crispEdges\"><rect width=\"10\" height=\"10\" fill=\"#1e162b\"/><path d=\"M8 1h1v1h-1zM7 2h2v1h-2zM6 3h2v1h-2zM1 4h1v1h-1zM5 4h2v1h-2zM1 5h2v1h-2zM4 5h2v1h-2zM2 6h3v1h-3zM3 7h1v1h-1z\" fill=\"#5fed83\"/></svg>";

export const ASSETS = {
  '/assets/app.css': { type: 'text/css; charset=utf-8', body: APP_CSS },
  '/assets/app.js': { type: 'text/javascript; charset=utf-8', body: APP_JS },
  '/assets/favicon.svg': { type: 'image/svg+xml', body: FAVICON_SVG },
  '/assets/fonts/silkscreen-400.woff2': { type: 'font/woff2', body: SILKSCREEN_400, encoding: 'base64' },
  '/assets/fonts/silkscreen-700.woff2': { type: 'font/woff2', body: SILKSCREEN_700, encoding: 'base64' },
};
