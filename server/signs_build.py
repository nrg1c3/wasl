#!/usr/bin/env python3
"""Wasl sign library builder.

Takes the raw takes filmed with record.html (a folder, or the ZIPs it exports),
picks one take per sign and signer, converts it to a small portrait clip and
rebuilds signs/index.json (the manifest the app reads).

  python3 server/signs_build.py                       # only rebuild signs/index.json
  python3 server/signs_build.py --in ~/Downloads/wasl-signs_m1_*.zip
  python3 server/signs_build.py --in raw/ --pick PHARMACY__m1=2 --max 4
  python3 server/signs_build.py --in raw/ --list      # show the takes, convert nothing

Choosing the take, per <ID>__<signer>:
  1. --pick ID__signer=N (or a picks.csv given with --picks: lines "ID__signer,N")
  2. otherwise the last take marked «تمام» (status "ok" in takes.json)
  3. otherwise the last take not marked rejected.
Output: signs/clips/<ID>__<signer>.mp4  (540x960 portrait, H.264 CRF 26, preset
veryfast, no audio, +faststart, at most --max seconds, default 4).
Landscape takes are not cropped to 9:16 (that cuts the hands off): the middle --land-crop of the width
(default 0.76) is kept whole, centred on a blurred copy of the frame.

A signer whose consent.json does not allow "use in the app" is skipped unless --force.
Needs ffmpeg and ffprobe on PATH. Standard library only.
"""
import argparse, csv, datetime, json, os, re, shutil, subprocess, sys, tempfile, zipfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VOCAB = os.path.join(REPO, 'signs', 'vocab.csv')
CLIPS = os.path.join(REPO, 'signs', 'clips')
INDEX = os.path.join(REPO, 'signs', 'index.json')
VIDEO_EXT = ('.webm', '.mp4', '.mov', '.mkv', '.m4v')
RAW_RE = re.compile(r'^(?P<id>.+?)__(?P<signer>[a-z]\d{1,2})__(?P<take>\d+)\.(?P<ext>[a-z0-9]+)$', re.I)
CLIP_RE = re.compile(r'^(?P<id>.+?)__(?P<signer>[a-z]\d{1,2})\.mp4$', re.I)

