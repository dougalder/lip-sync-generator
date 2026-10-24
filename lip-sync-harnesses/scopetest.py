#!/usr/bin/env python3
"""One switch at the top of the Export tab: all the clips, or the one open.

   The per-card toggles were there and were not found — so the question is
   asked once, at the top, where the tab starts. The claims are about what the
   buttons below are then about to do, read off the cards themselves.

       python3 scopetest.py
"""
import io, pathlib, sys, zipfile
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


def run():
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        ctx = b.new_context(viewport={"width": 1440, "height": 1100},
                            accept_downloads=True)
        pg = ctx.new_page()
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda m: m.type == "error" and errs.append(m.text))
        pg.goto(URL)
        pg.wait_for_timeout(900)
        pg.set_input_files("#fileInput", str(VOICE))
        pg.wait_for_timeout(10000)

        print("\n1. with one clip there is no question to ask")
        pg.click("#tabBtn-export")
        pg.wait_for_timeout(500)
        check(pg.is_hidden("#batchCard"), "the card stays out of the way")

        print("\n2. split it, and the question is at the top")
        # The face goes on before the cut, so every piece inherits it: a clip
        # with nothing behind the mouth has nothing for the overlay video to
        # burn it onto, and is skipped rather than exported.
        pg.evaluate("() => useFace('woman')")
        pg.wait_for_timeout(1800)
        pg.evaluate("() => splitClipAt(activeClip(), silenceCuts(0.25))")
        pg.wait_for_timeout(8000)
        pg.click("#tabBtn-export")
        pg.wait_for_timeout(500)
        n = pg.evaluate("() => queue.clips.length")
        check(not pg.is_hidden("#scopeAllRow"), "the switch is showing")
        check(pg.text_content("#scopeAll").strip() == "All %d clips" % n,
              "and it names the clips (%r)" % pg.text_content("#scopeAll"))
        klass = pg.get_attribute("#scopeAll", "class")
        check("on" in klass, "all clips is where it starts (%r)" % klass)

        print("\n3. one press and every format follows")
        pg.click("#scopeOne")
        pg.wait_for_timeout(400)
        scopes = pg.evaluate("() => Object.values(cardScope)")
        print("   card scopes:", scopes)
        check(all(s == "one" for s in scopes), "every card is on the open clip (%r)" % scopes)
        labels = pg.eval_on_selector_all(
            ".exp button.btn[id^='exp']", "els => els.map(e => e.textContent.trim())")
        print("   buttons:", labels[:4])
        check(not any(l.startswith("Export %d " % n) for l in labels),
              "and no button still offers the whole queue (%r)" % labels)

        print("\n4. and back again")
        pg.click("#scopeAll")
        pg.wait_for_timeout(400)
        scopes = pg.evaluate("() => Object.values(cardScope)")
        check(all(s == "queue" for s in scopes), "all of them again (%r)" % scopes)
        labels = pg.eval_on_selector_all(
            ".exp button.btn[id^='exp']", "els => els.map(e => e.textContent.trim())")
        check(any(("Export %d " % n) in l for l in labels),
              "the buttons say how many (%r)" % labels)

        print("\n5. a single card can still disagree, and the top says so")
        pg.evaluate("""() => {
          const row = document.querySelector('.scoperow[data-card="fcp"]');
          row.querySelector('.scopebtn[data-scope="one"]').click();
        }""")
        pg.wait_for_timeout(400)
        check(pg.evaluate("() => cardScope.fcp") == "one", "Final Cut on its own")
        check(pg.evaluate("() => cardScope.gif") == "queue", "while the GIFs stay a batch")
        check(not pg.is_hidden("#scopeMixed"),
              "and the top switch admits it is mixed rather than lying")
        check("on" not in (pg.get_attribute("#scopeAll", "class") or ""),
              "neither side claims to be the answer")

        print("\n6. the overlay video takes the switch like everything else")
        check(not pg.is_hidden("#expOverlayCard"), "the card is there with a puppet on")
        # The one card that used to ignore it. Pressing Export with All clips
        # chosen and getting a single file back is what "it exported just the
        # last one" looks like from outside, so the claim is about the COUNT
        # of files that come down.
        pg.click("#scopeAll")
        pg.wait_for_timeout(400)
        check(pg.evaluate("() => cardScope.overlay") == "queue",
              "the overlay card is on the whole queue")
        check(pg.text_content("#expOverlay").strip() == "Export %d overlay videos" % n,
              "and its button says so (%r)" % pg.text_content("#expOverlay"))
        pg.evaluate("() => { document.getElementById('ovSize').value = '720'; }")
        with pg.expect_download(timeout=300000) as dl:
            pg.click("#expOverlay")
        raw = pathlib.Path(dl.value.path()).read_bytes()
        print("   downloaded", dl.value.suggested_filename, len(raw), "bytes")
        names = zipfile.ZipFile(io.BytesIO(raw)).namelist()
        print("   holds:", names)
        mp4 = [x for x in names if x.endswith(".mp4")]
        check(len(mp4) == n, "one video per clip, not just the open one (%d of %d)"
              % (len(mp4), n))
        check(len(set(mp4)) == len(mp4), "each with its own name (%r)" % (mp4,))
        check(not any("/" in x for x in names),
              "and all in one folder, not a folder apiece (%r)" % (names,))

        print("\n7. a format that makes a SET per clip still cannot collide")
        # The frame sequence is hundreds of PNGs named mouth_0001.png, plus a
        # timing.csv — all of which repeat for every clip. Flat only works if
        # the names are made unique, so this is the check that matters.
        pg.evaluate("() => { document.getElementById('outSize').value = '256'; }")
        pg.evaluate("""() => {
          const row = document.querySelector('.scoperow[data-card="seq"]');
          row.querySelector('.scopebtn[data-scope="queue"]').click();
        }""")
        pg.wait_for_timeout(300)
        with pg.expect_download(timeout=300000) as dl2:
            pg.click("#expSeq")
        raw2 = pathlib.Path(dl2.value.path()).read_bytes()
        names2 = zipfile.ZipFile(io.BytesIO(raw2)).namelist()
        png = [x for x in names2 if x.endswith(".png")]
        csv = [x for x in names2 if x.endswith(".csv")]
        print("   %d PNG, %d timing files, folders: %s"
              % (len(png), len(csv), any("/" in x for x in names2)))
        check(not any("/" in x for x in names2),
              "no folders anywhere in the zip (%r)" % (names2[:4],))
        check(len(set(names2)) == len(names2), "and not one name used twice")
        check(len(csv) == n, "every clip's timing survived (%d of %d)" % (len(csv), n))
        check(len(png) > n * 3, "as did every clip's frames (%d)" % len(png))
        stems = {x.split("-mouth_")[0] for x in png if "-mouth_" in x}
        check(len(stems) == n,
              "each set named for the clip it came from (%r)" % (sorted(stems),))

        pg.locator("#batchCard").screenshot(path=str(OUT / "scope-switch.png"))
        check(not errs, "no page errors (%r)" % (errs[:4],))
        b.close()


run()
print()
if fails:
    print("%d failed:" % len(fails))
    for f in fails:
        print("  - " + f)
    sys.exit(1)
print("the export tab asks once, at the top")
