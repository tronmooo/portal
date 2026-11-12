"""Portol promo v2: 60 s chat-first cut built from REAL screen recordings.

python edit_v2.py <v2_dir> <logo.png> <out.mp4> [preview t1,t2,...]

<v2_dir> holds rec_main/, rec/ (retakes), rec_upload/ from record-chat.ts,
plus mix.wav (from sound_v2.py). Every screen shown is a recorded frame of the
live app; the edit only retimes, frames and captions them.
"""
import sys, os, json, bisect, subprocess, math
from functools import lru_cache
import numpy as np, cv2
from PIL import Image, ImageDraw, ImageFont, ImageFilter

V2, LOGO, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
PREVIEW = sys.argv[4] if len(sys.argv) > 4 else None
W, H, FPS, DUR = 1920, 1080, 30, 60.0
NF = int(DUR * FPS)
FONT = "/usr/share/fonts/opentype/inter/"
def font(n, s): return ImageFont.truetype(FONT + n, s)
CYAN = (64, 214, 240)
VIOLET = (150, 110, 255)

# ------------------------------------------------------------------ sources
class Rec:
    def __init__(self, name):
        d = json.load(open(os.path.join(V2, name, "events.json")))
        self.dir = os.path.join(V2, name, "frames")
        t0 = d["events"][0]["t"]
        self.ev = {}
        for e in d["events"]:
            self.ev.setdefault(e["label"], e["t"] - t0)
        self.ts = [f[0] - t0 for f in d["frames"]]
        self.files = [f[1] for f in d["frames"]]
    def at(self, t):
        i = max(0, bisect.bisect_right(self.ts, t) - 1)
        return load(os.path.join(self.dir, self.files[i]))
    def e(self, k): return self.ev[k]

@lru_cache(maxsize=96)
def load(p):
    return cv2.cvtColor(cv2.imread(p), cv2.COLOR_BGR2RGB)

R = {"main": Rec("rec_main"), "rt": Rec("rec"), "up": Rec("rec_upload")}
SW, SH = 430, 932                      # recorded screen (CSS px)

# ------------------------------------------------------------------ phone
BZ = 16; PW, PH = SW + 2 * BZ, SH + 2 * BZ; RAD = 56
def rr_mask(w, h, r, ss=4):
    m = Image.new("L", (w * ss, h * ss), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, w * ss - 1, h * ss - 1], r * ss, fill=255)
    return np.array(m.resize((w, h), Image.LANCZOS)).astype(np.float32) / 255
PHONE_MASK = rr_mask(PW, PH, RAD)
SCREEN_MASK = rr_mask(SW, SH, RAD - BZ + 2)
bez = np.zeros((PH, PW, 3), np.float32)
bez[:] = (14, 16, 22)
edge = rr_mask(PW, PH, RAD) - rr_mask(PW - 4, PH - 4, RAD - 2)[None] if False else None
ring = np.zeros((PH, PW), np.float32)
inner = np.pad(rr_mask(PW - 4, PH - 4, RAD - 2), 2)
ring = np.clip(PHONE_MASK - inner, 0, 1)
bez += ring[..., None] * np.array([70, 80, 100], np.float32)

def phone_rgba(screen):
    img = bez.copy()
    s = screen.astype(np.float32)
    m = SCREEN_MASK[..., None]
    img[BZ:BZ + SH, BZ:BZ + SW] = img[BZ:BZ + SH, BZ:BZ + SW] * (1 - m) + s * m
    return img, PHONE_MASK