# One emoji per sign: the picture card shown when a sign has no clip yet.
ICONS = {
    # the app's name (its sign is chosen by the sign expert)
    'BADALAK': '🤝',
    # bank
    'ACCOUNT': '🏦', 'WITHDRAW': '💵', 'DEPOSIT': '📥', 'TRANSFER': '🔁', 'ATM': '🏧', 'CARD-BLOCKED': '🚫',
    'BALANCE': '📊', 'CUSTOMER-SERVICE': '🎧', 'STATEMENT': '🧾', 'LOAN': '💳',
    # telecom and bills
    'TOP-UP': '📲', 'DATA-BUNDLE': '🌐', 'SIM': '📶', 'BILL': '🧾', 'ELECTRICITY': '💡', 'WATER': '🚰',
    'GAS': '🔥', 'INSTALLMENT': '🗓️', 'NOT-WORKING': '⚠️', 'HOME-INTERNET': '🏠',
    # restaurant
    'RESTAURANT': '🍽️', 'MENU': '📋', 'FOOD': '🍲', 'DRINK': '🥤', 'EAT-HERE': '🪑', 'TAKEAWAY': '🥡',
    'WITHOUT': '🚫', 'SPICY': '🌶️', 'THE-BILL': '🧾', 'TEA': '🍵', 'COFFEE': '☕',
    # delivery
    'DELIVERY': '🛵', 'ADDRESS': '📍', 'FLOOR-FLAT': '🏢', 'ORDER-LATE': '⏰', 'DOWNSTAIRS': '⬇️',
    # service
    'EMPLOYEE': '🧑‍💼', 'BRANCH': '🏬', 'COMPLAINT': '📢', 'RECEIVE': '📦', 'SUPERMARKET': '🛒',
    'CASHIER': '💁', 'PHONE-NUMBER': '📞',
    # greetings
    'HELLO': '👋', 'GOOD-MORNING': '🌅', 'THANK-YOU': '🙏', 'PLEASE': '🤲', 'SORRY': '😔',
    'GOODBYE': '👋', 'MY-NAME': '🪪', 'I-AM-DEAF': '🧏', 'SPEAK-TO-PHONE': '📱', 'OK': '👌',
    # basic
    'YES': '✅', 'NO': '❌', 'WAIT': '✋', 'REPEAT': '🔁', 'NOT-UNDERSTAND': '😕',
    'UNDERSTAND': '💡', 'SLOWLY': '🐢', 'DONT-KNOW': '🤷', 'CAN_POSSIBLE': '🙆', 'FINISHED': '🏁',
    # questions
    'WHERE': '📍', 'WHEN': '🕒', 'WHAT': '❓', 'WHO': '👤', 'WHY': '🤔', 'HOW-MANY_HOW-MUCH': '🧮',
    # pharmacy
    'PHARMACY': '🏪', 'MEDICINE': '💊', 'PRESCRIPTION': '📝', 'PILLS': '💊', 'SYRUP': '🧴',
    'INJECTION': '💉', 'TIMES-PER-DAY': '🔂', 'BEFORE-FOOD': '🍽️', 'AFTER-FOOD': '🍽️',
    'ALTERNATIVE': '🔄', 'NOT-AVAILABLE': '🚫',
    # doctor
    'DOCTOR': '🧑‍⚕️', 'HOSPITAL': '🏥', 'CLINIC': '🩺', 'APPOINTMENT': '📅', 'CHECKUP': '🩺',
    'LAB-TEST': '🧪', 'X-RAY': '🩻', 'FEVER': '🤒', 'BLOOD-PRESSURE': '🩸', 'DIABETES': '🍬',
    'PREGNANT': '🤰', 'ALLERGY': '⚠️',
    # body
    'PAIN': '🤕', 'HEAD': '🗣️', 'STOMACH': '🫃', 'TOOTH': '🦷', 'BACK': '🧍', 'CHEST': '🫁',
    'EYE': '👁️', 'EAR': '👂', 'LEG': '🦵', 'HAND_ARM': '💪',
    # feelings
    'DIZZY': '😵‍💫', 'SICK_TIRED': '🤢', 'SCARED': '😨', 'FINE_GOOD': '🙂',
    # transport
    'TAXI': '🚕', 'BUS': '🚌', 'METRO': '🚇', 'MICROBUS': '🚐', 'TUKTUK': '🛺', 'WANT-GO': '🚶',
    'STOP-HERE': '🛑', 'RIGHT': '➡️', 'LEFT': '⬅️', 'STRAIGHT': '⬆️', 'NEAR': '🤏', 'FAR': '🛣️',
    'STATION': '🚏',
    # places
    'HOME': '🏠', 'WORK': '💼', 'SCHOOL': '🏫', 'BANK': '🏦', 'POLICE-STATION': '🚓',
    'MARKET': '🛒', 'MOSQUE': '🕌', 'CHURCH': '⛪', 'TOILET': '🚻',
    # shop
    'WANT_NEED': '🫴', 'THIS': '👉', 'EXPENSIVE': '💸', 'CHEAPER': '🏷️', 'BAG': '🛍️',
    'ANOTHER': '➕', 'SIZE': '📏',
    # money
    'MONEY': '💵', 'POUND': '💷', 'SMALL-CHANGE': '🪙', 'CHANGE-DUE': '💱', 'CARD': '💳',
    'CASH': '💵', 'RECEIPT': '🧾', 'PAY': '🤝', 'MOBILE-WALLET': '📲',
    # government
    'ID-CARD': '🪪', 'BIRTH-CERTIFICATE': '👶', 'PAPERS': '📄', 'STAMP': '🔏', 'FORM': '📋',
    'PHOTOCOPY': '🖨️', 'COUNTER-WINDOW': '🪟', 'QUEUE_YOUR-TURN': '🧍‍♂️', 'SIGNATURE': '✍️',
    'DISABILITY-CARD': '♿',
    # numbers
    '0': '0️⃣', '1': '1️⃣', '2': '2️⃣', '3': '3️⃣', '4': '4️⃣', '5': '5️⃣', '6': '6️⃣',
    '7': '7️⃣', '8': '8️⃣', '9': '9️⃣', '10': '🔟', '100': '💯',  # 11-1000 otherwise: 🔢
    # time
    'TODAY': '📆', 'TOMORROW': '⏭️', 'YESTERDAY': '⏮️', 'NOW': '⏱️', 'HOUR_O-CLOCK': '🕐',
    'MORNING': '☀️', 'NIGHT': '🌙', 'SATURDAY': '📅', 'SUNDAY': '📅', 'MONDAY': '📅',
    'TUESDAY': '📅', 'WEDNESDAY': '📅', 'THURSDAY': '📅', 'FRIDAY': '📅',
    # sos
    'HELP': '🆘', 'AMBULANCE': '🚑', 'POLICE': '👮', 'FIRE': '🔥', 'ACCIDENT': '💥',
    'DANGER': '⚠️', 'ROBBED': '👛', 'LOST': '🧭', 'CALL-MY-FAMILY': '📞', 'BLEEDING': '🩸',
}
GROUP_ICONS = {'numbers': '🔢', 'time': '📅'}


