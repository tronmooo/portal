# Portol promo video (Blender)

A 48-second, 1080p cinematic promo built entirely in code: a procedural
Blender scene, real screenshots of the live app, an original synthesized
score and a finishing pass with titles.

| Time | Shot | What it sells |
|------|------|---------------|
| 0–6 s | Dark room, the laptop lid opens and the screen powers on | "Your life has a lot of moving parts." |
| 6–11 s | Macro on the backlit keyboard, keys typing on their own | "What if it all just listened?" |
| 11–17 s | Over the shoulder: a sentence typed into chat becomes a logged expense | "Portol logs it, files it, and remembers it." |
| 17–35 s | A phone floats in a studio, cycling seven features | Finance, Calendar, Tasks, Wellness, Habits, Bills, Journal |
| 35–42 s | Camera pulls back from a curved wall of 27 app screens | "Everything in your life. One place." |
| 42–48 s | A 3D portal (the Portol logo, reimagined) ignites and opens | Portol · Your AI-powered life command center · portol.me |

## Pipeline

```bash
# 1. Screenshots: seeds the SMOKE account through the real AI chat (under the
#    gate lock, like every gate) and captures phone + desktop screens.
npx tsx promo/capture.ts out/shots

# 2. Screen textures (laptop workspace composites, phone screens, masks, logo)
python3 promo/prep.py out/shots out/tex

# 3. Render (pip install bpy==5.3.0 in a venv; Cycles CPU works headless).
#    args: <tex> <out> <frames> <resolution %> <samples>; resumable.
DIFF=1 python promo/build.py out/tex out/frames 0-1151 67 12

# 4. Score + finishing (pip install numpy scipy opencv-python-headless pillow)
python promo/music.py out/score.wav
python promo/post.py out/frames out/score.wav portol-promo.mp4
```

`build.py out/tex out/blend save` writes `portol_promo.blend` to open in the
Blender UI. All animation happens in `update(frame)`; the render loop calls it
before each frame, so camera paths, screen swaps and the portal ignition are
easy to retime.

On a GPU machine, raise quality with `100 64` (full 1080p, 64 samples) and set
`scene.cycles.device = "GPU"`. The shipped cut renders 1286×723 at 12 samples
with OpenImageDenoise on 4 CPU cores (~15 s/frame) and is upscaled in post.

Fonts: Inter Display. Music and sound design are synthesized in `music.py`.
Key clicks are synced to the key presses in `build.py`.
