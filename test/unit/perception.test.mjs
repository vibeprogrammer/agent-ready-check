import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockSite, html, json } from '../helpers/mock-site.mjs';

const run = (body, id, extra = {}) => mockSite({ '/': html(body) }, extra).run(id);
const page = (inner, { lang = 'en', title = 'Fjellro cabin | Nordlys Cabins' } = {}) => `<!doctype html><html${lang ? ` lang="${lang}"` : ''}><head><title>${title}</title></head><body>${inner}</body></html>`;
const LONG = 'Fjellro is a two-bedroom cabin with a wood-fired sauna, sleeping six guests, two hours from Oslo by car. '.repeat(4);

test('non-HTML pages are neutral', async () => {
  assert.equal((await mockSite({ '/': json({ a: 1 }) }).run('perception.title')).status, 'neutral');
});

test('html-lang', async () => {
  assert.equal((await run(page('<p>x</p>'), 'perception.html-lang')).status, 'pass');
  assert.equal((await run(page('<p>x</p>', { lang: 'nb-NO' }), 'perception.html-lang')).status, 'pass');
  assert.equal((await run(page('<p>x</p>', { lang: '' }), 'perception.html-lang')).status, 'fail');
  assert.equal((await run(page('<p>x</p>', { lang: 'english language' }), 'perception.html-lang')).status, 'warn');
});

test('title', async () => {
  assert.equal((await run(page('<p>x</p>'), 'perception.title')).status, 'pass');
  assert.equal((await run(page('<p>x</p>', { title: '' }), 'perception.title')).status, 'fail');
  assert.equal((await run(page('<p>x</p>', { title: 'React App' }), 'perception.title')).status, 'warn');
  assert.equal((await run(page('<p>x</p>', { title: 'x'.repeat(90) }), 'perception.title')).status, 'warn');
});

test('landmarks', async () => {
  assert.equal((await run(page('<header>h</header><nav>n</nav><main>m</main><footer>f</footer>'), 'perception.landmarks')).status, 'pass');
  assert.equal((await run(page('<div>no main</div><nav>n</nav>'), 'perception.landmarks')).status, 'fail');
  assert.equal((await run(page('<main>a</main><main>b</main><footer>f</footer>'), 'perception.landmarks')).status, 'warn');
  assert.equal((await run(page('<div role="main">a</div>'), 'perception.landmarks')).status, 'warn');
});

test('headings', async () => {
  assert.equal((await run(page('<h1>A</h1><h2>B</h2><h3>C</h3><h2>D</h2>'), 'perception.headings')).status, 'pass');
  assert.equal((await run(page('<h2>B</h2>'), 'perception.headings')).status, 'fail');
  assert.equal((await run(page('<h1>A</h1><h1>B</h1>'), 'perception.headings')).status, 'warn');
  const r = await run(page('<h1>A</h1><h4>Skip</h4>'), 'perception.headings');
  assert.equal(r.status, 'warn'); assert.match(r.message, /h1 -> h4/);
});

test('form-labels', async () => {
  assert.equal((await run(page('<form><label for="a">Name</label><input id="a"><label>Email <input type="email"></label><input type="hidden" name="t"><select aria-label="Guests"></select></form>'), 'perception.form-labels')).status, 'pass');
  assert.equal((await run(page('<form><input name="q"></form>'), 'perception.form-labels')).status, 'fail');
  assert.equal((await run(page('<form><input name="q" placeholder="Search"></form>'), 'perception.form-labels')).status, 'warn');
  assert.equal((await run(page('<p>no form</p>'), 'perception.form-labels')).status, 'neutral');
});

test('control-names', async () => {
  assert.equal((await run(page('<a href="/a">About</a><button>Book</button><button aria-label="Close"><svg></svg></button>'), 'perception.control-names')).status, 'pass');
  const r = await run(page('<a href="/a">About</a><button><svg></svg></button>'), 'perception.control-names');
  assert.equal(r.status, 'fail'); assert.equal(r.details.unnamed.length, 1);
  assert.equal((await run(page('<a href="/x"><img src="a.png" alt="Home"></a>'), 'perception.control-names')).status, 'pass');
});

test('click-divs: static handlers fail; browser-only clickables warn; clean passes', async () => {
  assert.equal((await run(page('<div onclick="go()">Book</div>'), 'perception.click-divs')).status, 'fail');
  assert.equal((await run(page('<div role="button" tabindex="0" onclick="go()">Book</div>'), 'perception.click-divs')).status, 'pass');
  const bd = { ok: true, clickables: [{ selector: 'div.card', tag: 'div', role: null, focusable: false, hasHref: false }] };
  assert.equal((await run(page('<div class="card">x</div>'), 'perception.click-divs', { browserData: bd })).status, 'warn');
  assert.equal((await run(page('<button>x</button>'), 'perception.click-divs')).status, 'pass');
});

test('img-alt', async () => {
  assert.equal((await run(page('<img src="a.png" alt="Cabin"><img src="d.svg" alt="">'), 'perception.img-alt')).status, 'pass');
  assert.equal((await run(page('<img src="a.png"><img src="b.png">'), 'perception.img-alt')).status, 'fail');
  assert.equal((await run(page('<img src="a.png"><img src="b.png" alt="x"><img src="c.png" alt="y">'), 'perception.img-alt')).status, 'warn');
  assert.equal((await run(page('<p>none</p>'), 'perception.img-alt')).status, 'neutral');
});

test('native-forms', async () => {
  assert.equal((await run(page('<form action="/s" method="get"><input name="q" aria-label="q"><button>Go</button></form>'), 'perception.native-forms')).status, 'pass');
  assert.equal((await run(page('<input name="q" aria-label="q"><div onclick="s()">Go</div>'), 'perception.native-forms')).status, 'fail');
  assert.equal((await run(page('<form id="f"><input name="q" aria-label="q"></form>'), 'perception.native-forms')).status, 'warn');
  assert.equal((await run(page('<p>x</p>'), 'perception.native-forms')).status, 'neutral');
});

test('server-html: empty SPA shell fails, real content passes, browser ratio warns', async () => {
  assert.equal((await run(page('<div id="root"></div><script src="/assets/app.js"></script>'), 'perception.server-html')).status, 'fail');
  assert.equal((await run(page(`<main><h1>Fjellro</h1><p>${LONG}</p></main>`), 'perception.server-html')).status, 'pass');
  const bd = { ok: true, renderedText: LONG.repeat(3) };
  assert.equal((await run(page(`<main><p>${LONG}</p></main>`), 'perception.server-html', { browserData: bd })).status, 'warn');
  assert.equal((await run(page('<p>Short page.</p>'), 'perception.server-html')).status, 'info');
});
