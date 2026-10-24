"""Import a Gang Beasts stage from the player's own install into gbcache/<stage>/ (git-ignored, never shipped).

Writes scene.json (renderers, materials, box colliders, spawns, kill boxes), one .bin per mesh and PNG textures.
Coordinates are converted from Unity (left-handed) to three.js/Rapier (right-handed) by flipping z.

Usage: python tools/import_gb.py <stage> [gang beasts install dir]
Needs: pip install UnityPy
"""
import sys, os, json, glob, math, struct
from array import array
import UnityPy
from UnityPy.helpers.MeshHelper import MeshHandler

UnityPy.config.FALLBACK_UNITY_VERSION = "2021.3.33f1"  # bundles have their version stripped
stage = sys.argv[1]
install = sys.argv[2] if len(sys.argv) > 2 else r"S:\SteamLibrary\steamapps\common\Gang Beasts"
bundles = os.path.join(install, r"Gang Beasts_Data\StreamingAssets\aa\StandaloneWindows64-LocalBundles")
out = os.path.join(os.path.dirname(__file__), "..", "gbcache", stage)
os.makedirs(out, exist_ok=True)
# the stage's bundles plus every bundle they reference (shared props live in other stages' and core bundles)
cab_bundle = {}
for f in glob.glob(os.path.join(bundles, "*.bundle")):
    for bf in UnityPy.load(f).files.values():
        for cab in getattr(bf, "files", None) or {}: cab_bundle[cab.lower()] = f
need, todo = set(), glob.glob(os.path.join(bundles, f"stages-{stage}_*.bundle")) + glob.glob(os.path.join(bundles, "core-stages*.bundle"))
while todo:
    f = todo.pop()
    if f in need: continue
    need.add(f)
    for sf in UnityPy.load(f).assets:
        todo += [cab_bundle[c] for c in (e.path.split("/")[-1].lower() for e in sf.externals) if c in cab_bundle]
env = UnityPy.load(*need)

