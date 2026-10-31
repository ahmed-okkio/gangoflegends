"""Import Gang Beasts' Aquarium octopus tentacle from the player's own install into gbcache/aquarium/ (tentacle.json, tentacle.bin, texture).

tentacle.json: the skinned mesh's layout, each bone's height up the straight tentacle (bones all sit on its +y axis, unrotated,
in the order the skin weights index them) and its two submeshes (skin, suckers). tentacle.bin: positions, normals, uvs, skin
weights, skin indices, triangle indices. z flipped from Unity like tools/import_gb.py. sim.js / render.js bend it (maps.js tentaclePose).

Usage: python tools/import_tentacle.py [gang beasts install dir]
Needs: pip install UnityPy
"""
import sys, os, glob, json
from array import array
import UnityPy
from UnityPy.helpers.MeshHelper import MeshHandler

UnityPy.config.FALLBACK_UNITY_VERSION = "2021.3.33f1"  # bundles have their version stripped
install = sys.argv[1] if len(sys.argv) > 1 else r"S:\SteamLibrary\steamapps\common\Gang Beasts"
bundles = os.path.join(install, r"Gang Beasts_Data\StreamingAssets\aa\StandaloneWindows64-LocalBundles")
out = os.path.join(os.path.dirname(__file__), "..", "gbcache", "aquarium")
os.makedirs(out, exist_ok=True)
env = UnityPy.load(*glob.glob(os.path.join(bundles, "stages-aquarium*.bundle")), *glob.glob(os.path.join(bundles, "core-*.bundle")))

go = next(o.read() for o in env.objects if o.type.name == "GameObject" and o.peek_name() == "tentacle (0)")
smr = next(c.read() for c in (x.component.deref() if hasattr(x, "component") else x.deref() for x in go.m_Component) if c.type.name == "SkinnedMeshRenderer")
bones = [round(b.read().m_LocalPosition.y, 4) for b in smr.m_Bones]

mesh = smr.m_Mesh.read(); h = MeshHandler(mesh); h.process()
pos, nrm, uv, jw, ji = array("f"), array("f"), array("f"), array("f"), array("H")
for v in h.m_Vertices: pos.extend((v[0], v[1], -v[2]))
for v in h.m_Normals: nrm.extend((v[0], v[1], -v[2]))
for v in h.m_UV0: uv.extend((v[0], v[1]))
for bi, bw in zip(h.m_BoneIndices, h.m_BoneWeights): ji.extend(bi); jw.extend(bw)
idx, subs = array("I"), []
for sm, tris in zip(mesh.m_SubMeshes, h.get_triangles()):
    start = len(idx)
    for t in tris: idx.extend((t[0] + sm.baseVertex, t[2] + sm.baseVertex, t[1] + sm.baseVertex))  # flip reverses winding
    subs.append([start, len(idx) - start])
open(os.path.join(out, "tentacle.bin"), "wb").write(b"".join(a.tobytes() for a in (pos, nrm, uv, jw, ji, idx)))

mats = []
for ref in smr.m_Materials:
    m = ref.read(); props = m.m_SavedProperties
    texs = {k: v.m_Texture for k, v in props.m_TexEnvs}; cols = {k: c for k, c in props.m_Colors}
    base, tex = texs.get("_BaseMap") or texs.get("_MainTex"), None
    if base and base.path_id:
        t = base.read(); tex = "tentacle_" + t.m_Name.replace(" ", "_") + ".png"; t.image.save(os.path.join(out, tex))
    c = cols.get("_BaseColor") or cols.get("_Color")
    mats.append({"tex": tex, "color": [round(c.r, 4), round(c.g, 4), round(c.b, 4)] if c else [1, 1, 1]})

json.dump({"verts": h.m_VertexCount, "indices": len(idx), "subs": subs, "bones": bones, "mats": mats}, open(os.path.join(out, "tentacle.json"), "w"), indent=0)
print(f"tentacle: {h.m_VertexCount} verts, {len(bones)} bones up to {max(bones)}m, mats {mats}")
