#!/usr/bin/env python3
"""Play all: every line in order, through the preview, without being asked
   again between them.

   The claim is not "a button exists". It is that pressing it once walks the
   queue — the open clip moves on by itself when a line reaches its out point —
   that pressing it again stops where it is, and that the lines of a split take
   now open from one decode rather than one apiece.

       python3 playall.py
"""
import pathlib, sys, time
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


def openIndex(pg):
    return pg.evaluate("() => queue.clips.findIndex(c => c.id === queue.activeId)")


def run():
    with sync_playwright() as pw:
        b = pw.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
        pg = b.new_page(viewport={"width": 1440, "height": 1000})
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda m: m.type == "error" and errs.append(m.text))
        pg.goto(URL)
        pg.wait_for_timeout(900)
        pg.set_input_files("#fileInput", str(VOICE))
        pg.wait_for_timeout(10000)

        print("\n1. one clip is not a conversation")
        check(pg.is_hidden("#playAllBtn"), "nothing to play through yet, so no button")

        print("\n2. cut it into lines")
        pg.evaluate("() => splitClipAt(activeClip(), silenceCuts(0.25))")
        pg.wait_for_timeout(8000)
        n = pg.evaluate("() => queue.clips.length")
        print("   clips:", n)
        check(n >= 3, "three lines (%d)" % n)
        check(not pg.is_hidden("#playAllBtn"), "and the button is offered")
        check(pg.text_content("#playAllBtn").strip() == "Play all", "reading Play all")

        print("\n3. opening a sibling line costs one decode, not another read")
        # The whole take is decoded once; a line of it is a slice.
        pg.evaluate("() => openClip(queue.clips[0].id, {force: true})")
        pg.wait_for_timeout(9000)
        t0 = time.time()
        pg.evaluate("() => openClip(queue.clips[2].id, {force: true})")
        pg.wait_for_function("() => queue.activeId === queue.clips[2].id && !!state.buffer",
                             timeout=30000)
        warm = time.time() - t0
        print("   opened the third line in %.2fs" % warm)
        cached = pg.evaluate("() => srcCache.file === queue.clips[0].file")
        check(cached, "the take is held decoded, not read again")
        check(warm < 6, "and a line opens briskly (%.2fs)" % warm)

        print("\n4. press it once and it walks the queue")
        pg.evaluate("() => openClip(queue.clips[0].id, {force: true})")
        pg.wait_for_timeout(9000)
        pg.click("#playAllBtn")
        pg.wait_for_timeout(600)
        check(pg.evaluate("() => playAll.on"), "it is running")
        check(pg.text_content("#playAllBtn").strip() == "Stop", "and the button says Stop")
        seen = set()
        deadline = time.time() + 60
        while time.time() < deadline:
            i = openIndex(pg)
            if i >= 0:
                seen.add(i)
            if not pg.evaluate("() => playAll.on"):
                break
            pg.wait_for_timeout(250)
        print("   lines it visited:", sorted(seen))
        check(len(seen) >= 3, "it moved on by itself through every line (%r)" % sorted(seen))
        check(not pg.evaluate("() => playAll.on"), "and it stopped at the end")
        check(pg.text_content("#playAllBtn").strip() == "Play all",
              "with the button back to Play all")

        print("\n5. pressing it again stops where it is")
        pg.evaluate("() => openClip(queue.clips[0].id, {force: true})")
        pg.wait_for_timeout(9000)
        pg.click("#playAllBtn")
        pg.wait_for_timeout(1200)
        pg.click("#playAllBtn")
        pg.wait_for_timeout(600)
        check(not pg.evaluate("() => playAll.on"), "stopped")
        check(pg.evaluate("() => !playing && player.paused"), "and the sound stopped with it")

        print("\n6. taking the transport back ends the run")
        pg.click("#playAllBtn")
        pg.wait_for_timeout(1200)
        pg.click("#stopBtn")
        pg.wait_for_timeout(400)
        check(not pg.evaluate("() => playAll.on"),
              "pressing stop is 'I will drive now'")

        print("\n7. a loop would never end, so it is put aside and given back")
        pg.evaluate("() => setLooping(true)")
        pg.click("#playAllBtn")
        pg.wait_for_timeout(900)
        check(not pg.evaluate("() => looping"), "the loop is off while it plays through")
        pg.click("#playAllBtn")
        pg.wait_for_timeout(500)
        check(pg.evaluate("() => looping"), "and back on when it is done")
        pg.evaluate("() => setLooping(false)")

        pg.locator(".qhead").screenshot(path=str(OUT / "playall-head.png"))
        check(not errs, "no page errors (%r)" % (errs[:4],))
        b.close()


run()
print()
if fails:
    print("%d failed:" % len(fails))
    for f in fails:
        print("  - " + f)
    sys.exit(1)
print("one press plays the whole conversation")
