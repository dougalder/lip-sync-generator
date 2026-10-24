#!/usr/bin/env python3
"""A puppet arrives at the size of the frame it lands on, and the frame stays.

   Three things reported together after setting a clip to 1920×1080 and cutting
   it up:

   1. "each puppet I assign comes in large" — a puppet's size is its width as a
      fraction of the frame, and it arrived at 1, which is right only while the
      frame IS the puppet. A 900×1200 face on a 16:9 frame came in 1920 wide
      and 2560 tall.
   2. "if I deleted the audio track, it drops the puppet, but left the lips on
      the stage" — the mouth is a layer, and nothing was clearing the stack.
   3. "once the format is set, it should not default back to Match the puppet"
      — a clip with no canvas of its own fell back to match-the-puppet, so
      every new clip threw the chosen format away.

       python3 canvasfit.py
"""
import pathlib, sys
from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).parent
OUT = HERE / "shots"
OUT.mkdir(exist_ok=True)
URL = (HERE / "lip-sync-generator.html").resolve().as_uri()
VOICE = HERE / "trim-marks.wav"
TALL = HERE / "fixtures" / "puppet-padded.png"

fails = []


def check(cond, msg):
    if not cond:
        fails.append(msg)
        print("  FAIL  " + msg)
    else:
        print("  ok    " + msg)


def frame_box(pg):
    """Where the puppet actually lands, in fractions of the frame."""
    return pg.evaluate("""() => {
      const f = frameSize(), pz = plateSize();
      if (!pz) return null;
      const w = puppetPose.size;                       // of the frame's width
      const h = w * (f.w / f.h) * (pz.h / pz.w);       // of the frame's height
      return {w: +w.toFixed(4), h: +h.toFixed(4), pic: pz, frame: f};
    }""")


