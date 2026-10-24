#!/usr/bin/env python3
"""The scene export: a split, cast conversation coming down as ONE file.

   The claim being tested is not "a button exists" but "the file that lands is
   the whole conversation" — so the download is intercepted, unzipped, and the
   animated PNG's own frame count is read back out of its acTL chunk and
   checked against the number of frames the queue said it had.

       python3 scenetest.py
"""
import io, pathlib, struct, sys, zipfile
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


def tap(pg, sel):
    pg.locator(sel).locator("visible=true").first.click()


def apng_actl(data):
    """(frame count, play count, width, height) out of a PNG's own chunks —
       and prove acTL really does come before IDAT, which is what decides
       whether anything treats the file as animated."""
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "not a PNG"
    i, n, plays, w, h, seen_actl_before_idat = 8, None, None, None, None, False
    while i < len(data):
        ln = struct.unpack(">I", data[i:i + 4])[0]
        typ = data[i + 4:i + 8]
        body = data[i + 8:i + 8 + ln]
        if typ == b"IHDR":
            w, h = struct.unpack(">II", body[:8])
        elif typ == b"acTL":
            n, plays = struct.unpack(">II", body[:8])
            seen_actl_before_idat = True
        elif typ == b"IDAT":
            if n is None:
                seen_actl_before_idat = False
            break
        i += 12 + ln
    return n, plays, w, h, seen_actl_before_idat


def run():
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        pg = b.new_page(viewport={"width": 1440, "height": 1000},
                        accept_downloads=True)
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda m: m.type == "error" and errs.append(m.text))
        pg.goto(URL)
        pg.wait_for_timeout(900)
        pg.set_input_files("#fileInput", str(VOICE))
        pg.wait_for_timeout(10000)

        print("\n1. cut it into lines and cast two characters")
        n = pg.evaluate("() => splitClipAt(activeClip(), silenceCuts(0.25))")
        pg.wait_for_timeout(2500)
        check(n >= 2, "cut into %s lines" % n)
        pg.evaluate("""async () => {
          await castOnto(queue.clips[0], 'drawn:woman');
          await castOnto(queue.clips[1], 'drawn:older');
          const open = activeClip();
          if (open) { applyClipSettings(open); sizeStage(); drawStage(); }
          renderQueue();
        }""")
        pg.wait_for_timeout(600)
        tap(pg, "#castDeal")
        pg.wait_for_timeout(3500)

        print("\n2. the scene card is offering it")
        pg.click("#tabBtn-export")
        pg.wait_for_timeout(500)
        check(not pg.is_hidden("#expScene"), "the scene card is showing")
        line = pg.text_content("#sceneLine")
        print("   says:", line)
        check("Woman" in line and "Older" in line,
              "and names who is in it (%r)" % line)
        want = pg.evaluate("() => convEstimateFrames()")
        print("   expects", want, "frames")
        pg.screenshot(path=str(OUT / "scene-card.png"))

        print("\n3. render it — one animated PNG of the whole conversation")
        pg.evaluate("() => { document.getElementById('outSize').value = '256'; }")
        with pg.expect_download(timeout=180000) as dl:
            pg.click("#expSceneApng")
        path = dl.value.path()
        raw = pathlib.Path(path).read_bytes()
        print("   downloaded", dl.value.suggested_filename, len(raw), "bytes")
        check(dl.value.suggested_filename.endswith(".zip"),
              "it comes down as a zip (%s)" % dl.value.suggested_filename)

        z = zipfile.ZipFile(io.BytesIO(raw))
        names = z.namelist()
        print("   holds:", names)
        png = [n for n in names if n.endswith(".png")]
        wav = [n for n in names if n.endswith(".wav")]
        check(len(png) == 1, "one picture in it (%r)" % names)
        check(len(wav) == 1, "and the joined voice track (%r)" % names)
        check("README.txt" in names, "and the note")

        count, plays, w, h, order = apng_actl(z.read(png[0]))
        print("   apng: %s frames, %s plays, %sx%s, acTL first: %s"
              % (count, plays, w, h, order))
        check(order, "acTL comes before IDAT, so it really is animated")
        check(count == want,
              "it holds the whole conversation — %s frames, queue said %s"
              % (count, want))
        check(plays == 0, "and loops (play count %s)" % plays)
        # The frame has to be the PUPPET's shape. It came out square once,
        # because the walk composed the first clip before its picture had
        # decoded and plateCellSize had nothing to measure — a bug you cannot
        # see in a frame count.
        check(abs(w / h - 900 / 1200) < 0.02,
              "the frame is the drawn faces' shape, not a square (%d×%d)" % (w, h))

        # And the pictures themselves. The middle of line 1 and the middle of
        # line 2, which are two DIFFERENT characters — the first version of
        # this sampled the first and last frames and compared the woman with
        # herself, because the cast alternates and line 3 is hers again.
        lens = pg.evaluate(
            "() => queue.clips.map(c => (c.frames || []).length)")
        starts, at = [], 0
        for L in lens:
            starts.append(at)
            at += L
        mids = [starts[i] + lens[i] // 2 for i in range(min(2, len(lens)))]
        print("   line lengths %r, sampling frames %r" % (lens, mids))
        from PIL import Image, ImageSequence
        im = Image.open(io.BytesIO(z.read(png[0])))
        picked = {}
        for k, fr in enumerate(ImageSequence.Iterator(im)):
            if k in mids:
                p = fr.convert("RGBA")
                p.save(OUT / ("scene-line%d.png" % (mids.index(k) + 1)))
                picked[k] = p.tobytes()
        check(len(picked) == 2 and picked[mids[0]] != picked[mids[1]],
              "line 1 and line 2 are different characters on screen")
        alpha = Image.open(OUT / "scene-line1.png").getchannel("A").getextrema()
        check(alpha[1] > 0, "and there is something drawn there (alpha %r)" % (alpha,))

        note = z.read("README.txt").decode()
        print("   ---- note ----")
        print("   " + "\n   ".join(note.splitlines()[:14]))
        check("Woman" in note and "Older" in note,
              "the note lists who speaks which line")

        print("\n4. the queue is where it was left")
        check(pg.evaluate("() => queue.activeId === queue.clips[0].id"),
              "the export put the open clip back")

        print("\n5. and the GIF path, which walks the queue twice")
        with pg.expect_download(timeout=240000) as dl2:
            pg.click("#expSceneGif")
        raw2 = pathlib.Path(dl2.value.path()).read_bytes()
        z2 = zipfile.ZipFile(io.BytesIO(raw2))
        gifs = [n for n in z2.namelist() if n.endswith(".gif")]
        check(len(gifs) == 1, "a GIF came down too (%r)" % z2.namelist())
        g = z2.read(gifs[0])
        check(g[:6] in (b"GIF89a", b"GIF87a"), "and it is a GIF (%r)" % g[:6])
        gw, gh = int.from_bytes(g[6:8], "little"), int.from_bytes(g[8:10], "little")
        nimg = g.count(b"\x00\x21\xf9\x04")
        print("   gif %dx%d, %d graphic-control blocks" % (gw, gh, nimg))
        check((gw, gh) == (w, h), "the same frame as the PNG (%dx%d)" % (gw, gh))
        check(nimg == count, "and the same %d frames (%d)" % (count, nimg))

        check(not errs, "no page errors (%r)" % (errs[:4],))
        b.close()


run()
print()
if fails:
    print("%d failed:" % len(fails))
    for f in fails:
        print("  - " + f)
    sys.exit(1)
print("the whole conversation comes down as one file")
