"""Score + sound design + voiceover mix for promo v2 (60 s, 48 kHz stereo).

python sound_v2.py <v2_dir>      reads sfx_cues.json and vo/k1..k4.wav, writes mix.wav

120 BPM, so every 2 s hook beat is exactly one bar. Original synthesis only.
"""
import sys, os, json, wave
import numpy as np
from scipy.signal import butter, sosfilt, fftconvolve, resample_poly
import soundfile as sf

V2 = sys.argv[1]
SR = 48000; DUR = 60.0; N = int(SR * DUR)
M = np.zeros((2, N))      # music bus
X = np.zeros((2, N))      # sfx bus
rng = np.random.default_rng(7)
BPM = 120; B = 60 / BPM

def t_(n): return np.arange(n) / SR
def hz(m): return 440 * 2 ** ((m - 69) / 12)
def lp(x, f, o=2): return sosfilt(butter(o, f, "low", fs=SR, output="sos"), x)
def hp(x, f, o=2): return sosfilt(butter(o, f, "high", fs=SR, output="sos"), x)
def bp(x, lo, hi): return sosfilt(butter(2, [lo, hi], "band", fs=SR, output="sos"), x)
def put(bus, sig, at, gain=1.0, pan=0.0):
    i = int(at * SR)
    if i >= N or i + len(sig) <= 0: return
    if i < 0: sig = sig[-i:]; i = 0
    sig = sig[:N - i] * gain
    bus[0, i:i + len(sig)] += sig * np.sqrt(0.5 * (1 - pan))
    bus[1, i:i + len(sig)] += sig * np.sqrt(0.5 * (1 + pan))
def env(n, a, r):
    e = np.ones(n); A = max(1, int(a * SR)); R = max(1, int(r * SR))
    e[:A] = np.linspace(0, 1, A); e[-R:] *= np.linspace(1, 0, R); return e
def saw(f, n, det=0.006):
    t = t_(n); return sum(2 * ((t * f * (1 + d)) % 1) - 1 for d in (-det, 0, det)) / 3

# ------------------------------------------------------------------ instruments
def kick(at, g=0.9):
    n = int(0.45 * SR); t = t_(n)
    f = 48 + 140 * np.exp(-t * 32)
    s = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 7.5)
    s += 0.25 * hp(rng.standard_normal(n), 3000) * np.exp(-t * 200)
    put(M, s, at, g)
def clap(at, g=0.32):
    n = int(0.25 * SR); t = t_(n); s = np.zeros(n)
    for k, d in enumerate((0, 0.009, 0.018)):
        i = int(d * SR); seg = bp(rng.standard_normal(n - i), 900, 5000) * np.exp(-t[:n - i] * (60 if k < 2 else 16))
        s[i:] += seg
    put(M, s, at, g)
def hat(at, g=0.07, open_=False, pan=0.25):
    n = int((0.22 if open_ else 0.05) * SR); t = t_(n)
    s = hp(rng.standard_normal(n), 8000) * np.exp(-t * (18 if open_ else 90))
    put(M, s, at, g, pan)
def bass(m, at, dur, g=0.30):
    n = int(dur * SR); t = t_(n)
    s = np.sin(2 * np.pi * hz(m) * t) + 0.35 * lp(saw(hz(m), n), 700)
    put(M, s * env(n, 0.005, 0.05), at, g)
def pluck(m, at, g=0.09, pan=0.0, d=0.22, bright=4200):
    n = int(0.9 * SR); t = t_(n)
    s = lp(saw(hz(m), n, 0.003) + 0.6 * np.sin(2 * np.pi * hz(m) * t), bright) * np.exp(-t / d)
    put(M, s, at, g, pan)
def pad(ms, at, dur, g=0.06, cut=1600, pump=True):
    n = int(dur * SR); s = sum(saw(hz(m), n, 0.008) for m in ms)
    s = lp(s, cut) * env(n, 0.08, 0.3)
    if pump:
        ph = (t_(n) + at) % B
        s *= 0.35 + 0.65 * np.clip(ph / 0.22, 0, 1) ** 1.5
    put(M, s, at, g, -0.2); put(M, np.roll(s, 240), at, g, 0.2)

