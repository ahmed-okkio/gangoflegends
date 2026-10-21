"""Model the champion props (Blitzcrank's gauntlets and chest core, Hecarim's head blade, tail and hooves, Vi's gauntlets
and hair, Sett's fists and fur-collared jacket, Alistar's horns, nose ring and shackles) from scratch in Gang Beasts costume style: chunky bevelled blocks, domes and tubes in a few
solid toy colours. The League models are reference only (tools/import_lol.py fetches them for side-by-side renders).

Run with Blender (headless): blender -b --python tools/model_props.py [-- --preview]
Writes assets/props/<champ>_<prop>.glb. Each prop is modelled in its beast part's own frame (beast.js), as the part
hangs at rest: x = the beast's left, y up, z forward, metres. Arms and legs point down their -y. So render.js just
parents the prop to the part with no offset. --preview also renders assets/props/preview_*.png: every prop on a grey
mannequin built from the beast's collision shapes.
"""
import bpy, bmesh, os, sys, math
from mathutils import Vector

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets", "props")
preview = "--preview" in sys.argv

B = lambda v: Vector((v[0], -v[2], v[1]))  # our space (y up, z forward) -> Blender (z up, -y forward)
mats = {}
def mat(name, rgb, rough=0.45, metal=0.0, glow=0.0):
    if name not in mats:
        m = bpy.data.materials.new(name); m.use_nodes = True
        p = m.node_tree.nodes["Principled BSDF"]
        p.inputs["Base Color"].default_value = (*rgb, 1); p.inputs["Roughness"].default_value = rough; p.inputs["Metallic"].default_value = metal
        if glow: p.inputs["Emission Color"].default_value = (*rgb, 1); p.inputs["Emission Strength"].default_value = glow
        m.diffuse_color = (*rgb, 1)
        mats[name] = m
    return mats[name]

parts = []
def done(ob, m):
    ob.data.materials.append(m); parts.append(ob); return ob
def aim(ob, d):  # point the primitive's own axis (Blender z) along d (our space)
    ob.rotation_mode = "QUATERNION"; ob.rotation_quaternion = B(d).to_track_quat("Z", "Y")
def bake(ob):
    with bpy.context.temp_override(selected_editable_objects=[ob], active_object=ob, object=ob):
        bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)

def box(m, size, at, bevel=0.03, tilt=None):
    bpy.ops.mesh.primitive_cube_add(size=1, location=B(at)); ob = bpy.context.object
    ob.scale = (size[0], size[2], size[1]); bake(ob)
    if tilt: ob.rotation_euler = (math.radians(tilt[0]), math.radians(tilt[2]), math.radians(tilt[1])); bake(ob)
    bv = ob.modifiers.new("bevel", "BEVEL"); bv.width = bevel; bv.segments = 4; bv.limit_method = "NONE"
    return done(ob, m)
def ball(m, r, at, squash=(1, 1, 1), seg=40):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=r, segments=seg, ring_count=seg * 3 // 5, location=B(at)); ob = bpy.context.object
    ob.scale = (squash[0], squash[2], squash[1]); bake(ob)
    return done(ob, m)
def cyl(m, r, length, at, axis=(0, 1, 0), r2=None):
    bpy.ops.mesh.primitive_cone_add(vertices=32, radius1=r, radius2=r if r2 is None else r2, depth=length, location=B(at)); ob = bpy.context.object
    aim(ob, axis); bake(ob)
    bv = ob.modifiers.new("bevel", "BEVEL"); bv.width = min(r, length) * 0.15; bv.segments = 3; bv.limit_method = "ANGLE"
    return done(ob, m)
def ring(m, R, r, at, axis=(0, 1, 0)):
    bpy.ops.mesh.primitive_torus_add(major_radius=R, minor_radius=r, major_segments=40, minor_segments=12, location=B(at)); ob = bpy.context.object
    aim(ob, axis); bake(ob)
    return done(ob, m)
