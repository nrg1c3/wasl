#!/usr/bin/env python3
"""Wasl — build sign templates for sign → voice from the expert's clips.

For every published clip signs/clips/<ID>__<signer>.mp4 (made by server/signs_build.py; with --takes DIR also the
raw takes <ID>__<signer>__<take>.webm/.mp4 from record.html, which gives more templates per sign),
run MediaPipe Hand + Pose (the same two models the app uses on the phone), turn each frame into the same 96 numbers
the app computes (signs/s2v.js, frameFeatures — keep the two identical), cut the part between «hands down» and
«hands down», resample it to 32 frames, and write:

  signs/templates/<ID>.json
    {"v":1, "feat":"wasl-s2v-1", "id":"PHARMACY", "len":32, "dim":96, "q":0.05, "updated":"YYYY-MM-DD",
     "samples":[{"signer":"m1", "src":"signs/clips/PHARMACY__m1.mp4", "ms":2130, "b64":"<32×96 Int8 values × 0.05, base64>"}]}
  signs/templates/index.json
    {"v":1, "feat":"wasl-s2v-1", "updated":"YYYY-MM-DD", "ids":["PHARMACY", ...]}

The app loads index.json, then each listed <ID>.json (the service worker keeps them for offline use).
IDs are the vocab english_gloss with '/' replaced by '_' (signs/vocab.csv). Only signs whose direction is
both or sign2voice are built.

Setup (once, on a PC or the server — not needed by the app):
  pip install mediapipe opencv-python        (add --break-system-packages on Debian/Ubuntu's system Python)
  python3 server/signs_templates.py           # models are downloaded to server/models/ on first run
Options:
  --clips DIR   (default signs/clips)   --out DIR (default signs/templates)   --only ID,ID
  --takes DIR   also use raw takes (unpacked record.html ZIPs); run after signs_build.py so the IDs match
  --selftest FIXTURE.json   check this file's feature code against the app's (used by the tests; no MediaPipe needed)
"""
import argparse, base64, csv, datetime, glob, json, math, os, re, sys, urllib.request

FEAT, T_LEN, DIM, HAND, POSE_OFF, REST_Y, Q = 'wasl-s2v-1', 32, 96, 43, 86, 1.4, 0.05
FPS = 15  # the phone works at ≤ 15 frames a second; clips are sampled the same way
MODELS = {
    'hand_landmarker.task': 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
    'pose_landmarker_lite.task': 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
}
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)


# ---------- features: a line-by-line copy of signs/s2v.js ----------
def _g(p, k, d=None):
    if isinstance(p, dict):
        return p.get(k, d)
    return getattr(p, k, d)


def frame_features(hands, pose, aspect=1.0):
    a = aspect or 1.0
    f = [0.0] * DIM
    no_vis = (not pose) or all((not q) or not _g(q, 'visibility') for q in pose)

    def ok(p):
        return bool(p) and (no_vis or (_g(p, 'visibility') or 0) > 0.5)

    cx, cy, sw, have_pose = 0.5 * a, 0.45, 0.25, False
    if pose and ok(pose[11]) and ok(pose[12]):
        ls, rs = pose[11], pose[12]
        w = math.hypot((_g(ls, 'x') - _g(rs, 'x')) * a, _g(ls, 'y') - _g(rs, 'y'))
        if w > 0.02:
            cx, cy, sw, have_pose = (_g(ls, 'x') + _g(rs, 'x')) / 2 * a, (_g(ls, 'y') + _g(rs, 'y')) / 2, w, True

    def P(p):
        return ((_g(p, 'x') * a - cx) / sw, (_g(p, 'y') - cy) / sw)

    hands = [h for h in (hands or []) if h and len(h) >= 21][:2]
    slots = [None, None]
    if hands:
        pw = [P(pose[16]), P(pose[15])] if have_pose and ok(pose[16]) and ok(pose[15]) else None

        def d(h, s):
            w = P(h[0])
            return math.hypot(w[0] - pw[s][0], w[1] - pw[s][1])

        if len(hands) == 1:
            h = hands[0]
            right = d(h, 0) <= d(h, 1) if pw else P(h[0])[0] < 0
            slots[0 if right else 1] = h
        else:
            h0, h1 = hands
            keep = (d(h0, 0) + d(h1, 1) <= d(h0, 1) + d(h1, 0)) if pw else _g(h0[0], 'x') <= _g(h1[0], 'x')
            slots = [h0, h1] if keep else [h1, h0]
    for s, h in enumerate(slots):
        if not h:
            continue
        o, w, m = s * HAND, P(h[0]), P(h[9])
        hs = math.hypot(m[0] - w[0], m[1] - w[1]) or 1e-3
        f[o], f[o + 1], f[o + 2] = 1.0, w[0], w[1]
        for i in range(1, 21):
            p = P(h[i])
            f[o + 1 + i * 2] = (p[0] - w[0]) / hs
            f[o + 2 + i * 2] = (p[1] - w[1]) / hs
    if have_pose:
        for i, k in enumerate([0, 14, 13, 16, 15]):
            if ok(pose[k]):
                p = P(pose[k])
                f[POSE_OFF + i * 2], f[POSE_OFF + i * 2 + 1] = p[0], p[1]
    return f


