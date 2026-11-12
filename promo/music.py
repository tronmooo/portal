"""Original score for the Portol promo, synthesized from scratch (48 s, 48 kHz stereo)."""
import numpy as np, random, sys
from scipy.signal import butter, sosfilt, fftconvolve
import wave

SR = 48000
DUR = 48.0
N = int(SR * DUR)
L = np.zeros(N); R = np.zeros(N)
rng = np.random.default_rng(1)

def t_(n):
    return np.arange(n) / SR

def note_hz(n):  # midi -> hz
    return 440.0 * 2 ** ((n - 69) / 12)

def lp(x, fc, order=2):
    return sosfilt(butter(order, fc, "low", fs=SR, output="sos"), x)

def hp(x, fc, order=2):
    return sosfilt(butter(order, fc, "high", fs=SR, output="sos"), x)

def add(sig, start, pan=0.0, gain=1.0):
    i = int(start * SR)
    if i >= N:
        return
    sig = sig[: N - i] * gain
    L[i:i + len(sig)] += sig * np.sqrt(0.5 * (1 - pan))
    R[i:i + len(sig)] += sig * np.sqrt(0.5 * (1 + pan))

def env_adsr(n, a, d, s, r):
    e = np.ones(n) * s
    A, D, Rr = int(a * SR), int(d * SR), int(r * SR)
    A = min(A, n); e[:A] = np.linspace(0, 1, A)
    D2 = min(D, n - A)
    if D2 > 0:
        e[A:A + D2] = np.linspace(1, s, D2)
    if Rr > 0 and n > Rr:
        e[-Rr:] *= np.linspace(1, 0, Rr)
    return e

def saw(f, n, detune=0.0):
    t = t_(n)
    out = np.zeros(n)
    for d in (-detune, 0, detune):
        ph = (t * f * (1 + d)) % 1.0
        out += 2 * ph - 1
    return out / 3

def pad(midis, start, dur, gain=0.12, cutoff=1400, a=1.5, r=1.8):
    n = int((dur + r) * SR)
    s = np.zeros(n)
    for m in midis:
        s += saw(note_hz(m), n, 0.004)
    s = lp(s, cutoff, 2)
    s *= env_adsr(n, a, 0.5, 0.85, r)
    add(s, start, -0.25, gain)
    add(np.roll(s, 300), start, 0.25, gain)

def pluck(m, start, gain=0.10, pan=0.0, decay=0.35, bright=3500):
    n = int(1.2 * SR)
    t = t_(n)
    s = (np.sin(2 * np.pi * note_hz(m) * t) + 0.5 * np.sin(2 * np.pi * note_hz(m) * 2 * t) + 0.2 * saw(note_hz(m), n))
    s *= np.exp(-t / decay)
    s = lp(s, bright)
    add(s, start, pan, gain)

def kick(start, gain=0.55):
    n = int(0.5 * SR); t = t_(n)
    f = 45 + 110 * np.exp(-t * 28)
    ph = 2 * np.pi * np.cumsum(f) / SR
    s = np.sin(ph) * np.exp(-t * 7)
    add(s, start, 0, gain)

def hat(start, gain=0.05, pan=0.3):
    n = int(0.08 * SR); t = t_(n)
    s = hp(rng.standard_normal(n), 7000) * np.exp(-t * 60)
    add(s, start, pan, gain)

def click(start, gain=0.16):
    n = int(0.03 * SR); t = t_(n)
    s = hp(rng.standard_normal(n), 2500) * np.exp(-t * 300)
    s += 0.5 * np.sin(2 * np.pi * 1800 * t) * np.exp(-t * 400)
    add(s, start, rng.uniform(-0.3, 0.3), gain * rng.uniform(0.7, 1.1))

def riser(start, dur, gain=0.18):
    n = int(dur * SR); t = t_(n)
    noise = rng.standard_normal(n)
    out = np.zeros(n)
    seg = 2048
    for i in range(0, n, seg):
        fc = 300 + 9000 * (i / n) ** 2
        out[i:i + seg] = lp(noise[i:i + seg], fc, 2) if i + seg <= n else lp(noise[i:], fc, 2)
    out *= (t / dur) ** 2
    tone = np.sin(2 * np.pi * np.cumsum(200 + 900 * (t / dur) ** 2) / SR) * (t / dur) ** 3 * 0.3
    add(out + tone, start, 0, gain)

def impact(start, gain=0.9):
    n = int(4 * SR); t = t_(n)
    f = 32 + 80 * np.exp(-t * 6)
    boom = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 1.3)
    crack = lp(rng.standard_normal(n), 2500) * np.exp(-t * 9) * 0.5
    add(boom + crack, start, 0, gain)

def shimmer(start, dur, gain=0.03):
    n = int(dur * SR); t = t_(n)
    s = np.zeros(n)
    for m in (88, 93, 95, 100):
        s += np.sin(2 * np.pi * note_hz(m) * t + rng.uniform(0, 6)) * (0.5 + 0.5 * np.sin(2 * np.pi * rng.uniform(0.2, 0.6) * t))
    s *= env_adsr(n, dur * 0.4, 0.1, 1.0, dur * 0.4)
    add(s, start, rng.uniform(-0.5, 0.5), gain)

# ---------------------------------------------------------------- arrangement
# chords (midi): Am, F, C, G  -> resolve to A major-ish lift at the end
Am = [45, 52, 57, 60, 64]; F = [41, 48, 53, 57, 60]; C = [48, 55, 60, 64, 67]; G = [43, 50, 55, 59, 62]
Fmaj7 = [41, 48, 53, 57, 64]; Asus = [45, 52, 57, 59, 64]; A = [45, 52, 57, 61, 64]

