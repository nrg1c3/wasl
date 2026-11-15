#!/usr/bin/env node
/* Badalak — how often does sign → voice get a sign right? (issue #21)

   Uses the templates made by server/signs_templates.py (signs/templates/<ID>.json) and the app's own recogniser
   (signs/s2v.js: the same DTW, mirror and thresholds the phone uses), so the number is the app's, not a copy's.

   Two tests, per sample («leave one out»: the sample is hidden from the templates while it is being guessed):
     • any signer   — the other takes of everyone stay in, the sample's own signer included
     • new signer   — every take by the same signer is hidden too: how it does for a person it has never seen
   For each: top-1 (the first guess is right), top-3 (the right one is among the 3 shown), and «sure» (the app would say
   it without asking, and it is right) / «sure but wrong». A sign with no other sample to compare with is listed apart.

   Output: numbers and sign IDs only. No video, no name, nothing about a person (signer codes like d1/d2 at most).

     node server/signs_accuracy.js                         # P1 signs, signs/templates
     node server/signs_accuracy.js --all                   # every sign that has templates
     node server/signs_accuracy.js --tpl DIR --json out.json --md out.md
     node server/signs_accuracy.js --selftest              # synthetic data: checks the script, no templates needed
     node server/signs_accuracy.js --tpl DIR --test-signer t1
         # «قياس داخلي بس» (#43): the library = everyone except t1, the test = t1's takes only (a person it has never seen).
         # Build DIR in a temp folder (signs_templates.py --clips signs/clips --takes <t1's ZIPs> --out DIR), never in the repo. */
'use strict';
const fs = require('fs'), path = require('path');
const REPO = path.resolve(__dirname, '..');
require(path.join(REPO, 'signs', 's2v.js'));
const S = globalThis.WaslS2V;

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const has = k => args.includes(k);

function vocab() {
  const rows = fs.readFileSync(path.join(REPO, 'signs', 'vocab.csv'), 'utf8').trim().split(/\r?\n/).slice(1);
  const out = {};
  for (const r of rows) {
    const c = r.split(',');
    if (c.length < 5) continue;
    const id = c[2].trim().replace(/\//g, '_');
    out[id] = { ar: c[1].trim(), pri: c[4].trim(), group: c[0].trim() };
  }
  return out;
}

function loadTemplates(dir) {
  const list = [];
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'index.json').sort()) {
    const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    S.fromTemplateFile(j).forEach((t, k) => list.push({ ...t, key: `${t.id}#${t.signer}#${k}` }));
  }
  return list;
}

/* one test over all samples; exclude(sample, template) says which templates are hidden while guessing it */
function run(samples, exclude) {
  const per = {}, conf = {};
  let n = 0, t1 = 0, t3 = 0, sureOk = 0, sureBad = 0, alone = 0;
  const R = new S.Recognizer();
  for (const s of samples) {
    const pool = samples.filter(t => t.key !== s.key && !exclude(s, t));
    const p = per[s.id] || (per[s.id] = { n: 0, t1: 0, t3: 0, alone: 0 });
    if (!pool.some(t => t.id === s.id)) { p.alone++; alone++; continue; }
    R.set(pool);
    const r = R.recognize(s.seq, 3), ids = r.top.map(x => x.id);
    n++; p.n++;
    if (ids[0] === s.id) { t1++; p.t1++; if (r.sure) sureOk++; } else {
      if (r.sure) sureBad++;
      const k = `${s.id} → ${ids[0] || '-'}`; conf[k] = (conf[k] || 0) + 1;
    }
    if (ids.includes(s.id)) { t3++; p.t3++; }
  }
  const pc = (a, b) => (b ? Math.round(1000 * a / b) / 10 : null);
  return { tested: n, alone, top1: pc(t1, n), top3: pc(t3, n), sure_right: pc(sureOk, n), sure_wrong: pc(sureBad, n), per,
    confusions: Object.entries(conf).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([pair, count]) => ({ pair, count })) };
}

