"""Import Gang Beasts' Trawler shark from the player's own install into gbcache/trawler/ (shark.json, shark.bin, texture).

shark.json: the ragdoll (12 parts: frame, mass, collider, joint to its parent, all in shark space, root at the origin
facing -z, scale 0.6 baked in), the AI tuning off its SharkActor, the stage's swim nodes (world space) and the bind poses
for the skinned mesh. shark.bin: positions, normals, uvs, skin weights, skin indices, triangle indices.
Coordinates flipped in z from Unity like tools/import_gb.py, so nodes line up with the imported stage.

Usage: python tools/import_shark.py [gang beasts install dir]
Needs: pip install UnityPy
"""
import sys, os, glob, json
from array import array
import UnityPy
from UnityPy.helpers.MeshHelper import MeshHandler

UnityPy.config.FALLBACK_UNITY_VERSION = "2021.3.33f1"  # bundles have their version stripped
install = sys.argv[1] if len(sys.argv) > 1 else r"S:\SteamLibrary\steamapps\common\Gang Beasts"
bundles = os.path.join(install, r"Gang Beasts_Data\StreamingAssets\aa\StandaloneWindows64-LocalBundles")
out = os.path.join(os.path.dirname(__file__), "..", "gbcache", "trawler")
os.makedirs(out, exist_ok=True)
env = UnityPy.load(*glob.glob(os.path.join(bundles, "stages-trawler*.bundle")), *glob.glob(os.path.join(bundles, "core-*.bundle")))

def r5(v): return [round(x, 5) for x in v]
def qmul(a, b):
    ax, ay, az, aw = a; bx, by, bz, bw = b
    return [aw*bx+ax*bw+ay*bz-az*by, aw*by-ax*bz+ay*bw+az*bx, aw*bz+ax*by-ay*bx+az*bw, aw*bw-ax*bx-ay*by-az*bz]
def qrot(q, v):
    x, y, z, w = q
    tx, ty, tz = 2*(y*v[2]-z*v[1]), 2*(z*v[0]-x*v[2]), 2*(x*v[1]-y*v[0])
    return [v[0]+w*tx+y*tz-z*ty, v[1]+w*ty+z*tx-x*tz, v[2]+w*tz+x*ty-y*tx]
P = lambda v: [v.x, v.y, -v.z]          # Unity point -> ours (flip z)
Q = lambda q: [-q.x, -q.y, q.z, q.w]    # Unity rotation -> ours

def world(tf):  # Unity world [p, q, s] of a transform
    p, q, s = [0, 0, 0], [0, 0, 0, 1], 1
    chain = []
    while tf: chain.append(tf); tf = tf.m_Father.read() if tf.m_Father.path_id else None
    for t in reversed(chain):
        lp, lq = t.m_LocalPosition, t.m_LocalRotation
        p = [a + b for a, b in zip(p, qrot(q, [lp.x * s, lp.y * s, lp.z * s]))]
        q = qmul(q, [lq.x, lq.y, lq.z, lq.w]); s *= t.m_LocalScale.x
    return p, q, s
def comps(go):
    return [c.component.deref() if hasattr(c, "component") else c.deref() for c in go.m_Component]

root = next(o.read() for o in env.objects if o.type.name == "GameObject" and o.peek_name() == "Shark (Sleeping) (1)")
rootTf = next(c.read() for c in comps(root) if c.type.name == "Transform")
S = rootTf.m_LocalScale.x
actor = next(c for c in comps(root) if c.type.name == "MonoBehaviour" and "startDelay" in c.read_typetree())
A = actor.read_typetree()
smr = next(c.read() for c in comps(root) if c.type.name == "SkinnedMeshRenderer")