def norm_id(s):
    return s.strip().replace('/', '_')


def read_vocab():
    with open(VOCAB, encoding='utf-8-sig', newline='') as f:
        rows = list(csv.DictReader(f))
    out = []
    for r in rows:
        if not (r.get('english_gloss') or '').strip():
            continue
        sid = norm_id(r['english_gloss'])
        out.append({'id': sid, 'ar': r['arabic'].strip(), 'group': r['group'].strip(),
                    'dir': r['direction'].strip(), 'pri': r['priority'].strip(),
                    'icon': ICONS.get(sid) or GROUP_ICONS.get(r['group'].strip(), '🤟')})
    return out


def need(tool):
    if not shutil.which(tool):
        sys.exit(f'{tool} not found. Install ffmpeg (it includes ffprobe).')


def probe_dur(path):
    try:
        r = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
                            '-of', 'default=nw=1:nk=1', path], capture_output=True, text=True, timeout=60)
        return round(float(r.stdout.strip()), 1)
    except Exception:
        return None


def gather(inputs, tmp):
    """Return (takes, consent): takes = list of dicts {id, signer, take, path, status}."""
    files, meta, consent = [], {}, {}

    def read_json_bytes(name, data):
        try:
            j = json.loads(data.decode('utf-8'))
        except Exception:
            print(f'  ! could not read {name}')
            return
        if name.endswith('takes.json'):
            for t in j.get('files', []):
                meta[t.get('file')] = t
        elif name.endswith('consent.json'):
            for c in j.get('signers', []):
                if c.get('signer'):
                    consent[c['signer']] = c

    for src in inputs:
        src = os.path.expanduser(src)
        if os.path.isdir(src):
            for root, _, names in os.walk(src):
                for n in names:
                    p = os.path.join(root, n)
                    if n.lower().endswith('.zip'):
                        inputs.append(p)
                    elif n in ('takes.json', 'consent.json'):
                        with open(p, 'rb') as f:
                            read_json_bytes(n, f.read())
                    elif n.lower().endswith(VIDEO_EXT):
                        files.append((n, p))
        elif src.lower().endswith('.zip') and os.path.isfile(src):
            with zipfile.ZipFile(src) as z:
                sub = os.path.join(tmp, re.sub(r'\W+', '_', os.path.basename(src)))
                os.makedirs(sub, exist_ok=True)
                for info in z.infolist():
                    n = os.path.basename(info.filename)
                    if not n or info.is_dir():
                        continue
                    if n in ('takes.json', 'consent.json'):
                        read_json_bytes(n, z.read(info))
                    elif n.lower().endswith(VIDEO_EXT) and RAW_RE.match(n):
                        out = os.path.join(sub, n)  # basename only: no path tricks from the zip
                        with z.open(info) as a, open(out, 'wb') as b:
                            shutil.copyfileobj(a, b)
                        files.append((n, out))
        elif os.path.isfile(src) and src.lower().endswith(VIDEO_EXT):
            files.append((os.path.basename(src), src))
        else:
            print(f'  ! skipped (not a folder, zip or video): {src}')

    takes, seen = [], set()
    for n, p in files:
        m = RAW_RE.match(n)
        if not m:
            print(f'  ! name not like ID__signer__take.ext, skipped: {n}')
            continue
        if n in seen:
            continue
        seen.add(n)
        st = (meta.get(n) or {}).get('status', 'unknown')
        takes.append({'file': n, 'id': norm_id(m['id']), 'signer': m['signer'].lower(),
                      'take': int(m['take']), 'path': p, 'status': st})
    return takes, consent