def tube(m, pts, radii, flat=1):  # a tapered tube through points: handles, horns, flames; flat < 1 squashes it across x into a blade
    cu = bpy.data.curves.new("tube", "CURVE"); cu.dimensions = "3D"; cu.bevel_depth = 1; cu.bevel_resolution = 6; cu.use_fill_caps = True
    sp = cu.splines.new("NURBS"); sp.points.add(len(pts) - 1); sp.use_endpoint_u = True; sp.order_u = min(4, len(pts))
    for p, v, rr in zip(sp.points, pts, radii): p.co = (*B(v), 1); p.radius = rr
    ob = bpy.data.objects.new("tube", cu); bpy.context.scene.collection.objects.link(ob)
    with bpy.context.temp_override(selected_editable_objects=[ob], active_object=ob, object=ob, selected_objects=[ob]):
        bpy.ops.object.convert(target="MESH")
    ob.scale.x = flat; bake(ob)
    return done(ob, m)

def shell(m, radii, at, cut, seg=40):  # an ellipsoid with the faces where cut(x, y, z) (our space) removed: open jackets, hoods
    ob = ball(m, 1, at, radii, seg=seg)
    bm = bmesh.new(); bm.from_mesh(ob.data)
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if cut(f.calc_center_median().x, f.calc_center_median().z, -f.calc_center_median().y)], context="FACES")
    bm.to_mesh(ob.data); bm.free()
    sol = ob.modifiers.new("thick", "SOLIDIFY"); sol.thickness = 0.02; sol.offset = 1
    return ob

def finish(name):
    """Join what's been built into one prop and export it."""
    global parts
    for o in bpy.context.scene.objects: o.select_set(o in parts)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join(); ob = bpy.context.object; ob.name = name
    bpy.context.scene.cursor.location = (0, 0, 0); bpy.ops.object.origin_set(type="ORIGIN_CURSOR")  # origin = the part's pivot
    bpy.ops.object.shade_auto_smooth(angle=math.radians(50))
    for md in list(ob.modifiers):
        if md.type != "NODES":
            with bpy.context.temp_override(object=ob, active_object=ob): bpy.ops.object.modifier_apply(modifier=md.name)
    bm = bmesh.new(); bm.from_mesh(ob.data); bmesh.ops.recalc_face_normals(bm, faces=bm.faces); bm.to_mesh(ob.data); bm.free()
    bpy.ops.object.select_all(action="DESELECT"); ob.select_set(True)
    bpy.ops.export_scene.gltf(filepath=os.path.join(out, name + ".glb"), use_selection=True, export_format="GLB", export_apply=True)
    parts = []
    return ob

# ---------------- Blitzcrank: gold steam golem ----------------
GOLD = lambda: mat("gold", (0.86, 0.58, 0.12), 0.35, 0.25)
GOLD2 = lambda: mat("gold_dark", (0.62, 0.38, 0.08), 0.4, 0.2)
IRON = lambda: mat("iron", (0.14, 0.15, 0.18), 0.5, 0.3)
STEEL = lambda: mat("steel", (0.58, 0.6, 0.64), 0.3, 0.6)

def blitz_core():  # chest frame: the porthole on Blitz's belly, sat on the beast's chest (front surface ~z .19 at y .25)
    cyl(GOLD2(), 0.13, 0.05, (0, 0.25, 0.185), (0, 0, 1))
    ring(IRON(), 0.13, 0.032, (0, 0.25, 0.21), (0, 0, 1))
    cyl(GOLD(), 0.1, 0.03, (0, 0.25, 0.215), (0, 0, 1))
    for (x0, y0), (x1, y1) in (((-0.05, 0.32), (0.04, 0.28)), ((0.04, 0.28), (-0.04, 0.22)), ((-0.04, 0.22), (0.05, 0.18))):  # lightning bolt
        c = ((x0 + x1) / 2, (y0 + y1) / 2); ang = math.degrees(math.atan2(y1 - y0, x1 - x0))
        box(IRON(), (math.hypot(x1 - x0, y1 - y0) + 0.025, 0.026, 0.03), (c[0], c[1], 0.235), 0.008, (0, 0, ang))
    for k in range(8):  # rivets round the rim
        a = k * math.pi / 4; ball(STEEL(), 0.016, (math.cos(a) * 0.13, 0.25 + math.sin(a) * 0.13, 0.245))

