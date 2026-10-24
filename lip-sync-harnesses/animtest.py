#!/usr/bin/env python3
"""Animated GIF and APNG as layers.

   The claim is not "it decoded" but "the picture on the stage changes as the
   clip plays, and changes the same way twice". So this reads the stage's own
   pixels at several frame indices, and then reads them again to prove the
   answer is a function of the frame and not of the clock.

       python3 animtest.py
"""
import pathlib, sys
from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).parent
OUT = HERE / "shots"
OUT.mkdir(exist_ok=True)
URL = (HERE / "lip-sync-generator.html").resolve().as_uri()
VOICE = HERE / "speech.wav"
GIF = HERE / "fixtures" / "anim.gif"
APNG = HERE / "fixtures" / "anim.png"

fails = []


def check(cond, msg):
    if not cond:
        fails.append(msg)
        print("  FAIL  " + msg)
    else:
        print("  ok    " + msg)


# Render an EXACT frame through the compositor, rather than seeking the preview
# to it. seekTo lands on the nearest frame its own way — asking for 2, 4, 6, 8
# gave back 1, 3, 6, 7 — so a seek-based check is really testing the scrubber.
# This is also the path every export uses, so it tests the thing that ships.
SHOT = """(f) => {
  const W = 220, H = 220;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  compositeLayers(x, W, H, {frame: f, pose: poseAt(f)});
  return c.toDataURL('image/png');
}"""


def load(pg, path):
    pg.set_input_files("#layerImageInput", str(path))
    pg.wait_for_timeout(2500)


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
        pg.wait_for_timeout(9000)
        pg.click("#tabBtn-inputs")
        pg.wait_for_timeout(400)

        for name, path in (("GIF", GIF), ("animated PNG", APNG)):
            print("\n--- %s ---" % name)
            load(pg, path)
            a = pg.evaluate("""() => {
              const L = layers.filter(x => x.kind === 'image').pop();
              return L.anim ? {frames: L.anim.frames.length, w: L.anim.w, h: L.anim.h,
                               total: +L.anim.total.toFixed(3), loop: L.animLoop,
                               delays: L.anim.frames.map(f => +f.delay.toFixed(3))}
                            : null;
            }""")
            print("   decoded:", a)
            check(a is not None, "%s decoded as an animation" % name)
            if not a:
                continue
            check(a["frames"] == 6, "six frames (%s)" % a["frames"])
            check((a["w"], a["h"]) == (64, 64), "at 64x64 (%r)" % ((a["w"], a["h"]),))
            check(abs(a["total"] - 0.72) < 0.05,
                  "and 0.72s all told (%.3f)" % a["total"])
            check(all(abs(d - 0.12) < 0.02 for d in a["delays"]),
                  "each frame 120ms (%r)" % a["delays"])

            # Blow it up so a 64px animation is unmissable on the stage, and
            # put it somewhere the mouth is not.
            pg.evaluate("""() => {
              const L = layers.filter(x => x.kind === 'image').pop();
              selectLayer(L.id); L.pose.size = 0.9; L.pose.x = 0.5; L.pose.y = 0.35;
              bankLayers(); drawStage();
            }""")
            pg.wait_for_timeout(300)

            print("   the picture moves as the clip does")
            shots = [pg.evaluate(SHOT, f) for f in (0, 2, 4, 6, 8)]
            distinct = len(set(shots))
            check(distinct >= 4,
                  "five frame indices gave %d different pictures" % distinct)

            print("   and it is the same picture twice")
            again = [pg.evaluate(SHOT, f) for f in (0, 2, 4, 6, 8)]
            check(shots == again,
                  "re-reading the same indices gave the same pictures")
            back = [pg.evaluate(SHOT, f) for f in (8, 6, 4, 2, 0)]
            check(back == list(reversed(shots)),
                  "and scrubbing backwards agrees with scrubbing forwards")

            print("   the loop modes do different things")
            far = int(pg.evaluate("() => Math.round(state.fps * 2.0)"))
            looped = pg.evaluate(SHOT, far)
            pg.evaluate("""() => {
              const L = layers.filter(x => x.kind === 'image').pop();
              L.animLoop = 'once'; bankLayers();
            }""")
            once = pg.evaluate(SHOT, far)
            last = pg.evaluate(SHOT, 10000)
            check(once != looped,
                  "'play once' holds somewhere 'repeat' does not")
            check(once == last,
                  "and holds the last frame however far past the end you go")
            pg.evaluate("""() => {
              const L = layers.filter(x => x.kind === 'image').pop();
              L.animLoop = 'boomerang'; bankLayers();
            }""")
            # Over a RUN of frames, not one: repeat and back-and-forth land on
            # the same picture at plenty of individual moments, and a one-frame
            # comparison makes that look like a bug.
            def run_of(n=14):
                return [pg.evaluate(SHOT, far + k) for k in range(n)]
            boom = run_of()
            pg.evaluate("""() => {
              const L = layers.filter(x => x.kind === 'image').pop();
              L.animLoop = 'loop'; bankLayers();
            }""")
            rep = run_of()
            check(boom != rep,
                  "and 'back and forth' runs differently from 'repeat'")

            print("   speed changes what lands on a frame")
            pg.evaluate("""() => {
              const L = layers.filter(x => x.kind === 'image').pop();
              L.animLoop = 'loop'; L.animSpeed = 0.25; bankLayers();
            }""")
            slow = [pg.evaluate(SHOT, k) for k in range(10)]
            pg.evaluate("""() => {
              const L = layers.filter(x => x.kind === 'image').pop();
              L.animSpeed = 3; bankLayers();
            }""")
            quick = [pg.evaluate(SHOT, k) for k in range(10)]
            check(slow != quick, "quarter speed and triple speed run differently")
            check(len(set(slow)) < len(set(quick)),
                  "and the slow one changes less often (%d vs %d distinct)"
                  % (len(set(slow)), len(set(quick))))
            pg.evaluate("""() => {
              const L = layers.filter(x => x.kind === 'image').pop();
              L.animSpeed = 1; L.animLoop = 'loop'; bankLayers(); drawStage();
            }""")
            pg.locator("#stageWrap").screenshot(
                path=str(OUT / ("anim-%s.png" % name.split()[-1].lower())))
            # Clear it before the next format, so the two never overlap.
            pg.evaluate("""() => {
              const L = layers.filter(x => x.kind === 'image').pop();
              deleteLayer(L.id);
            }""")
            pg.wait_for_timeout(400)

        print("\n--- a still picture is still a still ---")
        load(pg, HERE / "fixtures" / "puppet-padded-alpha.png")
        still = pg.evaluate("""() => {
          const L = layers.filter(x => x.kind === 'image').pop();
          return {anim: !!L.anim, drew: !!L.img};
        }""")
        check(still["anim"] is False, "an ordinary PNG gets no animation")
        check(still["drew"], "and still draws")
        rows = pg.evaluate("""() => {
          const L = layers.filter(x => x.kind === 'image').pop();
          layerEditorId = L.id; selectLayer(L.id); renderLayerPanel();
          return [...document.querySelectorAll('#layerEdit .lfield > span')]
                 .map(e => e.textContent);
        }""")
        print("   still's settings:", rows)
        check("Loop" not in rows, "and is offered no loop controls (%r)" % rows)

        check(not errs, "no page errors (%r)" % (errs[:4],))
        b.close()


run()
print()
if fails:
    print("%d failed:" % len(fails))
    for f in fails:
        print("  - " + f)
    sys.exit(1)
print("animated layers play, and play the same way twice")