def run():
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        pg = b.new_context(viewport={"width": 1500, "height": 1080}).new_page()
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda m: m.type == "error" and errs.append(m.text))
        pg.goto(URL)
        pg.wait_for_timeout(900)
        pg.set_input_files("#fileInput", str(VOICE))
        pg.wait_for_function("() => state.frames.length > 0", timeout=120000)
        pg.wait_for_timeout(1200)

        print("\n1. matching the puppet, a puppet still fills the frame")
        pg.evaluate("() => useFace('woman')")
        pg.wait_for_timeout(2400)
        box = frame_box(pg)
        print("   ", box)
        check(abs(box["w"] - 1) < 1e-6 and abs(box["h"] - 1) < 1e-3,
              "it is the whole frame, as it always was (%r)" % (box,))

        print("\n2. set the frame to 16:9 and the next puppet fits it")
        pg.select_option("#canvasPreset", "1920x1080")
        pg.wait_for_timeout(500)
        pg.evaluate("() => { forgetPuppet(); }")
        pg.wait_for_timeout(600)
        pg.evaluate("() => useFace('older')")
        pg.wait_for_timeout(2400)
        box = frame_box(pg)
        print("   ", box)
        check(box["h"] <= 1.001,
              "the puppet is inside the frame top to bottom (%.3f)" % box["h"])
        check(box["h"] > 0.95,
              "and fills it, rather than sitting small in the middle (%.3f)" % box["h"])
        check(box["w"] < 0.9, "which on a 16:9 frame means it is not full width "
                              "(%.3f)" % box["w"])
        note = pg.text_content("#canvasNote") or ""
        print("   canvas note:", note.strip())
        check("off the edge" not in note,
              "nothing is reported off the edge (%r)" % note.strip())

        print("\n3. and the mouth lands on the face, not in the middle of the frame")
        m = pg.evaluate("() => ({x: +overlay.x.toFixed(3), y: +overlay.y.toFixed(3),"
                        " size: +overlay.size.toFixed(4)})")
        print("   mouth:", m)
        check(m["size"] < 0.2,
              "the mouth came in scaled with the puppet (%r)" % m["size"])
        # The mouth has to be inside the puppet's own box, which is what
        # "on the face" means when the puppet no longer fills the frame.
        inside = pg.evaluate("""() => {
          const f = frameSize(), pz = plateSize();
          const pw = puppetPose.size, ph = pw * (f.w / f.h) * (pz.h / pz.w);
          return overlay.x > 0.5 - pw / 2 && overlay.x < 0.5 + pw / 2 &&
                 overlay.y > 0.5 - ph / 2 && overlay.y < 0.5 + ph / 2;
        }""")
        check(inside, "and it is inside the puppet's own box")
        pg.locator("#stageWrap").screenshot(path=str(OUT / "canvasfit-169.png"))

        print("\n4. a picture imported from a file is measured the same way")
        pg.evaluate("() => forgetPuppet()")
        pg.wait_for_timeout(500)
        pg.set_input_files("#puppetInput", str(TALL))
        pg.wait_for_timeout(2400)
        box = frame_box(pg)
        print("   ", box)
        check(box["h"] <= 1.001,
              "an imported puppet fits the frame too (%.3f high)" % box["h"])

        print("\n5. a split carries the frame to every piece")
        pg.evaluate("() => { seekTo(3.0); splitAtPlayhead(); }")
        pg.wait_for_function("() => queue.clips.length === 2", timeout=120000)
        pg.wait_for_timeout(3000)
        pg.evaluate("() => openClip(fileFamily(activeClip())[1].id)")
        pg.wait_for_function("() => state.frames.length > 0", timeout=120000)
        pg.wait_for_timeout(2500)
        cv = pg.evaluate("() => ({...canvasSetting})")
        print("   piece 2:", cv)
        check(cv["mode"] == "fixed" and cv["w"] == 1920,
              "the second piece is 16:9 as well (%r)" % (cv,))
        pg.evaluate("() => useFace('child')")
        pg.wait_for_timeout(2400)
        box = frame_box(pg)
        check(box["h"] <= 1.001,
              "and a puppet assigned to it arrives the right size (%.3f)" % box["h"])

        print("\n6. clearing the audio clears the stage with it")
        pg.evaluate("() => clearQueue()")
        pg.wait_for_timeout(1500)
        st = pg.evaluate("""() => ({
          layers: layers.length, puppet: puppet.kind,
          canvas: {...canvasSetting},
          pick: document.getElementById('canvasPreset').value
        })""")
        print("   ", st)
        check(st["puppet"] is None, "the puppet went")
        check(st["layers"] == 0, "and the lips went with it (%d layers)" % st["layers"])
        pg.locator(".stage-panel").screenshot(path=str(OUT / "canvasfit-cleared.png"))

        print("\n7. but the format did not")
        check(st["canvas"]["mode"] == "fixed" and st["canvas"]["w"] == 1920,
              "the canvas is still 1920×1080 (%r)" % (st["canvas"],))
        check(st["pick"] == "1920x1080",
              "and the control still says so (%r)" % st["pick"])
        pg.set_input_files("#fileInput", str(HERE / "speech.wav"))
        pg.wait_for_function("() => state.frames.length > 0", timeout=120000)
        pg.wait_for_timeout(1500)
        after = pg.evaluate("""() => ({canvas: {...canvasSetting},
          pick: document.getElementById('canvasPreset').value})""")
        print("   after loading another track:", after)
        check(after["canvas"]["mode"] == "fixed" and after["canvas"]["w"] == 1920,
              "a new track keeps the chosen format (%r)" % (after["canvas"],))
        check(after["pick"] == "1920x1080", "and so does the control")

        check(not errs, "no page errors (%r)" % (errs[:4],))
        b.close()


run()
print()
if fails:
    print("%d failed:" % len(fails))
    for f in fails:
        print("  - " + f)
    sys.exit(1)
print("puppets arrive at the frame's size, and the frame outlives the audio")