# ------------------------------------------------------------------ background
yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
BASE = np.zeros((H, W, 3), np.float32)
g = (yy / H)[..., None]
BASE[:] = (8, 10, 18)
BASE = BASE * (1 - g) + np.array([4, 5, 10], np.float32) * g
VIG = np.clip(1 - 0.35 * (((xx - W / 2) / (W / 2)) ** 2 + ((yy - H / 2) / (H / 2)) ** 2), 0, 1)[..., None]
sy, sx = np.mgrid[0:H // 8, 0:W // 8].astype(np.float32)
def background(t, energy=1.0):
    small = np.zeros((H // 8, W // 8, 3), np.float32)
    for (cx, cy, r, col, sp, ph) in [(0.72, 0.45, 70, CYAN, 0.13, 0), (0.25, 0.6, 85, VIOLET, 0.09, 2), (0.55, 0.15, 60, (40, 120, 255), 0.11, 4)]:
        X = (cx + 0.08 * math.sin(t * sp * 6.28 + ph)) * W / 8
        Y = (cy + 0.06 * math.cos(t * sp * 5.0 + ph)) * H / 8
        d2 = (sx - X) ** 2 + (sy - Y) ** 2
        small += np.exp(-d2 / (2 * r * r))[..., None] * np.array(col, np.float32) * 0.22 * energy
    big = cv2.resize(small, (W, H), interpolation=cv2.INTER_LINEAR)
    return (BASE + big) * VIG

# ------------------------------------------------------------------ text
def text_img(lines, align="left", maxw=None, shadow=True):
    pad = 30
    sizes = []
    for txt, f, col, tr, gap in lines:
        w = sum(f.getlength(ch) + tr for ch in txt) - tr
        a, d = f.getmetrics(); sizes.append((w, a + d))
    tw = int(max(s[0] for s in sizes)) + 2 * pad
    th = int(sum(s[1] + l[4] for s, l in zip(sizes, lines))) + 2 * pad
    im = Image.new("RGBA", (tw, th), (0, 0, 0, 0)); dr = ImageDraw.Draw(im)
    y = pad
    for (txt, f, col, tr, gap), (w, h) in zip(lines, sizes):
        x = pad if align == "left" else pad + (tw - 2 * pad - w) / 2
        for ch in txt:
            dr.text((x, y), ch, font=f, fill=col); x += f.getlength(ch) + tr
        y += h + gap
    a = np.array(im).astype(np.float32) / 255
    if shadow:
        sh = cv2.GaussianBlur(a[..., 3], (0, 0), 9) * 0.6
        out = np.zeros_like(a); out[..., 3] = sh
        al = a[..., 3:4]
        out[..., :3] = a[..., :3]
        out[..., 3] = np.clip(sh + a[..., 3] * (1 - sh), 0, 1)
        out[..., :3] = np.where(a[..., 3:4] > 0, a[..., :3], 0)
        out[..., 3] = np.maximum(a[..., 3], sh)
        return out
    return a

def wrap(txt, f, maxw):
    words, lines, cur = txt.split(), [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if f.getlength(t) > maxw and cur:
            lines.append(cur); cur = w
        else: cur = t
    lines.append(cur); return lines

def chip_img(txt, size=34, fg=(6, 22, 28), bg=CYAN):
    f = font("InterDisplay-SemiBold.otf", size)
    w = int(f.getlength(txt)) + 2 * 26; h = size + 30
    im = Image.new("RGBA", (w + 40, h + 40), (0, 0, 0, 0))
    sh = Image.new("RGBA", im.size, (0, 0, 0, 0)); ImageDraw.Draw(sh).rounded_rectangle([20, 24, 20 + w, 24 + h], h // 2, fill=(0, 0, 0, 140))
    sh = sh.filter(ImageFilter.GaussianBlur(8)); im = Image.alpha_composite(im, sh)
    d = ImageDraw.Draw(im); d.rounded_rectangle([20, 20, 20 + w, 20 + h], h // 2, fill=bg + (255,))
    d.text((20 + 26, 20 + 13), txt, font=f, fill=fg)
    return np.array(im).astype(np.float32) / 255

def blit(canvas, img, x, y, alpha=1.0):
    h, w = img.shape[:2]; x, y = int(round(x)), int(round(y))
    x0, y0, x1, y1 = max(0, x), max(0, y), min(W, x + w), min(H, y + h)
    if x0 >= x1 or y0 >= y1: return
    sub = img[y0 - y:y1 - y, x0 - x:x1 - x]
    a = sub[..., 3:4] * alpha
    canvas[y0:y1, x0:x1] = canvas[y0:y1, x0:x1] * (1 - a) + sub[..., :3] * 255 * a

def ease(t): t = min(1, max(0, t)); return t * t * (3 - 2 * t)
def eout(t): t = min(1, max(0, t)); return 1 - (1 - t) ** 3
def lerp(a, b, t): return a + (b - a) * t

# ------------------------------------------------------------------ timeline
# A clip shows one recording over [t0, t1) of the video, mapping video time to
# recording time through (src_a, src_b) pieces, with a camera move.
CLIPS = []   # dict(t0,t1,rec,pieces=[(v0,v1,s0,s1)], cam=[(u,cx,cy,fx,fy,k)], kick=bool)
OVL = []     # overlays: dict(t0,t1,kind,...)
RIPPLES = [] # (t, clip-relative phone point)
SFX = []     # (t, kind) for the sound pass
BOXES = []   # (t0,t1, rec-screen rect) highlight boxes

def clip(t0, t1, rec, pieces, cam, kick=False, dx=0, band=None):
    """band: (y0, y1) in screen px kept sharp; the rest is blurred and dimmed
    (a shallow-focus look that keeps the eye on the command and its result)."""
    CLIPS.append(dict(t0=t0, t1=t1, rec=rec, pieces=pieces, cam=cam, kick=kick, dx=dx, band=band))

TYPE_BAND = (700, 932)

def caption(t0, t1, lines, x, y, align="left", slide=24):
    out = []
    for (txt, f, col, tr, gap) in lines:
        ws = wrap(txt, f, 780)
        for j, w_ in enumerate(ws):
            out.append((w_, f, col, tr, gap if j == len(ws) - 1 else 0))
    lines = out
    OVL.append(dict(t0=t0, t1=t1, img=text_img(lines, align), x=x, y=y, align=align, slide=slide))

def chip(t0, t1, txt, x, y, size=34):
    OVL.append(dict(t0=t0, t1=t1, img=chip_img(txt, size), x=x, y=y, align="left", slide=0, pop=True))

F_CMD = font("InterDisplay-SemiBold.otf", 62)
F_HEAD = font("InterDisplay-SemiBold.otf", 84)
F_SUB = font("InterDisplay-Light.otf", 38)
F_TAG = font("InterDisplay-Medium.otf", 24)
WHITE = (255, 255, 255, 255)

PX = 1300   # phone center x when captions sit on the left
TX = 120    # caption left edge

def typed_caption(t0, t1, text, y=330):
    """Command text that reveals as it is typed."""
    OVL.append(dict(t0=t0, t1=t1, kind="typed", text=text, x=TX, y=y))

# ---- 0-15 s: hook, seven real commands, 2 s each
HOOK = [
    ("main", "ran", "I ran 3 miles today", "Running tracker  ·  +3 mi", 520),
    ("main", "walmart", "I spent $65 at Walmart", "Expense saved  ·  $65.00", 500),
    ("main", "rent", "Remind me to pay rent on the first", "Pay rent  ·  due Dec 1", 490),
    ("rt", "show_license", "Show my driver's license", "Your license, opened", 300),
    ("rt", "license_number", "What's my driver's license number?", "Answered from your saved license", 560),
    ("main", "slept", "I slept 7 hours last night", "Sleep tracker  ·  7 hr", 515),
    ("rt", "bills", "Show me my upcoming bills", "Rent  ·  $1,850 due Dec 1", 420),
]
BEAT = 2.0
# (y0, y1) of each command's bubble + reply in its source frame (measured)
BANDS = {"ran": (368, 648), "walmart": (330, 648), "rent": (318, 648), "show_license": (20, 690),
         "license_number": (458, 662), "slept": (383, 642), "bills": (152, 662)}
for i, (rk, cid, text, res, fy) in enumerate(HOOK):
    r = R[rk]; v0 = i * BEAT; vt = v0 + 0.75
    ta, ts_ = r.e(f"type:{cid}"), r.e(f"send:{cid}")
    rr = r.e(f"reply:{cid}")
    if cid == "show_license": ra, rb = 17.2, 18.6
    else: ra, rb = rr - 1.1, rr + 0.2
    clip(v0, vt, rk, [(v0, vt, ta, ts_ + 0.15)], [(0, PX, 740, 231, 790, 1.42), (1, PX, 740, 231, 790, 1.42)], kick=True, band=TYPE_BAND)
    clip(vt, v0 + BEAT, rk, [(vt, v0 + BEAT, ra, rb)], [(0, PX, 560, 231, fy, 1.5), (1, PX, 560, 231, fy, 1.32)], kick=True, band=BANDS[cid])
    typed_caption(v0, v0 + BEAT, text)
    chip(vt + 0.12, v0 + BEAT, "✓  " + res, TX + 10, 560)
    OVL.append(dict(t0=v0, t1=v0 + BEAT, kind="counter", n=i + 1))
    SFX.append((v0, "whoosh")); SFX.append((vt, "send")); SFX.append((vt + 0.12, "pop"))
    SFX.append((v0 + 0.05, f"type:{0.62}"))
# 14-15: the line that lands the hook
clip(14.0, 15.0, "rt", [(14.0, 15.0, R["rt"].e("reply:bills") + 0.2, R["rt"].e("reply:bills") + 0.4)],
     [(0, PX, 560, 231, 520, 1.32), (1, PX + 60, 560, 231, 520, 1.12)])
caption(14.05, 15.0, [("All of that.", F_HEAD, WHITE, 0, 0), ("From one chat.", F_HEAD, CYAN + (255,), 0, 0)], TX, 330)
SFX.append((14.0, "impact"))

# ---- 15-30 s: one message, four records, verified in Trackers
rt = R["rt"]
clip(15.0, 17.8, "rt", [(15.0, 17.8, rt.e("type:multi"), rt.e("send:multi") + 0.1)],
     [(0, PX, 740, 231, 780, 1.38), (1, PX, 740, 231, 780, 1.38)], kick=True, band=TYPE_BAND)
typed_caption(15.0, 18.6, "I biked 5 miles, drank 32 ounces of water, spent $24 on lunch, and made $250 today", y=250)
OVL.append(dict(t0=15.0, t1=24.6, kind="tag", text="ONE MESSAGE  ·  FOUR RECORDS", x=TX + 4, y=200))
SFX.append((15.0, "whoosh")); SFX.append((15.05, "type:2.6")); SFX.append((17.8, "send"))
clip(17.8, 18.6, "rt", [(17.8, 18.6, rt.e("send:multi") + 0.2, rt.e("reply:multi") - 2.0)],
     [(0, PX, 600, 231, 700, 1.3), (1, PX, 600, 231, 700, 1.3)])
clip(18.6, 24.6, "rt", [(18.6, 24.6, rt.e("reply:multi") - 1.6, rt.e("tap:log_entry") - 0.05)],
     [(0, PX, 540, 231, 260, 1.45), (0.55, PX, 540, 231, 520, 1.45), (1, PX, 540, 231, 400, 1.3)])
SFX.append((18.6, "pop"))
items = [("Cycling  ·  5 mi", "Trackers"), ("Water  ·  32 oz", "Trackers"), ("Lunch  ·  $24", "Finance"), ("Income  ·  $250", "Finance")]
for k, (a, b) in enumerate(items):
    t = 19.0 + k * 0.55
    chip(t, 24.6, f"✓  {a}   →  {b}", TX + 10, 470 + k * 96, size=32)
    SFX.append((t, "tick"))
RIPPLES.append((24.45, (175, 355)))
SFX.append((24.45, "tap"))
clip(24.6, 30.0, "rt", [(24.6, 30.0, rt.e("tap:log_entry") + 0.6, rt.e("tapend:log_entry") - 0.1)],
     [(0, PX, 540, 231, 300, 1.12), (1, PX, 540, 231, 420, 1.22)], kick=True)
caption(24.8, 29.9, [("Saved where it belongs.", F_HEAD, WHITE, 0, 10), ("Open the tracker: today's 32 oz is already there.", F_SUB, (220, 230, 245, 235), 0, 0)], TX, 360)
SFX.append((24.6, "whoosh"))

# ---- 30-45 s: documents, read and answered from what was saved
up = R["up"]
OVL.append(dict(t0=30.0, t1=42.8, kind="tag", text="YOUR DOCUMENTS", x=TX + 4, y=200))
OVL.append(dict(t0=42.8, t1=45.0, kind="tag", text="YOUR CALENDAR", x=TX + 4, y=200))
clip(30.0, 32.4, "up", [(30.0, 32.4, 1.6, up.e("upload:send") + 0.1)],
     [(0, PX, 560, 231, 420, 1.25), (1, PX, 560, 231, 560, 1.32)], kick=True)
caption(30.15, 33.2, [("Snap a photo of your license.", F_HEAD, WHITE, 0, 0)], TX, 260)
RIPPLES.append((32.25, (213, 680))); SFX.append((32.25, "tap")); SFX.append((30.0, "whoosh"))
clip(32.4, 33.2, "up", [(32.4, 33.2, up.e("upload:send") + 0.3, 28.6)],
     [(0, PX, 560, 231, 300, 1.3), (1, PX, 560, 231, 300, 1.3)])
clip(33.2, 35.6, "up", [(33.2, 35.6, 29.1, 31.0)],
     [(0, PX, 540, 231, 300, 1.35), (1, PX, 540, 231, 500, 1.35)], kick=True)
caption(33.3, 35.6, [("AI reads every field.", F_HEAD, WHITE, 0, 10), ("98% confidence  ·  you review before it saves", F_SUB, (220, 230, 245, 235), 0, 0)], TX, 300)
SFX.append((33.2, "pop"))
clip(35.6, 37.6, "up", [(35.6, 37.6, 218.55, 218.95)],
     [(0, PX, 540, 231, 330, 1.5), (1, PX, 540, 231, 400, 1.4)])
BOXES.append((35.8, 37.6, "up", (10, 300, 420, 334)))
caption(35.7, 37.6, [("Expiration date found", F_SUB, (220, 230, 245, 235), 0, 6), ("Mar 14, 2029", F_HEAD, CYAN + (255,), 0, 0)], TX, 330)
RIPPLES.append((37.45, (348, 499))); SFX.append((37.45, "tap"))
clip(37.6, 39.4, "up", [(37.6, 38.0, 219.3, 222.0), (38.0, 39.4, 223.7, 225.0)],
     [(0, PX, 540, 231, 220, 1.25), (1, PX, 540, 231, 260, 1.2)], kick=True)
caption(37.7, 39.4, [("Confirmed. Saved.", F_HEAD, WHITE, 0, 0)], TX, 360)
SFX.append((38.0, "pop"))
# ask for it back
clip(39.4, 40.2, "rt", [(39.4, 40.2, rt.e("type:show_license"), rt.e("send:show_license") + 0.1)],
     [(0, PX, 740, 231, 780, 1.38), (1, PX, 740, 231, 780, 1.38)], kick=True, band=TYPE_BAND)
typed_caption(39.4, 42.8, "Show my driver's license", y=300)
SFX.append((39.4, "whoosh")); SFX.append((39.45, "type:0.7")); SFX.append((40.2, "send"))
clip(40.2, 42.8, "rt", [(40.2, 42.8, 17.3, 19.9)],
     [(0, PX, 540, 231, 160, 1.35), (0.5, PX, 540, 231, 300, 1.35), (1, PX, 540, 231, 520, 1.45)])
chip(40.4, 42.8, "✓  The real document, opened", TX + 10, 480)
BOXES.append((41.7, 42.8, "rt", (38, 597, 188, 632)))
SFX.append((40.3, "pop"))
main = R["main"]
clip(42.8, 43.4, "main", [(42.8, 43.4, main.e("type:calendar_q"), main.e("send:calendar_q") + 0.1)],
     [(0, PX, 740, 231, 780, 1.38), (1, PX, 740, 231, 780, 1.38)], kick=True, band=TYPE_BAND)
clip(43.4, 45.0, "main", [(43.4, 45.0, main.e("reply:calendar_q") - 1.2, main.e("reply:calendar_q") + 0.3)],
     [(0, PX, 540, 231, 450, 1.4), (1, PX, 540, 231, 450, 1.3)], band=(218, 662))
typed_caption(42.8, 45.0, "What's coming up on my calendar?", y=300)
chip(43.5, 45.0, "✓  Your next 7 days", TX + 10, 480)
SFX.append((42.8, "whoosh")); SFX.append((42.85, "type:0.5")); SFX.append((43.4, "send")); SFX.append((43.5, "pop"))

# ---- 45-55 s: one conversation, every section
clip(45.0, 46.6, "rt", [(45.0, 46.6, rt.e("reply:multi") - 1.0, rt.e("reply:multi") - 0.6)],
     [(0, PX, 540, 231, 466, 1.0), (1, PX, 540, 231, 466, 0.94)])
caption(45.1, 46.6, [("Stop switching apps.", F_HEAD, WHITE, 0, 0)], TX, 380)
SFX.append((45.0, "impact"))
TOUR = [("dashboard", "Dashboard", "Net worth, cash flow, wellness"), ("calendar", "Calendar", "Every date in one timeline"),
        ("artifacts", "Documents", "Your files, read and searchable"), ("trackers", "Trackers", "Health and habits, logged by chat"),
        ("finance", "Finance", "Spending, sorted automatically")]
TL = (55.0 - 46.6) / len(TOUR)
for k, (route, name, sub) in enumerate(TOUR):
    a = 46.6 + k * TL; b = a + TL
    n = main.e(f"nav:tour-{route}")
    clip(a, b, "main", [(a, b, n + 1.8, n + 3.4)], [(0, PX, 540, 231, 466, 1.0), (1, PX, 540, 231, 466, 1.04)], kick=True, dx=260)
    caption(a + 0.05, b, [(name, F_HEAD, WHITE, 0, 8), (sub, F_SUB, (220, 230, 245, 235), 0, 0)], TX, 400)
    OVL.append(dict(t0=a, t1=b, kind="tag", text="EVERYTHING CONNECTS", x=TX + 4, y=330))
    SFX.append((a, "whoosh"))
OVL.append(dict(t0=53.4, t1=55.0, kind="tag", text="JUST ASK.", x=TX + 4, y=640, big=True))

# ---- 55-60 s: close
OVL.append(dict(t0=55.0, t1=60.0, kind="endcard"))
SFX.append((55.0, "impact_big"))

json.dump({"sfx": SFX}, open(os.path.join(V2, "sfx_cues.json"), "w"))

# ------------------------------------------------------------------ render
def cam_at(c, u):
    ks = c["cam"]
    for j in range(len(ks) - 1):
        if ks[j][0] <= u <= ks[j + 1][0]:
            v = ease((u - ks[j][0]) / max(1e-6, ks[j + 1][0] - ks[j][0]))
            return [lerp(ks[j][i], ks[j + 1][i], v) for i in range(1, 6)]
    return list(ks[-1][1:])

def src_time(c, t):
    for (v0, v1, s0, s1) in c["pieces"]:
        if v0 <= t < v1 or (t >= v1 and (v0, v1, s0, s1) == c["pieces"][-1]):
            return lerp(s0, s1, min(1, (t - v0) / (v1 - v0)))
    return c["pieces"][-1][3]

def draw_phone(canvas, c, t, alpha=1.0):
    u = (t - c["t0"]) / (c["t1"] - c["t0"])
    cx, cy, fx, fy, k = cam_at(c, u)
    if c["kick"]:
        kt = (t - c["t0"]) * FPS
        k *= 1 + 0.06 * math.exp(-kt / 3.0)
    if c["dx"]:
        cx += c["dx"] * (1 - eout((t - c["t0"]) / 0.35))
    rec = R[c["rec"]]
    scr = rec.at(src_time(c, t)).copy()
    for (b0, b1, rk, (x0, y0, x1, y1)) in BOXES:
        if b0 <= t < b1 and rk == c["rec"]:
            a = ease((t - b0) / 0.25)
            ov = scr.copy(); cv2.rectangle(ov, (x0, y0), (x1, y1), CYAN, 2, cv2.LINE_AA)
            glow = np.zeros_like(scr); cv2.rectangle(glow, (x0, y0), (x1, y1), CYAN, -1)
            scr = np.clip(scr * (1 - 0.12 * a) + glow * 0.12 * a, 0, 255).astype(np.uint8)
            scr = cv2.addWeighted(scr, 1 - a, ov, a, 0) if a < 1 else ov
    if c.get("band"):
        y0, y1 = c["band"]
        soft = cv2.GaussianBlur(scr, (0, 0), 6).astype(np.float32) * 0.42
        yy_ = np.arange(SH, dtype=np.float32)[:, None, None]
        keep = np.clip(np.minimum((yy_ - (y0 - 24)) / 24, ((y1 + 24) - yy_) / 24), 0, 1)
        scr = (scr.astype(np.float32) * keep + soft * (1 - keep)).astype(np.uint8)
    img, m = phone_rgba(scr)
    # ripples (screen coords)
    for (rt_, (px, py)) in RIPPLES:
        dt = t - rt_
        if c["t0"] - 0.4 <= rt_ < c["t1"] + 0.01 and -0.25 <= dt < 0.45:
            if dt < 0:
                rad, al = 22, ease((dt + 0.25) / 0.25) * 0.55
            else:
                rad, al = 22 + 70 * eout(dt / 0.45), 0.55 * (1 - dt / 0.45)
            ov = img.copy()
            cv2.circle(ov, (int(px + BZ), int(py + BZ)), int(rad), (255, 255, 255), -1, cv2.LINE_AA)
            img = img * (1 - al) + ov * al
    # transform: phone point (fx+BZ, fy+BZ) -> canvas (cx, cy), scale k
    M = np.array([[k, 0, cx - k * (fx + BZ)], [0, k, cy - k * (fy + BZ)]], np.float32)
    # soft shadow + glow under the phone
    sh = cv2.warpAffine(m, M, (W, H), flags=cv2.INTER_LINEAR)
    shb = cv2.GaussianBlur(sh, (0, 0), 28)
    canvas *= (1 - 0.55 * alpha * shb[..., None])
    canvas += (np.array(CYAN, np.float32) * 0.05 * alpha) * cv2.GaussianBlur(sh, (0, 0), 60)[..., None]
    rgb = cv2.warpAffine(img, M, (W, H), flags=cv2.INTER_CUBIC)
    a = (sh * alpha)[..., None]
    canvas[:] = canvas * (1 - a) + rgb * a

_cache = {}
def typed_img(text, n):
    key = (text, n)
    if key not in _cache:
        lines = wrap("“" + text[:n] + ("”" if n >= len(text) else ""), F_CMD, 720)
        _cache[key] = text_img([(l, F_CMD, WHITE, 0, 6) for l in lines])
    return _cache[key]

LOGO_IMG = Image.open(LOGO).convert("RGBA")
def endcard(canvas, t):
    u = t - 55.0
    a = ease(u / 0.5)
    canvas *= (1 - 0.6 * a)
    s = 300 + 40 * eout(u / 1.2)
    lg = np.array(LOGO_IMG.resize((int(s), int(s)), Image.LANCZOS)).astype(np.float32) / 255
    glow = cv2.GaussianBlur(lg[..., 3], (0, 0), 40)
    gx, gy = int(W / 2 - s / 2), int(330 - s / 2)
    gl = np.zeros((H, W), np.float32);
    y0, x0 = max(0, gy), max(0, gx)
    gl[y0:y0 + lg.shape[0], x0:x0 + lg.shape[1]] = glow[:H - y0, :W - x0]
    canvas += (np.array(CYAN, np.float32) * 0.5 * a) * gl[..., None]
    blit(canvas, lg, gx, gy, a)
    for img, y, d in END_TXT:
        aa = ease((u - d) / 0.5)
        blit(canvas, img, W / 2 - img.shape[1] / 2, y + 18 * (1 - aa), aa)

END_TXT = [
    (text_img([("PORTOL", font("InterDisplay-SemiBold.otf", 120), WHITE, 22, 0)], "center"), 520, 0.3),
    (text_img([("Your Life. One Conversation.", font("InterDisplay-Light.otf", 52), (235, 240, 250, 255), 0, 0)], "center"), 680, 0.7),
    (text_img([("portol.me", font("InterDisplay-Medium.otf", 44), CYAN + (255,), 4, 0)], "center"), 790, 1.1),
]

def overlays(canvas, t):
    for o in OVL:
        if not (o["t0"] <= t < o["t1"]): continue
        kind = o.get("kind")
        fade = ease((o["t1"] - t) / 0.15)
        if kind == "endcard":
            endcard(canvas, t); continue
        if kind == "typed":
            dur = 0.62
            n = len(o["text"])
            prog = 1.0 if o["text"].startswith("I biked") is False else 1.0
            span = {15.0: 2.75, 39.4: 0.75, 42.8: 0.55}.get(o["t0"], 0.72)
            k = int(n * min(1, (t - o["t0"]) / span)) if t - o["t0"] < span else n
            img = typed_img(o["text"], max(1, k))
            blit(canvas, img, o["x"] - 30, o["y"] - 30, fade); continue
        if kind == "counter":
            img = COUNTERS[o["n"]]
            blit(canvas, img, TX - 26, 190, fade); continue
        if kind == "tag":
            img = TAGS.setdefault(o["text"], text_img([(o["text"], font("InterDisplay-SemiBold.otf", 44 if o.get("big") else 24), CYAN + (255,), 5 if not o.get("big") else 3, 0)]))
            blit(canvas, img, o["x"] - 30, o["y"] - 30, fade * ease((t - o["t0"]) / 0.2)); continue
        a = ease((t - o["t0"]) / 0.18) * fade
        img = o["img"]
        if o.get("pop"):
            sc = 0.82 + 0.18 * eout((t - o["t0"]) / 0.18)
            if sc < 0.999:
                h, w = img.shape[:2]
                img = cv2.resize(img, (max(1, int(w * sc)), max(1, int(h * sc))), interpolation=cv2.INTER_LINEAR)
            blit(canvas, img, o["x"] - 20, o["y"] - 20 + (1 - sc) * 30, a)
        else:
            dy = (1 - eout((t - o["t0"]) / 0.3)) * o["slide"]
            x = o["x"] - 30 if o["align"] == "left" else o["x"] - img.shape[1] / 2
            blit(canvas, img, x, o["y"] - 30 + dy, a)

TAGS = {}
COUNTERS = {i: text_img([(f"0{i}  /  07", font("InterDisplay-Medium.otf", 26), (140, 160, 190, 255), 3, 0)]) for i in range(1, 8)}

rng = np.random.default_rng(3)
def frame(i):
    t = i / FPS
    energy = 1.25 if t < 15 else (1.0 if t < 55 else 1.4)
    canvas = background(t, energy)
    active = [c for c in CLIPS if c["t0"] <= t < c["t1"]]
    if t < 55.0 + 0.5:
        if not active and t >= 55.0:
            active = [CLIPS[-1]]
        for c in active[:1]:
            al = 1.0 if t < 55.0 else 1 - ease((t - 55.0) / 0.4)
            draw_phone(canvas, c, min(t, c["t1"] - 1e-3), al)
    overlays(canvas, t)
    # flash on hook cuts
    if t < 15:
        ph = (t % BEAT)
        if ph < 0.06: canvas += 22 * (1 - ph / 0.06)
    if t < 0.3: canvas *= ease(t / 0.3)
    if t > 59.3: canvas *= ease((60 - t) / 0.7)
    g = rng.standard_normal((H // 2, W // 2, 1)).astype(np.float32)
    canvas += cv2.resize(g, (W, H))[..., None] * 2.2
    return np.clip(canvas, 0, 255).astype(np.uint8)

if PREVIEW:
    os.makedirs(OUT, exist_ok=True)
    for t in map(float, PREVIEW.split(",")):
        cv2.imwrite(os.path.join(OUT, f"e{t:05.2f}.jpg"), cv2.cvtColor(frame(int(round(t * FPS))), cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 90])
    sys.exit(0)

mix = os.path.join(V2, "mix.wav")
ff = subprocess.Popen(["ffmpeg", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
                       "-i", mix, "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p",
                       "-profile:v", "high", "-movflags", "+faststart", "-c:a", "aac", "-b:a", "192k", "-shortest", OUT], stdin=subprocess.PIPE)
for i in range(NF):
    ff.stdin.write(frame(i).tobytes())
    if i % 150 == 0: print("frame", i, flush=True)
ff.stdin.close(); ff.wait(); print("done", OUT)
