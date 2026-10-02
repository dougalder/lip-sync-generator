#!/usr/bin/env python3
"""The three media files the manual harnesses drive the app with.

   They were never committed — they are build inputs, not documentation — so
   this rebuilds them from nothing rather than leaving the next person to hunt
   for a .wav that no longer exists. Written to the project root, where
   manualshots.py and manualtest.py look for them.

     speech.wav       about five seconds of syllable-shaped sound. Not speech:
                      the analyser wants energy rising and falling at a
                      syllable rate with some formant structure, and this gives
                      it that, so the exposure sheet comes out with runs of
                      shapes instead of one long rest.
     trim-marks.wav   the same thing in three bursts with long gaps, so "Find
                      the pauses" has something to find and the split makes a
                      queue of three clips.
     codec-vp9.mp4    a moving picture with that sound on it, for the puppet,
                      placement and keyframe pictures.
"""
import math, pathlib, random, struct, subprocess, sys, wave

ROOT = pathlib.Path(__file__).resolve().parent.parent
SR = 22050


def syllables(dur, seed, gaps=(0.05, 0.22)):
    random.seed(seed)
    out, t = [], 0.18
    while t < dur - 0.3:
        d = random.uniform(0.11, 0.22)
        out.append((t, d,
                    random.choice([300, 500, 700, 800]),
                    random.choice([900, 1200, 1800, 2400]),
                    random.uniform(.45, 1.0)))
        t += d + random.uniform(*gaps)
    return out


def render(dur, syls, path):
    n = int(SR * dur)
    buf = bytearray()
    for i in range(n):
        s = i / SR
        v = 0.0
        for (t0, d, f1, f2, amp) in syls:
            if t0 <= s < t0 + d:
                p = (s - t0) / d
                env = math.sin(math.pi * p) ** 0.7
                v += amp * env * (0.6 * math.sin(2 * math.pi * f1 * s) +
                                  0.3 * math.sin(2 * math.pi * f2 * s) +
                                  0.1 * (random.random() * 2 - 1))
        buf += struct.pack("<h", int(max(-1.0, min(1.0, v * 0.5)) * 32000))
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes(bytes(buf))
    print(f"  {path.name}  {path.stat().st_size:,} bytes  {dur:.1f}s  {len(syls)} syllables")


# --- speech.wav ------------------------------------------------------------
# Two half-second pauses in it on purpose. "Find the pauses" has to have
# something to find, or the Split button never appears and the picture of the
# trim row comes out with a callout pointing at nothing.
sp = [s for s in syllables(5.0, 7)
      if not (1.55 < s[0] < 2.05 or 3.25 < s[0] < 3.75)]
render(5.0, sp, ROOT / "speech.wav")

# --- trim-marks.wav: three bursts, seven-tenths of a second of nothing between
bursts, t = [], 0.25
random.seed(11)
for b in range(3):
    end = t + 1.5
    while t < end - 0.25:
        d = random.uniform(0.12, 0.2)
        bursts.append((t, d, random.choice([320, 560, 760]),
                       random.choice([950, 1400, 2100]), random.uniform(.55, 1.0)))
        t += d + random.uniform(0.04, 0.12)
    t = end + 0.7
render(t + 0.3, bursts, ROOT / "trim-marks.wav")

# --- codec-vp9.mp4 ----------------------------------------------------------
# A head-ish shape on a flat ground, drifting a little so the keyframe pictures
# have something to key. The point is a picture the browser will decode with a
# soundtrack the analyser will chew on, not cinema.
png = ROOT / "fixtures" / "_frames"
png.mkdir(exist_ok=True)
try:
    from PIL import Image, ImageDraw
except ImportError:
    print("PIL missing — cannot build the video"); sys.exit(1)

FPS, SECS = 25, 5
for i in range(FPS * SECS):
    im = Image.new("RGB", (640, 360), (36, 44, 58))
    d = ImageDraw.Draw(im)
    p = i / (FPS * SECS)
    cx = 320 + math.sin(p * math.tau) * 16
    cy = 176 + math.cos(p * math.tau * 0.5) * 8
    d.ellipse([cx - 92, cy - 112, cx + 92, cy + 112], fill=(226, 198, 172))
    d.ellipse([cx - 46, cy - 36, cx - 20, cy - 10], fill=(40, 40, 48))
    d.ellipse([cx + 20, cy - 36, cx + 46, cy - 10], fill=(40, 40, 48))
    d.polygon([(cx, cy - 4), (cx - 9, cy + 26), (cx + 9, cy + 26)], fill=(206, 172, 146))
    im.save(png / ("%04d.png" % i))

# VP9 and Opus, not H.264 and AAC, and that is what the file name has always
# been about: the Chromium that Playwright drives is the open-source build,
# which ships no proprietary codecs at all. An H.264 fixture plays perfectly on
# the machine you made it on and then every harness times out waiting for audio
# that never decoded.
cmd = ["ffmpeg", "-y", "-framerate", str(FPS), "-i", str(png / "%04d.png"),
       "-i", str(ROOT / "speech.wav"),
       "-c:v", "libvpx-vp9", "-pix_fmt", "yuv420p", "-crf", "40", "-b:v", "0",
       "-c:a", "libopus", "-b:a", "96k", "-shortest",
       "-movflags", "+faststart", str(ROOT / "codec-vp9.mp4")]
r = subprocess.run(cmd, capture_output=True)
if r.returncode:
    print(r.stderr.decode()[-1200:]); sys.exit(1)
for f in png.glob("*.png"):
    f.unlink()
png.rmdir()
mp4 = ROOT / "codec-vp9.mp4"
print(f"  {mp4.name}  {mp4.stat().st_size:,} bytes  {SECS}s @ {FPS}fps  VP9 + Opus")
print("")
