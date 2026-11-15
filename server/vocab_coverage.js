#!/usr/bin/env node
/* Badalak — which words on the app's picture cards have no entry in the sign library list (signs/vocab.csv)? (issue #49)

   Collects the labels of the cards and pictures the user taps or sees:
     index.html  — PICS (the «اتكلم بدالي» picture cards and their sub-cards), SIT (home situations), TOOLS (home tools)
     meds.js     — medicine forms;   docs.js — document cards;   counter.html — REQ (the counter's request cards)
   and checks each against vocab.csv: a label is covered when one of the vocab words (the «/» alternatives of the arabic
   column) is the label itself or a whole word inside it. A report only: it never fails the tests.

     node server/vocab_coverage.js                    # print the report
     node server/vocab_coverage.js --md docs/vocab-coverage.md

   Rule (#49): any new card or picture adds its word to signs/vocab.csv in the same PR. */
'use strict';
const fs = require('fs'), path = require('path');
const REPO = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(REPO, f), 'utf8');
const norm = s => String(s || '').replace(/[ً-ْـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
  .replace(/[؟?!.،,()«»:]/g, ' ').replace(/\s+/g, ' ').trim();
/* the same light stemming on both sides: «الروشتة» = «روشتة», «للسخونية» = «سخونية», «بكام» = «كام» */
const stem = w => w.replace(/^(وال|بال|لل|ال)/, '').replace(/^[بلو](?=...)/, '');
const strip = s => norm(s).split(' ').map(stem).join(' ');

/* vocab: every «/» alternative of the arabic column */
const vocab = read('signs/vocab.csv').trim().split(/\r?\n/).slice(1).map(l => l.split(',')).filter(c => c.length >= 5)
  .map(c => ({ id: c[2].trim().replace(/\//g, '_'), alts: c[1].replace(/\(.*?\)/g, '').split('/').map(strip).filter(Boolean) }));

function covered(label) {
  const L = ' ' + strip(label) + ' ';
  // the vocab word is in the label, or the label is how the vocab word starts («البطاقة» → «بطاقة رقم قومي»)
  return vocab.filter(v => v.alts.some(a => L.includes(' ' + a + ' ') || (' ' + a + ' ').startsWith(L))).map(v => v.id);
}

/* labels: l:'…' entries inside a JS array literal that starts at `const NAME=[` */
function arrayLabels(src, name) {
  const i = src.indexOf(`const ${name}=[`);
  if (i < 0) return [];
  let d = 0, j = src.indexOf('[', i);
  for (let k = j; k < src.length; k++) { if (src[k] === '[') d++; else if (src[k] === ']' && !--d) { j = k; break; } }
  return [...src.slice(i, j).matchAll(/\bl:'([^']+)'/g)].map(m => m[1]);
}
const idx = read('index.html'), counter = read('counter.html');
const groups = [
  ['اتكلم بدالي (PICS)', arrayLabels(idx, 'PICS')],
  ['الرئيسية: المواقف (SIT)', arrayLabels(idx, 'SIT')],
  ['الرئيسية: الأدوات (TOOLS)', arrayLabels(idx, 'TOOLS')],
];
global.window = {}; global.document = {};
require(path.join(REPO, 'meds.js')); require(path.join(REPO, 'docs.js'));
groups.push(['أشكال الدوا (meds.js)', window.WaslMeds.list.map(m => m.ar)]);
groups.push(['كروت المستندات (docs.js)', window.WaslDocs.list.map(d => d.ar)]);
{ const i = counter.indexOf('const REQ='), j = counter.indexOf('};', i);
  groups.push(['الكاونتر: كروت الطلب (REQ)', [...counter.slice(i, j).matchAll(/\['[^']*','([^']+)','[^']*'\]/g)].map(m => m[1])]); }

let total = 0, miss = 0, md = '# تغطية القاموس: كلمات الكروت اللي مالهاش إشارة\n\n';
md += `اتعمل بـ\`node server/vocab_coverage.js\` على \`signs/vocab.csv\` (${vocab.length} كلمة). تقرير بس، مش اختبار.\n`;
md += 'الكارت «متغطي» لو كلمة من القاموس هي نفسها أو كلمة كاملة جواه. الكروت اللي جملها مركّبة ممكن تكون متغطية بأكتر من كلمة.\n\n';
const lines = [];
for (const [title, labels] of groups) {
  const uniq = [...new Set(labels)];
  const rows = uniq.map(l => ({ l, ids: covered(l) }));
  const no = rows.filter(r => !r.ids.length);
  total += uniq.length; miss += no.length;
  md += `## ${title}: ${uniq.length - no.length} من ${uniq.length} متغطيين\n\n`;
  md += no.length ? no.map(r => `- ❌ ${r.l}`).join('\n') + '\n\n' : '- ✅ كله متغطي\n\n';
  lines.push(`${title}: ${uniq.length - no.length}/${uniq.length}` + (no.length ? '  ناقص: ' + no.map(r => r.l).join('، ') : ''));
}
md = md.replace('\n\n## ', `\n\n**الإجمالي: ${total - miss} من ${total} كارت متغطي، و${miss} ناقص.**\n\n## `);
console.log(lines.join('\n') + `\n\nالإجمالي: ${total - miss}/${total} (ناقص ${miss})`);
const out = process.argv.indexOf('--md');
if (out > 0 && process.argv[out + 1]) fs.writeFileSync(path.join(process.cwd(), process.argv[out + 1]), md);
