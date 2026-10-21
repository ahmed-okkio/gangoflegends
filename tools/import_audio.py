"""Export the Gang Beasts sound effects we use from the local install into gbcache/audio/ (git-ignored, never shipped).

Usage: python tools/import_audio.py [gang beasts install dir]
Writes <group>_<n>.wav per clip and index.json ({group: [file, ...]}) that sfx.js reads.
"""
import UnityPy, glob, json, os, re, sys

UnityPy.config.FALLBACK_UNITY_VERSION = "2021.3.33f1"  # bundles have their version stripped
GB = sys.argv[1] if len(sys.argv) > 1 else r"S:\SteamLibrary\steamapps\common\Gang Beasts"
OUT = os.path.join(os.path.dirname(__file__), "..", "gbcache", "audio")

# group -> clip name pattern (names like "GB SFX PUNCh_FACE_NORM 3")
GROUPS = {
    "hit": r"^GB SFX PUNCh_FACE_NORM",
    "hitHard": r"^GB SFX PUNCh_FACE_HARD",
    "body": r"^GB PUNCH SFX XTRA BODY LIGHT",
    "swing": r"^GB SFX SWING",
    "grab": r"^GB SFX GRIPhangON",
    "thud": r"^GB SFX BODYhitGROUND",
    "ko": r"^GB VO [A-Z]{3} (DOH|MUNGY)",
    "fall": r"^GB VO [A-Z]{3} FALL LAUGH",
    "wind": r"^GB_SFX_FALL_WIND",
    "win": r"^GB VO [A-Z]{3} WIN LAUGH",
    "star": r"^GB SFX WIN STAR",
    "count": r"^GB SFX CountDown",
}

os.makedirs(OUT, exist_ok=True)
index = {g: [] for g in GROUPS}
seen = set()
BUNDLES = os.path.join(GB, r"Gang Beasts_Data\StreamingAssets\aa\StandaloneWindows64-LocalBundles")
for f in glob.glob(os.path.join(BUNDLES, "core-audio*.bundle")):
    for o in UnityPy.load(f).objects:
        if o.type.name != "AudioClip": continue
        name = o.peek_name()
        g = next((g for g, rx in GROUPS.items() if re.match(rx, name)), None)
        if not g or name in seen: continue
        seen.add(name)
        for data in o.read().samples.values():
            fn = f"{g}_{len(index[g])}.wav"
            open(os.path.join(OUT, fn), "wb").write(data)
            index[g].append(fn)
json.dump(index, open(os.path.join(OUT, "index.json"), "w"), indent=1)
print({g: len(v) for g, v in index.items()})
