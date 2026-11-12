"""Finishing: upscale, grade, bloom, titles, grain -> H.264 with score.

python post.py <frames_dir> <score.wav> <out.mp4>            full encode
python post.py <frames_dir> preview <out_dir> 60,200,...     stills
"""
import sys, os, subprocess, math
import numpy as np, cv2
from PIL import Image, ImageDraw, ImageFont

W, H = 1920, 1080
FONT = "/usr/share/fonts/opentype/inter/"
def font(name, size):
    return ImageFont.truetype(FONT + name, size)

F_HEAD = lambda s: font("InterDisplay-SemiBold.otf", s)
F_LIGHT = lambda s: font("InterDisplay-Light.otf", s)
F_REG = lambda s: font("InterDisplay-Regular.otf", s)
CYAN = (94, 220, 255)

def text_img(lines, align="left"):
    """lines: list of (text, font, color, tracking_px, gap_after). Returns RGBA image tightly sized."""
    pad = 40
    sizes = []
    for txt, f, col, tr, gap in lines:
        w = sum(f.getlength(ch) + tr for ch in txt) - tr
        asc, desc = f.getmetrics()
        sizes.append((w, asc + desc))
    tw = int(max(s[0] for s in sizes)) + pad * 2
    th = int(sum(s[1] + l[4] for s, l in zip(sizes, lines))) + pad * 2
    im = Image.new("RGBA", (tw, th), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    y = pad
    for (txt, f, col, tr, gap), (w, h) in zip(lines, sizes):
        x = pad if align == "left" else pad + (tw - 2 * pad - w) / 2
        for ch in txt:
            d.text((x, y), ch, font=f, fill=col)
            x += f.getlength(ch) + tr
        y += h + gap
    # soft shadow for legibility
    a = np.array(im)
    sh = cv2.GaussianBlur(a[:, :, 3], (0, 0), 10)
    base = np.zeros_like(a); base[:, :, 3] = (sh * 0.55).astype(np.uint8)
    out = Image.alpha_composite(Image.fromarray(base), im)
    return np.array(out).astype(np.float32) / 255.0

# ---------------------------------------------------------------- titles (frame ranges at 24 fps)
T = []
def title(f0, f1, lines, anchor, align="left", slide=22):
    T.append(dict(f0=f0, f1=f1, img=text_img(lines, align), anchor=anchor, align=align, slide=slide))

title(22, 136, [("Your life has a lot of moving parts.", F_HEAD(64), (255, 255, 255, 255), 0, 0)], (W / 2, 900), "center")
title(152, 258, [("What if it all just", F_LIGHT(60), (255, 255, 255, 235), 0, 4),
                 ("listened?", F_HEAD(88), (255, 255, 255, 255), 0, 0)], (W / 2, 820), "center")
title(282, 402, [("JUST SAY IT", F_REG(26), CYAN + (255,), 6, 14),
                 ("Portol logs it, files it,", F_HEAD(66), (255, 255, 255, 255), 0, 2),
                 ("and remembers it.", F_HEAD(66), (255, 255, 255, 255), 0, 0)], (120, 760), "left")
FEAT = [
    ("FINANCE", "Money, understood.", "Spending, cash flow and net worth, automatically."),
    ("CALENDAR", "Every date, remembered.", "Events, birthdays and renewals on one timeline."),
    ("TASKS", "Nothing slips.", "One sentence becomes a task with a priority and a due date."),
    ("WELLNESS", "Your health at a glance.", "Sleep, steps and vitals roll up into one score."),
    ("HABITS", "Habits that stick.", "Streaks and check-ins that keep you honest."),
    ("BILLS", "Bills before they're due.", "Rent, insurance and subscriptions, tracked for you."),
    ("JOURNAL", "A journal that listens.", "Mood, highlights and gratitude, in your own words."),
]
FL = (840 - 408) / 7
for i, (lab, head, sub) in enumerate(FEAT):
    f0 = int(408 + i * FL + 6); f1 = int(408 + (i + 1) * FL - 2)
    title(f0, f1, [(f"0{i + 1}  ·  {lab}", F_REG(24), CYAN + (255,), 5, 18),
                   (head, F_HEAD(78), (255, 255, 255, 255), 0, 16),
                   (sub, F_LIGHT(32), (225, 232, 245, 230), 0, 0)], (130, H / 2 - 110), "left", slide=26)
title(856, 1000, [("Everything in your life.", F_LIGHT(64), (255, 255, 255, 240), 0, 6),
                  ("One place.", F_HEAD(104), (255, 255, 255, 255), 0, 0)], (W / 2, 780), "center")
title(1062, 1200, [("Portol", F_HEAD(132), (255, 255, 255, 255), 2, 6),
                   ("Your AI-powered life command center", F_LIGHT(36), (230, 238, 250, 240), 1, 18),
                   ("portol.me", F_REG(34), CYAN + (255,), 3, 0)], (W / 2, 790), "center", slide=30)

def ease(t):
    t = max(0.0, min(1.0, t)); return t * t * (3 - 2 * t)

def overlay_titles(img, f):
    for t in T:
        if not (t["f0"] <= f < t["f1"]):
            continue
        a = ease((f - t["f0"]) / 12) * (1 - ease((f - (t["f1"] - 10)) / 10))
        if a <= 0:
            continue
        ti = t["img"]; th, tw = ti.shape[:2]
        dy = (1 - ease((f - t["f0"]) / 16)) * t["slide"]
        ax, ay = t["anchor"]
        x = int(ax - (tw / 2 if t["align"] == "center" else 40)); y = int(ay - 40 + dy)
        x0, y0 = max(0, x), max(0, y); x1, y1 = min(W, x + tw), min(H, y + th)
        sub = ti[y0 - y:y1 - y, x0 - x:x1 - x]
        al = sub[:, :, 3:4] * a
        img[y0:y1, x0:x1] = img[y0:y1, x0:x1] * (1 - al) + sub[:, :, :3] * al
    return img

# ---------------------------------------------------------------- grade
yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
vig = 1 - 0.42 * (((xx - W / 2) / (W / 2)) ** 2 + ((yy - H / 2) / (H / 2)) ** 2) ** 1.4
vig = np.clip(vig, 0, 1)[..., None]
# left-side darkening for feature titles (phone sits right of frame)
leftgrad = np.clip(1 - 0.45 * np.clip((900 - xx) / 900, 0, 1) ** 1.5, 0, 1)[..., None]
botgrad = np.clip(1 - 0.6 * np.clip((yy - 620) / 460, 0, 1) ** 1.3, 0, 1)[..., None]
rng = np.random.default_rng(5)

CUTS = {144: 3, 408: 4, 840: 4, 1008: 5}

def grade(src, f):
    im = cv2.cvtColor(src, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
    im = cv2.resize(im, (W, H), interpolation=cv2.INTER_LANCZOS4)
    bl = cv2.GaussianBlur(im, (0, 0), 1.2)
    im = np.clip(im + (im - bl) * 0.6, 0, 1)                      # unsharp after upscale
    if f < 408:                                                    # lift the dark room a touch
        im = np.clip(im * 1.18 + 0.004, 0, 1)
    elif f < 1008:                                                 # phone studio + wall
        im = np.clip(im * 1.14 + 0.003, 0, 1)
    lum = im.mean(axis=2, keepdims=True)
    hi = np.clip((im - 0.55) / 0.45, 0, 1) * (lum > 0.3)
    bloom = cv2.GaussianBlur(hi, (0, 0), 14) * 0.45 + cv2.GaussianBlur(hi, (0, 0), 48) * 0.35
    im = 1 - (1 - im) * (1 - np.clip(bloom, 0, 1))                 # screen-blend bloom
    # teal/orange split-tone
    sh = np.array([0.0, 0.012, 0.025], np.float32); hl = np.array([0.02, 0.008, -0.01], np.float32)
    im = np.clip(im + sh * (1 - lum) + hl * lum, 0, 1)
    im *= vig
    if 408 <= f < 840 or 282 <= f < 408:
        im *= leftgrad
    if f >= 1040 or f < 140 or 856 <= f < 1008 or 152 <= f < 262:
        im *= botgrad
    # dips at cuts
    for c, n in CUTS.items():
        d = abs(f - c + 0.5)
        if d < n:
            im *= ease(d / n)
    if f < 18:
        im *= ease(f / 18)
    im = overlay_titles(im, f)
    if f > 1152 - 16:
        im *= ease((1152 - f) / 16)
    g = rng.standard_normal((H // 2, W // 2, 1)).astype(np.float32)
    g = cv2.resize(g, (W, H), interpolation=cv2.INTER_LINEAR)[..., None]
    im = np.clip(im + g * 0.012, 0, 1)
    return (im * 255 + 0.5).astype(np.uint8)

def load(d, f):
    p = os.path.join(d, f"f{f:04d}.png")
    return cv2.imread(p)

if __name__ == "__main__":
    d = sys.argv[1]
    if sys.argv[2] == "preview":
        os.makedirs(sys.argv[3], exist_ok=True)
        for f in map(int, sys.argv[4].split(",")):
            src = load(d, f)
            if src is None:
                print("missing", f); continue
            cv2.imwrite(os.path.join(sys.argv[3], f"p{f:04d}.jpg"), cv2.cvtColor(grade(src, f), cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 92])
        sys.exit(0)
    wav, out = sys.argv[2], sys.argv[3]
    total = 1152
    ff = subprocess.Popen(["ffmpeg", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", "24",
                           "-i", "-", "-i", wav, "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "slow", "-crf", "16",
                           "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-c:a", "aac", "-b:a", "256k", "-shortest", out],
                          stdin=subprocess.PIPE)
    last = None
    for f in range(total):
        src = load(d, f)
        if src is None:
            src = last
        last = src
        ff.stdin.write(grade(src, f).tobytes())
        if f % 100 == 0:
            print("post", f, flush=True)
    ff.stdin.close(); ff.wait()
    print("done", out)