def hands_up(f):
    return (f[0] > 0.5 and f[2] < REST_Y) or (f[HAND] > 0.5 and f[HAND + 2] < REST_Y)


def fill_gaps(frames, max_gap=3):
    out = [list(f) for f in frames]
    for s in range(2):
        o, last = s * HAND, -1
        for i in range(len(out)):
            if out[i][o] > 0.5:
                gap = i - last - 1
                if last >= 0 and 0 < gap <= max_gap:
                    for j in range(last + 1, i):
                        out[j][o:o + HAND] = out[last][o:o + HAND]
                last = i
    return out


def trim_active(frames, ts, pre=2):
    g = fill_gaps(frames)
    up = [i for i, f in enumerate(g) if hands_up(f)]
    if not up:
        return None
    a, b = max(0, up[0] - pre), up[-1]
    return g[a:b + 1], ts[a:b + 1]


def resample(frames, ts, n=T_LEN):
    L = len(frames)
    out = [0.0] * (n * DIM)
    if not L:
        return out
    if not ts or len(ts) != L:
        ts = list(range(L))
    t0, t1, j = ts[0], ts[-1], 0
    for k in range(n):
        t = t0 if (L == 1 or t1 == t0) else t0 + (t1 - t0) * k / (n - 1)
        while j < L - 2 and ts[j + 1] < t:
            j += 1
        jb = min(j + 1, L - 1)
        ta, tb, A, B = ts[j], ts[jb], frames[j], frames[jb]
        u = min(1.0, max(0.0, (t - ta) / (tb - ta))) if tb > ta else 0.0
        for d in range(DIM):
            out[k * DIM + d] = A[d] + (B[d] - A[d]) * u
    return out


def encode(seq):
    b = bytes((max(-127, min(127, int(math.floor(v / Q + 0.5)))) & 0xFF for v in seq))
    return base64.b64encode(b).decode('ascii')


# ---------- MediaPipe on a clip ----------
def models_dir():
    d = os.path.join(HERE, 'models')
    os.makedirs(d, exist_ok=True)
    for name, url in MODELS.items():
        p = os.path.join(d, name)
        if not os.path.exists(p):
            print('downloading', name, '...')
            try:
                urllib.request.urlretrieve(url, p + '.part')
                os.replace(p + '.part', p)
            except Exception as e:
                sys.exit(f'could not download {name} ({e}).\nDownload it by hand from\n  {url}\ninto {d}/ and run again.')
    return d