def blitz_gauntlet(s):  # forearm frame: forearm runs down -y, hand at y -.337
    cyl(GOLD(), 0.075, 0.08, (0, -0.09, 0)); cyl(IRON(), 0.07, 0.03, (0, -0.145, 0)); cyl(GOLD(), 0.088, 0.09, (0, -0.2, 0))
    box(GOLD(), (0.26, 0.2, 0.25), (0, -0.35, 0.01), 0.05)  # fist
    for k in range(4):  # finger blocks across the knuckle end
        box(GOLD2(), (0.058, 0.07, 0.22), (-0.093 + k * 0.062, -0.47, 0.01), 0.02)
    box(GOLD2(), (0.06, 0.12, 0.07), (-s * 0.0, -0.36, 0.15), 0.025)  # thumb
    for y in (-0.3, -0.36, -0.42):  # bolts both sides
        for x in (0.135, -0.135): cyl(STEEL(), 0.022, 0.03, (x, y, 0.01), (1, 0, 0))

# ---------------- Hecarim: spectral armoured centaur ----------------
ARMOR = lambda: mat("armor", (0.12, 0.14, 0.17), 0.4, 0.4)
ARMOR2 = lambda: mat("armor_light", (0.26, 0.3, 0.34), 0.35, 0.5)
SPIRIT = lambda: mat("spirit", (0.33, 1.0, 0.82), 0.3, 0, glow=2.5)

def hec_blade():  # head frame: the great curved blade rising off his helm (skull top ~y .38)
    cyl(ARMOR(), 0.1, 0.08, (0, 0.35, 0.1), (0, 1, 0.5), r2=0.075)  # socket on the brow
    tube(ARMOR2(), [(0, 0.36, 0.16), (0, 0.56, 0.17), (0, 0.74, 0.06), (0, 0.82, -0.14), (0, 0.78, -0.36), (0, 0.66, -0.5)], [0.09, 0.08, 0.062, 0.045, 0.024, 0.003], flat=0.35)
    tube(SPIRIT(), [(0, 0.42, 0.24), (0, 0.6, 0.235), (0, 0.78, 0.12), (0, 0.88, -0.08)], [0.022, 0.02, 0.016, 0.003], flat=0.6)  # glowing edge

def hec_tail():  # hips frame: a spectral flame streaming back
    tube(SPIRIT(), [(0, 0.05, -0.17), (0, 0.06, -0.34), (0, -0.04, -0.52), (0, -0.16, -0.68), (0, -0.22, -0.85)], [0.07, 0.1, 0.085, 0.05, 0.003])
    for s in (1, -1): tube(SPIRIT(), [(s * 0.03, 0.06, -0.3), (s * 0.1, 0.08, -0.46), (s * 0.15, 0.02, -0.6)], [0.045, 0.03, 0.002])  # wisps

def hec_hoof(top, bottom, r):  # a chunky plated horse hoof down the part's -y, flaring to a flat sole; spirit glow round the cuff
    h = top - bottom
    cyl(ARMOR(), r * 0.85, h * 0.22, (0, top - h * 0.11, 0.01))  # cuff
    ring(SPIRIT(), r * 0.88, r * 0.15, (0, top - h * 0.22, 0.01))
    cyl(ARMOR2(), r, h * 0.62, (0, bottom + h * 0.41, 0.02), r2=r * 0.86)  # hoof wall, wide end down
    cyl(ARMOR(), r * 1.08, h * 0.14, (0, bottom + h * 0.07, 0.025))  # sole
    box(ARMOR(), (r * 0.4, h * 0.6, r * 0.4), (0, bottom + h * 0.42, 0.02 + r * 0.9), r * 0.15)  # front ridge

