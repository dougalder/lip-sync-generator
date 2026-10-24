#!/usr/bin/env python3
"""The sound in an exported movie has to be the clip's own, and its own length.

   Reported as "seems to have done the first clip and then left the rest
   blank": a movie whose picture stops partway and goes black for the rest.
   That is what you get when the picture is the clip and the sound track is the
   WHOLE source file — a movie lasts as long as its longest track, so the
   player runs on past the end of the picture, and on a split line the voice is
   the wrong line's as well.

   Headless Chromium has no AAC decoder, so a real H.264+AAC file cannot be
   loaded here (fixtures/talk-aac.mp4 is kept for a hand check in Safari). What
   this harness does instead is hand the app a copied track of exactly the
   shape the demuxer produces — 1024-sample frames spanning the whole file —
   and then measure, in seconds, what each clip's export is about to write.
   That is the claim that failed: the length of the track against the length of
   the clip.

       python3 audiolen.py
"""
import pathlib, sys
from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).parent
URL = (HERE / "lip-sync-generator.html").resolve().as_uri()
VOICE = HERE / "trim-marks.wav"

fails = []


def check(cond, msg):
    if not cond:
        fails.append(msg)
        print("  FAIL  " + msg)
    else:
        print("  ok    " + msg)


# A copied track exactly as Demux.passthrough builds one: whole-file AAC frames
# of 1024 samples, with the encoder's priming offset on the front.
FAKE = """() => {
  const sr = 44100, per = 1024;
  const n = Math.ceil(state.srcBuffer.duration * sr / per);
  state.srcAudio = {
    sampleRate: sr, channels: 1, description: new Uint8Array([1, 2]),
    samples: Array.from({length: n}, (_, i) =>
      ({data: new Uint8Array([i & 255]), duration: per})),
    editStart: 1024, bitrate: 128000, source: 'copied'
  };
  return +(n * per / sr).toFixed(3);
}"""

TRACK = """async () => {
  const t = await audioTrackFor(() => {});
  if (!t) return null;
  return {source: t.source,
          secs: +(t.samples.reduce((n, s) => n + (s.duration || 0), 0) / t.sampleRate).toFixed(3),
          first: t.samples[0].data[0], frames: t.samples.length};
}"""


def run():
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        pg = b.new_page(viewport={"width": 1440, "height": 1000})
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda m: m.type == "error" and errs.append(m.text))
        pg.goto(URL)
        pg.wait_for_timeout(900)
        pg.set_input_files("#fileInput", str(VOICE))
        pg.wait_for_timeout(10000)

        print("\n1. a file opened on its own copies its track whole")
        whole = pg.evaluate(FAKE)
        dur = pg.evaluate("() => +state.buffer.duration.toFixed(3)")
        print("   file runs %.3fs · fake copied track %.3fs" % (dur, whole))
        got = pg.evaluate(TRACK)
        print("   track:", got)
        check(got and got["source"] == "copied", "it is the copy, untouched (%r)" % (got,))
        check(abs(got["secs"] - dur) < 0.2,
              "and it is the clip's length (%.3fs vs %.3fs)" % (got["secs"], dur))
        plan = pg.evaluate("() => audioPlan()")
        check(plan["kind"] == "copy", "the card says copied (%r)" % (plan,))

        print("\n2. cut the take into lines")
        pg.evaluate("() => splitClipAt(activeClip(), silenceCuts(0.25))")
        pg.wait_for_timeout(8000)
        clips = pg.evaluate("""() => queue.clips.map(c =>
          ({in: +(c.in||0).toFixed(2), out: +(c.out||0).toFixed(2)}))""")
        print("   clips:", clips)
        check(len(clips) >= 2, "more than one line (%d)" % len(clips))

        print("\n3. a later line gets ITS seconds, not the file's")
        pg.evaluate("() => openClip(queue.clips[1].id, {force: true})")
        pg.wait_for_timeout(9000)
        pg.evaluate(FAKE)
        dur = pg.evaluate("() => +state.buffer.duration.toFixed(3)")
        got = pg.evaluate(TRACK)
        print("   clip runs %.3fs · track %r" % (dur, got))
        check(got is not None, "there is a track to write")
        check(abs(got["secs"] - dur) < 0.05,
              "the track is the clip's length, not the file's (%.3fs vs %.3fs, file %.3fs)"
              % (got["secs"], dur, whole))
        check(got["source"] == "trimmed", "and it says it was cut (%r)" % (got["source"],))
        # Taken from the right PLACE as well as the right length: frame 0 of a
        # line that starts partway in is not frame 0 of the file.
        at = pg.evaluate("() => queue.clips[1].in")
        want = int(round(at * 44100 / 1024)) & 255
        check(abs(got["first"] - want) <= 1,
              "and from the right place in the file (frame %d, wanted about %d)"
              % (got["first"], want))
        plan = pg.evaluate("() => audioPlan()")
        print("   plan:", plan)
        check(plan["kind"] == "cut", "the card says it will be cut (%r)" % (plan,))
        check("clip" in plan["label"], "in words (%r)" % (plan["label"],))

        print("\n4. the trim handles move the sound too")
        pg.evaluate("""async () => {
          const c = queue.clips[0];
          c.in = 0.5; c.out = 1.3;
          await openClip(c.id, {force: true});
        }""")
        pg.wait_for_timeout(9000)
        pg.evaluate(FAKE)
        dur = pg.evaluate("() => +state.buffer.duration.toFixed(3)")
        got = pg.evaluate(TRACK)
        print("   trimmed to %.3fs · track %r" % (dur, got))
        check(abs(got["secs"] - dur) < 0.05,
              "the handles cut the sound as well (%.3fs vs %.3fs)" % (got["secs"], dur))

        print("\n5. an export never writes more sound than picture")
        # The whole point, said once more as the thing the user sees: the movie
        # cannot outlast its own pictures.
        over = pg.evaluate("""async () => {
          const t = await audioTrackFor(() => {});
          const secs = t.samples.reduce((n, s) => n + (s.duration||0), 0) / t.sampleRate;
          return +(secs - state.buffer.duration).toFixed(3);
        }""")
        print("   sound minus picture: %+.3fs" % over)
        check(over <= 0.05, "no black tail (%+.3fs)" % over)

        check(not errs, "no page errors (%r)" % (errs[:4],))
        b.close()


run()
print()
if fails:
    print("%d failed:" % len(fails))
    for f in fails:
        print("  - " + f)
    sys.exit(1)
print("an exported movie's sound is the clip's own, and its own length")
