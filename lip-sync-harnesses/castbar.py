#!/usr/bin/env python3
"""Clicking a face in "Who says this line?" must put that character on the
   clip you are looking at.

   The report: "I managed to get two different characters assigned to the first
   two clips, but can't seem to add another character to the third clip. I
   click on the face, but it does not switch to it." Two rows of faces that
   look identical meant two different things — the puppet row switched the
   open clip, the cast row only ticked a name into a running order. So every
   check here reads the CLIP's record and the stage after a click on the cast
   row, not whether a function ran.

       python3 castbar.py
"""
import pathlib, sys
from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).parent
OUT = HERE / "shots"
OUT.mkdir(exist_ok=True)
URL = (HERE / "lip-sync-generator.html").resolve().as_uri()
VOICE = HERE / "trim-marks.wav"

fails = []


def check(cond, msg):
    if not cond:
        fails.append(msg)
        print("  FAIL  " + msg)
    else:
        print("  ok    " + msg)


CAST = """() => queue.clips.map(c => c.cast)"""


def chip(pg, n):
    """The nth chip in the cast row, as a person would click it."""
    pg.locator("#castPick button").nth(n).click()
    pg.wait_for_timeout(700)


def run():
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        pg = b.new_page(viewport={"width": 1440, "height": 1100})
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda m: m.type == "error" and errs.append(m.text))
        pg.goto(URL)
        pg.wait_for_timeout(900)
        pg.set_input_files("#fileInput", str(VOICE))
        pg.wait_for_timeout(10000)

        print("\n1. a take split into three lines")
        n = pg.evaluate("""() => {
          const c = activeClip();
          return splitClipAt(c, silenceCuts(0.25));
        }""")
        pg.wait_for_timeout(8000)
        clips = pg.evaluate("() => queue.clips.length")
        print("   clips:", clips)
        check(clips >= 3, "three or more clips to cast (%d)" % clips)
        check(not pg.is_hidden("#castBar"), "and the cast bar is showing")
        pg.locator("#castBar").screenshot(path=str(OUT / "castbar-empty.png"))
        check("Click a face" in pg.text_content("#castHint"),
              "saying what a face does before anyone has clicked one")

        print("\n2. clicking a face puts that character on the clip that is open")
        pg.evaluate("() => openClip(queue.clips[0].id)")
        pg.wait_for_timeout(9000)
        chip(pg, 0)
        got = pg.evaluate(CAST)
        print("   cast:", got)
        check(got[0] is not None, "clip 1 took the first face (%r)" % (got[0],))
        check(got[1] is None and got[2] is None,
              "and only that clip changed (%r)" % (got,))
        check(pg.evaluate("() => activeShelfId()") == got[0],
              "the stage is showing them too")

        print("\n3. a different face on the second clip")
        pg.evaluate("() => openClip(queue.clips[1].id)")
        pg.wait_for_timeout(9000)
        chip(pg, 1)
        got = pg.evaluate(CAST)
        print("   cast:", got)
        check(got[1] is not None and got[1] != got[0],
              "clip 2 has somebody else (%r)" % (got,))

        print("\n4. and a THIRD character on the third clip — the report")
        pg.evaluate("() => openClip(queue.clips[2].id)")
        pg.wait_for_timeout(9000)
        chip(pg, 2)
        got = pg.evaluate(CAST)
        print("   cast:", got)
        check(got[2] is not None, "clip 3 took a face at all (%r)" % (got,))
        check(got[2] not in (got[0], got[1]),
              "and it is a third character, not one of the first two (%r)" % (got,))
        check(pg.evaluate("() => activeShelfId()") == got[2],
              "the stage switched to them when clicked")
        shelf = pg.evaluate("""() => {
          const b = [...document.querySelectorAll('#castPick button')];
          return b.map(x => x.getAttribute('aria-pressed'));
        }""")
        print("   pressed:", shelf)
        check(shelf.count("true") == 1,
              "exactly one chip reads as the one in use (%r)" % (shelf,))

        print("\n5. the queue rows show who is on each line")
        rows = pg.eval_on_selector_all(".qrow .qcast", "els => els.length")
        check(rows >= 3, "every cast line carries its face (%d)" % rows)

        print("\n6. a line batch export has refused can still be cast")
        # The reported clip carried the red dot — too long for batch mode. That
        # is a complaint about exporting it in a queue, and it must not quietly
        # make the line uncastable.
        pg.evaluate("() => { queue.clips[2].error = 'too long'; renderQueue(); }")
        pg.wait_for_timeout(400)
        chip(pg, 0)
        got = pg.evaluate(CAST)
        print("   cast:", got)
        check(got[2] == got[0], "the marked line took the face anyway (%r)" % (got,))
        pg.evaluate("() => { queue.clips[2].error = null; renderQueue(); }")
        chip(pg, 2)

        print("\n7. the running order comes off the clips, not off a ticked list")
        # Uncast the last line and leave two characters on the first two. The
        # order the button deals must be read back from the queue.
        two = pg.evaluate("""() => {
          queue.clips[2].cast = null;
          renderQueue();
          return castRunningOrder();
        }""")
        print("   order:", two)
        check(len(two) == 2, "two in the scene (%r)" % (two,))
        check(pg.text_content("#castDeal").strip() == "Deal in turn",
              "and the button offers to deal them")

        print("\n8. dealing fills the rest, in that order")
        pg.click("#castDeal")
        pg.wait_for_timeout(3000)
        got = pg.evaluate(CAST)
        print("   dealt:", got)
        check(got == [two[i % 2] for i in range(len(got))],
              "every line alternates between the two (%r)" % (got,))
        check(all(pg.evaluate("() => queue.clips.map(c => !!(c.puppet && c.puppet.file))")),
              "and each has a real puppet file on it")
        ring = pg.evaluate("""() => {
          const b = [...document.querySelectorAll('#castPick button')]
            .find(x => x.getAttribute('aria-pressed') === 'true');
          return {ring: b ? b.dataset.cast : null, open: activeClip().cast,
                  head: activeShelfId()};
        }""")
        print("   ring:", ring)
        check(ring["ring"] == ring["open"] == ring["head"],
              "the ring, the record and the stage all name the same character (%r)" % (ring,))

        pg.locator("#castBar").screenshot(path=str(OUT / "castbar.png"))
        pg.screenshot(path=str(OUT / "castbar-full.png"))
        check(not errs, "no page errors (%r)" % (errs[:4],))
        b.close()


run()
print()
if fails:
    print("%d failed:" % len(fails))
    for f in fails:
        print("  - " + f)
    sys.exit(1)
print("clicking a face casts the open clip")
