#!/usr/bin/env python3
"""After a cut, the rest of the file is still there.

   Reported as "when the user clicks Split into 2, the second portion of the
   clip disappears from the Exposure Sheet". Nothing was lost — each piece
   became a clip of its own and the timeline drew only the open one, shading
   everything else like material that had been trimmed away. A four-line
   conversation cut into four looked like three quarters of it had gone.

   So the timeline is a cut list now: every piece of the file drawn where it
   runs, named, with a division between them; press a piece to open it, drag a
   division to move the cut, and ⌘Z takes any of it back.

   And the words changed with the thing. A MARKER (M) is a bookmark that cuts
   nothing; SPLIT (B) cuts at the playhead, now, and is live from the start.

       python3 timeline.py
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


def pieces(pg):
    return pg.evaluate("""() => queue.clips.map(c => ({
      name: c.name, a: +(c.in || 0).toFixed(3), b: +clipOut(c).toFixed(3),
      open: c.id === queue.activeId }))""")


def settle(pg, n=None):
    """Wait for the queue to stop working: a cut re-analyses what it opened."""
    if n is not None:
        pg.wait_for_function("(k) => queue.clips.length === k", arg=n, timeout=120000)
    pg.wait_for_function("() => state.frames.length > 0", timeout=120000)
    pg.wait_for_timeout(1200)


def at_time(pg, t, y):
    """Page coordinates of a moment on the timeline."""
    return pg.evaluate("""([t, y]) => {
      const r = document.getElementById('overview').getBoundingClientRect();
      return {x: r.left + ovX(ovSpan(), t, r.width), y: r.top + y};
    }""", [t, y])


def run():
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        ctx = b.new_context(viewport={"width": 1500, "height": 1080})
        pg = ctx.new_page()
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda m: m.type == "error" and errs.append(m.text))
        pg.goto(URL)
        pg.wait_for_timeout(900)
        pg.set_input_files("#fileInput", str(VOICE))
        settle(pg, 1)
        pg.evaluate("() => useFace('woman')")
        pg.wait_for_timeout(2200)

        print("\n1. the blade is there before anything else is")
        check(not pg.is_hidden("#trimSplit"), "Split is on the bar from the start")
        check(not pg.is_disabled("#trimSplit"), "and it is live with one clip loaded")
        check(pg.text_content("#trimMark").strip() == "+ Marker",
              "the bookmark is called a marker (%r)" % pg.text_content("#trimMark").strip())
        check(pg.is_hidden("#trimCommit"),
              "and 'split at markers' waits until there are markers")

        print("\n2. M drops a marker and cuts nothing")
        pg.evaluate("() => seekTo(2.0)")
        pg.wait_for_timeout(300)
        pg.locator("#overview").click(position={"x": 400, "y": 40})
        pg.wait_for_timeout(300)
        pg.evaluate("() => seekTo(2.0)")
        pg.keyboard.press("m")
        pg.wait_for_timeout(500)
        marks = pg.evaluate("() => (activeClip().marks || []).slice()")
        print("   markers:", marks)
        check(len(marks) == 1, "one marker went down (%r)" % (marks,))
        check(len(pieces(pg)) == 1, "and the queue is still one clip")
        check(not pg.is_hidden("#trimCommit"), "now the marker button shows itself")
        check("marker" in (pg.text_content("#trimRead") or ""),
              "the readout counts markers, not split points (%r)"
              % (pg.text_content("#trimRead") or "").strip())

        print("\n3. B cuts at the playhead, there and then")
        pg.evaluate("() => seekTo(4.4)")
        pg.wait_for_timeout(300)
        pg.keyboard.press("b")
        settle(pg, 2)
        ps = pieces(pg)
        for p in ps:
            print("   %-18s %5.2f → %5.2f%s" % (p["name"], p["a"], p["b"],
                                                "   ← open" if p["open"] else ""))
        check(len(ps) == 2, "two pieces (%d)" % len(ps))
        check(abs(ps[0]["b"] - 4.4) < 0.05, "the cut landed on the playhead (%.2f)" % ps[0]["b"])

        print("\n4. and the piece that is not open is still on the timeline")
        shown = pg.evaluate("() => fileFamily(activeClip()).map(c => c.name)")
        edges = pg.evaluate("() => fileEdges(activeClip()).map(e => +e.t.toFixed(3))")
        print("   drawn:", shown, "· divisions at", edges)
        check(len(shown) == 2, "both pieces belong to the timeline (%r)" % (shown,))
        check(len(edges) == 1, "with one division between them (%r)" % (edges,))
        check("piece 1 of 2" in (pg.text_content("#trimRead") or ""),
              "and the readout says which piece you are on (%r)"
              % (pg.text_content("#trimRead") or "").strip())
        pg.locator(".sheet-panel").screenshot(path=str(OUT / "timeline-pieces.png"))

        print("\n5. press another piece and it opens, at the moment pressed")
        other = pg.evaluate("""() => {
          const o = fileFamily(activeClip()).find(c => c.id !== queue.activeId);
          return {name: o.name, mid: ((o.in || 0) + clipOut(o)) / 2};
        }""")
        pt = at_time(pg, other["mid"], 60)
        pg.mouse.click(pt["x"], pt["y"])
        settle(pg)
        # playTime() is CLIP seconds; the press was a moment in the source, so
        # the two have to be put in the same time base before they can agree.
        now = pg.evaluate("() => ({name: activeClip().name,"
                          " at: clipToSrc(activeClip(), playTime())})")
        print("   opened %s, standing at %.2fs of the source" % (now["name"], now["at"]))
        check(now["name"] == other["name"], "the piece pressed is the one open (%r)" % now)
        check(abs(now["at"] - other["mid"]) < 0.35,
              "and the playhead is where it was pressed (%.2f vs %.2f)"
              % (now["at"], other["mid"]))

        print("\n6. the division drags, and both pieces follow it")
        before = pieces(pg)
        edge = pg.evaluate("() => fileEdges(activeClip())[0].t")
        grab = at_time(pg, edge, 6)
        pg.mouse.move(grab["x"], grab["y"])
        pg.mouse.down()
        pg.mouse.move(grab["x"] - 70, grab["y"], steps=10)
        pg.mouse.up()
        settle(pg)
        after = pieces(pg)
        print("   %.2f → %.2f" % (before[0]["b"], after[0]["b"]))
        check(after[0]["b"] < before[0]["b"] - 0.1,
              "the cut moved earlier (%.2f → %.2f)" % (before[0]["b"], after[0]["b"]))
        check(abs(after[0]["b"] - after[1]["a"]) < 0.002,
              "and the two pieces still meet — no gap, no overlap")
        check(abs(after[1]["b"] - before[1]["b"]) < 0.002,
              "the far end of the second piece did not move")

        print("\n7. ⌘Z on the timeline takes it back")
        pg.evaluate("() => timeUndo()")
        settle(pg)
        back = pieces(pg)
        check(abs(back[0]["b"] - before[0]["b"]) < 0.01,
              "the cut is where it was (%.2f)" % back[0]["b"])
        pg.evaluate("() => timeRedo()")
        settle(pg)
        check(abs(pieces(pg)[0]["b"] - after[0]["b"]) < 0.01, "and redo puts it back again")
        pg.evaluate("() => timeUndo()")
        settle(pg)
        pg.evaluate("() => timeUndo()")
        settle(pg, 1)
        one = pieces(pg)
        print("   undone back to:", [p["name"] for p in one])
        check(len(one) == 1, "undoing the split gives one clip again (%d)" % len(one))
        check(one[0]["a"] == 0 and abs(one[0]["b"] - 7.15) < 0.2,
              "spanning the whole file again (%r)" % (one[0],))
        check(pg.evaluate("() => state.frames.length > 0"),
              "with frames on it — the clip that was cut came back whole, "
              "not as something to analyse again")

        print("\n8. Whole file puts the pieces back together")
        pg.evaluate("() => timeRedo()")
        settle(pg, 2)
        check(len(pieces(pg)) == 2, "split again")
        check(not pg.is_hidden("#queueWrap"), "and the clips strip is showing")
        check("2 pieces" in (pg.get_attribute("#trimReset", "title") or ""),
              "Whole file says what it will put back (%r)"
              % (pg.get_attribute("#trimReset", "title") or ""))
        pg.click("#trimReset")
        settle(pg, 1)
        ps = pieces(pg)
        print("   after Whole file:", ps)
        check(len(ps) == 1, "one clip again (%d)" % len(ps))
        check(ps[0]["a"] == 0, "starting at the head of the file")
        check("-0" not in ps[0]["name"], "under the file's own name (%r)" % ps[0]["name"])
        check(pg.is_hidden("#queueWrap"),
              "and the clips strip goes with them")

        print("\n9. B still means the shape B inside the sheet")
        pg.locator("#xsScroll").click(position={"x": 60, "y": 40})
        pg.wait_for_timeout(300)
        n_before = len(pieces(pg))
        pg.keyboard.press("b")
        pg.wait_for_timeout(900)
        v = pg.evaluate("() => state.frames[state.sel].v")
        print("   frame under the selection is now %r, clips %d"
              % (v, len(pieces(pg))))
        check(len(pieces(pg)) == n_before,
              "the sheet's own B did not cut the clip (%d)" % len(pieces(pg)))
        check(v == "B", "it retimed the frame instead (%r)" % v)

        check(not errs, "no page errors (%r)" % (errs[:4],))
        b.close()


run()
print()
if fails:
    print("%d failed:" % len(fails))
    for f in fails:
        print("  - " + f)
    sys.exit(1)
print("the timeline is a cut list, and every cut on it can be taken back")