# ---------- 4x4 matrix helpers (row-major, column vectors) ----------
def trs(p, q, s):
    x, y, z, w = q
    r = [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
         [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
         [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]]
    return [[r[i][0] * s[0], r[i][1] * s[1], r[i][2] * s[2], p[i]] for i in range(3)] + [[0, 0, 0, 1]]
def mmul(a, b):
    return [[sum(a[i][k] * b[k][j] for k in range(4)) for j in range(4)] for i in range(4)]
def xform(m, v):
    return [m[i][0] * v[0] + m[i][1] * v[1] + m[i][2] * v[2] + m[i][3] for i in range(3)]
def flipz(m):  # S M S with S = diag(1,1,-1,1)
    f = [1, 1, -1, 1]
    return [[m[i][j] * f[i] * f[j] for j in range(4)] for i in range(4)]
def decompose(m):
    sx, sy, sz = (math.sqrt(sum(m[r][c] ** 2 for r in range(3))) for c in range(3))
    r = [[m[i][0] / sx, m[i][1] / sy, m[i][2] / sz] for i in range(3)]
    tr = r[0][0] + r[1][1] + r[2][2]
    if tr > 0:
        k = math.sqrt(tr + 1) * 2; q = [(r[2][1] - r[1][2]) / k, (r[0][2] - r[2][0]) / k, (r[1][0] - r[0][1]) / k, k / 4]
    elif r[0][0] > r[1][1] and r[0][0] > r[2][2]:
        k = math.sqrt(1 + r[0][0] - r[1][1] - r[2][2]) * 2; q = [k / 4, (r[0][1] + r[1][0]) / k, (r[0][2] + r[2][0]) / k, (r[2][1] - r[1][2]) / k]
    elif r[1][1] > r[2][2]:
        k = math.sqrt(1 + r[1][1] - r[0][0] - r[2][2]) * 2; q = [(r[0][1] + r[1][0]) / k, k / 4, (r[1][2] + r[2][1]) / k, (r[0][2] - r[2][0]) / k]
    else:
        k = math.sqrt(1 + r[2][2] - r[0][0] - r[1][1]) * 2; q = [(r[0][2] + r[2][0]) / k, (r[1][2] + r[2][1]) / k, k / 4, (r[1][0] - r[0][1]) / k]
    return [m[0][3], m[1][3], m[2][3]], q, [sx, sy, sz]
rnd = lambda v, n=4: [round(x, n) for x in v]

# ---------- scene graph ----------
transforms, gos = {}, {}
for o in env.objects:
    if o.type.name in ("Transform", "RectTransform"): transforms[o.path_id] = o.read()
    elif o.type.name == "GameObject": gos[o.path_id] = o.read()
parent_of = {pid: t.m_Father.path_id for pid, t in transforms.items()}
go_of = {pid: t.m_GameObject.path_id for pid, t in transforms.items()}
tf_of_go = {g: pid for pid, g in go_of.items()}
world, active = {}, {}
def wm(pid):
    if pid not in world:
        t = transforms[pid]
        local = trs([t.m_LocalPosition.x, t.m_LocalPosition.y, t.m_LocalPosition.z],
                    [t.m_LocalRotation.x, t.m_LocalRotation.y, t.m_LocalRotation.z, t.m_LocalRotation.w],
                    [t.m_LocalScale.x, t.m_LocalScale.y, t.m_LocalScale.z])
        par = parent_of[pid]
        world[pid] = mmul(wm(par), local) if par in transforms else local
    return world[pid]
# networked roots the game switches on at runtime (Trawler's boat is saved inactive, waiting for the server to spawn it)
WAKE = {"trawler": {"Trawler"}}
def is_active(pid):
    if pid not in active:
        go = gos.get(go_of[pid])
        par = parent_of[pid]
        on = bool(go and (go.m_IsActive or par not in transforms and go.m_Name in WAKE.get(stage, ())))
        active[pid] = on and (is_active(par) if par in transforms else True)
    return active[pid]
def path(pid):
    names = []
    while pid in transforms:
        names.append(gos[go_of[pid]].m_Name); pid = parent_of[pid]
    return "/".join(reversed(names))

def in_scene(o):
    return "_scenes_" in str(getattr(o.assets_file.parent, "name", ""))

# ---------- export ----------
meshes, materials, textures, renderers, colliders, capsules, trimeshes, spawns, kills = {}, {}, {}, [], [], [], [], [], []

def export_texture(ptr):
    if not ptr.path_id: return None
    tex = ptr.read()
    name = f"{tex.m_Name}_{ptr.path_id & 0xffffffff:x}.png".replace(" ", "_").replace("#", "")
    if name not in textures:
        try:
            tex.image.save(os.path.join(out, name)); textures[name] = True
        except Exception as e:
            print("  texture failed", tex.m_Name, e); textures[name] = False
    return name if textures[name] else None

def export_material(ptr):
    m = ptr.read()
    key = f"{m.m_Name}_{ptr.path_id & 0xffffffff:x}"
    if key not in materials:
        props = m.m_SavedProperties
        tex = {k: v.m_Texture for k, v in props.m_TexEnvs}
        cols = {k: c for k, c in props.m_Colors}
        floats = {k: f for k, f in props.m_Floats}
        base = tex.get("_BaseMap") or tex.get("_MainTex")
        col = cols.get("_BaseColor") or cols.get("_Color")
        materials[key] = {
            "name": m.m_Name,
            "color": rnd([col.r, col.g, col.b, col.a]) if col else [1, 1, 1, 1],
            "map": export_texture(base) if base else None,
            "smoothness": round(floats.get("_Smoothness", floats.get("_Glossiness", 0.3)), 3),
            "metallic": round(floats.get("_Metallic", 0), 3),
            "emission": rnd([cols["_EmissionColor"].r, cols["_EmissionColor"].g, cols["_EmissionColor"].b]) if "_EmissionColor" in cols else None,
        }
    return key

def export_mesh(ptr):
    key = f"m{ptr.path_id & 0xffffffffffff:x}"
    if key in meshes: return key
    mesh = ptr.read()
    h = MeshHandler(mesh); h.process()
    n = h.m_VertexCount
    pos = array("f"); nrm = array("f"); uv0 = array("f"); uv1 = array("f")
    for v in h.m_Vertices: pos.extend((v[0], v[1], -v[2]))
    for v in (h.m_Normals or []): nrm.extend((v[0], v[1], -v[2]))
    for v in (h.m_UV0 or []): uv0.extend((v[0], v[1]))
    for v in (h.m_UV1 or []): uv1.extend((v[0], v[1]))
    subs = []
    idx = array("I")
    for sm, tris in zip(mesh.m_SubMeshes, h.get_triangles()):
        start = len(idx)
        for t in tris: idx.extend((t[0] + sm.baseVertex, t[2] + sm.baseVertex, t[1] + sm.baseVertex))  # z flip reverses winding
        subs.append([start, len(idx) - start])
    blob = b"".join(a.tobytes() for a in (pos, nrm, uv0, uv1, idx))
    with open(os.path.join(out, key + ".bin"), "wb") as f: f.write(blob)
    meshes[key] = {"name": mesh.m_Name, "verts": n, "normals": len(nrm) > 0, "uv0": len(uv0) > 0, "uv1": len(uv1) > 0, "indices": len(idx), "subs": subs}
    return key

for o in env.objects:
    if o.type.name not in ("MeshRenderer", "BoxCollider", "CapsuleCollider", "SphereCollider", "MeshCollider"): continue
    if not in_scene(o): continue  # shared bundles also hold prefabs that aren't placed in this stage
    try: c = o.read()
    except Exception: continue
    pid = tf_of_go.get(c.m_GameObject.path_id)
    # breakable floor slabs sit inactive in the scene (the game switches them on); we keep them as solid floor
    if pid is None or not (is_active(pid) or "_breakable" in path(pid)) or not getattr(c, "m_Enabled", True): continue
    p = path(pid)
    m = wm(pid)
    # beasts (layer Actor) pass through Ball Only (11), Glass Only (14) and Ignore All (19): Trawler's stage-wide Bubble Collider, rope boxes
    if o.type.name != "MeshRenderer" and not c.m_IsTrigger and gos[go_of[pid]].m_Layer in (11, 14, 19): continue
    if o.type.name == "MeshRenderer":
        go = gos[go_of[pid]]
        mf = next((comp for comp in (x.component.read() if hasattr(x, "component") else x.read() for x in go.m_Component) if comp.object_reader.type.name == "MeshFilter"), None)
        if not mf or not mf.m_Mesh.path_id: continue
        try: mkey = export_mesh(mf.m_Mesh)
        except Exception as e: print("  mesh failed", p, e); continue
        sbi = c.m_StaticBatchInfo
        mats = [export_material(x) for x in c.m_Materials if x.path_id]
        # unbatched, Unity draws submesh i with material i, no more: Subway's track pieces point at the stage's whole static-batch
        # mesh with one material, and drawing all of it put a stray copy of the station over the track
        if not (sbi and sbi.subMeshCount) and meshes[mkey]["name"].startswith("Combined Mesh"): continue  # a batch mesh without its batch: nothing of its own
        first, count = (sbi.firstSubMesh, sbi.subMeshCount) if sbi and sbi.subMeshCount else (0, min(len(mats), len(meshes[mkey]["subs"])))
        renderers.append({
            "path": p, "mesh": mkey, "subs": list(range(first, first + count)), "mats": mats,
            # static-batched vertices are already in world space
            "matrix": None if (sbi and sbi.subMeshCount) else [rnd(r, 5) for r in flipz(m)],
            "lightmap": c.m_LightmapIndex if c.m_LightmapIndex < 65534 else -1,
            "lmso": rnd([c.m_LightmapTilingOffset.x, c.m_LightmapTilingOffset.y, c.m_LightmapTilingOffset.z, c.m_LightmapTilingOffset.w], 6),
            # 0 no shadows, 1 on, 2 two-sided, 3 shadows only (invisible); Incinerator's fire light shines through walls that don't cast
            "cast": int(c.m_CastShadows), "recv": bool(c.m_ReceiveShadows), "layer": go.m_Layer,
        })
    elif o.type.name == "BoxCollider":
        cm = mmul(m, trs([c.m_Center.x, c.m_Center.y, c.m_Center.z], [0, 0, 0, 1], [c.m_Size.x, c.m_Size.y, c.m_Size.z]))
        pos, q, size = decompose(flipz(cm))
        box = {"path": p, "p": rnd(pos), "q": rnd(q, 5), "h": rnd([s / 2 for s in size])}
        if c.m_IsTrigger:
            if "kill" in p.lower(): kills.append(box)
        elif "/City" not in p and "/Camera" not in p and "AI_Helpers" not in p:  # Camera Blocker only stops the camera; beasts fall through it. AI_Helpers: bot hints (Subway's sits over a track)
            colliders.append(box)
    elif c.m_IsTrigger or "/City" in p or "/Camera" in p or "AI_Helpers" in p: continue
    # everything else is frozen where it sits in the scene (ropes, props): physics props would need syncing over the network
    elif o.type.name in ("CapsuleCollider", "SphereCollider"):
        # Rapier capsules run along local y: turn Unity's x / z direction onto it
        axis = getattr(c, "m_Direction", 1)
        cm = mmul(m, trs([c.m_Center.x, c.m_Center.y, c.m_Center.z], [[0, 0, -0.70711, 0.70711], [0, 0, 0, 1], [0.70711, 0, 0, 0.70711]][axis], [1, 1, 1]))
        pos, q, s = decompose(flipz(cm))
        r = c.m_Radius * max(s[0], s[2])
        half = max(0, getattr(c, "m_Height", 0) / 2 * s[1] - r)
        capsules.append({"path": p, "p": rnd(pos), "q": rnd(q, 5), "r": round(r, 4), "hh": round(half, 4)})
    elif c.m_Mesh.path_id:  # MeshCollider: the mesh's triangles, placed by `matrix`
        try: trimeshes.append({"path": p, "mesh": export_mesh(c.m_Mesh), "matrix": [rnd(r, 5) for r in flipz(m)]})
        except Exception as e: print("  collider mesh failed", p, e)

# Subway's train: one car, saved inactive in the scene (the game pools and spawns it). Its renderers go in "train", placed
# relative to the car's root, and its solid box; maps.js runs it along the tracks
MOVER = {"subway": "Train A(Clone)"}
train = None
if stage in MOVER:
    root = next(pid for pid in transforms if gos[go_of[pid]].m_Name == MOVER[stage] and in_scene(transforms[pid]))
    rt = wm(root)  # rigid: its inverse is the transposed rotation and the translation turned back
    inv = [[rt[j][i] for j in range(3)] + [-sum(rt[j][i] * rt[j][3] for j in range(3))] for i in range(3)] + [[0, 0, 0, 1]]
    under = lambda pid: pid == root or (parent_of[pid] in transforms and under(parent_of[pid]))
    train = {"renderers": [], "box": None}
    for o in env.objects:
        if o.type.name not in ("MeshRenderer", "BoxCollider") or not in_scene(o): continue
        c = o.read(); pid = tf_of_go.get(c.m_GameObject.path_id)
        if pid is None or not under(pid) or not (gos[go_of[pid]].m_IsActive or pid == root): continue
        m = mmul(inv, wm(pid))
        if o.type.name == "BoxCollider":
            if not c.m_IsTrigger and pid == root: train["box"] = {"c": rnd([c.m_Center.x, c.m_Center.y, -c.m_Center.z]), "h": rnd([c.m_Size.x / 2, c.m_Size.y / 2, c.m_Size.z / 2])}
            continue
        go = gos[go_of[pid]]
        mf = next((comp for comp in (x.component.read() if hasattr(x, "component") else x.read() for x in go.m_Component) if comp.object_reader.type.name == "MeshFilter"), None)
        if not mf or not mf.m_Mesh.path_id or not c.m_Enabled: continue
        mkey = export_mesh(mf.m_Mesh); mats = [export_material(x) for x in c.m_Materials if x.path_id]
        train["renderers"].append({"path": path(pid), "mesh": mkey, "subs": list(range(min(len(mats), len(meshes[mkey]["subs"])))), "mats": mats,
                                   "matrix": [rnd(r, 5) for r in flipz(m)], "lightmap": -1, "lmso": [1, 1, 0, 0], "cast": 1, "recv": True, "layer": go.m_Layer})

# free-for-all spawn points: named "Player Spawnpoint" (Girders), or the children of the single-player group
# ("SingleSpawns", "1-8", "StartSpawns") elsewhere. Stages that place players from code (Ring) get none; maps.js supplies those.
def spawn_point(pid):
    parent = parent_of[pid] in transforms and gos[go_of[parent_of[pid]]].m_Name
    return gos[go_of[pid]].m_Name == "Player Spawnpoint" or parent in ("SingleSpawns", "1-8", "StartSpawns") and not gos[go_of[pid]].m_Name.startswith("GameObject")
for pid in transforms:
    if spawn_point(pid) and is_active(pid):
        x, y, z = xform(wm(pid), [0, 0, 0]); spawns.append(rnd([x, y, -z]))
    # Trawler: one "Spawn Point" that Gang Beasts spreads the beasts around (its _raduis, 1.5m)
    elif gos[go_of[pid]].m_Name == "Spawn Point" and is_active(pid):
        x, y, z = xform(wm(pid), [0, 0, 0])
        spawns += [rnd([x + 1.5 * math.cos(a * math.pi / 4), y, -z + 1.5 * math.sin(a * math.pi / 4)]) for a in range(8)]

# lightmaps live in the scene's LightmapSettings. They're RGBM: linear = (5 * a * rgb) ^ 2.2. Stored as sRGB rgb * a, so nothing
# clips; the renderer scales by 5 ^ 2.2 (LIGHTMAP_RGBM in render.js).
lightmaps = []
for o in env.objects:
    if o.type.name == "LightmapSettings" and in_scene(o):
        for lm in o.read().m_Lightmaps:
            tex = lm.m_Lightmap.read()
            name = f"lightmap_{len(lightmaps)}.png"
            im = tex.image.convert("RGBA")
            px = [(round(r * a / 255), round(g * a / 255), round(b * a / 255)) for r, g, b, a in im.getdata()]
            from PIL import Image
            dec = Image.new("RGB", im.size); dec.putdata(px); dec.save(os.path.join(out, name))
            lightmaps.append(name)

# the stage's skybox as Unity bakes it for reflections: six faces (+x -x +y -y +z -z, Unity's left-handed frame) as sRGB PNGs,
# and their mean linear colour over the sphere. BC6H decodes to 8 bits, so the sun and anything brighter than 1 clip:
# render.js scales the environment to the ambient probe's average (sh[0], sh[9], sh[18]) rather than trusting these
def export_sky(ptr):
    if not ptr.path_id: return {}
    from UnityPy.export.Texture2DConverter import parse_image_data
    cube = ptr.read(); w = cube.m_Width; data = cube.get_image_data()
    per = sum(((max(1, w >> m) + 3) // 4) ** 2 * 16 for m in range(cube.m_MipCount))
    names, tot, wsum = [], [0, 0, 0], 0
    for f in range(6):
        im = parse_image_data(data[f * per:f * per + ((w + 3) // 4) ** 2 * 16], w, w, cube.m_TextureFormat, cube.object_reader.version, cube.object_reader.platform, flip=False).convert("RGB")  # faces are stored top-down
        px = list(im.getdata())
        for i, (r, g, b) in enumerate(px):  # texel solid angle ~ (1 + u^2 + v^2)^-1.5
            u, v = (i % w + 0.5) / w * 2 - 1, (i // w + 0.5) / w * 2 - 1
            k = (1 + u * u + v * v) ** -1.5; wsum += k
            tot[0] += r / 255 * k; tot[1] += g / 255 * k; tot[2] += b / 255 * k
        im.putdata([tuple(round(255 * (c / 255) ** (1 / 2.2)) for c in p) for p in px])
        names.append(f"sky_{f}.png"); im.save(os.path.join(out, names[-1]))
    return {"sky": names, "skyMean": rnd([c / wsum for c in tot])}

# ambient + the lights that shine at runtime (realtime and mixed; baked-only ones are already in the lightmaps)
env_light, lights = {}, []
# PositionalJitter (Incinerator's fire lights): the light hops to a random offset within range every Min..MaxInterval s
jitter = {}
for o in env.objects:
    if o.type.name != "MonoBehaviour" or not in_scene(o): continue
    try: d = o.read_typetree()
    except Exception: continue
    if "JitterCurve" in d:
        jitter[d["m_GameObject"]["m_PathID"]] = {"range": rnd([d["Range"]["x"], d["Range"]["y"], d["Range"]["z"]]), "every": rnd([d["MinimumInterval"], d["MaximumInterval"]])}

for o in env.objects:
    if not in_scene(o): continue
    if o.type.name == "RenderSettings":
        t = o.read_typetree()
        col = lambda c: rnd([c["r"], c["g"], c["b"]])
        env_light.update(ambientSky=col(t["m_AmbientSkyColor"]), ambientEquator=col(t["m_AmbientEquatorColor"]), ambientGround=col(t["m_AmbientGroundColor"]),
                         fog=t["m_Fog"], fogColor=col(t["m_FogColor"]), fogDensity=t["m_FogDensity"],
                         # the ambient probe Unity lights everything unlightmapped with (from the skybox): eval = sh0 + sh1 y + sh2 z + sh3 x + ...
                         sh=[round(t["m_AmbientProbe"][f"sh[{i:2d}]"], 5) for i in range(27)])
        env_light.update(export_sky(o.read().m_GeneratedSkyboxReflection))
    elif o.type.name == "Light":
        l = o.read()
        pid = tf_of_go.get(l.m_GameObject.path_id)
        t = o.read_typetree()
        bake = t.get("m_Lightmapping", 4)  # 1 mixed, 2 baked, 4 realtime
        if l.m_Enabled and pid is not None and is_active(pid) and bake != 2 and l.m_Type in (0, 1, 2) and l.m_Intensity > 0:
            d = xform(wm(pid), [0, 0, 1]); o0 = xform(wm(pid), [0, 0, 0])
            lights.append({"type": ["spot", "sun", "point"][l.m_Type], "color": rnd([l.m_Color.r, l.m_Color.g, l.m_Color.b]), "intensity": round(l.m_Intensity, 3),
                           "p": rnd([o0[0], o0[1], -o0[2]]), "dir": rnd([d[0] - o0[0], d[1] - o0[1], -(d[2] - o0[2])]), "range": round(l.m_Range, 2),
                           "angle": round(l.m_SpotAngle, 2), "inner": round(t.get("m_InnerSpotAngle", l.m_SpotAngle * 0.8), 2),
                           "shadows": t["m_Shadows"]["m_Type"] > 0, "mask": t["m_CullingMask"]["m_Bits"], "name": gos[l.m_GameObject.path_id].m_Name, "jitter": jitter.get(l.m_GameObject.path_id)})

json.dump({"stage": stage, "meshes": meshes, "materials": materials, "renderers": renderers, "colliders": colliders, "capsules": capsules, "trimeshes": trimeshes,
           "spawns": spawns, "kill": kills, "train": train, "lightmaps": lightmaps, "env": env_light, "lights": lights}, open(os.path.join(out, "scene.json"), "w"), indent=0)
print(f"{stage}: {len(renderers)} renderers, {len(meshes)} meshes, {len(materials)} materials, {len(colliders)} boxes, {len(capsules)} capsules, {len(trimeshes)} mesh colliders, {len(spawns)} spawns, {len(kills)} kill boxes, lightmaps {lightmaps}, lights {[(x["type"], x["name"], x["intensity"], x["mask"]) for x in lights]}")
