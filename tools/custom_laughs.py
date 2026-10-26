# Custom laughs: assets/custom_sfx/*.wav (raw recordings, git-ignored, not shipped) -> assets/sfx/laugh_N.wav, each
# recording pitched up (same length) with a brighter tone, trimmed and brought up to the Gang Beasts laughs' loudness.
# sfx.js mixes them into the 'fall' and 'win' laughs.  usage: python tools/custom_laughs.py [path to ffmpeg]
import os, re, subprocess, sys

FF = sys.argv[1] if len(sys.argv) > 1 else r"S:\Tools\ffmpeg-4.3.2-2021-02-27-full_build\bin\ffmpeg.exe"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TARGET = -24  # dB mean, about the GB laughs'
TRIM = "silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse"
TONE = "highpass=f=300,treble=g=5"  # brighter
TEMPO = 1.08  # on top of the pitch
SOURCES = [  # recording, pitch factor (laugh_N in this order, so new ones go on the end)
    ("dogger1", 1.4), ("dogger2", 1.4), ("dogger3", 1.4),
    ("baleed", 1.2), ("dog", 1.3), ("woofwoof", 1.35), ("dogwoofwoof", 1.5), ("gafil", 1.6),
]

def ff(*args):
    return subprocess.run([FF, "-hide_banner", "-y", *args], capture_output=True, text=True).stderr

out = os.path.join(ROOT, "assets", "sfx")
os.makedirs(out, exist_ok=True)
for n, (name, k) in enumerate(SOURCES):
    src = os.path.join(ROOT, "assets", "custom_sfx", name + ".wav")
    chain = f"{TRIM},asetrate=48000*{k},aresample=48000,atempo={TEMPO / k:.4f},{TONE}"
    mean = float(re.search(r"mean_volume: (-?[\d.]+)", ff("-i", src, "-af", chain + ",volumedetect", "-f", "null", "-")).group(1))
    dst = os.path.join(out, f"laugh_{n}.wav")
    ff("-i", src, "-af", f"{chain},volume={TARGET - mean:.1f}dB,alimiter=limit=0.9", "-ar", "48000", "-ac", "1", dst)
    print(os.path.basename(src), "->", os.path.basename(dst), f"x{k}", f"{TARGET - mean:+.1f} dB")