# intro drone 0-11s
pad([33, 40, 45], 0.0, 11.5, gain=0.22, cutoff=500, a=4.0, r=2.0)
pad(Am, 2.0, 4.0, gain=0.10, cutoff=900, a=2.5)
pad(F, 6.0, 5.0, gain=0.10, cutoff=1100, a=1.0)
shimmer(0.5, 6.0); shimmer(5.0, 7.0)

# typing clicks, synced with the key presses in build.py
krng = random.Random(3)
for f in range(150, 330, 3):
    krng.randrange(71)
    tf = f + krng.randrange(0, 2)
    click(tf / 24.0)

# 11-17s: chat — arpeggio enters, free tempo leading into grid
BEAT = (840 - 408) / 7 / 24 / 4          # one bar per feature card
GRID0 = 408 / 24                          # 17.0 s
prog = [Am, F, C, G, Am, F, Fmaj7]
pad(C, 11.0, 3.0, gain=0.07, cutoff=1300, a=0.6)
pad(G, 14.0, 3.0, gain=0.07, cutoff=1500, a=0.6)
for i in range(int((GRID0 - 11.0) / (BEAT / 2))):
    st = 11.0 + i * BEAT / 2
    ch = C if st < 14 else G
    pluck(ch[2 + i % 3] + 12, st, gain=0.06 + 0.04 * (st - 11) / 6, pan=0.35 * (1 if i % 2 else -1))

# 17-35s: features — full groove, one chord per feature
for b, ch in enumerate(prog):
    bs = GRID0 + b * 4 * BEAT
    pad(ch, bs, 4 * BEAT, gain=0.085, cutoff=1800 + b * 200, a=0.25, r=0.8)
    bass = np.sin(2 * np.pi * note_hz(ch[0] - 12) * t_(int(4 * BEAT * SR)))
    bass = lp(bass + 0.3 * saw(note_hz(ch[0] - 12), len(bass)), 300) * env_adsr(len(bass), 0.02, 0.2, 0.8, 0.2)
    add(bass, bs, 0, 0.22)
    for q in range(4):
        kick(bs + q * BEAT, 0.5 if q % 2 == 0 else 0.35)
        hat(bs + q * BEAT + BEAT / 2, 0.045, 0.3)
        hat(bs + q * BEAT + BEAT * 0.75, 0.025, -0.3)
    arp = [ch[1], ch[2], ch[3], ch[4], ch[3] + 12, ch[4], ch[3], ch[2]]
    for e in range(8):
        pluck(arp[e] + 12, bs + e * BEAT / 2, gain=0.085, pan=0.4 * np.sin(e), decay=0.3)
    shimmer(bs, 4 * BEAT, gain=0.02)

# 35-42s: the wall — lift, riser, drop out
WALL0 = 840 / 24
pad(F + [72], WALL0, 3.5, gain=0.09, cutoff=2600, a=0.3)
pad(G + [74], WALL0 + 3.5, 3.5, gain=0.10, cutoff=3200, a=0.3)
for i in range(int(6.5 / (BEAT / 2))):
    st = WALL0 + i * BEAT / 2
    ch = F if st < WALL0 + 3.5 else G
    pluck(ch[(i % 4) + 1] + 12, st, gain=0.08, pan=0.4 * (1 if i % 2 else -1), decay=0.25, bright=5000)
    if i % 2 == 0 and st < WALL0 + 6.0:
        kick(st, 0.45)
riser(WALL0 + 1.0, 6.0, gain=0.16)

# 42s+: portal — silence beat, ignition ticks, impact on disc open, resolve
P0 = 1008 / 24
for i in range(14):
    pluck(81 + (i % 5) * 2, P0 + (6 + i * 2.2) / 24, gain=0.05, pan=np.sin(i), decay=0.2, bright=6000)
HIT = P0 + 36 / 24
impact(HIT, 0.85)
pad(A + [69, 76], HIT, 4.5, gain=0.12, cutoff=2400, a=0.05, r=2.5)
pad([33, 45], HIT, 4.5, gain=0.12, cutoff=400, a=0.05, r=2.5)
shimmer(HIT, 4.5, gain=0.05)

# ---------------------------------------------------------------- reverb + master
ir_n = int(2.8 * SR)
ir_t = t_(ir_n)
irL = rng.standard_normal(ir_n) * np.exp(-ir_t * 2.4); irR = rng.standard_normal(ir_n) * np.exp(-ir_t * 2.4)
irL = lp(irL, 6000); irR = lp(irR, 6000)
wetL = fftconvolve(L, irL)[:N]; wetR = fftconvolve(R, irR)[:N]
wetL /= np.max(np.abs(wetL)) + 1e-9; wetR /= np.max(np.abs(wetR)) + 1e-9
dry = max(np.max(np.abs(L)), np.max(np.abs(R)))
L2 = L / dry + 0.32 * wetL; R2 = R / dry + 0.32 * wetR
# fade out tail
fade = np.ones(N); fn = int(2.0 * SR); fade[-fn:] = np.linspace(1, 0, fn) ** 2
L2 *= fade; R2 *= fade
st = np.stack([L2, R2], 1)
st = np.tanh(st * 1.4) / np.tanh(1.4)       # gentle saturation / limiting
st *= 0.89 / np.max(np.abs(st))
pcm = (st * 32767).astype(np.int16)
with wave.open(sys.argv[1], "wb") as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())
print("wrote", sys.argv[1])