function report(samples, V, scope) {
  const signers = [...new Set(samples.map(s => s.signer))].sort();
  const ids = [...new Set(samples.map(s => s.id))];
  const any = run(samples, () => false);
  const cross = run(samples, (s, t) => t.signer === s.signer);
  const weak = ids.map(id => ({ id, ar: (V[id] || {}).ar || id, ...(any.per[id] || {}), x: cross.per[id] || {} }))
    .filter(w => w.n || (w.x && w.x.n))
    .map(w => ({ ...w, score: (w.n ? w.t1 / w.n : 0) + (w.x.n ? w.x.t1 / w.x.n : 0) }))
    .sort((a, b) => a.score - b.score || a.id.localeCompare(b.id));
  return { scope, feat: S.FEAT, thresholds: S.TH, signs: ids.length, samples: samples.length, signers, any_signer: any, new_signer: cross, weakest: weak.slice(0, 25) };
}

/* --test-signer: every take of one person (filmed for measuring only) is guessed against the library of the others */
function reportSigner(all, V, code, p1only) {
  const lib = all.filter(s => s.signer !== code);
  let test = all.filter(s => s.signer === code);
  if (p1only) test = test.filter(s => (V[s.id] || {}).pri === 'P1');
  const per = {}, conf = {};
  let n = 0, t1 = 0, t3 = 0, sureOk = 0, sureBad = 0, nolib = 0;
  const R = new S.Recognizer(); R.set(lib);
  const libIds = new Set(lib.map(t => t.id));
  for (const s of test) {
    const p = per[s.id] || (per[s.id] = { n: 0, t1: 0, t3: 0, alone: 0 });
    if (!libIds.has(s.id)) { p.alone++; nolib++; continue; }
    const r = R.recognize(s.seq, 3), ids = r.top.map(x => x.id);
    n++; p.n++;
    if (ids[0] === s.id) { t1++; p.t1++; if (r.sure) sureOk++; } else { if (r.sure) sureBad++; const k = `${s.id} → ${ids[0] || '-'}`; conf[k] = (conf[k] || 0) + 1; }
    if (ids.includes(s.id)) { t3++; p.t3++; }
  }
  const pc = (a, b) => (b ? Math.round(1000 * a / b) / 10 : null);
  const res = { tested: n, alone: nolib, top1: pc(t1, n), top3: pc(t3, n), sure_right: pc(sureOk, n), sure_wrong: pc(sureBad, n), per,
    confusions: Object.entries(conf).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([pair, count]) => ({ pair, count })) };
  const weak = Object.entries(per).filter(([, w]) => w.n).map(([id, w]) => ({ id, ar: (V[id] || {}).ar || id, ...w, x: w }))
    .sort((a, b) => a.t1 / a.n - b.t1 / b.n || a.id.localeCompare(b.id));
  return { scope: `مصوّر القياس ${code}${p1only ? ' · P1' : ''}`, feat: S.FEAT, thresholds: S.TH, signs: new Set(test.map(s => s.id)).size, samples: test.length,
    signers: [...new Set(lib.map(s => s.signer))].sort().concat([code + ' (اختبار)']), any_signer: res, new_signer: res, weakest: weak.slice(0, 25) };
}

function markdown(r) {
  const row = (name, t) => `| ${name} | ${t.tested} | ${t.top1 ?? '-'}% | ${t.top3 ?? '-'}% | ${t.sure_right ?? '-'}% | ${t.sure_wrong ?? '-'}% | ${t.alone} |`;
  let m = `## دقة التعرّف على الإشارة (${r.scope})\n\n`;
  m += `${r.signs} إشارة، ${r.samples} أخدة، المصوّرين: ${r.signers.join('، ')}. نفس طريقة الموبايل (\`${r.feat}\`، DTW).\n\n`;
  m += '| الاختبار | اتجرّب | أول تخمين صح | صح في أول 3 | «متأكد» وصح | «متأكد» وغلط | مالهاش أخدة تانية |\n|---|---|---|---|---|---|---|\n';
  m += row('أي مصوّر (الأخدة اللي بتتجرّب مستخبية بس)', r.any_signer) + '\n';
  m += row('مصوّر جديد (كل أخدات نفس المصوّر مستخبية)', r.new_signer) + '\n\n';
  m += '### أضعف الإشارات\n\n| الإشارة | ID | أي مصوّر: صح/اتجرّب | مصوّر جديد: صح/اتجرّب |\n|---|---|---|---|\n';
  for (const w of r.weakest) m += `| ${w.ar} | \`${w.id}\` | ${w.t1 ?? 0}/${w.n ?? 0} | ${w.x.t1 ?? 0}/${w.x.n ?? 0} |\n`;
  if (r.any_signer.confusions.length) {
    m += '\n### أكتر لخبطة (الإشارة → اللي اتخمّن بدالها)\n\n';
    for (const c of r.any_signer.confusions) m += `- \`${c.pair}\` × ${c.count}\n`;
  }
  return m;
}

