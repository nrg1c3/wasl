/* Badalak medicine-shape cards (issue #20).
   At the pharmacy the Deaf user picks the shape they want (tablets, syrup, drops...) from big drawings, confirms it,
   and the sentence goes to the pharmacist. General shapes only: no medicine names, no boxes, no brands, no doses,
   no medical advice. The choice is the user's; the app adds nothing to it.
   Used by counter.html (pharmacy) and index.html (translation screen):
     WaslMeds.open({lang:'ar'|'gulf'|'en', send:'label of the confirm button', onPick(sentence, item)}) */
(function () {
  'use strict';
  const S = (inner, vb) => `<svg dir="ltr" viewBox="${vb || '0 0 120 120'}" aria-hidden="true">${inner}</svg>`;
  const MEDS = [
    { id: 'tablets', ar: 'أقراص', gu: 'حبوب', en: 'Tablets', say: { ar: 'أقراص', gu: 'حبوب', en: 'tablets' },
      svg: S('<circle cx="42" cy="48" r="26" fill="#fff" stroke="#2B67B5" stroke-width="5"/><path d="M24 48h36" stroke="#2B67B5" stroke-width="4"/><circle cx="80" cy="82" r="22" fill="#DCE9F8" stroke="#2B67B5" stroke-width="5"/><path d="M65 82h30" stroke="#2B67B5" stroke-width="4"/>') },
    { id: 'capsules', ar: 'كبسولات', gu: 'كبسولات', en: 'Capsules', say: { ar: 'كبسولات', gu: 'كبسولات', en: 'capsules' },
      svg: S('<g transform="rotate(-35 60 60)"><rect x="18" y="42" width="84" height="36" rx="18" fill="#fff" stroke="#C0392B" stroke-width="5"/><path d="M60 42v36" stroke="#C0392B" stroke-width="5"/><path d="M36 42h24v36H36a18 18 0 0 1 0-36z" fill="#F4C7C1"/></g>') },
    { id: 'syrup', ar: 'شراب', gu: 'شراب', en: 'Syrup', say: { ar: 'شراب', gu: 'شراب', en: 'syrup' },
      svg: S('<rect x="40" y="12" width="28" height="14" rx="3" fill="#7A5230"/><path d="M36 26h36v10l8 12v58a6 6 0 0 1-6 6H34a6 6 0 0 1-6-6V48l8-12z" fill="#F6E3C8" stroke="#7A5230" stroke-width="5" stroke-linejoin="round"/><rect x="34" y="62" width="40" height="24" rx="3" fill="#fff" stroke="#7A5230" stroke-width="3"/><path d="M86 88q14-4 22 4" stroke="#7A5230" stroke-width="5" fill="none" stroke-linecap="round"/><ellipse cx="80" cy="90" rx="10" ry="6" fill="#F6E3C8" stroke="#7A5230" stroke-width="4"/>') },
    { id: 'injection', ar: 'حقنة', gu: 'إبرة', en: 'Injection', say: { ar: 'حقنة', gu: 'إبرة', en: 'an injection' },
      svg: S('<g transform="rotate(-45 60 60)"><rect x="34" y="46" width="52" height="28" rx="4" fill="#E3F2E8" stroke="#2E7D4F" stroke-width="5"/><path d="M44 46v10M56 46v10M68 46v10" stroke="#2E7D4F" stroke-width="3"/><path d="M86 60h20M106 52v16M20 60h14M14 54v12" stroke="#2E7D4F" stroke-width="5" stroke-linecap="round"/><path d="M20 60H2" stroke="#2E7D4F" stroke-width="3"/></g>') },
    { id: 'cream', ar: 'كريم أو مرهم', gu: 'كريم أو مرهم', en: 'Cream', say: { ar: 'كريم أو مرهم', gu: 'كريم أو مرهم', en: 'a cream or ointment' },
      svg: S('<g transform="rotate(-30 60 60)"><path d="M20 44h62l14 8v16l-14 8H20z" fill="#fff" stroke="#8E6BB8" stroke-width="5" stroke-linejoin="round"/><rect x="96" y="54" width="14" height="12" rx="2" fill="#8E6BB8"/><path d="M20 40v40" stroke="#8E6BB8" stroke-width="6"/><rect x="34" y="52" width="36" height="16" rx="3" fill="#E9E0F4"/></g>') },
    { id: 'drops', ar: 'نقط', gu: 'قطرة', en: 'Drops', say: { ar: 'نقط', gu: 'قطرة', en: 'drops' },
      svg: S('<rect x="46" y="10" width="20" height="24" rx="8" fill="#1E3A47"/><path d="M42 34h28v42a14 14 0 0 1-28 0z" fill="#DCEFF4" stroke="#1E3A47" stroke-width="5"/><path d="M56 88v8" stroke="#1E3A47" stroke-width="4"/><path d="M56 100c-6 8-6 12 0 14 6-2 6-6 0-14z" fill="#3BA3C4"/><path d="M86 70c-5 7-5 10 0 12 5-2 5-5 0-12zM26 78c-4 6-4 8 0 10 4-2 4-4 0-10z" fill="#3BA3C4"/>') },
    { id: 'inhaler', ar: 'بخّاخ', gu: 'بخاخ', en: 'Inhaler', say: { ar: 'بخّاخ', gu: 'بخاخ', en: 'an inhaler' },
      svg: S('<rect x="38" y="10" width="30" height="58" rx="10" fill="#fff" stroke="#E07B39" stroke-width="5"/><path d="M30 64h46v20l20 8v20H40a10 10 0 0 1-10-10z" fill="#FBE3D2" stroke="#E07B39" stroke-width="5" stroke-linejoin="round"/><path d="M100 96q8 0 14-6M100 104q8 0 14 6" stroke="#E07B39" stroke-width="4" fill="none" stroke-linecap="round"/>') },
    { id: 'suppository', ar: 'لبوس', gu: 'تحاميل', en: 'Suppositories', say: { ar: 'لبوس', gu: 'تحاميل', en: 'suppositories' },
      svg: S('<path d="M30 92V52q0-30 18-30t18 30v40z" fill="#FFF6DC" stroke="#B8902F" stroke-width="5" stroke-linejoin="round"/><path d="M70 98V62q0-24 14-24t14 24v36z" fill="#FFF6DC" stroke="#B8902F" stroke-width="5" stroke-linejoin="round"/>') }
  ];

  const T = {
    ar: { q: '💊 عايز الدوا شكله إيه؟', note: 'اختار شكل واحد. الصيدلي هيشوف اختيارك.', back: 'رجوع', sent: s => `لو ينفع، عايز الدوا ده ${s}.` },
    gu: { q: '💊 تبي الدوا بأي شكل؟', note: 'اختر شكل واحد. الصيدلي بيشوف اختيارك.', back: 'رجوع', sent: s => `إذا ممكن، أبي الدوا هذا ${s}.` },
    en: { q: '💊 Which form do you want?', note: 'Pick one. The pharmacist will see your choice.', back: 'Back', sent: s => `If possible, I would like this medicine as ${s}.` }
  };

  let box = null;
  function ensure() {
    if (box) return box;
    const css = document.createElement('style');
    css.textContent = '#medPop{position:fixed;inset:0;z-index:55;background:rgba(10,20,25,.6);display:flex;align-items:flex-end;justify-content:center;font-family:Cairo,Tahoma,sans-serif}' +
      '#medPop.hidden{display:none}#medPop>div{background:#fff;color:#13262F;width:100%;max-width:560px;max-height:92vh;overflow:auto;border-radius:20px 20px 0 0;padding:16px 14px 20px;display:flex;flex-direction:column;gap:10px}' +
      '#medPop h2{margin:0;font-size:22px;text-align:center}#medPop .mn{margin:0;text-align:center;color:#5B6B73;font-weight:700;font-size:15px}' +
      '#medPop .mg{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}' +
      '#medPop .mg button{min-height:112px;border:2px solid #E2E7E9;border-radius:16px;background:#F7F9FA;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;font:800 18px Cairo,Tahoma,sans-serif;color:#13262F;padding:6px}' +
      '#medPop .mg svg{width:64px;height:64px}#medPop .mbig{display:flex;flex-direction:column;align-items:center;gap:6px}#medPop .mbig svg{width:140px;height:140px}' +
      '#medPop .mbig b{font-size:28px}#medPop .mbig p{margin:0;text-align:center;font-weight:700;color:#3E4E56;font-size:17px;line-height:1.5}' +
      '#medPop .mrow{display:flex;gap:8px}#medPop .mrow button,#medPop .mx{flex:1;min-height:56px;border:0;border-radius:14px;font:800 18px Cairo,Tahoma,sans-serif;padding:4px 10px}' +
      '#medPop .mok{background:#2E7D4F;color:#fff}#medPop .mx,#medPop .mno{background:#EEF1F2;color:#13262F}';
    document.head.appendChild(css);
    box = document.createElement('div');
    box.id = 'medPop'; box.className = 'hidden'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true');
    box.addEventListener('click', e => { if (e.target === box) close(); });
    document.body.appendChild(box);
    return box;
  }
  function close() { if (box) box.classList.add('hidden'); }

  function open(opts) {
    opts = opts || {};
    const L = opts.lang === 'en' ? 'en' : opts.lang === 'gulf' ? 'gu' : 'ar', t = T[L], b = ensure();
    const name = m => (L === 'en' ? m.en : L === 'gu' ? m.gu : m.ar);
    const grid = () => {
      b.innerHTML = `<div><h2>${t.q}</h2><p class="mn">${t.note}</p><div class="mg">` +
        MEDS.map((m, i) => `<button type="button" data-i="${i}">${m.svg}<span>${name(m)}</span></button>`).join('') +
        `</div><button type="button" class="mx">${t.back}</button></div>`;
      b.querySelectorAll('.mg button').forEach(x => x.onclick = () => confirm(MEDS[+x.dataset.i]));
      b.querySelector('.mx').onclick = close;
      b.setAttribute('aria-label', t.q);
    };
    /* a health choice: show it big with the exact sentence, the user sends it or goes back */
    const confirm = m => {
      const s = t.sent(m.say[L]);
      b.innerHTML = `<div><div class="mbig">${m.svg}<b>${name(m)}</b><p>${s}</p></div>` +
        `<div class="mrow"><button type="button" class="mok">✅ ${opts.send || 'OK'}</button><button type="button" class="mno">↩ ${t.back}</button></div></div>`;
      b.querySelector('.mok').onclick = () => { close(); if (opts.onPick) opts.onPick(s, m); };
      b.querySelector('.mno').onclick = grid;
      try { b.querySelector('.mok').focus({ preventScroll: true }); } catch (e) {}
    };
    grid();
    b.classList.remove('hidden');
  }

  window.WaslMeds = { open, close, list: MEDS };
})();