def choose(takes, picks):
    by = {}
    for t in takes:
        by.setdefault(f"{t['id']}__{t['signer']}", []).append(t)
    chosen = {}
    for key, ts in by.items():
        ts.sort(key=lambda t: t['take'])
        if key in picks:
            hit = [t for t in ts if t['take'] == picks[key]]
            if hit:
                chosen[key] = (hit[0], 'picked')
                continue
            print(f'  ! --pick {key}={picks[key]}: no such take, using the default')
        ok = [t for t in ts if t['status'] == 'ok']
        if ok:
            chosen[key] = (ok[-1], 'last «تمام»')
            continue
        rest = [t for t in ts if t['status'] != 'rejected']
        if rest:
            chosen[key] = (rest[-1], 'last take (none marked «تمام»)')
    return chosen, by


def probe_size(path):
    """(width, height) as the video is shown, after its rotation tag; None if ffprobe can't tell."""
    try:
        r = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries',
                            'stream=width,height:stream_tags=rotate:stream_side_data=rotation',
                            '-of', 'json', path], capture_output=True, text=True, timeout=60)
        st = json.loads(r.stdout)['streams'][0]
        w, h = int(st['width']), int(st['height'])
        rot = st.get('tags', {}).get('rotate')
        for sd in st.get('side_data_list', []):
            rot = sd.get('rotation', rot)
        if rot is not None and abs(int(float(rot))) % 180 == 90:
            w, h = h, w
        return w, h
    except Exception:
        return None


def convert(src, dst, max_s, land_crop=0.76):
    """Portrait source: fill 540x960 and crop the edges. Landscape source (filmed sideways, as on 14/11): cropping to
    9:16 would cut the hands off, so keep the middle land_crop of the width, whole, on a blurred copy of the frame."""
    size = probe_size(src)
    tail = 'fps=30,format=yuv420p,setsar=1'
    if size and size[0] > size[1]:
        fg = f'crop=trunc(iw*{land_crop}/2)*2:ih,scale=540:-2'
        flt = ['-filter_complex',
               f'[0:v]split[a][b];[a]scale=540:960:force_original_aspect_ratio=increase,crop=540:960,boxblur=20:2[bg];'
               f'[b]{fg}[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,{tail}[v]', '-map', '[v]']
    else:
        flt = ['-vf', f'scale=540:960:force_original_aspect_ratio=increase,crop=540:960,{tail}']
    cmd = ['ffmpeg', '-y', '-v', 'error', '-i', src, '-t', str(max_s), '-an', *flt,
           '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-profile:v', 'main',
           '-movflags', '+faststart', dst]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip()[-400:])


def build_index(vocab, signer_names):
    clips = {}
    if os.path.isdir(CLIPS):
        for n in sorted(os.listdir(CLIPS)):
            m = CLIP_RE.match(n)
            if m:
                clips.setdefault(m['id'], []).append(
                    {'signer': m['signer'].lower(), 'src': f'signs/clips/{n}',
                     'dur': probe_dur(os.path.join(CLIPS, n))})
    old = {}
    try:
        with open(INDEX, encoding='utf-8') as f:
            old = json.load(f).get('signers', {})
    except Exception:
        pass
    signers = {}
    used = sorted({c['signer'] for cs in clips.values() for c in cs})
    for s in used:
        # Names stay private by default (index.json is public on the site); --public-names publishes them.
        name = (signer_names.get(s) or (old.get(s) or {}).get('name') or s) if PUBLIC_NAMES else s
        signers[s] = {'name': name}
    ids = {v['id'] for v in vocab}
    for sid in clips:
        if sid not in ids:
            print(f'  ! clip for an ID that is not in vocab.csv (ignored): {sid}')
    signs = []
    for v in vocab:
        s = dict(v)
        s['clips'] = clips.get(v['id'], [])
        signs.append(s)
    man = {'version': 1, 'updated': datetime.date.today().isoformat(), 'signers': signers, 'signs': signs}
    with open(INDEX, 'w', encoding='utf-8') as f:
        json.dump(man, f, ensure_ascii=False, indent=1)
        f.write('\n')
    return man


