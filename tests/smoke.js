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

// first run: the welcome card has one start button (#48: one interface for everyone)
async function pastWelcome(page) {
  const b = page.locator('#wOk');
  if (await b.isVisible().catch(() => false)) { await b.click(); await page.waitForTimeout(400); } // ?go=sos skips the welcome on purpose
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
        if (pg.startsWith('index')) await pastWelcome(page);
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

    // one home for everyone (#48): the 6 situations, the tools (counter included) and the emergency button all show without
    // scrolling, above the bottom bar; «التنبيهات» is in the bottom bar with its icon; a user who once chose «بقرا كويس»
    // (wasl_pic=false) gets the same home
    for (const old of [null, 'false']) {
      const where = `${tag} home${old ? ' (old wasl_pic=false)' : ''}`;
      const { ctx, page } = await newPage(browser, vp, base);
      if (old) await page.addInitScript(v => { localStorage.setItem('wasl_pic', v); localStorage.setItem('wasl_welcome', 'true'); }, old);
      await page.goto(base + 'index.html'); await page.waitForTimeout(600); await pastWelcome(page);
      const r = await page.evaluate(() => {
        const nav = document.querySelector('.hnav').getBoundingClientRect(), H = innerHeight;
        const vis = el => { const b = el.getBoundingClientRect(); return b.height >= 48 && b.top >= 0 && b.bottom <= Math.min(H, nav.top) + 1; };
        const al = document.getElementById('openAlerts'), ab = al.getBoundingClientRect();
        return { pm: !document.getElementById('bigTalk') && !document.getElementById('openFree'), picSw: !!document.getElementById('picSw'),
          sit: [...document.querySelectorAll('#sitGrid button')].filter(vis).length, tools: [...document.querySelectorAll('#toolGrid button')].filter(vis).length,
          toolsAll: document.querySelectorAll('#toolGrid button').length, sos: vis(document.getElementById('sosBtn')),
          alerts: ab.height >= 48 && ab.bottom <= H + 1 && !!al.querySelector('svg') && /التنبيهات/.test(al.textContent), scroll: document.scrollingElement.scrollTop };
      });
      r.pm && !r.picSw ? pass(where, 'one interface (no picture-mode switch, no old home buttons)') : fail(where, `old buttons gone=${r.pm} picSw=${r.picSw}`);
      r.sit === 6 && r.tools === r.toolsAll && r.sos ? pass(where, `6 situations + ${r.tools} tools + emergency, no scroll`) : fail(where, `visible: ${r.sit} situations, ${r.tools}/${r.toolsAll} tools, emergency ${r.sos}`);
      r.alerts ? pass(where, '«التنبيهات» in the bottom bar with its icon') : fail(where, '«التنبيهات» not visible in the bottom bar');
      if (page.errs.length) fail(where, 'console errors: ' + page.errs.join(' | ').slice(0, 300));
      await ctx.close();
    }
  }

  // demo: the four-scene list, and the counter scene, with every outside request blocked
  console.log('\n== demo (375x667, offline)');
  {
    const { ctx, page } = await newPage(browser, PHONES[0], base);
    await page.unroute('**/*');
    await page.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.abort());
    await page.goto(base + 'index.html?demo'); await page.waitForTimeout(600); await pastWelcome(page);
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
    // medicine forms (meds.js): pharmacy, customer phone → 8 picture cards, confirm, the sentence goes to the pharmacist
    if (await page.locator('#medBtn').count()) {
      await page.click('#medBtn'); await page.waitForTimeout(200);
      const n = await page.locator('#medPop .mg button').count();
      n === 8 ? pass('counter demo', '8 medicine forms') : fail('counter demo', `${n} medicine forms, expected 8`);
      await page.locator('#medPop .mg button').nth(2).click(); await page.click('#medPop .mok'); await page.waitForTimeout(300);
      const last = await page.locator('#chat .m.me').last().textContent();
      /شراب/.test(last) ? pass('counter demo', 'medicine form sent') : fail('counter demo', 'medicine form not in the chat');
    } else fail('counter demo', 'no medicine-form button at the pharmacy');
    await page.click('#endBtn'); await page.waitForTimeout(300); await page.click('#doneY'); await page.waitForTimeout(500);
    const sum = await page.locator('#sumCard').count();
    sum ? pass('counter demo', 'errand summary shown') : fail('counter demo', 'no errand summary at the end');
    if (page.errs.length) fail('demo', 'console errors: ' + page.errs.join(' | ').slice(0, 300));
    await ctx.close();
  }

  // «قياس داخلي بس» (#43): a measure-only signer's takes never reach signs/clips or signs/index.json, even with --force
  console.log('\n== signs_build: measure-only signer');
  {
    const { execFileSync } = require('child_process'), os = require('os');
    const has = (c, f = '-version') => { try { execFileSync(c, [f], { stdio: 'ignore' }); return true; } catch (e) { return false; } };
    if (!has('python3', '--version')) pass('signs_build', 'skipped (no python here)');
    else if (!has('ffmpeg') || !has('ffprobe')) pass('signs_build', 'skipped (no ffmpeg here)');
    else {
      const T = fs.mkdtempSync(path.join(os.tmpdir(), 'wasl-measure-'));
      fs.mkdirSync(path.join(T, 'server')); fs.mkdirSync(path.join(T, 'signs')); fs.mkdirSync(path.join(T, 'raw'));
      fs.copyFileSync(path.join(ROOT, 'server', 'signs_build.py'), path.join(T, 'server', 'signs_build.py'));
      fs.copyFileSync(path.join(ROOT, 'signs', 'vocab.csv'), path.join(T, 'signs', 'vocab.csv'));
      fs.writeFileSync(path.join(T, 'raw', 'HELLO__z9__1.webm'), 'not a real video');
      fs.writeFileSync(path.join(T, 'raw', 'takes.json'), JSON.stringify({ files: [{ file: 'HELLO__z9__1.webm', id: 'HELLO', signer: 'z9', take: 1, status: 'ok' }] }));
      fs.writeFileSync(path.join(T, 'raw', 'consent.json'), JSON.stringify({ signers: [{ signer: 'z9', name: 'test', purpose: 'measure', uses: { app: false, training: true, competitions: false, social: false } }] }));
      let out = '';
      for (const extra of [[], ['--force']]) {
        try { out += execFileSync('python3', [path.join(T, 'server', 'signs_build.py'), '--in', path.join(T, 'raw'), ...extra], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
        catch (e) { out += (e.stdout || '') + (e.stderr || ''); }
      }
      const clips = fs.existsSync(path.join(T, 'signs', 'clips')) ? fs.readdirSync(path.join(T, 'signs', 'clips')) : [];
      const idx = fs.existsSync(path.join(T, 'signs', 'index.json')) ? fs.readFileSync(path.join(T, 'signs', 'index.json'), 'utf8') : '';
      (/internal measuring only/.test(out) && !clips.some(f => /z9/.test(f)) && !/z9/.test(idx))
        ? pass('signs_build', 'measure-only signer skipped, also with --force') : fail('signs_build', 'measure-only signer reached the library: ' + out.slice(-300));
      fs.rmSync(T, { recursive: true, force: true });
    }
    // signs_templates.py: the same signer gets no templates when --out is inside the repo (the app loads signs/templates),
    // and is used when --out is a temp folder (the measuring run). --list stops before MediaPipe.
    if (has('python3', '--version')) {
      const T = fs.mkdtempSync(path.join(os.tmpdir(), 'wasl-measure-tpl-'));
      fs.mkdirSync(path.join(T, 'clips')); fs.mkdirSync(path.join(T, 'zip1'));
      fs.writeFileSync(path.join(T, 'zip1', 'PHARMACY__z9__1.webm'), 'x');
      fs.writeFileSync(path.join(T, 'zip1', 'PHARMACY__d1__1.webm'), 'x');
      fs.writeFileSync(path.join(T, 'zip1', 'consent.json'), JSON.stringify({ signers: [{ signer: 'z9', purpose: 'measure' }, { signer: 'd1', purpose: 'app' }] }));
      const run = out => { try { return execFileSync('python3', [path.join(ROOT, 'server', 'signs_templates.py'), '--clips', path.join(T, 'clips'), '--takes', T, '--out', out, '--list'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return 'ERR ' + (e.stdout || '') + (e.stderr || ''); } };
      const inRepo = run(path.join(ROOT, 'signs', 'templates')), outside = run(path.join(T, 'tpl'));
      (/internal measuring only/.test(inRepo) && !/z9:/.test(inRepo) && /d1:/.test(inRepo) && /z9:/.test(outside))
        ? pass('signs_templates', 'measure-only signer: no templates inside the repo, used with --out outside it')
        : fail('signs_templates', 'measure-only signer guard: ' + (inRepo + ' | ' + outside).slice(-400));
      fs.rmSync(T, { recursive: true, force: true });
    }
  }

  // pharmacy from home (#40): straight to the pharmacy cards, no doctor / bills sections; «رجوع» goes home
  console.log('\n== pharmacy from home');
  for (const vp of PHONES) {
    const tag = `${vp.width}x${vp.height}`;
    const { ctx, page } = await newPage(browser, vp, base);
    await page.goto(base + 'index.html'); await page.waitForTimeout(600); await pastWelcome(page);
    const i = await page.evaluate(() => SIT.findIndex(x => x.ph));
    await page.locator(`#sitGrid button[data-i="${i}"]`).click(); await page.waitForTimeout(400);
    const r = await page.evaluate(() => ({ on: document.getElementById('talk').classList.contains('on'), t: [...document.querySelectorAll('#pics button')].map(x => x.textContent),
      hs: document.documentElement.scrollWidth - innerWidth }));
    r.on && r.t.length === 13 && r.t.some(x => /روشتة/.test(x)) && r.t.some(x => /قطرة للعين/.test(x)) ? pass(tag + ' pharmacy', '12 pharmacy cards + back') : fail(tag + ' pharmacy', `cards: ${r.t.join(' | ')}`);
    r.t.some(x => /دكتور|فلوس وفواتير/.test(x)) ? fail(tag + ' pharmacy', 'old sections shown') : pass(tag + ' pharmacy', 'no doctor / bills sections');
    r.hs > 0 ? fail(tag + ' pharmacy', `scrolls sideways by ${r.hs}px`) : pass(tag + ' pharmacy', 'no sideways scroll');
    // box / strip / bottle (#50): pictures after the card, «رجوع» back to the cards, the choice goes in the sentence
    await page.evaluate(() => { document.getElementById('startTask').click = () => {}; });
    const cards = async () => page.evaluate(() => [...document.querySelectorAll('#pics button')].map(x => x.textContent));
    await page.locator('#pics button', { hasText: 'مسكن للصداع' }).click(); await page.waitForTimeout(200);
    let q = await cards();
    q.length === 4 && /علبة/.test(q[1]) && /شريط/.test(q[2]) && /مش مهم/.test(q[3]) ? pass(tag + ' pharmacy', 'headache: box / strip / doesn\'t matter') : fail(tag + ' pharmacy', `qty: ${q.join(' | ')}`);
    await page.locator('#pics button.back').click(); await page.waitForTimeout(200);
    (await cards()).length === 13 ? pass(tag + ' pharmacy', 'qty «رجوع» back to the cards') : fail(tag + ' pharmacy', 'qty «رجوع» lost the cards');
    await page.locator('#pics button', { hasText: 'دوا للبرد' }).click(); await page.waitForTimeout(200);
    q = await cards();
    const qs = await page.evaluate(() => { const b = [...document.querySelectorAll('#pics button')]; return { hs: document.documentElement.scrollWidth - innerWidth, small: b.filter(x => x.offsetHeight < 48 || x.offsetWidth < 48).length }; });
    q.length === 5 && /إزازة/.test(q[3]) && !qs.hs && !qs.small ? pass(tag + ' pharmacy', 'cold: box / strip / bottle, 48px+, no sideways scroll') : fail(tag + ' pharmacy', `qty: ${q.join(' | ')} ${JSON.stringify(qs)}`);
    await page.locator('#pics button', { hasText: 'شريط' }).click(); await page.waitForTimeout(200);
    const goal = await page.evaluate(() => document.getElementById('goal').value);
    goal === 'عايز شريط دوا للبرد والكحة' ? pass(tag + ' pharmacy', 'sentence: ' + goal) : fail(tag + ' pharmacy', 'sentence: ' + goal);
    await page.evaluate(() => drawPics(PICS[0], true)); await page.waitForTimeout(200);
    await page.locator('#pics button.back').click(); await page.waitForTimeout(300);
    (await page.evaluate(() => document.getElementById('home').classList.contains('on'))) ? pass(tag + ' pharmacy', '«رجوع» goes home') : fail(tag + ' pharmacy', '«رجوع» did not go home');
    if (page.errs.length) fail(tag + ' pharmacy', 'console errors: ' + page.errs.join(' | ').slice(0, 300));
    await ctx.close();
  }

  // other places from home (#46): the 6th square opens the places grid with «رجوع»; a place's «رجوع» goes back to the grid,
  // the grid's goes home; telecom has its 6 cards; «فين المكان؟» is a card in the grid
  console.log('\n== other places from home');
  for (const vp of PHONES) {
    const tag = `${vp.width}x${vp.height}`;
    const { ctx, page } = await newPage(browser, vp, base);
    await page.goto(base + 'index.html'); await page.waitForTimeout(600); await pastWelcome(page);
    const cards = () => page.evaluate(() => [...document.querySelectorAll('#pics button')].map(x => x.textContent));
    const i = await page.evaluate(() => SIT.findIndex(x => x.more));
    await page.locator(`#sitGrid button[data-i="${i}"]`).click(); await page.waitForTimeout(400);
    let t = await cards();
    const on = await page.evaluate(() => document.getElementById('talk').classList.contains('on'));
    on && /رجوع/.test(t[0]) && t.some(x => /اتصالات/.test(x)) && t.some(x => /فين المكان/.test(x)) && t.some(x => /صيدلية/.test(x))
      ? pass(tag + ' places', `grid: ${t.length - 1} places + back`) : fail(tag + ' places', `grid: ${t.join(' | ')}`);
    await page.locator('#pics button', { hasText: 'اتصالات' }).click(); await page.waitForTimeout(200);
    t = await cards();
    const m = await page.evaluate(() => { const b = [...document.querySelectorAll('#pics button')]; return { hs: document.documentElement.scrollWidth - innerWidth, small: b.filter(x => x.offsetHeight < 48).length }; });
    t.length === 7 && t.some(x => /خط جديد/.test(x)) && t.some(x => /شكوى/.test(x)) && !m.hs && !m.small
      ? pass(tag + ' places', 'telecom: 6 cards + back, 48px+, no sideways scroll') : fail(tag + ' places', `telecom: ${t.join(' | ')} ${JSON.stringify(m)}`);
    await page.locator('#pics button.back').click(); await page.waitForTimeout(200);
    t = await cards();
    /رجوع/.test(t[0]) && t.some(x => /اتصالات/.test(x)) ? pass(tag + ' places', '«رجوع» from telecom goes back to the grid') : fail(tag + ' places', `after back: ${t.join(' | ')}`);
    // government (#46 PR 5): «ورق حكومي» split in three; the police station starts with «🚨 طوارئ», which opens the emergency screen
    t = await cards();
    !t.some(x => /ورق حكومي/.test(x)) && ['السجل المدني', 'المرور', 'قسم الشرطة'].every(n => t.some(x => x.includes(n))) ? pass(tag + ' places', 'government split in three') : fail(tag + ' places', `grid: ${t.join(' | ')}`);
    await page.locator('#pics button', { hasText: 'السجل المدني' }).click(); await page.waitForTimeout(200);
    t = await cards();
    t.length === 6 && t.some(x => /بدل فاقد/.test(x)) ? pass(tag + ' places', 'civil registry: 5 cards + back') : fail(tag + ' places', `civil registry: ${t.join(' | ')}`);
    await page.locator('#pics button.back').click(); await page.waitForTimeout(200);
    await page.locator('#pics button', { hasText: 'المرور' }).click(); await page.waitForTimeout(200);
    t = await cards();
    t.length === 5 && t.some(x => /مخالفة/.test(x)) ? pass(tag + ' places', 'traffic: 4 cards + back') : fail(tag + ' places', `traffic: ${t.join(' | ')}`);
    await page.locator('#pics button.back').click(); await page.waitForTimeout(200);
    await page.locator('#pics button', { hasText: 'قسم الشرطة' }).click(); await page.waitForTimeout(200);
    t = await cards();
    const sosFirst = await page.evaluate(() => document.querySelectorAll('#pics button')[1].classList.contains('psos'));
    // the red card is fully on screen, under the header, right after opening the place from the bottom of the grid
    const sosVis = await page.evaluate(() => { const r = document.querySelector('#pics .psos').getBoundingClientRect(), h = document.querySelector('#talk .top').getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), head: Math.round(h.bottom), H: innerHeight }; });
    sosVis.top >= sosVis.head && sosVis.bottom <= sosVis.H ? pass(tag + ' places', '«🚨 طوارئ» fully visible under the header') : fail(tag + ' places', `«🚨 طوارئ» hidden: ${JSON.stringify(sosVis)}`);
    t.length === 5 && /طوارئ/.test(t[1]) && sosFirst && t.some(x => /أعمل محضر/.test(x)) ? pass(tag + ' places', 'police: «🚨 طوارئ» first + 3 cards') : fail(tag + ' places', `police: ${t.join(' | ')}`);
    await page.locator('#pics button.psos').click(); await page.waitForTimeout(400);
    (await page.evaluate(() => document.getElementById('sos').classList.contains('on'))) ? pass(tag + ' places', '«🚨 طوارئ» opens the emergency screen') : fail(tag + ' places', '«🚨 طوارئ» did not open the emergency screen');
    await page.evaluate(() => { show('talk'); openPlaces(); }); await page.waitForTimeout(200);
    // hospital and labs (#46 PR 4): 6 cards, the referral card is a photo card
    await page.locator('#pics button', { hasText: 'مستشفى وتحاليل' }).click(); await page.waitForTimeout(200);
    t = await cards();
    const hc = await page.evaluate(() => document.querySelectorAll('#pics button.pcam').length);
    t.length === 7 && t.some(x => /أول مرة هنا/.test(x)) && t.some(x => /تأمين صحي/.test(x)) && hc === 1 ? pass(tag + ' places', 'hospital: 6 cards + back, 1 photo card') : fail(tag + ' places', `hospital: ${t.join(' | ')} (photo ${hc})`);
    await page.locator('#pics button.back').click(); await page.waitForTimeout(200);
    // post office (#46 PR 2): 5 cards, the bill card is a photo card
    await page.locator('#pics button', { hasText: 'بريد' }).click(); await page.waitForTimeout(200);
    t = await cards();
    const pc = await page.evaluate(() => document.querySelectorAll('#pics button.pcam').length);
    t.length === 6 && t.some(x => /معاش/.test(x)) && t.some(x => /استلام طرد/.test(x)) && pc === 1 ? pass(tag + ' places', 'post office: 5 cards + back, 1 photo card') : fail(tag + ' places', `post office: ${t.join(' | ')} (photo ${pc})`);
    await page.locator('#pics button.back').click(); await page.waitForTimeout(200);
    // home repairs (#46 PR 3): 5 cards + the call card, which opens «مكالمة (تجريبي)»
    await page.locator('#pics button', { hasText: 'صيانة البيت' }).click(); await page.waitForTimeout(200);
    t = await cards();
    t.length === 7 && t.some(x => /سبّاك/.test(x)) && t.some(x => /مكالمة \(تجريبي\)/.test(x)) ? pass(tag + ' places', 'home repairs: 5 cards + call + back') : fail(tag + ' places', `home repairs: ${t.join(' | ')}`);
    await page.locator('#pics button', { hasText: 'مكالمة (تجريبي)' }).click(); await page.waitForTimeout(400);
    (await page.evaluate(() => document.getElementById('call').classList.contains('on'))) ? pass(tag + ' places', 'call card opens the call screen') : fail(tag + ' places', 'call card did not open the call screen');
    const cg = await page.evaluate(() => document.getElementById('cGoal').value);
    cg === 'عايز سبّاك أو كهربائي ييجي البيت' ? pass(tag + ' places', 'call request box starts with the home-repair sentence') : fail(tag + ' places', 'call request box: ' + cg);
    // opened again without a sentence (home tool, call link): the untouched ready sentence is gone; what the user typed stays
    const after = await page.evaluate(() => { callOpen(); const a = document.getElementById('cGoal').value;
      callOpen('عايز سبّاك أو كهربائي ييجي البيت'); document.getElementById('cGoal').value = 'عايز أحجز كشف'; callOpen(); return [a, document.getElementById('cGoal').value]; });
    after[0] === '' && after[1] === 'عايز أحجز كشف' ? pass(tag + ' places', 'ready sentence cleared on a plain open, typed text kept') : fail(tag + ' places', 'after reopen: ' + JSON.stringify(after));
    await page.evaluate(() => { show('talk'); openPlaces(); }); await page.waitForTimeout(200);
    await page.locator('#pics button.back').click(); await page.waitForTimeout(300);
    (await page.evaluate(() => document.getElementById('home').classList.contains('on'))) ? pass(tag + ' places', '«رجوع» from the grid goes home') : fail(tag + ' places', 'grid «رجوع» did not go home');
    if (page.errs.length) fail(tag + ' places', 'console errors: ' + page.errs.join(' | ').slice(0, 300));
    await ctx.close();
  }

  // «مكالمة (تجريبي)» with a fake server: the call connects, the other side speaks, then asks with 4 choices.
  // The question and every choice are on screen above the bottom bar, 48px+, no sideways scroll.
  console.log('\n== call (trial), fake server');
  for (const vp of PHONES) {
    const tag = `${vp.width}x${vp.height}`;
    const { ctx, page } = await newPage(browser, vp, base);
    page.on('dialog', d => d.accept());
    let polls = 0, round = 1;
    await page.route(/wasl-call-start/, r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ cid: 'c1', mode: 'live' }) }));
    await page.route(/wasl-call$/, r => { polls++; r.fulfill({ contentType: 'application/json', body: JSON.stringify({ state: 'live',
      lines: [{ r: 'wasl', t: 'أهلاً، أنا مساعد بالذكاء الاصطناعي بتكلم بالنيابة عن عميل أصم. عايز أحجز كشف.' },
        ...Array.from({ length: 12 }, (_, i) => ({ r: i % 2 ? 'callee' : 'wasl', t: 'كلام في نص المكالمة عشان سجل المكالمة يطوّل، رقم ' + (i + 1) })),
        { r: 'callee', t: 'عندنا ميعاد بكرة الساعة خمسة، أو بعد بكرة الساعة عشرة الصبح. حضرتك تحب أنهي ميعاد؟' }],
      pending: polls > 1 ? { q: round === 1 ? 'تختار أنهي ميعاد؟' : 'الكشف بمية وخمسين جنيه. توافق؟', o: ['بكرة الساعة خمسة', 'بعد بكرة الساعة عشرة', 'اسأل عن ميعاد تاني', 'أنا هكتب'] } : null }) }); });
    await page.addInitScript(() => { localStorage.setItem('wasl_welcome', 'true'); localStorage.setItem('wasl_consent_call2', 'true'); });
    await page.goto(base + 'index.html'); await page.waitForTimeout(600);
    await page.evaluate(() => { callOpen(); document.getElementById('cNum').value = '01001234567'; document.getElementById('cGoal').value = 'عايز أحجز كشف'; });
    await page.click('#cGo'); await page.waitForTimeout(4500);
    const r = await page.evaluate(() => { const d = document.getElementById('cDecide'), f = document.getElementById('cFoot'), top = document.querySelector('#call .top').getBoundingClientRect().bottom;
      const fr = f.classList.contains('hidden') ? innerHeight : f.getBoundingClientRect().top, b = [...d.querySelectorAll('button')].map(x => x.getBoundingClientRect());
      return { shown: !d.classList.contains('hidden'), heard: document.getElementById('cHeard').textContent.length > 0, n: b.length,
        vis: b.filter(x => x.top >= top - 1 && x.bottom <= fr + 1).length, minH: Math.min(...b.map(x => x.height)), hs: document.documentElement.scrollWidth - innerWidth }; });
    r.shown && r.heard && r.n === 4 && r.vis === 4 && r.minH >= 48 && r.hs <= 0 ? pass(tag + ' call', 'question + 4 choices on screen, 48px+, no sideways scroll') : fail(tag + ' call', JSON.stringify(r));
    // the user scrolled down to read the whole call; a new question still comes into view (showBox scrolls the call, #65)
    await page.evaluate(() => { document.getElementById('cLogBox').open = true; const c = document.querySelector('#call .cbody'); c.scrollTop = c.scrollHeight; });
    round = 2; await page.waitForTimeout(3000);
    const q2 = await page.evaluate(() => { const q = document.getElementById('cQ'), top = document.querySelector('#call .top').getBoundingClientRect().bottom, f = document.getElementById('cFoot');
      const fr = f.classList.contains('hidden') ? innerHeight : f.getBoundingClientRect().top, rc = q.getBoundingClientRect(); return { t: q.textContent, top: Math.round(rc.top), vis: rc.top >= top - 1 && rc.bottom <= fr + 1 }; });
    /توافق/.test(q2.t) && q2.vis ? pass(tag + ' call', 'new question scrolled into view after reading the log') : fail(tag + ' call', 'question hidden: ' + JSON.stringify(q2));
    if (page.errs.length) fail(tag + ' call', 'console errors: ' + page.errs.join(' | ').slice(0, 300));
    await ctx.close();
  }

  // Gulf conversation (ar-SA): the quick replies in «ترجمة» are said in Gulf, each with its icon; the call trial note is Gulf
  console.log('\n== Gulf screen (375x667)');
  {
    const { ctx, page } = await newPage(browser, PHONES[0], base);
    await page.addInitScript(() => { localStorage.setItem('wasl_lang', '"ar-SA"'); localStorage.setItem('wasl_welcome', 'true'); });
    await page.goto(base + 'index.html'); await page.waitForTimeout(600);
    const r = await page.evaluate(() => { openFreeScreen(); const t = [...document.querySelectorAll('#fSug button')].map(b => [b.textContent, b.querySelector('.ri use, .ri svg') ? 1 : 0]);
      callOpen(); return { t, note: document.querySelector('#call .cnote') ? document.querySelector('#call .cnote').textContent : '' }; });
    r.t.length === 4 && /شوي؟/.test(r.t[0][0]) && /تكتب لي/.test(r.t[2][0]) && r.t.every(x => x[1]) ? pass('gulf', 'quick replies in Gulf, each with an icon') : fail('gulf', 'replies: ' + JSON.stringify(r.t));
    /للحين/.test(r.note) && !/لسه/.test(r.note) ? pass('gulf', 'call trial note in Gulf') : fail('gulf', 'call note: ' + r.note);
    if (page.errs.length) fail('gulf', 'console errors: ' + page.errs.join(' | ').slice(0, 300));
    await ctx.close();
  }

  // document cards: matched on the phone, big drawing with two 48px+ buttons, nothing sent
  console.log('\n== document cards (375x667)');
  {
    const { ctx, page } = await newPage(browser, PHONES[0], base);
    await page.goto(base + 'index.html'); await page.waitForTimeout(600); await pastWelcome(page);
    await page.locator('#toolGrid button[data-i="0"]').click(); await page.waitForTimeout(300); // «ترجمة»
    const r = await page.evaluate(() => { docAsk('هات البطاقة لو سمحت'); const b = document.getElementById('docPop');
      return { on: !b.classList.contains('hidden'), word: b.querySelector('.dw').textContent, btns: [...b.querySelectorAll('button')].map(x => x.getBoundingClientRect().height), hs: document.documentElement.scrollWidth - innerWidth }; });
    r.on && /البطاقة/.test(r.word) ? pass('docs', 'ID card shown') : fail('docs', 'no card for «هات البطاقة»');
    r.btns.every(h => h >= 48) ? pass('docs', 'buttons 48px+') : fail('docs', 'buttons under 48px: ' + r.btns.join(','));
    r.hs > 0 ? fail('docs', `scrolls sideways by ${r.hs}px`) : pass('docs', 'no sideways scroll');
    const none = await page.evaluate(() => ['الدوا ده بخمسين جنيه', 'كاش ولا فيزا؟', 'بطاقة شحن', 'عندك فيزا للسفر؟'].filter(t => WaslDocs.find(t)));
    none.length ? fail('docs', 'card where no paper is asked: ' + none.join(' | ')) : pass('docs', 'no card when no paper is asked (incl. «كاش ولا فيزا؟»)');
    const id2 = await page.evaluate(() => (WaslDocs.find('رقمك القومي لو سمحت') || {}).id);
    id2 === 'national' ? pass('docs', '«رقمك القومي» → ID card') : fail('docs', '«رقمك القومي» gave ' + id2);
    if (page.errs.length) fail('docs', 'console errors: ' + page.errs.join(' | ').slice(0, 300));
    await ctx.close();
  }

  await browser.close(); srv.close();
  console.log(failures ? `\n${failures} problem(s) found.` : '\nAll good.');
  process.exit(failures ? 1 : 0);
})();