/* synthetic check: 12 signs, 2 signers × 2 takes, noisy copies of one base movement per sign */
function selftest() {
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const L = S.T_LEN * S.DIM, samples = [];
  for (let k = 0; k < 12; k++) {
    const base = new Float32Array(L);
    for (let i = 0; i < L; i++) base[i] = (rnd() - 0.5) * 2;
    for (let f = 0; f < S.T_LEN; f++) { base[f * S.DIM] = 1; base[f * S.DIM + S.HAND] = 1; } // both hands present
    for (const signer of ['d1', 'd2']) for (let take = 0; take < 2; take++) {
      const seq = Float32Array.from(base, (v, i) => (i % S.DIM === 0 || i % S.DIM === S.HAND) ? v : v + (rnd() - 0.5) * 0.3);
      samples.push({ id: 'S' + k, signer, src: 'lib', seq, key: `S${k}#${signer}#${take}` });
    }
  }
  samples.push({ id: 'ALONE', signer: 'd1', src: 'lib', seq: new Float32Array(L), key: 'ALONE#d1#0' });
  // a measuring signer t1: one noisy take per sign, guessed against d1+d2 only
  for (let k = 0; k < 12; k++) {
    const b = samples.find(x => x.id === 'S' + k).seq;
    samples.push({ id: 'S' + k, signer: 't1', src: 'lib', seq: Float32Array.from(b, (v, i) => (i % S.DIM === 0 || i % S.DIM === S.HAND) ? v : v + (rnd() - 0.5) * 0.3), key: `S${k}#t1#0` });
  }
  const ts = reportSigner(samples, {}, 't1', false);
  const tsOk = ts.new_signer.tested === 12 && ts.new_signer.top1 === 100 && !ts.signers.includes('t1');
  console.log(`test-signer t1: ${ts.new_signer.tested} takes, top-1 ${ts.new_signer.top1}%`);
  samples.splice(samples.length - 12, 12);
  const r = report(samples, {}, 'selftest');
  const ok = tsOk && r.any_signer.top1 === 100 && r.new_signer.top1 === 100 && r.any_signer.alone === 1 && r.any_signer.tested === 48;
  console.log(markdown(r));
  console.log(ok ? 'selftest: ok' : 'selftest: FAILED');
  process.exit(ok ? 0 : 1);
}

if (has('--selftest')) selftest();
else {
  const dir = opt('--tpl', path.join(REPO, 'signs', 'templates'));
  if (!fs.existsSync(dir)) { console.error(`No templates in ${dir}. Run: python3 server/signs_templates.py`); process.exit(2); }
  const V = vocab(), all = loadTemplates(dir);
  if (opt('--test-signer')) {
    const code = opt('--test-signer').toLowerCase();
    if (!all.some(s => s.signer === code)) { console.error(`No templates for signer ${code} in ${dir}.`); process.exit(2); }
    const r = reportSigner(all, V, code, !has('--all'));
    const md = markdown(r).replace(/\| أي مصوّر[^\n]*\n/, '').replace('| مصوّر جديد (كل أخدات نفس المصوّر مستخبية)', `| مصوّر جديد (${code}، المكتبة من غيره)`);
    console.log(md);
    if (opt('--json')) fs.writeFileSync(opt('--json'), JSON.stringify(r, null, 1));
    if (opt('--md')) fs.writeFileSync(opt('--md'), md);
    process.exit(0);
  }
  const samples = has('--all') ? all : all.filter(s => (V[s.id] || {}).pri === 'P1');
  const r = report(samples, V, has('--all') ? 'كل الإشارات' : 'الأولوية الأولى P1');
  const md = markdown(r);
  console.log(md);
  if (opt('--json')) fs.writeFileSync(opt('--json'), JSON.stringify(r, null, 1));
  if (opt('--md')) fs.writeFileSync(opt('--md'), md);
}
