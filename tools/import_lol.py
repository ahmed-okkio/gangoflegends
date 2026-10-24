"""Fetch the base-skin League of Legends models for our champions from CommunityDragon into lolcache/ (git-ignored, never shipped)
and convert each .skn to .obj (+ .mtl) so Blender can open it. tools/build_props.py then cuts the props out of them.

Usage: python tools/import_lol.py
"""
import os, struct, urllib.request

CDRAGON = "https://raw.communitydragon.org/latest/game/assets/characters/{c}/skins/base/{f}"
CHAMPS = {  # champion folder: (mesh, diffuse texture)
    "blitzcrank": ("blitzcrank.skn", "steamgolem.png"),
    "hecarim": ("hecarim.skn", "hecarim_base_tx_cm.png"),
    "thresh": ("thresh.skn", "thresh_base_tx_cm.png"),
}
root = os.path.join(os.path.dirname(__file__), "..", "lolcache")

def skn_to_obj(data, obj_path, tex):
    magic, major, minor = struct.unpack_from("<IHH", data, 0); o = 8
    assert magic == 0x00112233, "not an .skn"
    subs = []
    if major > 0:
        (n,) = struct.unpack_from("<I", data, o); o += 4
        for _ in range(n):
            name = data[o:o + 64].split(b"\0")[0].decode(); o += 64
            subs.append((name, *struct.unpack_from("<4I", data, o))); o += 16
    if major == 4: o += 4  # flags
    n_idx, n_vert = struct.unpack_from("<II", data, o); o += 8
    stride = 52
    if major == 4:
        stride, _vtype = struct.unpack_from("<II", data, o); o += 8 + 40  # vertex size, type, bbox, bounding sphere
    idx = struct.unpack_from(f"<{n_idx}H", data, o); o += n_idx * 2
    lines = [f"mtllib {os.path.basename(obj_path)[:-4]}.mtl"]
    vs, vn, vt = [], [], []
    for i in range(n_vert):
        b = o + i * stride
        x, y, z = struct.unpack_from("<3f", data, b)
        nx, ny, nz = struct.unpack_from("<3f", data, b + 32)
        u, v = struct.unpack_from("<2f", data, b + 44)
        # League is left-handed (x mirrored vs glTF/Blender conventions): flip x so the model isn't mirrored
        vs.append(f"v {-x:.5f} {y:.5f} {z:.5f}"); vn.append(f"vn {-nx:.4f} {ny:.4f} {nz:.4f}"); vt.append(f"vt {u:.5f} {1 - v:.5f}")
    lines += vs + vt + vn
    for name, _sv, _vc, si, ic in subs or [("body", 0, n_vert, 0, n_idx)]:
        lines += [f"o {name}", f"usemtl {name}"]
        for t in range(si, si + ic, 3):
            a, b, c = (idx[t + k] + 1 for k in (0, 2, 1))  # x flip reverses winding
            lines.append(f"f {a}/{a}/{a} {b}/{b}/{b} {c}/{c}/{c}")
    open(obj_path, "w").write("\n".join(lines))
    mtl = []
    for name, *_ in subs or [("body",)]:
        mtl += [f"newmtl {name}", "Kd 1 1 1", f"map_Kd {tex}"]
    open(obj_path[:-4] + ".mtl", "w").write("\n".join(mtl))
    return [s[0] for s in subs], n_vert

for champ, (skn, tex) in CHAMPS.items():
    d = os.path.join(root, champ); os.makedirs(d, exist_ok=True)
    for f in (skn, tex):
        p = os.path.join(d, f)
        if not os.path.exists(p):  # CommunityDragon refuses Python's default user agent
            req = urllib.request.Request(CDRAGON.format(c=champ, f=f), headers={"User-Agent": "GangOfLegends-importer"})
            open(p, "wb").write(urllib.request.urlopen(req).read())
    subs, n = skn_to_obj(open(os.path.join(d, skn), "rb").read(), os.path.join(d, champ + ".obj"), tex)
    print(f"{champ}: {n} verts, submeshes {subs}")
