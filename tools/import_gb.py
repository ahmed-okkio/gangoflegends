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
env = UnityPy.load(*glob.glob(os.path.join(bundles, f"stages-{stage}_*.bundle")), *glob.glob(os.path.join(bundles, "core-stages*.bundle")))

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
def is_active(pid):
    if pid not in active:
        go = gos.get(go_of[pid])
        par = parent_of[pid]
        active[pid] = bool(go and go.m_IsActive) and (is_active(par) if par in transforms else True)
    return active[pid]
def path(pid):
    names = []
    while pid in transforms:
        names.append(gos[go_of[pid]].m_Name); pid = parent_of[pid]
    return "/".join(reversed(names))

def in_scene(o):
    return "_scenes_" in str(getattr(o.assets_file.parent, "name", ""))

# ---------- export ----------
meshes, materials, textures, renderers, colliders, spawns, kills = {}, {}, {}, [], [], [], []

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
    if o.type.name not in ("MeshRenderer", "BoxCollider"): continue
    if not in_scene(o): continue  # shared bundles also hold prefabs that aren't placed in this stage
    try: c = o.read()
    except Exception: continue
    pid = tf_of_go.get(c.m_GameObject.path_id)
    # breakable floor slabs sit inactive in the scene (the game switches them on); we keep them as solid floor
    if pid is None or not (is_active(pid) or "_breakable" in path(pid)) or not getattr(c, "m_Enabled", True): continue
    p = path(pid)
    m = wm(pid)
    if o.type.name == "MeshRenderer":
        go = gos[go_of[pid]]
        mf = next((comp for comp in (x.component.read() if hasattr(x, "component") else x.read() for x in go.m_Component) if comp.object_reader.type.name == "MeshFilter"), None)
        if not mf or not mf.m_Mesh.path_id: continue
        try: mkey = export_mesh(mf.m_Mesh)
        except Exception as e: print("  mesh failed", p, e); continue
        sbi = c.m_StaticBatchInfo
        mats = [export_material(x) for x in c.m_Materials if x.path_id]
        first, count = (sbi.firstSubMesh, sbi.subMeshCount) if sbi and sbi.subMeshCount else (0, len(meshes[mkey]["subs"]))
        renderers.append({
            "path": p, "mesh": mkey, "subs": list(range(first, first + count)), "mats": mats,
            # static-batched vertices are already in world space
            "matrix": None if (sbi and sbi.subMeshCount) else [rnd(r, 5) for r in flipz(m)],
            "lightmap": c.m_LightmapIndex if c.m_LightmapIndex < 65534 else -1,
            "lmso": rnd([c.m_LightmapTilingOffset.x, c.m_LightmapTilingOffset.y, c.m_LightmapTilingOffset.z, c.m_LightmapTilingOffset.w], 6),
        })
    else:
        cm = mmul(m, trs([c.m_Center.x, c.m_Center.y, c.m_Center.z], [0, 0, 0, 1], [c.m_Size.x, c.m_Size.y, c.m_Size.z]))
        pos, q, size = decompose(flipz(cm))
        box = {"path": p, "p": rnd(pos), "q": rnd(q, 5), "h": rnd([s / 2 for s in size])}
        if c.m_IsTrigger:
            if "kill" in p.lower(): kills.append(box)
        elif "/City" not in p and "/Camera" not in p:  # Camera Blocker only stops the camera; beasts fall through it
            colliders.append(box)

for pid in transforms:
    if gos[go_of[pid]].m_Name == "Player Spawnpoint" and is_active(pid):
        x, y, z = xform(wm(pid), [0, 0, 0]); spawns.append(rnd([x, y, -z]))

# lightmaps live in the scene's LightmapSettings. They're RGBM (gamma space: rgb * a * 5); decode to plain RGB.
lightmaps = []
for o in env.objects:
    if o.type.name == "LightmapSettings" and in_scene(o):
        for lm in o.read().m_Lightmaps:
            tex = lm.m_Lightmap.read()
            name = f"lightmap_{len(lightmaps)}.png"
            im = tex.image.convert("RGBA")
            px = [(min(255, int(r * a * 5 / 255)), min(255, int(g * a * 5 / 255)), min(255, int(b * a * 5 / 255))) for r, g, b, a in im.getdata()]
            from PIL import Image
            dec = Image.new("RGB", im.size); dec.putdata(px); dec.save(os.path.join(out, name))
            lightmaps.append(name)

# ambient + realtime sun, so the renderer can match the original lighting
env_light = {}
for o in env.objects:
    if not in_scene(o): continue
    if o.type.name == "RenderSettings":
        t = o.read_typetree()
        col = lambda c: rnd([c["r"], c["g"], c["b"]])
        env_light.update(ambientSky=col(t["m_AmbientSkyColor"]), ambientEquator=col(t["m_AmbientEquatorColor"]), ambientGround=col(t["m_AmbientGroundColor"]),
                         fog=t["m_Fog"], fogColor=col(t["m_FogColor"]), fogDensity=t["m_FogDensity"])
    elif o.type.name == "Light":
        l = o.read()
        pid = tf_of_go.get(l.m_GameObject.path_id)
        if l.m_Type == 1 and l.m_Enabled and pid is not None and is_active(pid):
            d = xform(wm(pid), [0, 0, 1]); o0 = xform(wm(pid), [0, 0, 0])
            env_light["sun"] = {"color": rnd([l.m_Color.r, l.m_Color.g, l.m_Color.b]), "intensity": l.m_Intensity, "dir": rnd([d[0] - o0[0], d[1] - o0[1], -(d[2] - o0[2])])}

json.dump({"stage": stage, "meshes": meshes, "materials": materials, "renderers": renderers, "colliders": colliders,
           "spawns": spawns, "kill": kills, "lightmaps": lightmaps, "env": env_light}, open(os.path.join(out, "scene.json"), "w"), indent=0)
print(f"{stage}: {len(renderers)} renderers, {len(meshes)} meshes, {len(materials)} materials, {len(colliders)} colliders, {len(spawns)} spawns, {len(kills)} kill boxes, lightmaps {lightmaps}")