# ---------------- Vi: Piltover enforcer, giant Hextech gauntlets ----------------
VI_PINK = lambda: mat("vi_pink", (0.86, 0.3, 0.52), 0.35, 0.35)
VI_HAIR = lambda: mat("vi_hair", (0.95, 0.38, 0.62), 0.55)
HEX = lambda: mat("hextech", (0.3, 0.75, 1.0), 0.2, 0, glow=3)

def vi_gauntlet(s):  # forearm frame, hand at y -.337; s = 1 left, -1 right (the Hextech core sits on the outside)
    cyl(VI_PINK(), 0.085, 0.16, (0, -0.13, 0)); ring(GOLD(), 0.088, 0.018, (0, -0.06, 0)); ring(GOLD(), 0.092, 0.018, (0, -0.21, 0))
    box(VI_PINK(), (0.32, 0.28, 0.3), (0, -0.37, 0.01), 0.06)  # the huge fist
    for k in range(4):  # steel knuckle plates on the punching end
        box(STEEL(), (0.07, 0.06, 0.25), (-0.11 + k * 0.073, -0.53, 0.01), 0.02)
    box(IRON(), (0.08, 0.14, 0.09), (0, -0.37, 0.19), 0.03)  # thumb guard
    cyl(GOLD(), 0.075, 0.04, (s * 0.165, -0.36, 0.01), (1, 0, 0)); cyl(HEX(), 0.05, 0.05, (s * 0.175, -0.36, 0.01), (1, 0, 0))  # Hextech core
    for y in (-0.28, -0.44): box(HEX(), (0.02, 0.02, 0.18), (-s * 0.16, y, 0.01), 0.008)  # glowing vents on the inside
    cyl(IRON(), 0.03, 0.18, (0, -0.2, -0.11))  # piston along the back

def vi_hair():  # head frame (skull centre y .165, z .057, r .21): pink cap with a big side-swept fringe and a spiky crown
    ball(VI_HAIR(), 0.235, (0, 0.27, 0.02), (1.0, 0.62, 1.0))
    tube(VI_HAIR(), [(0.04, 0.4, 0.1), (-0.06, 0.38, 0.22), (-0.17, 0.3, 0.23), (-0.24, 0.19, 0.15)], [0.08, 0.07, 0.05, 0.015])
    for x, z, lean in ((0.06, -0.08, -0.4), (-0.06, -0.1, -0.5), (0.0, -0.02, -0.25), (0.12, 0.0, -0.3)):
        cyl(VI_HAIR(), 0.055, 0.14, (x, 0.43, z), (x, 1, lean), r2=0.004)

# ---------------- Sett: the Boss, wrapped brass-knuckle fists and a fur-collared jacket ----------------
WRAP = lambda: mat("wraps", (0.9, 0.84, 0.7), 0.7)
BRASS = lambda: mat("brass", (0.85, 0.62, 0.22), 0.3, 0.6)
COAT = lambda: mat("coat", (0.17, 0.04, 0.08), 0.6)
FUR = lambda: mat("fur", (0.95, 0.92, 0.85), 0.9)
GOLD = lambda: mat("gold", (0.95, 0.7, 0.25), 0.3, 0.7)

def sett_fist():  # forearm frame: bandaged wrist and hand, brass knuckles across the punching end
    for k, y in enumerate((-0.17, -0.21, -0.25, -0.29)): ring(WRAP(), 0.055, 0.022, (0, y, 0), (0, 1, 0.15 * (-1) ** k))
    ball(WRAP(), 0.085, (0, -0.35, 0.02), (1.05, 1.1, 0.95))
    box(BRASS(), (0.2, 0.05, 0.12), (0, -0.425, 0.02), 0.02)
    for k in range(4): ring(BRASS(), 0.028, 0.012, (-0.072 + k * 0.048, -0.44, 0.02), (0, 0, 1))

JC, JR = (0, 0.255, -0.013), (0.3, 0.235, 0.218)  # vest ellipsoid around the chest capsule
def on_vest(x, y, out=1.0):  # the point on the vest's front at (x, y), pushed out by `out`
    k = max(0.0, 1 - (x / JR[0]) ** 2 - ((y - JC[1]) / JR[1]) ** 2)
    return (x * out, JC[1] + (y - JC[1]) * out, JC[2] + JR[2] * math.sqrt(k) * out)
