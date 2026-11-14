#!/usr/bin/env node
/* Wasl smoke test: opens every page on a small phone (375x667) and a normal one (390x844), with the server
   mocked (no request leaves this machine), and checks what CLAUDE.md asks for before a commit:
   - no JS errors in the console
   - no sideways scrolling
   - every button / link is at least 48px tall (checkboxes inside a tappable label are fine)
   - the emergency button is fully visible on the home screen
   - the offline demo works: the four-scene list in the app, and the counter scene (counter.html?demo) with its errand summary
   - document cards (docs.js): «هات البطاقة» shows the ID drawing on the translation screen
   Run from the repo root:   node tests/smoke.js
   Needs Playwright with Chromium (npm i -g playwright && npx playwright install chromium). */
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.csv': 'text/csv', '.txt': 'text/plain', '.xml': 'application/xml' };
const PAGES = ['index.html', 'index.html?go=sos', 'index.html?go=order', 'index.html?go=free', 'counter.html?demo',
  'join.html', 'feedback.html', 'privacy.html', 'record.html', 'review.html', 'sponsor.html', 'site/index.html'];
const PHONES = [{ width: 375, height: 667 }, { width: 390, height: 844 }];
const MOCK = { ok: true, left: 3, limit: 30, t: 'test' };

let failures = 0;
const fail = (where, what) => { failures++; console.log(`  ✗ ${where}: ${what}`); };
const pass = (where, what) => console.log(`  ✓ ${where}: ${what}`);

function serve() {
  return new Promise(res => {
    const srv = http.createServer((req, rsp) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p.endsWith('/')) p += 'index.html';
      const f = path.join(ROOT, p);
      if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { rsp.writeHead(404); rsp.end(); return; }
      rsp.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
      fs.createReadStream(f).pipe(rsp);
    });
    srv.listen(0, '127.0.0.1', () => res(srv));
  });
}

async function newPage(browser, viewport, base) {
  const ctx = await browser.newContext({ viewport, locale: 'ar-EG', serviceWorkers: 'block' });
  const page = await ctx.newPage();
  page.errs = [];
  page.on('pageerror', e => page.errs.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/net::|ERR_FAILED|Failed to load resource/.test(m.text())) page.errs.push(m.text()); });
  await page.route('**/*', r => {
    const u = r.request().url();
    if (u.startsWith(base)) return r.continue();
    if (/api\.nrg-egypt\.com/.test(u)) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK) });
    return r.abort(); // fonts, CDNs: nothing leaves this machine
  });
  return { ctx, page };
}

// first run: the welcome card asks how the user likes the app; pick one so the home screen shows
async function pastWelcome(page, choice) {
  const b = page.getByText(choice === 'pics' ? 'بفضّل الصور' : 'بقرا كويس');
  if (await b.first().isVisible().catch(() => false)) { await b.first().click(); await page.waitForTimeout(400); } // ?go=sos skips the welcome on purpose
}

