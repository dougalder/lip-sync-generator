#!/usr/bin/env python3
"""The demo clip's voice, and the constant in app.js that carries it.

   Synthesized rather than recorded, for two reasons. A recording of a person is
   a person's voice to host and to ship, and this file goes in a public
   repository; and a synthesiser gives clean, evenly spaced phonemes, which is
   exactly what makes the exposure sheet legible as an example. It sounds like a
   robot, and it is meant to — the demo is about the mouth, not the acting.

   Needs eSpeak NG and ffmpeg:
       apt-get install espeak-ng ffmpeg        (or brew install espeak-ng ffmpeg)

   Run it and it rewrites DEMO_MP3 in app.js in place, so the thing in the build
   and the thing on disk cannot disagree:
       python3 fixtures/make_demo_voice.py
"""
import base64, pathlib, re, subprocess, sys

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
MP3 = HERE / "demo-voice.mp3"
APP = ROOT / "app.js"

LINE = "Hello! I am a lip sync demo. Watch my mouth move while I talk."

for tool in ("espeak-ng", "ffmpeg"):
    if subprocess.run(["which", tool], capture_output=True).returncode:
        sys.exit(tool + " is not installed — see the note at the top of this file")

raw = HERE / "_demo_raw.wav"
subprocess.run(["espeak-ng", "-v", "en-us+m3", "-s", "150", "-p", "42",
                "-w", str(raw), LINE], check=True)
# Mono, 22 kHz, gently compressed: the analyser wants a steady level, and a
# synthesiser's output swings more than a voice does between a vowel and a stop.
subprocess.run(["ffmpeg", "-y", "-i", str(raw), "-ac", "1", "-ar", "22050",
                "-af", "highpass=f=70,acompressor=threshold=-18dB:ratio=3,volume=1.6",
                "-c:a", "libmp3lame", "-b:a", "48k", str(MP3)],
               check=True, capture_output=True)
raw.unlink()

b64 = base64.b64encode(MP3.read_bytes()).decode()
src = APP.read_text()
new, n = re.subn(r"const DEMO_MP3 = '[^']*';",
                 "const DEMO_MP3 = '" + b64 + "';", src, count=1)
if n != 1:
    sys.exit("could not find DEMO_MP3 in app.js")
APP.write_text(new)
print("  %s  %,d bytes  ->  %d chars of base64 written into app.js"
      .replace("%,d", "{:,}".format(MP3.stat().st_size)) % (MP3.name, len(b64)))