# ------------------------------------------------------------------ sfx
def whoosh(at, g=0.20, dur=0.32):
    n = int(dur * SR); t = t_(n); x = rng.standard_normal(n); out = np.zeros(n)
    for i in range(0, n, 512):
        fc = 600 + 6000 * (i / n) ** 1.5
        out[i:i + 512] = lp(x[i:i + 512], fc)
    out *= np.sin(np.pi * t / dur) ** 2
    put(X, out, at - dur * 0.7, g, 0.0)
def pop(at, g=0.20):
    n = int(0.12 * SR); t = t_(n); f = 700 + 900 * (1 - np.exp(-t * 60))
    put(X, np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 32), at, g)
def tick(at, g=0.12):
    n = int(0.06 * SR); t = t_(n)
    put(X, np.sin(2 * np.pi * 1760 * t) * np.exp(-t * 70), at, g, 0.2)
def send(at, g=0.16):
    n = int(0.16 * SR); t = t_(n); f = 500 + 1400 * t / 0.16
    put(X, np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 18), at, g)
def tap(at, g=0.24):
    n = int(0.05 * SR); t = t_(n)
    put(X, (bp(rng.standard_normal(n), 1500, 6000) * 0.6 + np.sin(2 * np.pi * 300 * t)) * np.exp(-t * 120), at, g)
def keyclick(at, g):
    n = int(0.035 * SR); t = t_(n)
    s = bp(rng.standard_normal(n), 2000, 7000) * np.exp(-t * 260) + 0.4 * np.sin(2 * np.pi * 2100 * t) * np.exp(-t * 400)
    put(X, s, at, g * rng.uniform(0.7, 1.1), rng.uniform(-0.3, 0.3))
def typing(at, dur, g=0.11):
    k = at
    while k < at + dur:
        keyclick(k, g); k += rng.uniform(0.045, 0.085)
def impact(at, g=0.7, big=False):
    n = int((3.5 if big else 1.6) * SR); t = t_(n)
    f = 36 + 90 * np.exp(-t * 7)
    s = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * (1.1 if big else 3))
    s += lp(rng.standard_normal(n), 3000) * np.exp(-t * 10) * 0.35
    put(X, s, at, g)
def riser(at, dur, g=0.13):
    n = int(dur * SR); t = t_(n); x = rng.standard_normal(n); out = np.zeros(n)
    for i in range(0, n, 1024):
        out[i:i + 1024] = lp(x[i:i + 1024], 400 + 8000 * (i / n) ** 2)
    out *= (t / dur) ** 2
    put(X, out, at, g)

# ------------------------------------------------------------------ arrangement
Am = [57, 60, 64]; F = [53, 57, 60]; C = [55, 60, 64]; G = [55, 59, 62]
PROG = [(Am, 45), (F, 41), (C, 48), (G, 43)]
def groove(bar0, bars, energy=1.0, drums=True, arp=True):
    for b in range(bars):
        t0 = bar0 + b * 4 * B
        ch, root = PROG[b % 4]
        pad(ch + [ch[0] + 12], t0, 4 * B, g=0.05 * energy, cut=1400 + 900 * energy)
        for e in range(8):
            bass(root - 12 if e % 2 == 0 else root, t0 + e * B / 2, B / 2 * 0.9, 0.26 * energy)
        if drums:
            for q in range(4):
                kick(t0 + q * B, 0.85 * energy)
                if q in (1, 3): clap(t0 + q * B, 0.28 * energy)
                for s16 in range(4):
                    hat(t0 + q * B + s16 * B / 4, (0.05 if s16 % 2 else 0.03) * energy, pan=0.3 if s16 % 2 else -0.2)
                hat(t0 + q * B + B / 2, 0.035 * energy, open_=True, pan=-0.3)
        if arp:
            seq = [ch[0], ch[1], ch[2], ch[1] + 12, ch[2], ch[0] + 12, ch[2], ch[1]]
            for e in range(8):
                pluck(seq[e] + 12, t0 + e * B / 2, 0.07 * energy, pan=0.45 * (1 if e % 2 else -1))

