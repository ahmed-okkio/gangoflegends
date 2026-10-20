"""Import the Gang Beasts beast mesh (Medium build) from the player's own install into gbcache/beast/ (git-ignored, never shipped).

Writes beast.json (bone names + bind poses, head submeshes), body.bin (skinned) and head.bin (rigid, in head-bone space).
Coordinates are x-mirrored from Unity so the beast faces +z with its left at +x, matching beast.js.

Usage: python tools/import_beast.py [gang beasts install dir]
Needs: pip install UnityPy
"""
import sys, os, glob, json
from array import array
import UnityPy
from UnityPy.helpers.MeshHelper import MeshHandler

UnityPy.config.FALLBACK_UNITY_VERSION = "2021.3.33f1"  # bundles have their version stripped
install = sys.argv[1] if len(sys.argv) > 1 else r"S:\SteamLibrary\steamapps\common\Gang Beasts"
bundles = os.path.join(install, r"Gang Beasts_Data\StreamingAssets\aa\StandaloneWindows64-LocalBundles")
out = os.path.join(os.path.dirname(__file__), "..", "gbcache", "beast")
os.makedirs(out, exist_ok=True)
# the prefab lives in core-beasts, its meshes in core-globalassets
env = UnityPy.load(*glob.glob(os.path.join(bundles, "core-beasts_*.bundle")), *glob.glob(os.path.join(bundles, "core-globalassets_*.bundle")))

tfs = {o.path_id: o.read() for o in env.objects if o.type.name == "Transform"}
def root_name(tf):
    while tf.m_Father.path_id in tfs: tf = tfs[tf.m_Father.path_id]
    return tf.m_GameObject.read().m_Name
tf_of_go = {t.m_GameObject.path_id: t for t in tfs.values()}
def bone_name(ptr): return tfs[ptr.path_id].m_GameObject.read().m_Name

def qmul(a, b):
    ax, ay, az, aw = a; bx, by, bz, bw = b
    return [aw*bx+ax*bw+ay*bz-az*by, aw*by-ax*bz+ay*bw+az*bx, aw*bz+ax*by-ay*bx+az*bw, aw*bw-ax*bx-ay*by-az*bz]
def qrot(q, v):
    x, y, z, w = q
    tx, ty, tz = 2*(y*v[2]-z*v[1]), 2*(z*v[0]-x*v[2]), 2*(x*v[1]-y*v[0])
    return [v[0]+w*tx+y*tz-z*ty, v[1]+w*ty+z*tx-x*tz, v[2]+w*tz+x*ty-y*tx]
def rest(ptr):  # bone's prefab pose relative to the beast root, mirrored: [p, q]
    chain, tf = [], tfs[ptr.path_id]
    while tf.m_Father.path_id in tfs: chain.append(tf); tf = tfs[tf.m_Father.path_id]  # stops below the root
    p, q = [0, 0, 0], [0, 0, 0, 1]
    for t in reversed(chain):
        lp, lq = t.m_LocalPosition, t.m_LocalRotation
        p = [a + b for a, b in zip(p, qrot(q, [lp.x, lp.y, lp.z]))]; q = qmul(q, [lq.x, lq.y, lq.z, lq.w])
    return [[round(-p[0], 5), round(p[1], 5), round(p[2], 5)], [round(q[0], 5), round(-q[1], 5), round(-q[2], 5), round(q[3], 5)]]
def mirror_m(m):  # S M S with S = diag(-1,1,1,1); m is a Unity Matrix4x4f (row/col fields eRC)
    s = [-1, 1, 1, 1]
    return [[getattr(m, f"e{r}{c}") * s[r] * s[c] for c in range(4)] for r in range(4)]
def col_major(rows): return [round(rows[r][c], 6) for c in range(4) for r in range(4)]
def apply(m, v):  # unmirrored Unity matrix on a point
    return [sum(getattr(m, f"e{r}{c}") * x for c, x in enumerate((*v, 1))) for r in range(3)]
def apply_dir(m, v):
    return [sum(getattr(m, f"e{r}{c}") * x for c, x in enumerate(v)) for r in range(3)]

smrs = {}
for o in env.objects:
    # core-globalassets carries another copy of the prefab with a slightly different rest pose; use the one the physics comes from
    if o.type.name != "SkinnedMeshRenderer" or "core-beasts" not in str(getattr(o.assets_file.parent, "name", "")): continue
    r = o.read()
    go = r.m_GameObject.read()
    if go.m_Name in ("actor_body_skinnedMesh", "actor_head_skinnedMesh") and root_name(tf_of_go[r.m_GameObject.path_id]) == "actor_humanoidMediumEctomorph":
        smrs[go.m_Name] = r

def triangles(mesh, h):
    idx, groups = array("I"), []
    for sm, tris in zip(mesh.m_SubMeshes, h.get_triangles()):
        start = len(idx)
        for t in tris: idx.extend((t[0] + sm.baseVertex, t[2] + sm.baseVertex, t[1] + sm.baseVertex))  # mirror reverses winding
        groups.append([start, len(idx) - start])
    return idx, groups

# body: skinned
r = smrs["actor_body_skinnedMesh"]; mesh = r.m_Mesh.read(); h = MeshHandler(mesh); h.process()
pos, nrm, ji, jw = array("f"), array("f"), array("H"), array("f")
for v in h.m_Vertices: pos.extend((-v[0], v[1], v[2]))
for v in h.m_Normals: nrm.extend((-v[0], v[1], v[2]))
for bi, bw in zip(h.m_BoneIndices, h.m_BoneWeights):
    ji.extend(bi); jw.extend(bw)
idx, groups = triangles(mesh, h)
open(os.path.join(out, "body.bin"), "wb").write(b"".join(a.tobytes() for a in (pos, nrm, jw, ji, idx)))
body = {"verts": h.m_VertexCount, "indices": len(idx),
        "bones": [{"name": bone_name(b), "rest": rest(b), "bind": col_major(mirror_m(bp))} for b, bp in zip(r.m_Bones, mesh.m_BindPose)]}

# head: one bone, so bake it into head-bone space and parent it to the head
r = smrs["actor_head_skinnedMesh"]; mesh = r.m_Mesh.read(); h = MeshHandler(mesh); h.process()
bp = mesh.m_BindPose[0]
pos, nrm = array("f"), array("f")
for v in h.m_Vertices: x, y, z = apply(bp, v); pos.extend((-x, y, z))
for v in h.m_Normals: x, y, z = apply_dir(bp, v); nrm.extend((-x, y, z))
idx, groups = triangles(mesh, h)
open(os.path.join(out, "head.bin"), "wb").write(b"".join(a.tobytes() for a in (pos, nrm, idx)))
head = {"verts": h.m_VertexCount, "indices": len(idx), "groups": groups, "bone": bone_name(r.m_Bones[0]),
        "mats": [m.read().m_Name for m in r.m_Materials]}

json.dump({"body": body, "head": head}, open(os.path.join(out, "beast.json"), "w"), indent=0)
print(f"beast: body {body['verts']} verts / {len(body['bones'])} bones, head {head['verts']} verts / mats {head['mats']}")
