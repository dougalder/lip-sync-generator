#!/usr/bin/env python3
"""A two-hander: split a take on its pauses, deal two characters round the
   lines, and check that each line really is wearing its own.

   The thing being guarded here is that casting writes to the clip RECORDS and
   that opening a clip puts the record back on the stage. Those are two halves
   of one claim and a test of either alone passes while the app is broken — so
   this reads the records AND then opens two clips and reads what is live.

       python3 convtest.py
"""
import pathlib, sys
from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).parent
OUT = HERE / "shots"
OUT.mkdir(exist_ok=True)
URL = (HERE / "lip-sync-generator.html").resolve().as_uri()
VOICE = HERE / "trim-marks.wav"      # the one with real pauses in it

fails = []


def check(cond, msg):
    if not cond:
        fails.append(msg)
        print("  FAIL  " + msg)
    else:
        print("  ok    " + msg)


def tap(pg, sel):
    pg.locator(sel).locator("visible=true").first.click()


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

        print("\n1. set the scene up once, before cutting it")
        tap(pg, '.facepick button[data-shelf="drawn:man"]')
        pg.wait_for_timeout(1200)
        pg.evaluate("() => { addTextLayer && addTextLayer(); }")
        pg.wait_for_timeout(300)
        before = pg.evaluate("""() => ({
          head: activeShelfId(), layers: layers.length, style: state.style })""")
        print("   before:", before)
        check(before["head"] == "drawn:man", "the man is on, with a caption layer")

        print("\n2. cut it on the pauses")
        n = pg.evaluate("""() => {
          const c = activeClip();
          const cuts = silenceCuts(0.25);
          return splitClipAt(c, cuts);
        }""")
        pg.wait_for_timeout(2500)
        print("   pieces:", n)
        check(n >= 2, "the take cut into at least two lines (%s)" % n)

        print("\n3. every piece came out of the cut already dressed")
        kept = pg.evaluate("""() => queue.clips.map(c => ({
          puppet: !!(c.puppet && c.puppet.file),
          layers: c.layers ? c.layers.length : null,
          style: c.style }))""")
        print("   pieces:", kept)
        check(all(k["puppet"] for k in kept),
              "each piece kept the puppet (was: none of them did)")
        check(all(k["layers"] and k["layers"] >= 3 for k in kept),
              "and the layer stack (%r)" % [k["layers"] for k in kept])

        print("\n4. deal two characters round the lines")
        # The running order is read off the clips, so casting is what seeds it:
        # put the two of them on the first two lines, as clicking their faces
        # with those lines open does.
        pg.evaluate("""async () => {
          // A split carries the parent's character onto every piece, so the
          // lines past the two being cast are put back to nobody — which is
          // what they are when a take is cut up before anyone is chosen.
          queue.clips.forEach(c => { c.cast = null; });
          await castOnto(queue.clips[0], 'drawn:woman');
          await castOnto(queue.clips[1], 'drawn:older');
          const open = activeClip();
          if (open) { applyClipSettings(open); sizeStage(); drawStage(); }
          renderQueue();
        }""")
        pg.wait_for_timeout(600)
        check(not pg.is_hidden("#castBar"), "the cast bar is showing now there is a queue")
        tap(pg, "#castDeal")
        pg.wait_for_timeout(3500)

        cast = pg.evaluate("""() => queue.clips.map(c => ({
          cast: c.cast, name: c.puppet && c.puppet.file && c.puppet.file.name,
          style: c.style, size: +c.overlay.size.toFixed(4) }))""")
        for i, c in enumerate(cast):
            print("   %d. %s  %s  %s" % (i + 1, c["cast"], c["style"], c["name"]))
        want = ["drawn:woman", "drawn:older"]
        check([c["cast"] for c in cast] == [want[i % 2] for i in range(len(cast))],
              "they alternate, in the order their first lines come up")
        check(all(c["name"] for c in cast),
              "every line has a real puppet file on it")
        check(cast[0]["style"] != cast[1]["style"],
              "and the two speakers have different lips (%s vs %s)"
              % (cast[0]["style"], cast[1]["style"]))

        print("\n5. opening a line puts its character on the stage")
        pg.evaluate("() => openClip(queue.clips[0].id, {force: true})")
        pg.wait_for_timeout(4000)
        one = pg.evaluate("() => ({head: activeShelfId(), style: state.style})")
        print("   clip 1 live:", one)
        check(one["head"] == "drawn:woman",
              "clip 1 is wearing the woman (%s)" % one["head"])
        pg.locator("#stageWrap").screenshot(path=str(OUT / "conv-clip1.png"))

        pg.evaluate("() => openClip(queue.clips[1].id, {force: true})")
        pg.wait_for_timeout(4000)
        two = pg.evaluate("() => ({head: activeShelfId(), style: state.style})")
        print("   clip 2 live:", two)
        check(two["head"] == "drawn:older",
              "clip 2 is wearing the older person (%s)" % two["head"])
        check(one["style"] != two["style"], "and they are not sharing a mouth")
        pg.locator("#stageWrap").screenshot(path=str(OUT / "conv-clip2.png"))

        check(not errs, "no page errors (%r)" % (errs[:4],))
        b.close()


run()
print()
if fails:
    print("%d failed:" % len(fails))
    for f in fails:
        print("  - " + f)
    sys.exit(1)
print("a split conversation casts, and each line wears its own character")