OPEN = lambda y: 0.035 + (y - 0.08) * 0.28  # half-width of the open front at height y: a deep V, chest on show

def sett_jacket():  # chest frame (capsule along x: r .193, half length .082, centre y .254 z -.013): open sleeveless vest, fur collar
    shell(COAT(), JR, JC, lambda x, y, z: (z + JC[2] > 0 and abs(x) < OPEN(y + JC[1])) or y + JC[1] < 0.08, seg=72)  # cut() gets shell-centred coords
    for sx in (1, -1):  # gold piping down both edges of the opening
        ys = [0.09 + k * 0.05 for k in range(7)]
        tube(GOLD(), [on_vest(sx * (OPEN(y) + 0.008), y, 1.06) for y in ys], [0.016] * len(ys))
        box(GOLD(), (0.035, 0.035, 0.02), on_vest(sx * (OPEN(0.2) + 0.03), 0.2, 1.08), 0.01)  # a button
    # fur collar: one fat roll from lapel to lapel round the back of the neck
    pts = [on_vest(-0.15, 0.3, 1.1), on_vest(-0.16, 0.4, 1.12)] +           [(math.sin(a) * 0.17, 0.46, -math.cos(a) * 0.1) for a in (-1.1, -0.5, 0, 0.5, 1.1)] + [on_vest(0.16, 0.4, 1.12), on_vest(0.15, 0.3, 1.1)]
    tube(FUR(), pts, [0.035, 0.06, 0.07, 0.075, 0.075, 0.075, 0.07, 0.06, 0.035])

# ---------------- Alistar: the Minotaur, great horns, a gold nose ring and broken shackles ----------------
IVORY = lambda: mat("ivory", (0.93, 0.88, 0.74), 0.5)
BRONZE = lambda: mat("bronze", (0.72, 0.45, 0.18), 0.35, 0.6)

def ali_horns():  # head frame (skull centre y .165, z .057, r .21): two big horns sweeping out, then up and forward; nose ring
    for s in (1, -1):
        ring(BRONZE(), 0.06, 0.022, (s * 0.2, 0.28, 0.06), (1, 0.4 * s, 0))  # band where each horn leaves the skull
        tube(IVORY(), [(s * 0.15, 0.27, 0.06), (s * 0.3, 0.3, 0.07), (s * 0.42, 0.38, 0.12), (s * 0.47, 0.5, 0.2), (s * 0.45, 0.6, 0.26)], [0.075, 0.068, 0.05, 0.03, 0.004])
    ring(BRONZE(), 0.055, 0.014, (0, 0.04, 0.275), (1, 0, 0))  # nose ring through the snout

def ali_cuff():  # forearm frame (hand at y -.337): a heavy bronze shackle on the wrist with a broken chain swinging off it
    cyl(BRONZE(), 0.075, 0.1, (0, -0.22, 0)); ring(IRON(), 0.078, 0.014, (0, -0.17, 0)); ring(IRON(), 0.078, 0.014, (0, -0.27, 0))
    for k, (y, z) in enumerate(((-0.28, -0.09), (-0.33, -0.12), (-0.38, -0.12))): ring(IRON(), 0.03, 0.01, (0, y, z), (k % 2, 0, (k + 1) % 2))