(async () => {
  const srv = await serve();
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch();

  for (const vp of PHONES) {
    const tag = `${vp.width}x${vp.height}`;
    console.log(`\n== ${tag}`);
    for (const pg of PAGES) {
      const where = `${tag} ${pg}`;
      const { ctx, page } = await newPage(browser, vp, base);
      try {
        await page.goto(base + pg, { waitUntil: 'load', timeout: 20000 });
        await page.waitForTimeout(1200);
        if (pg.startsWith('index')) await pastWelcome(page, 'text');
        const r = await page.evaluate(() => ({
          hscroll: document.documentElement.scrollWidth - innerWidth,
          dir: document.documentElement.dir,
          small: [...document.querySelectorAll('button,a,select,summary')].filter(e => {
            const b = e.getBoundingClientRect(), cs = getComputedStyle(e);
            return b.width > 0 && b.height > 0 && cs.visibility !== 'hidden' && b.height < 48 && b.bottom > 0 && b.top < innerHeight;
          }).map(e => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''} "${(e.innerText || e.getAttribute('aria-label') || '').trim().slice(0, 20)}" ${Math.round(e.getBoundingClientRect().height)}px`)
        }));
        if (page.errs.length) fail(where, 'console errors: ' + [...new Set(page.errs)].join(' | ').slice(0, 300));
        if (r.hscroll > 0) fail(where, `scrolls sideways by ${r.hscroll}px`);
        if (r.dir !== 'rtl') fail(where, `dir is "${r.dir}", expected rtl`);
        if (r.small.length) fail(where, 'tap targets under 48px: ' + r.small.join(', '));
        if (!page.errs.length && r.hscroll <= 0 && r.dir === 'rtl' && !r.small.length) pass(where, 'ok');
      } catch (e) { fail(where, e.message.split('\n')[0]); }
      await ctx.close();
    }

    // emergency button fully visible above the bottom bar, in both home modes
    for (const mode of ['text', 'pics']) {
      const where = `${tag} home (${mode})`;
      const { ctx, page } = await newPage(browser, vp, base);
      await page.goto(base + 'index.html'); await page.waitForTimeout(600); await pastWelcome(page, mode);
      const ok = await page.evaluate(() => { const s = document.getElementById('sosBtn').getBoundingClientRect(), n = document.querySelector('.hnav').getBoundingClientRect(); return s.top >= 0 && s.bottom <= n.top + 1 && s.height >= 48; });
      ok ? pass(where, 'emergency button visible') : fail(where, 'emergency button hidden or cut off');
      await ctx.close();
    }
  }

  // demo: the four-scene list, and the counter scene, with every outside request blocked
  console.log('\n== demo (375x667, offline)');
  {
    const { ctx, page } = await newPage(browser, PHONES[0], base);
    await page.unroute('**/*');
    await page.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.abort());
    await page.goto(base + 'index.html?demo'); await page.waitForTimeout(600); await pastWelcome(page, 'pics');
    await page.click('#demoFab'); await page.waitForTimeout(300);
    const n = await page.locator('#dmOpts button').count();
    n === 4 ? pass('demo list', '4 scenes') : fail('demo list', `${n} scenes, expected 4`);
    for (const [i, screen] of [[0, 'task'], [1, 'order'], [3, 'sos']]) {
      await page.goto(base + 'index.html?demo'); await page.waitForTimeout(500);
      await page.click('#demoFab'); await page.locator('#dmOpts button').nth(i).click(); await page.waitForTimeout(900);
      const on = await page.evaluate(id => document.getElementById(id).classList.contains('on'), screen);
      on ? pass(`demo scene ${i + 1}`, `opens #${screen}`) : fail(`demo scene ${i + 1}`, `#${screen} did not open`);
    }
    await page.goto(base + 'counter.html?demo'); await page.waitForTimeout(800);
    await page.locator('#reqGrid button').first().click(); await page.waitForTimeout(2600);
    const msgs = await page.locator('#chat .m').count();
    msgs >= 2 ? pass('counter demo', 'pharmacist answered') : fail('counter demo', `only ${msgs} message(s) in the chat`);
    // document card (docs.js): the pharmacist asks for the prescription → the drawing shows; «فاهم» closes it
    if (await page.locator('#docPop:not(.hidden)').count()) { pass('counter demo', 'prescription card shown'); await page.click('#docPop .dok'); await page.waitForTimeout(200); }
    await page.click('#endBtn'); await page.waitForTimeout(300); await page.click('#doneY'); await page.waitForTimeout(500);
    const sum = await page.locator('#sumCard').count();
    sum ? pass('counter demo', 'errand summary shown') : fail('counter demo', 'no errand summary at the end');
    if (page.errs.length) fail('demo', 'console errors: ' + page.errs.join(' | ').slice(0, 300));
    await ctx.close();
  }

  // document cards: matched on the phone, big drawing with two 48px+ buttons, nothing sent
  console.log('\n== document cards (375x667)');
  {
    const { ctx, page } = await newPage(browser, PHONES[0], base);
    await page.goto(base + 'index.html'); await page.waitForTimeout(600); await pastWelcome(page, 'text');
    await page.click('#openFree'); await page.waitForTimeout(300);
    const r = await page.evaluate(() => { docAsk('هات البطاقة لو سمحت'); const b = document.getElementById('docPop');
      return { on: !b.classList.contains('hidden'), word: b.querySelector('.dw').textContent, btns: [...b.querySelectorAll('button')].map(x => x.getBoundingClientRect().height), hs: document.documentElement.scrollWidth - innerWidth }; });
    r.on && /البطاقة/.test(r.word) ? pass('docs', 'ID card shown') : fail('docs', 'no card for «هات البطاقة»');
    r.btns.every(h => h >= 48) ? pass('docs', 'buttons 48px+') : fail('docs', 'buttons under 48px: ' + r.btns.join(','));
    r.hs > 0 ? fail('docs', `scrolls sideways by ${r.hs}px`) : pass('docs', 'no sideways scroll');
    const none = await page.evaluate(() => WaslDocs.find('الدوا ده بخمسين جنيه'));
    none ? fail('docs', 'card for a sentence with no paper') : pass('docs', 'no card when no paper is asked');
    if (page.errs.length) fail('docs', 'console errors: ' + page.errs.join(' | ').slice(0, 300));
    await ctx.close();
  }

  await browser.close(); srv.close();
  console.log(failures ? `\n${failures} problem(s) found.` : '\nAll good.');
  process.exit(failures ? 1 : 0);
})();
