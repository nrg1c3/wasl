/* Wasl — sign → voice, on the phone (window.WaslS2V).
   The Deaf user signs to the front camera. MediaPipe finds the hands and the upper body in each frame, ON THE PHONE;
   no video or picture ever leaves it. Each sign («hands down → sign → hands down») becomes a short sequence of numbers
   (feature frames), resampled to a fixed length, and is compared (DTW) with templates:
     (a) the user's own recorded takes (IndexedDB, this phone only)
     (b) library templates extracted from the expert's clips: signs/templates/<ID>.json (server/signs_templates.py).
   recognize(seq) is the one door: a trained classifier (TF.js) can replace DTW later with setClassifier(fn).

   Feature frame (DIM = 96), coordinates in shoulder widths, centre = middle of the shoulders, x right in the image:
     [0..42]   the signer's RIGHT hand: present(0/1), wrist x, wrist y, then 20 points (1..20) minus the wrist,
               divided by the hand size (wrist → middle-finger knuckle), x and y each
     [43..85]  the signer's LEFT hand, same layout
     [86..95]  pose: nose, right elbow, left elbow, right wrist, left wrist (x, y each)
   A hand is matched to the body side by the nearest pose wrist (fallback: image side). The same function is written in
   Python in server/signs_templates.py; keep the two identical (FEAT names the version). */