PROPS = {
    "alistar_horns": ali_horns, "alistar_cuff": ali_cuff,
    "blitzcrank_core": blitz_core, "blitzcrank_gauntletL": lambda: blitz_gauntlet(1), "blitzcrank_gauntletR": lambda: blitz_gauntlet(-1),
    "hecarim_blade": hec_blade, "hecarim_tail": hec_tail,
    "hecarim_hoofHand": lambda: hec_hoof(-0.24, -0.44, 0.1),  # forearm frame: hand at y -.337
    "hecarim_hoofFoot": lambda: hec_hoof(0.03, -0.15, 0.115),  # leg frame: foot bottom at y ~-.136
    "vi_gauntletL": lambda: vi_gauntlet(1), "vi_gauntletR": lambda: vi_gauntlet(-1), "vi_hair": vi_hair,
    "sett_fist": sett_fist, "sett_jacket": sett_jacket,
}
# where each prop sits on the preview mannequin: part pivot in the beast's rest pose with arms hanging (beast.js)
PIVOT = {"core": (0, 0.6347, -0.0101), "blade": (0, 1.0693, 0.0247), "tail": (0, 0.4223, 0.0002),
         "gauntletL": (0.2015, 0.6711, -0.0433), "gauntletR": (-0.2015, 0.6711, -0.0433),
         "hoofHand": (0.2015, 0.6711, -0.0433), "hoofFoot": (0.239, 0.1201, 0.0057),
         "hair": (0, 1.0693, 0.0247), "jacket": (0, 0.6347, -0.0101), "sleeve": (0.2015, 0.9447, -0.0425), "fist": (0.2015, 0.6711, -0.0433),
         "horns": (0, 1.0693, 0.0247), "cuff": (0.2015, 0.6711, -0.0433)}

def mannequin(dx):
    grey = mat("beast", (0.62, 0.6, 0.58), 0.6)
    for at, r, sq in (((0, 0.889, -0.024), 0.24, (1.15, 1, 0.85)), ((0, 1.235, 0.082), 0.212, (1, 1, 1)), ((0, 0.52, 0), 0.2, (1.1, 1, 0.9)),
                      ((0.2015, 0.81, -0.043), 0.066, (1, 2.6, 1)), ((-0.2015, 0.81, -0.043), 0.066, (1, 2.6, 1)),
                      ((0.2015, 0.52, -0.043), 0.05, (1, 3.5, 1)), ((-0.2015, 0.52, -0.043), 0.05, (1, 3.5, 1)),
                      ((0.22, 0.22, -0.01), 0.06, (1, 2.4, 1)), ((-0.22, 0.22, -0.01), 0.06, (1, 2.4, 1)),
                      ((0.239, 0.07, 0.0), 0.05, (1, 1.6, 1)), ((-0.239, 0.07, 0.0), 0.05, (1, 1.6, 1))):
        ob = ball(grey, r, (at[0] + dx, at[1], at[2]), sq)
    for o in parts: o.name = "mannequin"
    parts.clear()

os.makedirs(out, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
built = {}
for name, fn in PROPS.items():
    fn(); built[name] = finish(name)
    print(name, len(built[name].data.polygons), "faces")

if preview:
    sc = bpy.context.scene
    sc.world = bpy.data.worlds.new("w"); sc.world.color = (0.32, 0.34, 0.38)
    sc.render.engine = "BLENDER_WORKBENCH"; sc.display.shading.light = "STUDIO"; sc.display.shading.color_type = "MATERIAL"
    sc.display.shading.show_cavity = True; sc.display.shading.show_shadows = True
    sc.render.resolution_x, sc.render.resolution_y = 1800, 900
    for champ, dx in (("blitzcrank", -2.2), ("hecarim", -1.1), ("vi", 0), ("sett", 1.1), ("alistar", 2.2)):
        mannequin(dx)
        for name, ob in built.items():
            if name.startswith(champ): ob.location = B(Vector(PIVOT[name.split("_")[1]]) + Vector((dx, 0, 0)))
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam")); sc.collection.objects.link(cam); sc.camera = cam
    cam.data.type = "ORTHO"; cam.data.ortho_scale = 5.8
    for view, d in (("front", (0.0, 0.25, 1)), ("three_quarter", (0.8, 0.35, 0.9)), ("back", (-0.5, 0.3, -1))):
        target = B((0, 0.75, 0)); cam.location = target + B(Vector(d).normalized() * 6)
        cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()
        sc.render.filepath = os.path.join(out, f"preview_{view}.png"); bpy.ops.render.render(write_still=True)