PUBLIC_NAMES = False


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--in', dest='inputs', nargs='*', default=[], help='folders, ZIPs or video files from record.html')
    ap.add_argument('--pick', action='append', default=[], help='ID__signer=TAKE (repeatable)')
    ap.add_argument('--picks', help='CSV file with lines ID__signer,TAKE')
    ap.add_argument('--max', type=float, default=4.0, help='longest clip in seconds (default 4)')
    ap.add_argument('--land-crop', type=float, default=0.76, help='landscape takes: share of the width kept around the signer (default 0.76)')
    ap.add_argument('--list', action='store_true', help='only list the takes and the default choice')
    ap.add_argument('--skip-existing', action='store_true', help='keep clips that already exist')
    ap.add_argument('--force', action='store_true', help='publish even without "use in the app" consent')
    ap.add_argument('--public-names', action='store_true', help='put signer names from consent.json in the public index.json (default: codes only)')
    a = ap.parse_args()
    global PUBLIC_NAMES
    PUBLIC_NAMES = a.public_names

    vocab = read_vocab()
    vocab_ids = {v['id'] for v in vocab}
    picks = {}
    for p in a.pick:
        k, _, n = p.partition('=')
        if n.isdigit():
            picks[norm_id(k)] = int(n)
    if a.picks:
        with open(a.picks, encoding='utf-8') as f:
            for row in csv.reader(f):
                if len(row) >= 2 and row[1].strip().isdigit():
                    picks[norm_id(row[0])] = int(row[1])

    signer_names = {}
    if a.inputs:
        need('ffmpeg'); need('ffprobe')
        tmp = tempfile.mkdtemp(prefix='wasl-signs-')
        try:
            takes, consent = gather(list(a.inputs), tmp)
            print(f'Found {len(takes)} takes, consent for: {", ".join(sorted(consent)) or "nobody"}')
            for s, c in consent.items():
                if c.get('name'):
                    signer_names[s] = c['name']
            chosen, by = choose(takes, picks)
            if a.list:
                for key in sorted(by):
                    ts = by[key]
                    ch = chosen.get(key)
                    marks = ' '.join(f"{t['take']}{'*' if ch and ch[0] is t else ''}({t['status']})" for t in ts)
                    print(f'  {key}: {marks}')
                return
            os.makedirs(CLIPS, exist_ok=True)
            done = trimmed = 0
            for key in sorted(chosen):
                t, why = chosen[key]
                if t['id'] not in vocab_ids:
                    print(f'  ! {key}: ID not in vocab.csv, skipped')
                    continue
                c = consent.get(t['signer'])
                if not a.force and not (c and (c.get('uses') or {}).get('app')):
                    print(f'  ! {key}: no consent for "use in the app" from {t["signer"]}, skipped (--force to override)')
                    continue
                dst = os.path.join(CLIPS, f'{key}.mp4')
                if a.skip_existing and os.path.exists(dst):
                    continue
                src_d = probe_dur(t['path'])
                try:
                    convert(t['path'], dst, a.max, a.land_crop)
                except RuntimeError as e:
                    print(f'  ! {key}: ffmpeg failed: {e}')
                    continue
                if src_d and src_d > a.max + 0.2:
                    trimmed += 1
                    print(f'  ~ {key}: {src_d}s trimmed to {a.max}s, check the end is not cut')
                done += 1
                print(f'  ok {key}.mp4  take {t["take"]} ({why}), {os.path.getsize(dst)//1024} KB')
            print(f'Converted {done} clips ({trimmed} trimmed).')
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    man = build_index(vocab, signer_names)
    with_clip = [s for s in man['signs'] if s['clips']]
    p1 = [s for s in man['signs'] if s['pri'] == 'P1']
    p1_missing = [s for s in p1 if not s['clips']]
    print(f'\nsigns/index.json: {len(man["signs"])} signs, {len(with_clip)} with a clip, '
          f'signers: {", ".join(man["signers"]) or "none yet"}')
    for pri in ('P1', 'P2', 'P3'):
        allp = [s for s in man['signs'] if s['pri'] == pri]
        print(f'  {pri}: {sum(1 for s in allp if s["clips"])} of {len(allp)} have a clip')
    if p1_missing:
        print(f'\nP1 signs still without a clip ({len(p1_missing)}):')
        for s in p1_missing:
            print(f'  {s["id"]:<22} {s["ar"]}')
    else:
        print('\nAll P1 signs have a clip.')


if __name__ == '__main__':
    main()