(function (root) {
  'use strict';
  const FEAT = 'wasl-s2v-1', T_LEN = 32, DIM = 96, HAND = 43, POSE_OFF = 86;
  const REST_Y = 1.4;          // a wrist lower than this (shoulder widths under the shoulder line) is "hands down"
  const Q = 0.05;              // template quantisation step (Int8 × Q)

  /* ---------- features ---------- */
  function frameFeatures(hands, pose, aspect) {
    const a = aspect || 1, f = new Float32Array(DIM);
    // some MediaPipe builds report visibility 0 for every pose point: then trust the points
    const noVis = !pose || pose.every(p => !p || !p.visibility);
    const ok = p => p && (noVis || p.visibility > 0.5);
    let cx = 0.5 * a, cy = 0.45, sw = 0.25, havePose = false;
    if (pose && ok(pose[11]) && ok(pose[12])) {
      const ls = pose[11], rs = pose[12], w = Math.hypot((ls.x - rs.x) * a, ls.y - rs.y);
      if (w > 0.02) { cx = (ls.x + rs.x) / 2 * a; cy = (ls.y + rs.y) / 2; sw = w; havePose = true; }
    }
    const P = p => [(p.x * a - cx) / sw, (p.y - cy) / sw];
    hands = (hands || []).filter(h => h && h.length >= 21).slice(0, 2);
    // which hand is the signer's right one: nearest pose wrist (16 = right, 15 = left); else image side
    // (the camera image is not mirrored: the signer's right hand is on the image's left, smaller x)
    let slots = [null, null];
    if (hands.length) {
      const pw = havePose && ok(pose[16]) && ok(pose[15]) ? [P(pose[16]), P(pose[15])] : null;
      const d = (h, s) => { const w = P(h[0]); return Math.hypot(w[0] - pw[s][0], w[1] - pw[s][1]); };
      if (hands.length === 1) {
        const h = hands[0];
        const right = pw ? d(h, 0) <= d(h, 1) : P(h[0])[0] < 0;
        slots[right ? 0 : 1] = h;
      } else {
        const [h0, h1] = hands;
        const keep = pw ? d(h0, 0) + d(h1, 1) <= d(h0, 1) + d(h1, 0) : h0[0].x <= h1[0].x;
        slots = keep ? [h0, h1] : [h1, h0];
      }
    }
    slots.forEach((h, s) => {
      if (!h) return;
      const o = s * HAND, w = P(h[0]), m = P(h[9]);
      const hs = Math.hypot(m[0] - w[0], m[1] - w[1]) || 1e-3;
      f[o] = 1; f[o + 1] = w[0]; f[o + 2] = w[1];
      for (let i = 1; i < 21; i++) { const p = P(h[i]); f[o + 1 + i * 2] = (p[0] - w[0]) / hs; f[o + 2 + i * 2] = (p[1] - w[1]) / hs; }
    });
    if (havePose) [0, 14, 13, 16, 15].forEach((k, i) => { if (ok(pose[k])) { const p = P(pose[k]); f[POSE_OFF + i * 2] = p[0]; f[POSE_OFF + i * 2 + 1] = p[1]; } });
    return f;
  }
  const handsUp = f => (f[0] > 0.5 && f[2] < REST_Y) || (f[HAND] > 0.5 && f[HAND + 2] < REST_Y);
  const anyHand = f => f[0] > 0.5 || f[HAND] > 0.5;

  /* short dropouts (≤ maxGap frames) of a hand that was there: carry the last values forward */
  function fillGaps(frames, maxGap) {
    maxGap = maxGap == null ? 3 : maxGap;
    const out = frames.map(f => Float32Array.from(f));
    for (let s = 0; s < 2; s++) {
      const o = s * HAND;
      let last = -1;
      for (let i = 0; i < out.length; i++) {
        if (out[i][o] > 0.5) {
          if (last >= 0 && i - last - 1 > 0 && i - last - 1 <= maxGap)
            for (let j = last + 1; j < i; j++) out[j].set(out[last].subarray(o, o + HAND), o);
          last = i;
        }
      }
    }
    return out;
  }

  /* the active part of a take or a clip: first "hands up" (minus `pre` frames) to the last "hands up" */
  function trimActive(frames, ts, pre) {
    pre = pre == null ? 2 : pre;
    const g = fillGaps(frames);
    let a = -1, b = -1;
    for (let i = 0; i < g.length; i++) if (handsUp(g[i])) { if (a < 0) a = i; b = i; }
    if (a < 0) return null;
    a = Math.max(0, a - pre);
    return { frames: g.slice(a, b + 1), ts: ts.slice(a, b + 1) };
  }

  /* time-based linear resampling to n frames → one flat Float32Array(n × DIM) */
  function resample(frames, ts, n) {
    n = n || T_LEN;
    const out = new Float32Array(n * DIM), L = frames.length;
    if (!L) return out;
    if (!ts || ts.length !== L) ts = frames.map((_, i) => i);
    const t0 = ts[0], t1 = ts[L - 1];
    let j = 0;
    for (let k = 0; k < n; k++) {
      const t = L === 1 || t1 === t0 ? t0 : t0 + (t1 - t0) * k / (n - 1);
      while (j < L - 2 && ts[j + 1] < t) j++;
      const ta = ts[j], tb = ts[Math.min(j + 1, L - 1)], A = frames[j], B = frames[Math.min(j + 1, L - 1)];
      const u = tb > ta ? Math.min(1, Math.max(0, (t - ta) / (tb - ta))) : 0;
      for (let d = 0; d < DIM; d++) out[k * DIM + d] = A[d] + (B[d] - A[d]) * u;
    }
    return out;
  }

  /* the same sign done with the other hand (left-handed signer, or a mirrored clip) */
  function mirror(seq) {
    const n = seq.length / DIM, out = new Float32Array(seq.length);
    for (let k = 0; k < n; k++) {
      const o = k * DIM;
      for (let s = 0; s < 2; s++) {
        const src = o + s * HAND, dst = o + (1 - s) * HAND;
        out[dst] = seq[src];
        for (let i = 1; i < HAND; i += 2) { out[dst + i] = -seq[src + i]; out[dst + i + 1] = seq[src + i + 1]; }
      }
      const p = o + POSE_OFF, sw = [0, 2, 1, 4, 3]; // nose, R elbow↔L elbow, R wrist↔L wrist
      for (let i = 0; i < 5; i++) { out[p + sw[i] * 2] = -seq[p + i * 2]; out[p + sw[i] * 2 + 1] = seq[p + i * 2 + 1]; }
    }
    return out;
  }

  /* ---------- DTW ---------- */
  const W = new Float32Array(DIM);
  for (let s = 0; s < 2; s++) { const o = s * HAND; W[o] = 1.5; W[o + 1] = W[o + 2] = 1.0; for (let i = 3; i < HAND; i++) W[o + i] = 0.35; }
  for (let i = POSE_OFF; i < DIM; i++) W[i] = 0.5;
  // a missing hand has zeros everywhere: compare only presence, not the zero positions (else "no hand" looks like "hand at the centre")
  function frameDist(a, ia, b, ib) {
    let s = 0;
    for (let h = 0; h < 2; h++) {
      const o = h * HAND, pa = a[ia + o], pb = b[ib + o], dp = pa - pb;
      s += W[o] * dp * dp;
      const both = Math.min(pa, pb);
      if (both > 0.05) for (let i = 1; i < HAND; i++) { const d = a[ia + o + i] - b[ib + o + i]; s += both * W[o + i] * d * d; }
    }
    for (let i = POSE_OFF; i < DIM; i++) { const d = a[ia + i] - b[ib + i]; s += W[i] * d * d; }
    return Math.sqrt(s);
  }
  function dtw(a, b, band) {
    const n = a.length / DIM, m = b.length / DIM, r = Math.max(band == null ? 6 : band, Math.abs(n - m));
    const INF = 1e18;
    let prev = new Float64Array(m + 1).fill(INF), cur = new Float64Array(m + 1).fill(INF);
    prev[0] = 0;
    for (let i = 1; i <= n; i++) {
      cur.fill(INF);
      const lo = Math.max(1, i - r), hi = Math.min(m, i + r);
      for (let j = lo; j <= hi; j++) {
        const c = frameDist(a, (i - 1) * DIM, b, (j - 1) * DIM);
        cur[j] = c + Math.min(prev[j], cur[j - 1], prev[j - 1]);
      }
      const t = prev; prev = cur; cur = t;
    }
    return prev[m] / (n + m);
  }

  /* ---------- the recogniser (kNN over DTW) ---------- */
  const TH = { sure: 1.1, max: 2.2, margin: 0.8 }; // tuned on synthetic data; re-tune with the expert's clips
  function Recognizer() { this.tpl = []; }
  Recognizer.prototype.set = function (list) { this.tpl = list.filter(t => t && t.seq && t.seq.length === T_LEN * DIM); };
  Recognizer.prototype.add = function (t) { this.set(this.tpl.concat([t])); };
  Recognizer.prototype.recognize = function (seq, k) {
    k = k || 3;
    const best = {};
    let mir = null;
    for (const t of this.tpl) {
      let d = dtw(seq, t.seq);
      if (t.src === 'lib') { mir = mir || mirror(seq); d = Math.min(d, dtw(mir, t.seq)); }
      const b = best[t.id];
      if (!b || d < b.dist) best[t.id] = { id: t.id, dist: d, src: t.src };
    }
    const top = Object.values(best).sort((x, y) => x.dist - y.dist).slice(0, k);
    top.forEach(x => { x.score = Math.round(100 * Math.exp(-x.dist / TH.sure * 0.7)) / 100; });
    const d1 = top[0] ? top[0].dist : Infinity, d2 = top[1] ? top[1].dist : Infinity;
    const sure = d1 < TH.sure && (d2 === Infinity || d1 < TH.margin * d2);
    return { top, sure, none: d1 >= TH.max };
  };
  const dtwRec = new Recognizer();
  let classifier = null;
  /* recognize(seq: Float32Array(T_LEN×DIM)) → Promise<{top:[{id,score,dist}], sure, none}>.
     A trained model replaces DTW with setClassifier(async seq => same shape). */
  async function recognize(seq) {
    if (classifier) { try { const r = await classifier(seq); if (r && r.top) return r; } catch (e) {} }
    return dtwRec.recognize(seq);
  }

  /* ---------- live segmentation: hands down → sign → hands down (or a hold button) ---------- */
  function Segmenter(o) {
    o = o || {};
    this.upN = o.upN || 3; this.downN = o.downN || 5; this.minF = o.minF || 6; this.maxMs = o.maxMs || 6000; this.pre = o.pre == null ? 2 : o.pre;
    this.reset();
  }
  Segmenter.prototype.reset = function () { this.state = 'rest'; this.buf = []; this.f = []; this.t = []; this.up = 0; this.down = 0; this.held = false; this.miss = [9, 9]; this.last = null; };
  Segmenter.prototype.hold = function (on) {
    if (on) { this.held = true; this.state = 'sign'; this.f = []; this.t = []; this.down = 0; return null; }
    this.held = false; const r = this._emit(true); this.state = 'rest'; return r;
  };
  Segmenter.prototype._fill = function (f) { // carry a hand over a dropout of ≤ 3 frames
    const g = Float32Array.from(f);
    for (let s = 0; s < 2; s++) {
      const o = s * HAND;
      if (g[o] > 0.5) this.miss[s] = 0;
      else if (this.last && this.last[o] > 0.5 && ++this.miss[s] <= 3) g.set(this.last.subarray(o, o + HAND), o);
    }
    this.last = g; return g;
  };
  Segmenter.prototype._emit = function (manual) {
    let f = this.f, t = this.t;
    if (!manual) { const n = this.f.length - this.down; f = f.slice(0, n); t = t.slice(0, n); }
    this.f = []; this.t = []; this.down = 0; this.up = 0; this.buf = [];
    if (manual) { const r = trimActive(f, t, this.pre); if (!r) return null; f = r.frames; t = r.ts; }
    if (f.length < this.minF || !f.some(anyHand)) return null;
    return { frames: f, ts: t, seq: resample(f, t, T_LEN), ms: t[t.length - 1] - t[0] };
  };
  /* push one feature frame (time in ms) → a finished sign {frames, ts, seq, ms} or null */
  Segmenter.prototype.push = function (feat, ms) {
    const g = this._fill(feat), up = handsUp(feat); // "up" from what the camera really saw; g fills short dropouts
    if (this.held) { this.f.push(g); this.t.push(ms); return null; }
    if (this.state === 'rest' || this.state === 'wait') {
      this.buf.push([g, ms]); if (this.buf.length > this.pre + this.upN) this.buf.shift();
      if (this.state === 'wait') { this.down = up ? 0 : this.down + 1; if (this.down >= this.downN) { this.state = 'rest'; this.down = 0; } this.up = 0; return null; }
      this.up = up ? this.up + 1 : 0;
      if (this.up >= this.upN) { this.state = 'sign'; this.f = this.buf.map(x => x[0]); this.t = this.buf.map(x => x[1]); this.buf = []; this.down = 0; }
      return null;
    }
    this.f.push(g); this.t.push(ms);
    this.down = up ? 0 : this.down + 1;
    if (this.down >= this.downN) { this.state = 'rest'; return this._emit(false); }
    if (ms - this.t[0] > this.maxMs) { const r = this._emit(false); this.state = 'wait'; return r; } // too long: send what we have, wait for hands down
    return null;
  };

  /* ---------- template file encoding: Int8 × 0.05, base64 ---------- */
  function encode(seq) {
    const b = new Int8Array(seq.length);
    for (let i = 0; i < seq.length; i++) b[i] = Math.max(-127, Math.min(127, Math.round(seq[i] / Q)));
    let s = ''; const u = new Uint8Array(b.buffer);
    for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
    return (root.btoa ? root.btoa(s) : Buffer.from(s, 'binary').toString('base64'));
  }
  function decode(b64) {
    const s = root.atob ? root.atob(b64) : Buffer.from(b64, 'base64').toString('binary');
    const out = new Float32Array(s.length);
    for (let i = 0; i < s.length; i++) { let v = s.charCodeAt(i); if (v > 127) v -= 256; out[i] = v * Q; }
    return out;
  }
  /* signs/templates/<ID>.json → [{id, src:'lib', signer, seq}] */
  function fromTemplateFile(j) {
    if (!j || j.feat !== FEAT || j.len !== T_LEN || j.dim !== DIM) return [];
    return (j.samples || []).map(s => ({ id: j.id, src: 'lib', signer: s.signer, seq: s.b64 ? decode(s.b64) : Float32Array.from([].concat.apply([], s.frames || [])) }))
      .filter(t => t.seq.length === T_LEN * DIM);
  }

  /* ---------- the user's own takes: IndexedDB «wasl-signs», on this phone only ---------- */
  const DBN = 'wasl-signs', ST = 'takes';
  function idb() {
    return new Promise((res, rej) => {
      if (!root.indexedDB) return rej(new Error('noidb'));
      const r = root.indexedDB.open(DBN, 1);
      r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains(ST)) d.createObjectStore(ST, { keyPath: 'k', autoIncrement: true }); };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  }
  async function tx(mode, fn) {
    const d = await idb();
    return new Promise((res, rej) => { const t = d.transaction(ST, mode), s = t.objectStore(ST); const out = fn(s); t.oncomplete = () => { d.close(); res(out && out.result !== undefined ? out.result : out); }; t.onerror = () => { d.close(); rej(t.error); }; });
  }
  const mine = {
    all: () => tx('readonly', s => s.getAll()).then(l => l || []).catch(() => []),
    add: rec => tx('readwrite', s => s.add(Object.assign({ t: Date.now() }, rec, { b64: rec.b64 || encode(rec.seq), seq: undefined }))),
    delLabel: async label => { const l = await mine.all(); return tx('readwrite', s => { l.filter(r => r.label === label).forEach(r => s.delete(r.k)); }); },
    clear: () => tx('readwrite', s => s.clear()).catch(() => {}),
    templates: async () => (await mine.all()).map(r => ({ id: r.id, label: r.label, icon: r.icon, src: 'me', seq: decode(r.b64) })).filter(t => t.seq.length === T_LEN * DIM)
  };

  /* ---------- the camera engine (MediaPipe Hand + Pose lite, ≤ 15 frames a second) ---------- */
  const MP = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
  const MODELS = {
    hand: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
    pose: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task'
  };
  const Engine = {
    hand: null, pose: null, stream: null, video: null, on: false, timer: 0, fps: 15, ms: 0, frames: 0, poseEvery: 1, lastPose: null, n: 0, onFrame: null,
    async load() {
      if (this.hand) return;
      const vision = await import(MP + '/vision_bundle.mjs');
      const fs = await vision.FilesetResolver.forVisionTasks(MP + '/wasm');
      const mk = async (Cls, path, o) => {
        try { return await Cls.createFromOptions(fs, Object.assign({ baseOptions: { modelAssetPath: path, delegate: 'GPU' }, runningMode: 'VIDEO' }, o)); }
        catch (e) { return await Cls.createFromOptions(fs, Object.assign({ baseOptions: { modelAssetPath: path, delegate: 'CPU' }, runningMode: 'VIDEO' }, o)); }
      };
      this.hand = await mk(vision.HandLandmarker, MODELS.hand, { numHands: 2, minHandDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
      this.pose = await mk(vision.PoseLandmarker, MODELS.pose, { numPoses: 1 });
    },
    async start(video, onFrame) {
      this.video = video; this.onFrame = onFrame;
      if (!this.stream) {
        this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 480 }, height: { ideal: 640 }, frameRate: { ideal: 30, max: 30 } }, audio: false });
        video.srcObject = this.stream; video.muted = true; video.playsInline = true;
        await video.play();
      }
      this.on = true; this.loop();
    },
    loop() {
      if (!this.on) return;
      clearTimeout(this.timer);
      if (document.hidden) return; // resumes on visibilitychange
      const t0 = performance.now(), v = this.video;
      if (v && v.readyState >= 2 && v.videoWidth && this.hand) {
        try {
          const hr = this.hand.detectForVideo(v, t0);
          if (this.n++ % this.poseEvery === 0) { const pr = this.pose.detectForVideo(v, t0); this.lastPose = (pr.landmarks && pr.landmarks[0]) || null; }
          const hands = hr.landmarks || [], asp = v.videoWidth / v.videoHeight;
          const feat = frameFeatures(hands, this.lastPose, asp);
          const took = performance.now() - t0;
          this.ms = this.ms ? this.ms * 0.9 + took * 0.1 : took; this.frames++;
          // slow phone: run the body model every 2nd frame, then drop to 10 frames a second
          this.poseEvery = this.ms > 45 ? 2 : 1; this.fps = this.ms > 80 ? 10 : 15;
          this.onFrame && this.onFrame({ hands, pose: this.lastPose, feat, t: t0, ms: took });
        } catch (e) {}
      }
      const wait = Math.max(5, 1000 / this.fps - (performance.now() - t0));
      this.timer = setTimeout(() => this.loop(), wait);
    },
    pause() { this.on = false; clearTimeout(this.timer); },
    stop() { this.pause(); if (this.stream) this.stream.getTracks().forEach(t => t.stop()); this.stream = null; if (this.video) this.video.srcObject = null; }
  };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => {
    if (!Engine.stream) return;
    if (document.hidden) { clearTimeout(Engine.timer); Engine.stream.getVideoTracks().forEach(t => t.enabled = false); }
    else { Engine.stream.getVideoTracks().forEach(t => t.enabled = true); if (Engine.on) Engine.loop(); }
  });

  root.WaslS2V = {
    FEAT, T_LEN, DIM, HAND, POSE_OFF, REST_Y, TH, MODELS, MP,
    frameFeatures, handsUp, anyHand, fillGaps, trimActive, resample, mirror, frameDist, dtw,
    Recognizer, Segmenter, recognize, dtw_recognizer: dtwRec,
    setClassifier(fn) { classifier = typeof fn === 'function' ? fn : null; },
    hasClassifier: () => !!classifier,
    setTemplates(list) { dtwRec.set(list); },
    encode, decode, fromTemplateFile, mine, Engine,
    clearAll: () => mine.clear()
  };
})(typeof window !== 'undefined' ? window : globalThis);
