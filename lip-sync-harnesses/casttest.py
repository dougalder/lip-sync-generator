#!/usr/bin/env python3
"""The cast: a head is a character, and switching heads does not cost you the
   lips you chose or the size you set.

   Every check here is a claim about state the user can SEE, so each one reads
   it back out of the live page rather than trusting that a function was
   called. The screenshots are left in shots/ so "technically correct and
   visibly wrong" has somewhere to show itself.

       python3 casttest.py
"""
import pathlib, sys
from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).parent
OUT = HERE / "shots"
OUT.mkdir(exist_ok=True)
URL = (HERE / "lip-sync-generator.html").resolve().as_uri()
VOICE = HERE / "speech.wav"
PUP = HERE / "fixtures" / "puppet-padded-alpha.png"

fails = []

def tap(pg, sel):
    """The chips live in two rows — the invite row and the puppet row — and
       which one is on screen depends on whether there is a puppet yet. Always
       click the one a person could actually click."""
    pg.locator(sel).locator("visible=true").first.click()




def check(cond, msg):
    if not cond:
        fails.append(msg)
        print("  FAIL  " + msg)
    else:
        print("  ok    " + msg)


# What the user would call "my lip settings".
LOOK = """() => ({
  style: state.style,
  setId: (typeof lips !== 'undefined' ? lips.activeId : null),
  size: +overlay.size.toFixed(5),
  x: +overlay.x.toFixed(5), y: +overlay.y.toFixed(5),
  head: activeShelfId(),
  pinned: keepLips
})"""


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

        print("\n1. a drawn face brings its own lips the FIRST time")
        tap(pg, '.facepick button[data-shelf="drawn:man"]')
        pg.wait_for_timeout(900)
        man = pg.evaluate(LOOK)
        print("   man:", man)
        check(man["head"] == "drawn:man", "the man is the head on the stage")
        check(man["style"].startswith("faceman"),
              "and he arrived wearing his own lip style (%s)" % man["style"])

        print("\n2. now make it mine — a different style, a smaller mouth, moved")
        pg.evaluate("""() => {
          state.style = 'squiggle';
          custom.on = false; lips.activeId = null;
          overlay.size = 0.11; overlay.x = 0.42; overlay.y = 0.61;
          buildStyleChips(); buildChart(); drawStage();
        }""")
        pg.wait_for_timeout(400)
        mine = pg.evaluate(LOOK)
        print("   mine:", mine)

        print("\n3. switch to another head and back — mine comes back")
        tap(pg, '.facepick button[data-shelf="drawn:woman"]')
        pg.wait_for_timeout(900)
        woman = pg.evaluate(LOOK)
        print("   woman:", woman)
        check(woman["style"].startswith("facewoman"),
              "the woman, never worn before, brings her own (%s)" % woman["style"])
        tap(pg, '.facepick button[data-shelf="drawn:man"]')
        pg.wait_for_timeout(900)
        back = pg.evaluate(LOOK)
        print("   back:", back)
        check(back["style"] == "squiggle",
              "back on the man, MY style is back (%s)" % back["style"])
        check(abs(back["size"] - 0.11) < 1e-4,
              "and my mouth size (%.3f)" % back["size"])
        check(abs(back["x"] - 0.42) < 1e-4 and abs(back["y"] - 0.61) < 1e-4,
              "and where I put it (%.2f, %.2f)" % (back["x"], back["y"]))

        print("\n4. and the woman kept hers, independently")
        tap(pg, '.facepick button[data-shelf="drawn:woman"]')
        pg.wait_for_timeout(900)
        w2 = pg.evaluate(LOOK)
        check(w2["style"].startswith("facewoman"),
              "the woman still wears her own (%s)" % w2["style"])

        print("\n5. the pin stops a never-worn head suggesting anything")
        pg.evaluate("""() => { state.style = 'squiggle'; custom.on = false;
                               lips.activeId = null; overlay.size = 0.09;
                               buildStyleChips(); drawStage(); }""")
        tap(pg, '.facepick button[data-pin]')
        pg.wait_for_timeout(300)
        check(pg.evaluate("() => keepLips") is True, "the pin is on")
        check(pg.locator('.facepick button[data-pin]').locator('visible=true').first.get_attribute('aria-pressed') == 'true',
              "and says so")
        tap(pg, '.facepick button[data-shelf="drawn:child"]')
        pg.wait_for_timeout(900)
        kid = pg.evaluate(LOOK)
        print("   child:", kid)
        check(kid["head"] == "drawn:child", "the child is on the stage")
        check(kid["style"] == "squiggle",
              "but brought no lips of its own — mine held (%s)" % kid["style"])
        check(abs(kid["size"] - 0.09) < 1e-4,
              "and my size held too (%.3f)" % kid["size"])

        print("\n6. a loaded photograph never suggests lips, pin or no pin")
        tap(pg, '.facepick button[data-pin]')          # pin back off
        pg.wait_for_timeout(200)
        pg.set_input_files("#puppetInput", str(PUP))
        pg.wait_for_timeout(2500)
        photo = pg.evaluate(LOOK)
        print("   photo:", photo)
        check(photo["style"] == "squiggle",
              "the photograph left my style alone (%s)" % photo["style"])

        print("\n7. a placement survives the round trip")
        pg.evaluate("() => { overlay.x = .4; overlay.size = .12; bankLayers(); }")
        tap(pg, '.facepick button[data-shelf="drawn:older"]')
        pg.wait_for_timeout(900)
        check(abs(pg.evaluate("() => overlay.size") - 0.12) > 1e-6,
              "a different head does not inherit another's mouth placement")
        tap(pg, '.facepick button[data-shelf="drawn:child"]')
        pg.wait_for_timeout(900)
        tap(pg, '.facepick button[data-shelf^="f:"]')
        pg.wait_for_timeout(1800)
        got = pg.evaluate(LOOK)
        print("   back to the photo:", got)
        check(abs(got["size"] - 0.12) < 1e-4,
              "and the photo's own mouth placement came back (%r)" % got["size"])

        pg.locator("#stageWrap").screenshot(path=str(OUT / "cast-stage.png"))
        check(not errs, "no page errors (%r)" % (errs[:4],))
        b.close()


run()
print()
if fails:
    print("%d failed:" % len(fails))
    for f in fails:
        print("  - " + f)
    sys.exit(1)
print("a head is a character, and switching keeps what you put on it")