class Landmarks:
    def __init__(self):
        try:
            import mediapipe as mp
            from mediapipe.tasks import python as mpt
            from mediapipe.tasks.python import vision
        except ImportError:
            sys.exit('mediapipe is not installed: pip install mediapipe opencv-python (add --break-system-packages on system Python)')
        d = models_dir()
        self.mp, V = mp, vision
        self.hand = V.HandLandmarker.create_from_options(V.HandLandmarkerOptions(
            base_options=mpt.BaseOptions(model_asset_path=os.path.join(d, 'hand_landmarker.task')),
            running_mode=V.RunningMode.VIDEO, num_hands=2, min_hand_detection_confidence=0.5, min_tracking_confidence=0.5))
        self.pose = V.PoseLandmarker.create_from_options(V.PoseLandmarkerOptions(
            base_options=mpt.BaseOptions(model_asset_path=os.path.join(d, 'pose_landmarker_lite.task')),
            running_mode=V.RunningMode.VIDEO, num_poses=1))

    def clip(self, path):
        import cv2
        cap = cv2.VideoCapture(path)
        fps = cap.get(cv2.CAP_PROP_FPS) or 30
        frames, ts, i, next_t = [], [], 0, 0.0
        while True:
            okf, img = cap.read()
            if not okf:
                break
            t = i * 1000.0 / fps
            i += 1
            if t + 1e-6 < next_t:
                continue  # sample at ≤ 15 frames a second, like the phone
            next_t = t + 1000.0 / FPS
            h, w = img.shape[:2]
            im = self.mp.Image(image_format=self.mp.ImageFormat.SRGB, data=cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
            hr = self.hand.detect_for_video(im, int(t))
            pr = self.pose.detect_for_video(im, int(t))
            pose = pr.pose_landmarks[0] if pr.pose_landmarks else None
            frames.append(frame_features(hr.hand_landmarks or [], pose, w / h))
            ts.append(t)
        cap.release()
        return frames, ts


def vocab_ids(path):
    ids = set()
    with open(path, encoding='utf-8') as fh:
        for r in csv.DictReader(fh):
            if (r.get('direction') or '').strip() in ('both', 'sign2voice'):
                ids.add((r.get('english_gloss') or '').strip().replace('/', '_'))
    return ids


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--clips', default=os.path.join(REPO, 'signs', 'clips'))
    ap.add_argument('--out', default=os.path.join(REPO, 'signs', 'templates'))
    ap.add_argument('--vocab', default=os.path.join(REPO, 'signs', 'vocab.csv'))
    ap.add_argument('--only', default='')
    ap.add_argument('--takes', default='', help='folder with raw takes ID__signer__take.ext (optional)')
    ap.add_argument('--selftest', default='')
    a = ap.parse_args()

    if a.selftest:  # fixture: {"cases":[{"frames":[{"hands":..,"pose":..}],"ts":[..],"asp":..,"feat0":[..],"seq":[..],"b64":".."}]}
        fx = json.load(open(a.selftest, encoding='utf-8'))
        worst = 0.0
        bad_b64 = 0
        for c in fx['cases']:
            fr = [frame_features(x['hands'], x['pose'], c['asp']) for x in c['frames']]
            worst = max(worst, max(abs(p - q) for p, q in zip(fr[c.get('k', 0)], c['featk'])))
            r = trim_active(fr, c['ts'])
            seq = resample(r[0], r[1], T_LEN)
            worst = max(worst, max(abs(p - q) for p, q in zip(seq, c['seq'])))
            # the phone works in 32-bit floats: a value right on a rounding edge may land one step away
            x, y = base64.b64decode(encode(seq)), base64.b64decode(c['b64'])
            bad_b64 += sum(1 for p, q in zip(x, y) if p != q and abs(((p + 128) % 256) - ((q + 128) % 256)) > 1) + (len(x) != len(y))
        print(json.dumps({'cases': len(fx['cases']), 'max_abs_diff': worst, 'b64_mismatch': bad_b64}))
        sys.exit(0 if worst < 1e-4 and bad_b64 == 0 else 1)

    allowed = vocab_ids(a.vocab) if os.path.exists(a.vocab) else None
    only = set(x.strip().replace('/', '_') for x in a.only.split(',') if x.strip())
    # same names as server/signs_build.py: published <ID>__<signer>.mp4, raw <ID>__<signer>__<take>.<ext>
    clip_re = re.compile(r'^(?P<id>.+?)__(?P<signer>[a-z]\d{1,2})\.mp4$', re.I)
    raw_re = re.compile(r'^(?P<id>.+?)__(?P<signer>[a-z]\d{1,2})__(?P<take>\d+)\.(webm|mp4|mov|mkv|m4v)$', re.I)
    found = [(clip_re, p) for p in sorted(glob.glob(os.path.join(a.clips, '*.mp4')))]
    if a.takes:
        found += [(raw_re, p) for p in sorted(glob.glob(os.path.join(a.takes, '**', '*'), recursive=True))]
    clips = {}
    for rx, p in found:
        m = rx.match(os.path.basename(p))
        if not m:
            continue
        sid = m.group('id').replace('/', '_')
        if (only and sid not in only) or (allowed is not None and sid not in allowed):
            continue
        clips.setdefault(sid, []).append((m.group('signer').lower(), p))
    if not clips:
        print('no clips found in', a.clips)
        return
    lm = Landmarks()
    os.makedirs(a.out, exist_ok=True)
    today = datetime.date.today().isoformat()
    done, skipped = [], []
    for sid, lst in sorted(clips.items()):
        samples = []
        for signer, p in lst:
            fr, ts = lm.clip(p)
            r = trim_active(fr, ts)
            if not r or len(r[0]) < 6:
                skipped.append(os.path.basename(p) + ' (no hands seen)')
                continue
            seq = resample(r[0], r[1], T_LEN)
            samples.append({'signer': signer, 'src': os.path.relpath(p, REPO).replace(os.sep, '/'), 'ms': int(r[1][-1] - r[1][0]), 'b64': encode(seq)})
        if samples:
            json.dump({'v': 1, 'feat': FEAT, 'id': sid, 'len': T_LEN, 'dim': DIM, 'q': Q, 'updated': today, 'samples': samples},
                      open(os.path.join(a.out, sid + '.json'), 'w', encoding='utf-8'), separators=(',', ':'))
            done.append(sid)
    ids = sorted(set(done) | set(os.path.basename(x)[:-5] for x in glob.glob(os.path.join(a.out, '*.json')) if not x.endswith('index.json')))
    json.dump({'v': 1, 'feat': FEAT, 'updated': today, 'ids': ids}, open(os.path.join(a.out, 'index.json'), 'w', encoding='utf-8'), separators=(',', ':'))
    print('templates written:', len(done), '· total in index:', len(ids))
    for s in skipped:
        print('skipped:', s)


if __name__ == '__main__':
    main()
