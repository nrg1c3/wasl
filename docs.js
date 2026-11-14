/* Badalak document cards (issue #19).
   When the other person asks for a paper («هات البطاقة», «الباسبور لو سمحت»), the Deaf user sees a big drawing of it
   with one word under it. The words are matched on the phone itself, in the text that is already on the screen:
   no new request to the server, nothing stored. The drawings are ours, all marked «نموذج»: never a real person's ID.
   Used by index.html and counter.html:
     WaslDocs.find(text)            -> doc or null
     WaslDocs.show(doc, {en, onUnclear(doc), buzz})   big card on top until the user closes it */
(function () {
  'use strict';
  const norm = s => String(s || '').toLowerCase()
    .replace(/[ً-ْـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي');

  /* card shell: rounded card, "نموذج" stamp */
  const stamp = (x, y, r) => `<g transform="rotate(${r || -12} ${x} ${y})"><rect x="${x - 34}" y="${y - 12}" width="68" height="24" rx="5" fill="none" stroke="#C62828" stroke-width="2.5"/><text x="${x}" y="${y + 6}" text-anchor="middle" font-size="15" font-weight="800" fill="#C62828" font-family="Cairo,Tahoma,sans-serif">نموذج</text></g>`;
  const person = (x, y, s, c) => `<rect x="${x}" y="${y}" width="${36 * s}" height="${44 * s}" rx="4" fill="#fff" stroke="${c}" stroke-width="2"/><circle cx="${x + 18 * s}" cy="${y + 16 * s}" r="${8 * s}" fill="${c}"/><path d="M${x + 5 * s} ${y + 42 * s}q${13 * s}-${18 * s} ${26 * s} 0" fill="${c}"/>`;
  const lines = (x, y, n, w, c) => Array.from({ length: n }, (_, i) => `<rect x="${x}" y="${y + i * 12}" width="${i % 2 ? w * 0.7 : w}" height="5" rx="2.5" fill="${c}"/>`).join('');
  const landscape = (bg, edge, extra) => `<svg dir="ltr" viewBox="0 0 200 128" aria-hidden="true"><rect x="2" y="2" width="196" height="124" rx="12" fill="${bg}" stroke="${edge}" stroke-width="3"/>${extra}</svg>`;
  const paper = extra => `<svg dir="ltr" viewBox="0 0 150 190" aria-hidden="true"><path d="M4 4h112l30 30v152H4z" fill="#fff" stroke="#5B6B73" stroke-width="3"/><path d="M116 4v30h30" fill="#E7ECEE" stroke="#5B6B73" stroke-width="3"/>${extra}</svg>`;

  const DOCS = [
    { id: 'bankcard', ar: 'كارت البنك', en: 'Bank card',
      re: /(فيزا|ماستر ?كارد|كارت (ال)?بنك|كارت ال(ا)?ئتمان|بطاق(ه)? (ال)?(ا)?ئتمان|كريدت|\bvisa\b|credit card|debit card|bank card)/,
      svg: landscape('#1E3A47', '#13262F', '<rect x="22" y="40" width="34" height="26" rx="5" fill="#E9C46A"/><path d="M22 53h34M39 40v26" stroke="#B8902F" stroke-width="2"/>' +
        '<text x="22" y="98" direction="ltr" text-anchor="start" font-size="17" fill="#fff" font-family="monospace" letter-spacing="1">•••• •••• ••••</text>' + stamp(150, 40)) },
    { id: 'national', ar: 'البطاقة (الرقم القومي)', en: 'National ID card',
      re: /(بطاق(ه|تك|ته) ?(ال)?(شخصي(ه)?|قومي(ه)?)?|(ال)?رقم (ال)?قومي|\bid card\b|national id|identity card|\bthe id\b|your id\b)/,
      not: /تموين/, // the ration card is another paper
      svg: landscape('#E3F2E8', '#2E7D4F', person(16, 30, 1.6, '#2E7D4F') + lines(90, 34, 4, 90, '#9CC9AE') + stamp(140, 100)) },
    { id: 'passport', ar: 'الباسبور', en: 'Passport',
      re: /(باسبور|جواز (ال)?سفر|passport)/,
      svg: `<svg dir="ltr" viewBox="0 0 150 196" aria-hidden="true"><rect x="4" y="4" width="142" height="188" rx="10" fill="#7A1F2B" stroke="#4E121A" stroke-width="3"/><circle cx="75" cy="82" r="30" fill="none" stroke="#E9C46A" stroke-width="4"/><path d="M75 58v48M53 82h44" stroke="#E9C46A" stroke-width="3"/><rect x="35" y="130" width="80" height="8" rx="4" fill="#E9C46A"/>${stamp(75, 166)}</svg>` },
    { id: 'drive', ar: 'رخصة السواقة', en: 'Driving licence',
      re: /(رخص(ه|ة|تك|ته)? (ال)?(قياد(ه)?|سواق(ه)?|سوقان)|driving licen[cs]e|driver'?s licen[cs]e)/,
      svg: landscape('#E3EEFA', '#2B67B5', person(16, 30, 1.6, '#2B67B5') + '<circle cx="128" cy="58" r="24" fill="none" stroke="#2B67B5" stroke-width="5"/><circle cx="128" cy="58" r="6" fill="#2B67B5"/><path d="M104 58h18M134 58h18M128 64v18" stroke="#2B67B5" stroke-width="5"/>' + stamp(150, 106, -8)) },
    { id: 'car', ar: 'رخصة العربية', en: 'Car licence',
      re: /(رخص(ه|ة|تك|ته)? (ال)?(عربي(ه)?|سيار(ه)?)|car (licen[cs]e|registration)|vehicle registration)/,
      svg: landscape('#EEF0E6', '#6B7A34', '<path d="M34 78l12-26h70l14 26" fill="none" stroke="#6B7A34" stroke-width="6" stroke-linejoin="round"/><rect x="24" y="76" width="118" height="26" rx="8" fill="#6B7A34"/><circle cx="50" cy="104" r="9" fill="#33401A"/><circle cx="118" cy="104" r="9" fill="#33401A"/>' + lines(150, 30, 3, 36, '#B9C29A') + stamp(152, 104, -8)) },
    { id: 'birth', ar: 'شهادة الميلاد', en: 'Birth certificate',
      re: /(شهاد(ه|ة)? (ال)?ميلاد|birth certificate)/,
      svg: paper('<circle cx="75" cy="52" r="16" fill="none" stroke="#8E6BB8" stroke-width="3"/><path d="M75 42v20M67 50l8-8 8 8" stroke="#8E6BB8" stroke-width="3" fill="none"/>' + lines(22, 86, 5, 104, '#C9D2D6') + stamp(80, 160)) },
    { id: 'rx', ar: 'الروشتة', en: 'Prescription',
      re: /(روشت(ه|ة|تك|ته)|prescription)/,
      svg: paper('<text x="20" y="62" direction="ltr" text-anchor="start" font-size="44" font-weight="800" fill="#2E7D4F" font-family="Georgia,serif">Rx</text>' + lines(22, 88, 5, 104, '#C9D2D6') + stamp(82, 160)) }
  ];

  /* the bank card is checked first: «بطاقة ائتمان» is a bank card, not the national ID */
  function find(text) {
    const t = norm(text);
    if (!t) return null;
    for (const d of DOCS) if (d.re.test(t) && !(d.not && d.not.test(t))) return d;
    return null;
  }

  const shownAt = {};
  let box = null;
  function ensureBox() {
    if (box) return box;
    const css = document.createElement('style');
    css.textContent = '#docPop{position:fixed;inset-inline:12px;top:12px;margin:auto;max-width:420px;z-index:60;background:#fff;color:#13262F;border-radius:22px;' +
      'box-shadow:0 12px 40px rgba(0,0,0,.35);padding:14px 14px 12px;display:flex;flex-direction:column;align-items:center;gap:8px;border:4px solid #FFD54A;' +
      'animation:docIn .25s ease-out;font-family:Cairo,Tahoma,sans-serif}' +
      '#docPop.hidden{display:none}#docPop .dq{font-weight:800;font-size:16px;color:#5B6B73;margin:0}' +
      '#docPop .dimg{width:min(72vw,260px);max-height:34vh;display:flex;justify-content:center}#docPop .dimg svg{width:100%;height:100%;max-height:34vh}' +
      '#docPop .dw{font-weight:800;font-size:28px;line-height:1.25;text-align:center;margin:0}' +
      '#docPop .drow{display:flex;gap:8px;width:100%}#docPop .drow button{flex:1;min-height:56px;border:0;border-radius:14px;font:800 18px Cairo,Tahoma,sans-serif;padding:4px 10px}' +
      '#docPop .dok{background:#2E7D4F;color:#fff}#docPop .dno{background:#EEF1F2;color:#13262F}' +
      '@keyframes docIn{from{transform:translateY(-16px);opacity:0}to{transform:none;opacity:1}}';
    document.head.appendChild(css);
    box = document.createElement('div');
    box.id = 'docPop'; box.className = 'hidden'; box.setAttribute('role', 'alertdialog'); box.setAttribute('aria-live', 'assertive');
    document.body.appendChild(box);
    return box;
  }

  function hide() { if (box) box.classList.add('hidden'); }

  /* opts: en (English screen), onUnclear(doc) (tell the other person), buzz(pattern) */
  function show(doc, opts) {
    if (!doc) return false;
    opts = opts || {};
    const now = Date.now();
    if (shownAt[doc.id] && now - shownAt[doc.id] < 60000) return false; // same paper asked again soon: don't pop it again
    shownAt[doc.id] = now;
    const en = !!opts.en, b = ensureBox();
    b.setAttribute('aria-label', en ? doc.en : doc.ar);
    b.innerHTML = `<p class="dq">${en ? 'They are asking for:' : 'بيطلب منك:'}</p><div class="dimg">${doc.svg}</div><p class="dw">${en ? doc.en : doc.ar}</p>` +
      `<div class="drow"><button type="button" class="dok">✅ ${en ? 'Got it' : 'فاهم'}</button><button type="button" class="dno">❓ ${en ? 'Not clear' : 'مش فاهم'}</button></div>`;
    b.querySelector('.dok').onclick = hide;
    b.querySelector('.dno').onclick = () => { hide(); if (opts.onUnclear) opts.onUnclear(doc); };
    b.classList.remove('hidden');
    try { opts.buzz ? opts.buzz([120, 60, 120]) : (navigator.vibrate && navigator.vibrate([120, 60, 120])); } catch (e) {}
    setTimeout(() => { try { b.querySelector('.dok').focus({ preventScroll: true }); } catch (e) {} }, 50);
    return true;
  }

  window.WaslDocs = { find, show, hide, list: DOCS };
})();