# parts: the shark's children; rigidbody path id -> part index for the joints
parts, rb_index, tf_index = [], {}, {}
for ch in rootTf.m_Children:
    tf = ch.read(); go = tf.m_GameObject.read(); cs = comps(go)
    lp, lq = tf.m_LocalPosition, tf.m_LocalRotation
    part = {"name": go.m_Name.replace("shark_", ""), "p": r5(P(type("v", (), {"x": lp.x * S, "y": lp.y * S, "z": lp.z * S}))), "q": r5(Q(lq))}
    for c in cs:
        t, d = c.type.name, c.read_typetree()
        if t == "Rigidbody": rb_index[c.path_id] = len(parts); part["mass"] = d["m_Mass"]
        elif t == "CapsuleCollider":
            ax = "xyz"[d["m_Direction"]]; c0 = d["m_Center"]
            part["cap"] = [round(d["m_Radius"] * S, 4), round(max(0, d["m_Height"] / 2 - d["m_Radius"]) * S, 4), ax]
            part["c"] = r5([c0["x"] * S, c0["y"] * S, -c0["z"] * S])
        elif t == "SphereCollider":
            c0 = d["m_Center"]; part["ball"] = round(d["m_Radius"] * S, 4); part["c"] = r5([c0["x"] * S, c0["y"] * S, -c0["z"] * S])
        elif t == "BoxCollider":
            c0, sz = d["m_Center"], d["m_Size"]; part["box"] = r5([sz["x"] * S / 2, sz["y"] * S / 2, sz["z"] * S / 2]); part["c"] = r5([c0["x"] * S, c0["y"] * S, -c0["z"] * S])
        elif t == "MeshCollider":  # convex: its points, for a hull
            h = MeshHandler(c.read().m_Mesh.read()); h.process()
            part["hull"] = [round(x * S * (-1 if i % 3 == 2 else 1), 4) for v in h.m_Vertices for i, x in enumerate(v)]
        elif t == "ConfigurableJoint":
            part["joint"] = {"to": d["m_ConnectedBody"]["m_PathID"], "anchor": r5([v * S for v in P(type("v", (), d["m_ConnectedAnchor"]))]),
                             "free": [d["m_AngularXMotion"], d["m_AngularYMotion"], d["m_AngularZMotion"]],  # 0 locked, 1 limited, 2 free
                             "x": [d["m_LowAngularXLimit"]["limit"], d["m_HighAngularXLimit"]["limit"]], "y": d["m_AngularYLimit"]["limit"], "z": d["m_AngularZLimit"]["limit"],
                             "spring": d["m_SlerpDrive"]["positionSpring"], "damper": d["m_SlerpDrive"]["positionDamper"]}
    tf_index[ch.path_id] = len(parts)
    parts.append(part)
for p in parts:
    if "joint" in p: p["joint"]["to"] = rb_index[p["joint"]["to"]]

tfs = {o.path_id: o for o in env.objects if o.type.name == "Transform" and o.assets_file is actor.assets_file}
def node_list(key):  # world positions of the actor's swim nodes
    outp = []
    for ref in A[key]:
        tf = tfs[ref["m_PathID"]].read()
        p, _, _ = world(tf)
        outp.append(r5([p[0], p[1], -p[2]]))
    return outp

# skinned mesh, in shark-root space (bind poses relative to the root, flipped)
mesh = smr.m_Mesh.read(); h = MeshHandler(mesh); h.process()
pos, nrm, uv, jw, ji = array("f"), array("f"), array("f"), array("f"), array("H")
for v in h.m_Vertices: pos.extend((v[0], v[1], -v[2]))
for v in h.m_Normals: nrm.extend((v[0], v[1], -v[2]))
for v in h.m_UV0: uv.extend((v[0], v[1]))
for bi, bw in zip(h.m_BoneIndices, h.m_BoneWeights): ji.extend(bi); jw.extend(bw)
idx = array("I")
for sm, tris in zip(mesh.m_SubMeshes, h.get_triangles()):
    for t in tris: idx.extend((t[0] + sm.baseVertex, t[2] + sm.baseVertex, t[1] + sm.baseVertex))  # flip reverses winding
open(os.path.join(out, "shark.bin"), "wb").write(b"".join(a.tobytes() for a in (pos, nrm, uv, jw, ji, idx)))
sf = [1, 1, -1, 1]
binds = [[round(getattr(bp, f"e{r}{c}") * sf[r] * sf[c], 6) for c in range(4) for r in range(4)] for bp in mesh.m_BindPose]  # column-major
bones = [tf_index[b.path_id] for b in smr.m_Bones]

mat = smr.m_Materials[0].read(); texs = {k: v.m_Texture for k, v in mat.m_SavedProperties.m_TexEnvs}
base = texs.get("_BaseMap") or texs.get("_MainTex"); tex = None
if base and base.path_id:
    t = base.read(); tex = "shark_" + t.m_Name.replace(" ", "_") + ".png"; t.image.save(os.path.join(out, tex))

keys = ["startDelay", "maxHealth", "maxUnconsciousTime", "minSleepingTime", "maxSleepingTime", "minSearchingTime", "maxSearchingTime",
        "minAttackingTime", "maxAttackingTime", "onLandMovementSpeed", "onLandHopStrength", "inWaterMovementSpeed", "inWaterLeapStrength",
        "inWaterDiveStrength", "maxVelocity", "upForce", "breachDepth", "breachHeight"]
json.dump({"scale": S, "parts": parts, "ai": {k: A[k] for k in keys},
           "nodes": {k: node_list(k + "Nodes") for k in ("search", "retreat", "dive", "breach")},
           "mesh": {"verts": h.m_VertexCount, "indices": len(idx), "bones": bones, "binds": binds, "tex": tex, "color": None}},
          open(os.path.join(out, "shark.json"), "w"), indent=0)
print(f"shark: {len(parts)} parts {[p['name'] for p in parts]}, {h.m_VertexCount} verts, tex {tex}")