groove(0.0, 7, 1.0)                     # 0-14 s hook: full energy, one bar per command
pad(Am + [69, 76], 14.0, 1.0, g=0.07, cut=3000, pump=False)   # 14-15 stop-time on "All of that."
groove(15.0, 15, 0.72)                  # 15-45 s: under the voiceover
groove(45.0, 5, 0.9, arp=True)          # 45-55 s: tour
riser(51.0, 4.0)
pad([57, 61, 64, 69, 76], 55.0, 4.6, g=0.09, cut=2600, pump=False)   # 55 s: resolve to A major
bass(33, 55.0, 4.0, 0.3)
for i, m in enumerate([76, 81, 85, 88]):
    pluck(m, 55.25 + i * 0.25, 0.06, pan=0.3 * (i - 1.5), d=0.6, bright=6000)

cues = json.load(open(os.path.join(V2, "sfx_cues.json")))["sfx"]
for at, kind in cues:
    if kind == "whoosh": whoosh(at)
    elif kind == "pop": pop(at)
    elif kind == "tick": tick(at)
    elif kind == "send": send(at)
    elif kind == "tap": tap(at)
    elif kind == "impact": impact(at, 0.55)
    elif kind == "impact_big": impact(at, 0.8, big=True)
    elif kind.startswith("type:"): typing(at, float(kind[5:]))

# ------------------------------------------------------------------ voiceover
VO = [("k1.wav", 15.35), ("k2.wav", 30.45), ("k3.wav", 45.25), ("k4.wav", 55.7)]
V = np.zeros((2, N)); duck = np.zeros(N)
for f, at in VO:
    p = os.path.join(V2, "vo", f)
    a, sr = sf.read(p)
    if a.ndim > 1: a = a.mean(1)
    if sr != SR: a = resample_poly(a, SR, sr)
    a = hp(a, 90)
    a = a / (np.max(np.abs(a)) + 1e-9) * 0.9
    put(V, a, at, 1.0)
    i0, i1 = int((at - 0.15) * SR), min(N, int((at + len(a) / SR + 0.25) * SR))
    duck[i0:i1] = 1
# smooth the duck envelope
k = int(0.12 * SR); duck = np.convolve(duck, np.ones(k) / k, mode="same")

# ------------------------------------------------------------------ mix
def norm(x): return x / (np.max(np.abs(x)) + 1e-9)
ir_n = int(1.8 * SR); ir = rng.standard_normal((2, ir_n)) * np.exp(-t_(ir_n) * 3.2)
ir = np.stack([lp(ir[0], 5000), lp(ir[1], 5000)])
wet = np.stack([fftconvolve(M[c], ir[c])[:N] for c in range(2)])
music = norm(M) * 0.8 + norm(wet) * 0.12
music *= (1 - 0.62 * duck)                               # ~ -8.5 dB under the voice
sfx = norm(X) * 0.55
vwet = np.stack([fftconvolve(V[c], ir[c] * 0.3)[:N] for c in range(2)])
voice = V + 0.05 * norm(vwet) * np.max(np.abs(V))
mix = music * 0.62 + sfx * 0.5 + voice * 0.95
fade = np.ones(N); fn = int(0.8 * SR); fade[-fn:] = np.linspace(1, 0, fn) ** 2
mix *= fade
mix = np.tanh(mix * 1.3) / np.tanh(1.3)
mix *= 0.93 / np.max(np.abs(mix))
pcm = (mix.T * 32767).astype(np.int16)
with wave.open(os.path.join(V2, "mix.wav"), "wb") as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())
print("wrote mix.wav")
