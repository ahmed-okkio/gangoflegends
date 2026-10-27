# Custom laughs: assets/custom_sfx/*.wav (raw recordings, git-ignored, not shipped) -> assets/sfx/laugh_N.wav, each
# recording pitched up (same length), its formants further for the new ones, trimmed and brought up to the Gang Beasts laughs' loudness.
# sfx.js mixes them into the 'fall' and 'win' laughs.  usage: python tools/custom_laughs.py [path to ffmpeg]
import os, re, subprocess, sys

FF = sys.argv[1] if len(sys.argv) > 1 else r"S:\Tools\ffmpeg-4.3.2-2021-02-27-full_build\bin\ffmpeg.exe"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TARGET = -24  # dB mean, about the GB laughs'
TRIM = "silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse"
TEMPO = 1.08  # on top of the pitch
SQUEAKY = "highpass=f=300,treble=g=5"
# recording, formant factor, pitch factor, tone (laugh_N in this order, so new ones go on the end).
# Formants moved further than the pitch (a smaller creature, not the recording sped up) hide whose voice it is
SOURCES = [
    ("dogger1", 1.4, 1.4, SQUEAKY), ("dogger2", 1.4, 1.4, SQUEAKY), ("dogger3", 1.4, 1.4, SQUEAKY),
    ("baleed", 1.9, 1.5, "highpass=f=250"), ("dog", 1.9, 1.55, "highpass=f=250"),
    ("dogwoofwoof", 1.9, 1.65, "highpass=f=250"),
]

def ff(*args):
    return subprocess.run([FF, "-hide_banner", "-y", *args], capture_output=True, text=True).stderr

out = os.path.join(ROOT, "assets", "sfx")
os.makedirs(out, exist_ok=True)
for n, (name, k, pitch, tone) in enumerate(SOURCES):
    src = os.path.join(ROOT, "assets", "custom_sfx", name + ".wav")
    # asetrate moves pitch and formants together; rubberband then brings the pitch back down, formants kept
    back = f",rubberband=pitch={pitch / k:.4f}:formant=preserved" if pitch != k else ""
    chain = f"{TRIM},asetrate=48000*{k},aresample=48000,atempo={TEMPO / k:.4f}{back},{tone}"
    mean = float(re.search(r"mean_volume: (-?[\d.]+)", ff("-i", src, "-af", chain + ",volumedetect", "-f", "null", "-")).group(1))
    dst = os.path.join(out, f"laugh_{n}.wav")
    ff("-i", src, "-af", f"{chain},volume={TARGET - mean:.1f}dB,alimiter=limit=0.9", "-ar", "48000", "-ac", "1", dst)
    print(os.path.basename(src), "->", os.path.basename(dst), f"formants x{k} pitch x{pitch}", f"{TARGET - mean:+.1f} dB")
