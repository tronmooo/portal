"""Portol promo — procedural Blender scene + per-frame animation + render loop.

Usage: python build.py <tex_dir> <out_dir> <frames spec e.g. 0-1151 or 10,200,500> [res_pct] [samples]
"""
import bpy, math, random, sys, os, time
from mathutils import Vector, Euler
import addon_utils
addon_utils.enable("cycles")

TEX, OUT, SPEC = sys.argv[1], sys.argv[2], sys.argv[3]
RES = int(sys.argv[4]) if len(sys.argv) > 4 else 100
SAMPLES = int(sys.argv[5]) if len(sys.argv) > 5 else 48
os.makedirs(OUT, exist_ok=True)
random.seed(7)

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
FPS = 24
scene.render.fps = FPS

# ---------------------------------------------------------------- helpers
def img(name):
    return bpy.data.images.load(os.path.join(TEX, name), check_existing=True)

def mat(name, color=(0.5, 0.5, 0.5), rough=0.5, metal=0.0, emit=None, strength=0.0, coat=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*color, 1)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    if coat:
        b.inputs["Coat Weight"].default_value = coat
    if emit:
        b.inputs["Emission Color"].default_value = (*emit, 1)
        b.inputs["Emission Strength"].default_value = strength
    return m

def screen_mat(name, image_names, mask=None, strength=1.4):
    """Emission material that can cross-fade between two image slots A/B."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    ta = nt.nodes.new("ShaderNodeTexImage"); ta.name = "A"; ta.image = img(image_names[0])
    tb = nt.nodes.new("ShaderNodeTexImage"); tb.name = "B"; tb.image = img(image_names[-1])
    for t in (ta, tb):
        t.interpolation = "Cubic"
    mix = nt.nodes.new("ShaderNodeMix"); mix.data_type = "RGBA"; mix.name = "MIX"
    mix.inputs["Factor"].default_value = 0.0
    nt.links.new(ta.outputs["Color"], mix.inputs["A"])
    nt.links.new(tb.outputs["Color"], mix.inputs["B"])
    em = nt.nodes.new("ShaderNodeEmission"); em.name = "EM"
    em.inputs["Strength"].default_value = strength
    # glossy glass on top of the screen for reflections
    gl = nt.nodes.new("ShaderNodeBsdfGlossy"); gl.inputs["Roughness"].default_value = 0.08
    gl.inputs["Color"].default_value = (0.06, 0.06, 0.07, 1)
    add = nt.nodes.new("ShaderNodeAddShader")
    if mask:
        tm = nt.nodes.new("ShaderNodeTexImage"); tm.image = img(mask)
        tm.image.colorspace_settings.name = "Non-Color"
        mul = nt.nodes.new("ShaderNodeMix"); mul.data_type = "RGBA"; mul.blend_type = "MULTIPLY"
        mul.inputs["Factor"].default_value = 1.0
        nt.links.new(mix.outputs["Result"], mul.inputs["A"])
        nt.links.new(tm.outputs["Color"], mul.inputs["B"])
        nt.links.new(mul.outputs["Result"], em.inputs["Color"])
    else:
        nt.links.new(mix.outputs["Result"], em.inputs["Color"])
    nt.links.new(em.outputs[0], add.inputs[0])
    nt.links.new(gl.outputs[0], add.inputs[1])
    nt.links.new(add.outputs[0], out.inputs["Surface"])
    return m

def box(name, size, loc, material, bevel=0.0, segs=3, parent=None, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = bpy.context.active_object
    o.name = name
    o.scale = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if bevel:
        mod = o.modifiers.new("bev", "BEVEL"); mod.width = bevel; mod.segments = segs
        mod.limit_method = "ANGLE"
    o.data.materials.append(material)
    for p in o.data.polygons:
        p.use_smooth = True
    if parent:
        o.parent = parent
    return o

def plane(name, w, h, loc, rot, material, parent=None):
    bpy.ops.mesh.primitive_plane_add(size=1, location=loc, rotation=rot)
    o = bpy.context.active_object
    o.name = name
    o.scale = (w, h, 1)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    o.data.materials.append(material)
    if parent:
        o.parent = parent
    return o

def cyl(name, r, depth, loc, material, verts=48, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=depth, location=loc, vertices=verts, rotation=rot)
    o = bpy.context.active_object; o.name = name
    o.data.materials.append(material)
    bpy.ops.object.shade_smooth()
    return o

def area_light(name, loc, rot, size, power, color=(1, 1, 1), shape="RECTANGLE", size_y=None):
    l = bpy.data.lights.new(name, "AREA")
    l.energy = power; l.color = color; l.shape = shape; l.size = size
    if size_y:
        l.size_y = size_y
    o = bpy.data.objects.new(name, l)
    scene.collection.objects.link(o)
    o.location = loc; o.rotation_euler = rot
    o.visible_camera = False
    o.visible_glossy = False
    return o

def point_at(obj, target):
    d = Vector(target) - obj.location
    obj.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()

def camera(name, lens=35, fstop=2.8):
    c = bpy.data.cameras.new(name)
    c.lens = lens
    c.dof.use_dof = True
    c.dof.aperture_fstop = fstop
    c.clip_start = 0.005
    o = bpy.data.objects.new(name, c)
    scene.collection.objects.link(o)
    return o

def ease(t):
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)

def ease_out(t):
    t = max(0.0, min(1.0, t))
    return 1 - (1 - t) ** 3

def lerp(a, b, t):
    return a + (b - a) * t

def vlerp(a, b, t):
    return Vector(a).lerp(Vector(b), t)

def place_cam(cam, pos, target, focus=None):
    cam.location = Vector(pos)
    point_at(cam, target)
    cam.data.dof.focus_distance = (Vector(focus or target) - Vector(pos)).length

# ---------------------------------------------------------------- world
world = bpy.data.worlds.new("W"); scene.world = world
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.004, 0.006, 0.012, 1)
world.node_tree.nodes["Background"].inputs["Strength"].default_value = 1.0

# ---------------------------------------------------------------- materials
M_floor = mat("floor", (0.035, 0.03, 0.027), 0.42, coat=0.2)
M_wall = mat("wall", (0.03, 0.033, 0.04), 0.85)
M_wood = mat("walnut", (0.11, 0.055, 0.028), 0.32, coat=0.4)
M_blackmetal = mat("blackmetal", (0.02, 0.02, 0.022), 0.35, 1.0)
M_alu = mat("alu", (0.33, 0.34, 0.36), 0.28, 1.0)
M_key = mat("key", (0.04, 0.042, 0.048), 0.38)
M_pad = mat("pad", (0.28, 0.29, 0.31), 0.18, 1.0)
M_bezel = mat("bezel", (0.005, 0.005, 0.006), 0.15)
M_backlight = mat("backlight", (0, 0, 0), 1.0, emit=(0.25, 0.75, 1.0), strength=2.0)
M_ceramic = mat("ceramic", (0.82, 0.8, 0.76), 0.25, coat=0.6)
M_coffee = mat("coffee", (0.05, 0.02, 0.01), 0.1)
M_pot = mat("pot", (0.12, 0.11, 0.1), 0.7)
M_leaf = mat("leaf", (0.03, 0.12, 0.04), 0.45)
M_lampbulb = mat("bulb", (1, 1, 1), 0.5, emit=(1.0, 0.72, 0.42), strength=25)
M_window = mat("window", (0, 0, 0), 1.0, emit=(0.18, 0.32, 0.8), strength=1.2)
M_book = [mat(f"book{i}", c, 0.6) for i, c in enumerate([(0.25, 0.06, 0.05), (0.05, 0.1, 0.2), (0.4, 0.33, 0.2), (0.06, 0.06, 0.06)])]
M_titanium = mat("titanium", (0.09, 0.09, 0.1), 0.22, 1.0)
M_glossfloor = mat("glossfloor", (0.008, 0.009, 0.012), 0.12, coat=1.0)
M_dust = mat("dust", (0, 0, 0), 1, emit=(0.75, 0.85, 1.0), strength=1.2)

# ================================================================ ROOM (origin)
plane("floor", 14, 14, (0, 0, 0), (0, 0, 0), M_floor)
plane("backwall", 14, 6, (0, 2.6, 3), (math.radians(90), 0, 0), M_wall)
plane("leftwall", 14, 6, (-3.2, 0, 3), (math.radians(90), 0, math.radians(90)), M_wall)
plane("ceiling", 14, 14, (0, 0, 3.2), (math.radians(180), 0, 0), M_wall)
# window with mullions, sky glow behind
plane("window", 2.2, 1.5, (1.35, 2.585, 1.75), (math.radians(90), 0, 0), M_window)
for x in (0.25, 1.35, 2.45):
    box(f"mullion_v{x}", (0.04, 0.05, 1.55), (x, 2.56, 1.75), M_blackmetal)
for z in (1.0, 1.75, 2.5):
    box(f"mullion_h{z}", (2.24, 0.05, 0.04), (1.35, 2.56, z), M_blackmetal)
area_light("window_light", (1.35, 2.4, 1.75), (math.radians(-90), 0, 0), 2.0, 140, (0.55, 0.7, 1.0), size_y=1.4)
# neon logo on the wall (the brand, glowing in the bokeh)
logo_m = bpy.data.materials.new("logo"); logo_m.use_nodes = True
nt = logo_m.node_tree; nt.nodes.clear()
lt = nt.nodes.new("ShaderNodeTexImage"); lt.image = img("logo.png")
le = nt.nodes.new("ShaderNodeEmission"); le.inputs["Strength"].default_value = 3.0
tr = nt.nodes.new("ShaderNodeBsdfTransparent")
mx = nt.nodes.new("ShaderNodeMixShader"); lo = nt.nodes.new("ShaderNodeOutputMaterial")
nt.links.new(lt.outputs["Color"], le.inputs["Color"])
nt.links.new(lt.outputs["Alpha"], mx.inputs["Fac"])
nt.links.new(tr.outputs[0], mx.inputs[1]); nt.links.new(le.outputs[0], mx.inputs[2])
nt.links.new(mx.outputs[0], lo.inputs["Surface"])
plane("wall_logo", 0.75, 0.75, (-1.25, 2.58, 1.85), (math.radians(90), 0, 0), logo_m)
pt = bpy.data.lights.new("logo_glow", "POINT"); pt.energy = 18; pt.color = (0.3, 0.6, 1.0); pt.shadow_soft_size = 0.3
po = bpy.data.objects.new("logo_glow", pt); scene.collection.objects.link(po); po.location = (-1.25, 2.35, 1.85)

# desk
DESK_Z = 0.775
box("desktop", (2.4, 1.0, 0.05), (0, 0.2, 0.75), M_wood, bevel=0.006)
for x in (-1.1, 1.1):
    for y in (-0.2, 0.6):
        box(f"leg{x}{y}", (0.04, 0.04, 0.725), (x, y, 0.3625), M_blackmetal)

# laptop
LX, LY = 0.0, 0.12
base = box("lap_base", (0.31, 0.215, 0.012), (LX, LY, DESK_Z + 0.006), M_alu, bevel=0.004, segs=4)
KEY_TOP = DESK_Z + 0.012
plane("lap_backlight", 0.27, 0.095, (LX, LY + 0.025, KEY_TOP + 0.0002), (0, 0, 0), M_backlight)
keys = []
cols, rows = 14, 5
kw = 0.0165
for r in range(rows):
    for c in range(cols):
        x = LX - (cols - 1) * 0.0188 / 2 + c * 0.0188
        y = LY + 0.068 - r * 0.0188
        k = box(f"key_{r}_{c}", (kw, kw, 0.0028), (x, y, KEY_TOP + 0.0016), M_key, bevel=0.0012, segs=2)
        k["rest_z"] = KEY_TOP + 0.0016
        keys.append(k)
# space bar
sp = box("key_space", (0.11, kw, 0.0028), (LX, LY + 0.068 - 5 * 0.0188, KEY_TOP + 0.0016), M_key, bevel=0.0012, segs=2)
sp["rest_z"] = KEY_TOP + 0.0016
keys.append(sp)
box("trackpad", (0.115, 0.06, 0.0006), (LX, LY - 0.07, KEY_TOP + 0.0003), M_pad, bevel=0.0003)

hinge = bpy.data.objects.new("hinge", None); scene.collection.objects.link(hinge)
hinge.location = (LX, LY + 0.1075, KEY_TOP)
lid = box("lid", (0.31, 0.005, 0.21), (0, 0.0025, 0.105), M_alu, bevel=0.003, segs=4, parent=hinge)
lid.location = (0, 0.0025, 0.105)
bez = plane("bezel", 0.304, 0.203, (0, -0.0001, 0.105), (math.radians(90), 0, 0), M_bezel, parent=lid)
bez.location = (0, -0.0026, 0.0)
M_lapscreen = screen_mat("lapscreen", ["lap_dash.png", "lap_chat1.png"], strength=1.0)
scr = plane("lap_screen", 0.288, 0.18, (0, 0, 0), (math.radians(90), 0, 0), M_lapscreen, parent=lid)
scr.location = (0, -0.0028, 0.006)
screen_light = area_light("screen_light", (0, 0, 0), (0, 0, 0), 0.25, 0, (0.55, 0.75, 1.0), size_y=0.16)
screen_light.parent = lid
screen_light.location = (0, -0.03, 0.006)
screen_light.rotation_euler = (math.radians(90), 0, 0)

# mug
mug = cyl("mug", 0.042, 0.1, (0.42, 0.05, DESK_Z + 0.05), M_ceramic)
cyl("coffee", 0.038, 0.002, (0.42, 0.05, DESK_Z + 0.093), M_coffee)
bpy.ops.mesh.primitive_torus_add(major_radius=0.028, minor_radius=0.007, location=(0.468, 0.05, DESK_Z + 0.05), rotation=(math.radians(90), 0, 0))
h = bpy.context.active_object; h.data.materials.append(M_ceramic); bpy.ops.object.shade_smooth()
# plant
cyl("pot", 0.075, 0.16, (-0.8, 0.45, DESK_Z + 0.08), M_pot)
for i in range(16):
    a = i / 16 * math.tau + random.random() * 0.3
    bpy.ops.mesh.primitive_uv_sphere_add(radius=1, segments=16, ring_count=8,
                                         location=(-0.8 + math.cos(a) * 0.07, 0.45 + math.sin(a) * 0.07, DESK_Z + 0.24 + random.random() * 0.12))
    lf = bpy.context.active_object
    lf.scale = (0.022, 0.09, 0.006)
    lf.rotation_euler = (math.radians(55 + random.random() * 25), 0, a + math.pi / 2)
    lf.data.materials.append(M_leaf); bpy.ops.object.shade_smooth()
# books
bz = DESK_Z
for i, (w, t) in enumerate([(0.26, 0.035), (0.24, 0.03), (0.27, 0.04), (0.22, 0.025)]):
    box(f"book{i}", (w, 0.19, t), (0.78, 0.5, bz + t / 2), M_book[i], bevel=0.002, rot=(0, 0, math.radians(8 * (i % 2) - 4)))
    bz += t
# desk lamp
cyl("lamp_base", 0.07, 0.015, (-0.55, 0.55, DESK_Z + 0.0075), M_blackmetal)
arm = cyl("lamp_arm", 0.008, 0.45, (-0.55, 0.47, DESK_Z + 0.22), M_blackmetal, rot=(math.radians(-20), 0, 0))
bpy.ops.mesh.primitive_cone_add(radius1=0.07, radius2=0.025, depth=0.1, location=(-0.5, 0.36, DESK_Z + 0.43), rotation=(math.radians(-60), 0, math.radians(-15)))
shade = bpy.context.active_object; shade.data.materials.append(M_blackmetal)
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.018, location=(-0.49, 0.34, DESK_Z + 0.405))
bpy.context.active_object.data.materials.append(M_lampbulb)
sl = bpy.data.lights.new("lamp_spot", "SPOT"); sl.energy = 14; sl.color = (1.0, 0.7, 0.42)
sl.spot_size = math.radians(70); sl.spot_blend = 0.6; sl.shadow_soft_size = 0.04
so = bpy.data.objects.new("lamp_spot", sl); scene.collection.objects.link(so)
so.location = (-0.49, 0.33, DESK_Z + 0.4); point_at(so, (-0.2, 0.05, DESK_Z))
# chair silhouette hint (back rest, out of focus foreground in some shots)
# box("chair_back", (0.5, 0.06, 0.55), (0.0, -0.75, 0.95), mat("chair", (0.015, 0.015, 0.017), 0.6), bevel=0.03, segs=6)
kl = area_light("key_light", (LX - 0.12, LY - 0.25, KEY_TOP + 0.32), (0, 0, 0), 0.35, 4, (0.85, 0.92, 1.0))
point_at(kl, (LX, LY + 0.02, KEY_TOP))
# fill/rim lights
area_light("room_fill", (-2.0, -1.5, 2.2), (math.radians(60), 0, math.radians(-50)), 1.5, 25, (1.0, 0.85, 0.7))
area_light("room_rim", (1.8, 1.6, 1.6), (math.radians(80), 0, math.radians(140)), 0.8, 40, (0.4, 0.6, 1.0))

# dust motes (one mesh, drifts as a whole)
import bmesh
bm = bmesh.new()
for i in range(260):
    p = Vector((random.uniform(-1.2, 2.2), random.uniform(-0.8, 2.3), random.uniform(0.8, 2.6)))
    r = random.uniform(0.0006, 0.0016)
    bmesh.ops.create_icosphere(bm, subdivisions=1, radius=r, matrix=__import__("mathutils").Matrix.Translation(p))
dm = bpy.data.meshes.new("dust"); bm.to_mesh(dm); bm.free()
dust = bpy.data.objects.new("dust", dm); scene.collection.objects.link(dust); dm.materials.append(M_dust)

# ================================================================ PHONE STUDIO (x=50)
PX = 50.0
plane("studio_floor", 30, 30, (PX, 0, 0), (0, 0, 0), M_glossfloor)
phone_root = bpy.data.objects.new("phone_root", None); scene.collection.objects.link(phone_root)
phone_root.location = (PX, 0, 1.0)
pw, ph_, pd = 0.0715, 0.147, 0.0078
body = box("phone_body", (pw, pd, ph_), (0, 0, 0), M_titanium, bevel=0.009, segs=10, parent=phone_root)
body.location = (0, 0, 0)
pglass = box("phone_glass", (pw - 0.002, 0.0006, ph_ - 0.002), (0, 0, 0), M_bezel, bevel=0.0003, parent=phone_root)
pglass.location = (0, -pd / 2 - 0.0002, 0)
PH_SCREENS = ["ph_finance.png", "ph_calendar.png", "ph_tasks.png", "ph_wellness.png", "ph_habits.png", "ph_obligations.png", "ph_journal.png"]
M_phscreen = screen_mat("phscreen", PH_SCREENS[:2], mask="phone_mask.png", strength=1.6)
psc = plane("phone_screen", 0.0665, 0.1438, (0, 0, 0), (math.radians(90), 0, 0), M_phscreen, parent=phone_root)
psc.location = (0, -pd / 2 - 0.0006, 0)
# camera bump on back
box("phone_cam", (0.03, 0.002, 0.03), (0, 0, 0), M_titanium, bevel=0.006, segs=6, parent=phone_root).location = (-0.017, pd / 2 + 0.001, 0.05)
# floating background cards
card_names = ["ph_dashboard.png", "ph_trackers.png", "ph_chat-reply.png", "ph_goals.png", "ph_insights.png",
              "ph_finance-2.png", "ph_wellness-2.png", "ph_calendar-2.png", "ph_dashboard-2.png", "ph_chat-reply2.png"]
cards = []
for i, cn in enumerate(card_names):
    cm = screen_mat(f"card{i}", [cn], mask="card_mask.png", strength=0.9)
    a = (i / len(card_names)) * math.tau
    rad = random.uniform(0.9, 1.4)
    loc = (PX + math.cos(a) * rad, 0.6 + math.sin(a) * rad * 0.6 + 0.6, 1.0 + random.uniform(-0.35, 0.45))
    c = plane(f"card{i}", 0.17, 0.368, loc, (math.radians(90), random.uniform(-0.2, 0.2), random.uniform(-0.5, 0.5)), cm)
    c["base"] = loc; c["phase"] = random.random() * 6.28
    cards.append(c)
area_light("studio_key", (PX - 0.6, -0.8, 1.6), (0, 0, 0), 0.6, 18, (1.0, 0.96, 0.92))
point_at(bpy.data.objects["studio_key"], (PX, 0, 1.0))
rim1 = area_light("studio_rim_cyan", (PX + 0.7, 0.5, 1.2), (0, 0, 0), 0.3, 50, (0.1, 0.75, 1.0), size_y=1.5)
point_at(rim1, (PX, 0, 1.0))
rim2 = area_light("studio_rim_violet", (PX - 0.7, 0.5, 1.1), (0, 0, 0), 0.3, 50, (0.55, 0.3, 1.0), size_y=1.5)
point_at(rim2, (PX, 0, 1.0))

# ================================================================ WALL (x=100)
WX = 100.0
wall_names = [n for n in sorted(os.listdir(TEX)) if n.startswith("ph_")]
wall = []
R = 3.2
for row in range(3):
    for col in range(9):
        n = wall_names[(row * 9 + col * 5) % len(wall_names)]
        if row == 1 and col == 4:
            n = "ph_dashboard.png"
        a = math.radians((col - 4) * 13.5)
        loc = (WX + math.sin(a) * R, -math.cos(a) * R + R, 1.4 + (row - 1) * 0.86)
        cm = bpy.data.materials.get(f"wall_{n}") or screen_mat(f"wall_{n}", [n], mask="card_mask.png", strength=1.1)
        p = plane(f"wall_{row}_{col}", 0.36, 0.78, loc, (math.radians(90), 0, a), cm)
        wall.append(p)
plane("wall_floor", 30, 30, (WX, 0, 0), (0, 0, 0), M_glossfloor)

# ================================================================ PORTAL (x=150)
QX = 150.0
plane("portal_floor", 40, 40, (QX, 0, 0), (0, 0, 0), M_glossfloor)
for i, (w, d) in enumerate([(3.4, 0.5), (3.0, 0.4), (2.6, 0.35)]):
    box(f"step{i}", (w, d, 0.12), (QX, -0.25 + i * 0.12, 0.06 + i * 0.12), M_titanium, bevel=0.01)
bpy.ops.mesh.primitive_torus_add(major_radius=1.25, minor_radius=0.13, major_segments=128, minor_segments=24,
                                 location=(QX, 0.1, 1.72), rotation=(math.radians(90), 0, 0))
ring = bpy.context.active_object; ring.data.materials.append(M_titanium); bpy.ops.object.shade_smooth()
ring.scale = (0.82, 1.0, 1.0)
seg_mats = []
for i in range(14):
    a = i / 14 * math.tau
    sm = mat(f"seg{i}", (0, 0, 0), 0.4, emit=(0.05, 0.45, 1.0), strength=0.0)
    seg_mats.append(sm)
    b = box(f"seg{i}", (0.09, 0.05, 0.16), (QX + math.sin(a) * 1.25 * 0.82, 0.0, 1.72 + math.cos(a) * 1.25), sm, bevel=0.01,
            rot=(0, -a, 0))
# swirl disc
disc_m = bpy.data.materials.new("swirl"); disc_m.use_nodes = True
nt = disc_m.node_tree; nt.nodes.clear()
tc = nt.nodes.new("ShaderNodeTexCoord")
mp = nt.nodes.new("ShaderNodeMapping"); mp.name = "MAP"
ns = nt.nodes.new("ShaderNodeTexNoise"); ns.inputs["Scale"].default_value = 2.2
ns.inputs["Detail"].default_value = 10; ns.inputs["Distortion"].default_value = 1.4
ns.noise_dimensions = "4D"; ns.name = "NOISE"
cr = nt.nodes.new("ShaderNodeValToRGB")
cr.color_ramp.elements[0].position = 0.3; cr.color_ramp.elements[0].color = (0.0, 0.02, 0.15, 1)
cr.color_ramp.elements[1].position = 0.85; cr.color_ramp.elements[1].color = (0.6, 0.9, 1.0, 1)
e = cr.color_ramp.elements.new(0.55); e.color = (0.05, 0.45, 1.0, 1)
gr = nt.nodes.new("ShaderNodeTexGradient"); gr.gradient_type = "SPHERICAL"
mp2 = nt.nodes.new("ShaderNodeMapping"); mp2.inputs["Scale"].default_value = (1.0, 1.0, 1.0)
mul = nt.nodes.new("ShaderNodeMix"); mul.data_type = "RGBA"; mul.blend_type = "ADD"; mul.inputs["Factor"].default_value = 0.25
em = nt.nodes.new("ShaderNodeEmission"); em.name = "EM"; em.inputs["Strength"].default_value = 0.0
out = nt.nodes.new("ShaderNodeOutputMaterial")
nt.links.new(tc.outputs["Object"], mp.inputs["Vector"])
nt.links.new(mp.outputs["Vector"], ns.inputs["Vector"])
nt.links.new(ns.outputs["Fac"], cr.inputs["Fac"])
nt.links.new(tc.outputs["Object"], mp2.inputs["Vector"])
nt.links.new(mp2.outputs["Vector"], gr.inputs["Vector"])
nt.links.new(cr.outputs["Color"], mul.inputs["A"])
nt.links.new(gr.outputs["Color"], mul.inputs["B"])
nt.links.new(mul.outputs["Result"], em.inputs["Color"])
nt.links.new(em.outputs[0], out.inputs["Surface"])
bpy.ops.mesh.primitive_circle_add(vertices=128, radius=1.2, fill_type="NGON", location=(QX, 0.1, 1.72), rotation=(math.radians(90), 0, 0))
disc = bpy.context.active_object; disc.data.materials.append(disc_m); disc.scale = (0.82, 1, 1)
portal_light = area_light("portal_light", (QX, -0.2, 1.72), (math.radians(90), 0, 0), 1.6, 0, (0.3, 0.65, 1.0), shape="DISK")
area_light("portal_top", (QX, -2.0, 4.0), (0, 0, 0), 2.0, 60, (0.6, 0.7, 1.0))
point_at(bpy.data.objects["portal_top"], (QX, 0, 1.0))
# sparkle motes near the portal
bm = bmesh.new()
import mathutils
for i in range(140):
    p = Vector((QX + random.uniform(-2.5, 2.5), random.uniform(-2.5, 1.0), random.uniform(0.1, 3.2)))
    bmesh.ops.create_icosphere(bm, subdivisions=1, radius=random.uniform(0.002, 0.006), matrix=mathutils.Matrix.Translation(p))
sm_ = bpy.data.meshes.new("sparks"); bm.to_mesh(sm_); bm.free()
sparks = bpy.data.objects.new("sparks", sm_); scene.collection.objects.link(sparks)
M_spark = mat("spark", (0, 0, 0), 1, emit=(0.4, 0.8, 1.0), strength=0.0); sm_.materials.append(M_spark)

# ================================================================ cameras
cam_room = camera("cam_room", 35, 2.8)
cam_macro = camera("cam_macro", 85, 2.8)
cam_ots = camera("cam_ots", 50, 2.0)
cam_phone = camera("cam_phone", 70, 2.2)
cam_wall = camera("cam_wall", 35, 4.0)
cam_portal = camera("cam_portal", 28, 4.0)

# ================================================================ timeline
SHOTS = [("room", 0, 144), ("macro", 144, 264), ("ots", 264, 408), ("phone", 408, 840), ("wall", 840, 1008), ("portal", 1008, 1152)]
TOTAL = 1152
LID_OPEN = -0.30
FEATURE_LEN = (840 - 408) / len(PH_SCREENS)

key_rng = random.Random(3)
press_times = {}
for f in range(150, 330, 3):
    k = keys[key_rng.randrange(len(keys))]
    press_times.setdefault(k.name, []).append(f + key_rng.randrange(0, 2))

def set_screen(m, a_img, b_img, fac, strength=None):
    nt = m.node_tree
    nt.nodes["A"].image = img(a_img)
    nt.nodes["B"].image = img(b_img)
    nt.nodes["MIX"].inputs["Factor"].default_value = fac
    if strength is not None:
        nt.nodes["EM"].inputs["Strength"].default_value = strength

def update(f):
    # ---- keys press (global, harmless when not seen)
    for k in keys:
        dz = 0.0
        for t in press_times.get(k.name, []):
            if t <= f < t + 4:
                dz = -0.0014 * (1 - abs((f - t) - 1.5) / 2.5)
        k.location.z = k["rest_z"] + dz
    dust.location = (math.sin(f * 0.01) * 0.05, f * 0.0004, math.sin(f * 0.013) * 0.03)
    dust.rotation_euler = (0, 0, f * 0.0004)

    shot = next(s for s in SHOTS if s[1] <= f < s[2])
    name, s0, s1 = shot
    t = (f - s0) / (s1 - s0)

    if name == "room":
        scene.camera = cam_room
        place_cam(cam_room, vlerp((-1.45, -2.45, 1.5), (-0.5, -0.95, 1.08), ease(t)), vlerp((0.1, 0.4, 1.0), (0.0, 0.2, 0.9), ease(t)),
                  focus=(0, 0.15, 0.88))
        cam_room.data.lens = lerp(32, 40, ease(t))
        open_t = ease((f - 18) / 70)
        hinge.rotation_euler.x = lerp(math.radians(90), LID_OPEN, open_t)
        on = ease((f - 70) / 30)
        set_screen(M_lapscreen, "lap_dash.png", "lap_dash.png", 0, 1.0 * on)
        screen_light.data.energy = 6 * on
        M_backlight.node_tree.nodes["Principled BSDF"].inputs["Emission Strength"].default_value = 1.2 * on
    elif name == "macro":
        scene.camera = cam_macro
        hinge.rotation_euler.x = LID_OPEN
        set_screen(M_lapscreen, "lap_chat1.png", "lap_chat1.png", 0, 1.0)
        screen_light.data.energy = 6
        M_backlight.node_tree.nodes["Principled BSDF"].inputs["Emission Strength"].default_value = 1.2
        x = lerp(0.135, 0.035, ease(t))
        place_cam(cam_macro, (LX + x, LY - 0.17, KEY_TOP + 0.08), (LX + x - 0.05, LY + 0.035, KEY_TOP), focus=(LX + x - 0.045, LY + 0.03, KEY_TOP))
    elif name == "ots":
        scene.camera = cam_ots
        hinge.rotation_euler.x = LID_OPEN
        fac = ease((f - 330) / 10)
        set_screen(M_lapscreen, "lap_chat1.png", "lap_chat2.png", fac, 1.0)
        screen_light.data.energy = 6
        scr_c = scr.matrix_world.translation
        place_cam(cam_ots, vlerp((-0.42, -0.62, 1.08), (-0.1, -0.3, 0.98), ease(t)), vlerp(scr_c + Vector((0.02, 0, 0)), scr_c + Vector((-0.05, 0, 0.01)), ease(t)), focus=scr_c)
        cam_ots.data.lens = lerp(45, 55, ease(t))
    elif name == "phone":
        scene.camera = cam_phone
        lf = f - s0
        i = int(lf // FEATURE_LEN)
        local = lf - i * FEATURE_LEN
        a = PH_SCREENS[max(0, i - 1)] if local < 8 else PH_SCREENS[i]
        b = PH_SCREENS[i]
        fac = ease(local / 8) if i > 0 else 1.0
        set_screen(M_phscreen, a, b, fac, 1.6)
        # phone motion: float + swing on each feature change
        swing = math.sin(i * 2.1) * 0.35
        prev = math.sin((i - 1) * 2.1) * 0.35 if i > 0 else swing
        yaw = lerp(prev, swing, ease_out(local / 18))
        phone_root.rotation_euler = (math.radians(4) + math.sin(f * 0.03) * 0.03, 0, yaw)
        phone_root.location = (PX, 0, 1.0 + math.sin(f * 0.05) * 0.008)
        ang = lerp(-0.55, 0.55, t)
        dist = 0.62 - 0.05 * math.sin(t * math.pi)
        pos = (PX + math.sin(ang) * dist, -math.cos(ang) * dist, 1.03 + 0.03 * math.sin(t * 3.0))
        side = Vector((-math.cos(ang), -math.sin(ang), 0)) * 0.055
        place_cam(cam_phone, pos, Vector((PX, 0, 1.0)) + side, focus=(PX, 0, 1.0))
        for c in cards:
            bx, by, bz = c["base"]
            c.location = (bx + math.sin(f * 0.01 + c["phase"]) * 0.05, by, bz + math.sin(f * 0.02 + c["phase"]) * 0.04)
    elif name == "wall":
        scene.camera = cam_wall
        center = Vector((WX, 0, 1.4))
        start = Vector((WX, -0.55, 1.4))
        end = Vector((WX + 0.9, R - 7.2, 2.1))
        p = vlerp(start, end, ease(t))
        place_cam(cam_wall, p, vlerp(center, Vector((WX, R, 1.3)), ease(t)), focus=vlerp(center, Vector((WX, R * 0.5, 1.4)), ease(t)))
        cam_wall.data.lens = lerp(40, 28, ease(t))
        cam_wall.data.dof.aperture_fstop = lerp(2.0, 6.0, ease(t))
    elif name == "portal":
        scene.camera = cam_portal
        lf = f - s0
        for i, sm in enumerate(seg_mats):
            on = ease((lf - 6 - i * 2.2) / 6)
            sm.node_tree.nodes["Principled BSDF"].inputs["Emission Strength"].default_value = 3.5 * on
        don = ease((lf - 34) / 26)
        disc_m.node_tree.nodes["EM"].inputs["Strength"].default_value = 0.75 * don
        disc_m.node_tree.nodes["MAP"].inputs["Rotation"].default_value = (0, 0, lf * 0.012)
        disc_m.node_tree.nodes["NOISE"].inputs["W"].default_value = lf * 0.012
        portal_light.data.energy = 120 * don
        M_spark.node_tree.nodes["Principled BSDF"].inputs["Emission Strength"].default_value = 3 * don
        sparks.location = (0, 0, lf * 0.002)
        place_cam(cam_portal, vlerp((QX, -8.2, 1.05), (QX, -6.1, 1.2), ease_out(t)), (QX, 0.1, 1.3), focus=(QX, 0.1, 1.7))

# ---------------------------------------------------------------- render settings
r = scene.render
r.engine = os.environ.get("ENGINE", "CYCLES")
if r.engine == "BLENDER_EEVEE":
    ee = scene.eevee
    ee.taa_render_samples = SAMPLES
    try:
        ee.use_raytracing = True; ee.ray_tracing_options.resolution_scale = "2"
    except Exception as ex: print("eevee rt", ex)
    try: ee.use_shadows = True
    except Exception: pass
r.resolution_x, r.resolution_y = 1920, 1080
r.resolution_percentage = RES
r.use_persistent_data = True
r.image_settings.file_format = "PNG"
r.image_settings.color_depth = "8"
cy = scene.cycles
cy.device = "CPU"
cy.samples = SAMPLES
cy.use_adaptive_sampling = True
cy.adaptive_threshold = 0.06
cy.use_denoising = True
cy.denoiser = "OPENIMAGEDENOISE"
cy.max_bounces = 3; cy.diffuse_bounces = int(os.environ.get('DIFF', '2')); cy.glossy_bounces = 2; cy.transmission_bounces = 2
cy.caustics_reflective = False; cy.caustics_refractive = False
cy.blur_glossy = 1.0
scene.view_settings.view_transform = "AgX"
try:
    scene.view_settings.look = "AgX - Medium High Contrast"
except Exception:
    pass

def frames(spec):
    out = []
    for part in spec.split(","):
        if "-" in part:
            a, b = part.split("-"); step = 1
            if ":" in b:
                b, step = b.split(":")
            out += list(range(int(a), int(b) + 1, int(step)))
        else:
            out.append(int(part))
    return out

if SPEC == "save":
    update(0)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, "portol_promo.blend"))
    sys.exit(0)

for f in frames(SPEC):
    path = os.path.join(OUT, f"f{f:04d}.png")
    if os.path.exists(path):
        continue
    scene.frame_set(f)
    update(f)
    r.filepath = path
    t0 = time.time()
    bpy.ops.render.render(write_still=True)
    print(f"FRAME {f} {time.time() - t0:.1f}s", flush=True)
