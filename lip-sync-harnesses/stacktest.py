#!/usr/bin/env python3
"""A stack with NO puppet — a picture dropped in as a layer, which is what the
   Layers tab invites you to do and which leaves the puppet row still saying
   "nothing behind the mouth yet".

   Everything on the stage was gated on there being a PUPPET, so in this state
   the handles drew themselves and did nothing, and the placement strip under
   the preview was not there at all.

       python3 stacktest.py
"""
import pathlib, sys
from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).parent
OUT = HERE / "shots"
OUT.mkdir(exist_ok=True)
URL = (HERE / "lip-sync-generator.html").resolve().as_uri()
VOICE = HERE / "speech.wav"
PIC = HERE / "fixtures" / "puppet-padded-alpha.png"

fails = []


def check(cond, msg):
    if not cond:
        fails.append(msg)
        print("  FAIL  " + msg)
    else:
        print("  ok    " + msg)


def stage_in_view(pg):
    """Put the stage back on screen before pointing at it.

    The stage and the exposure sheet share the left column now, so working in
    the Layers panel can leave the page scrolled far enough that the stage is
    above the top of the window. getBoundingClientRect then reports a negative
    y, the drag is delivered to whatever is at that point on screen, and the
    layer never moves — which looks exactly like a dead handle."""
    pg.evaluate("() => document.getElementById('stageWrap')"
                ".scrollIntoView({block: 'center'})")
    pg.wait_for_timeout(200)


def drag(pg, x0, y0, x1, y1):
    pg.mouse.move(x0, y0)
    pg.mouse.down()
    for i in range(1, 13):
        pg.mouse.move(x0 + (x1 - x0) * i / 12, y0 + (y1 - y0) * i / 12)
    pg.mouse.up()


def handle_at(pg, which):
    """Where a handle of the selected layer is, in page coordinates."""
    return pg.evaluate("""(which) => {
      const s = document.getElementById('stage');
      const r = s.getBoundingClientRect();
      const b = activeBox(s.width, s.height);
      const g = overlayHandles(b, s.width, s.height);
      const q = which === 'turn' ? g.turn : g.scale;
      const c = Math.cos(b.rot), sn = Math.sin(b.rot);
      const px = b.cx + q.x * c - q.y * sn;
      const py = b.cy + q.x * sn + q.y * c;
      return {x: r.left + px / s.width * r.width,
              y: r.top + py / s.height * r.height};
    }""", which)


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

        print("\n1. a picture as a LAYER, with no puppet at all")
        pg.click("#tabBtn-inputs")
        pg.wait_for_timeout(400)
        pg.set_input_files("#layerImageInput", str(PIC))
        pg.wait_for_timeout(1800)
        st = pg.evaluate("() => ({plate: hasPlate(), stack: hasStack(), "
                         "kinds: layers.map(L => L.kind)})")
        print("   state:", st)
        check(st["plate"] is False, "there is genuinely no puppet")
        check(st["kinds"] == ["mouth", "image"], "just the mouth and a picture (%r)" % st["kinds"])

        print("\n2. the placement strip is there anyway")
        check(not pg.is_hidden("#overlayTools"),
              "the strip under the preview is showing")
        check(not pg.is_hidden("#overlaySizeRange"), "with its size control")

        print("\n3. the handles actually work")
        stage_in_view(pg)
        pg.evaluate("() => selectLayer(layers.find(L => L.kind === 'image').id)")
        pg.wait_for_timeout(300)
        was = pg.evaluate("() => ({...selectedLayer().pose})")
        c = pg.evaluate("""() => {
          const s = document.getElementById('stage');
          const r = s.getBoundingClientRect();
          const b = activeBox(s.width, s.height);
          return {x: r.left + b.cx / s.width * r.width,
                  y: r.top + b.cy / s.height * r.height};
        }""")
        drag(pg, c["x"], c["y"], c["x"] + 30, c["y"] + 20)
        pg.wait_for_timeout(300)
        now = pg.evaluate("() => ({...selectedLayer().pose})")
        check(abs(now["x"] - was["x"]) > 0.01,
              "dragging the picture moved it (%.3f -> %.3f)" % (was["x"], now["x"]))

        h = handle_at(pg, "scale")
        s0 = pg.evaluate("() => selectedLayer().pose.size")
        drag(pg, h["x"], h["y"], h["x"] - 40, h["y"] - 40)
        pg.wait_for_timeout(300)
        s1 = pg.evaluate("() => selectedLayer().pose.size")
        check(abs(s1 - s0) > 0.01,
              "the corner handle resized it (%.3f -> %.3f)" % (s0, s1))

        t = handle_at(pg, "turn")
        r0 = pg.evaluate("() => selectedLayer().pose.rot")
        drag(pg, t["x"], t["y"], t["x"] + 50, t["y"] + 50)
        pg.wait_for_timeout(300)
        r1 = pg.evaluate("() => selectedLayer().pose.rot")
        check(abs(r1 - r0) > 1,
              "the turn knob tilted it (%.1f -> %.1f)" % (r0, r1))
        pg.locator("#stageWrap").screenshot(path=str(OUT / "stack-handles.png"))

        print("\n4. the mouth is still reachable in the same stack")
        stage_in_view(pg)
        # Put the picture back the size it arrived at. The drags above leave it
        # SMALLER than the mouth and rotated across it, and the smallest box at
        # a point is the one that wins — correctly, or a full-frame background
        # would swallow every click. The claim here is the other one: a mouth
        # sitting on a picture is still the thing you grab.
        pg.evaluate("""() => {
          const img = layers.find(L => L.kind === 'image');
          Object.assign(img.pose, {x: 0.5, y: 0.5, size: 0.9, rot: 0});
          drawStage();
        }""")
        pg.wait_for_timeout(250)
        m = pg.evaluate("""() => {
          const s = document.getElementById('stage');
          const r = s.getBoundingClientRect();
          const b = overlayBox(s.width, s.height);
          return {x: r.left + b.cx / s.width * r.width,
                  y: r.top + b.cy / s.height * r.height};
        }""")
        mw = pg.evaluate("() => ({...overlay})")
        drag(pg, m["x"], m["y"], m["x"] + 25, m["y"] + 18)
        pg.wait_for_timeout(300)
        check(pg.evaluate("() => (selectedLayer()||{}).kind") == "mouth",
              "clicking the mouth selected it")
        check(abs(pg.evaluate("() => overlay.x") - mw["x"]) > 0.005,
              "and moved it")

        print("\n5. an exact size can be typed, not only dragged")
        pg.evaluate("() => selectLayer(layers.find(L => L.kind === 'image').id)")
        pg.wait_for_timeout(300)
        num = pg.locator("#overlaySizeNum")
        check(num.count() > 0, "the strip has a number field beside the slider")
        num.fill("37")
        num.press("Enter")
        pg.wait_for_timeout(400)
        got = pg.evaluate("() => selectedLayer().pose.size")
        check(abs(got - 0.37) < 0.005, "typing 37 set it to exactly 37%% (%.4f)" % got)
        ang = pg.locator("#overlayAngleNum")
        ang.fill("-12")
        ang.press("Enter")
        pg.wait_for_timeout(400)
        check(abs(pg.evaluate("() => selectedLayer().pose.rot") + 12) < 0.01,
              "and -12 on the angle")

        print("\n6. the layer can be deleted from the preview panel")
        check(pg.is_visible("#overlayDelete"), "there is a delete on the strip")
        n0 = pg.evaluate("() => layers.length")
        pg.click("#overlayDelete")
        pg.wait_for_timeout(500)
        n1 = pg.evaluate("() => layers.length")
        check(n1 == n0 - 1, "it removed the picture (%d -> %d)" % (n0, n1))
        check(pg.evaluate("() => layers.some(L => L.kind === 'mouth')"),
              "and left the mouth alone")
        # The mouth must never be deletable this way either.
        pg.evaluate("() => selectLayer(layers.find(L => L.kind === 'mouth').id)")
        pg.wait_for_timeout(300)
        check(pg.evaluate("() => document.getElementById('overlayDelete').disabled") is True,
              "with the mouth selected the delete is refused")

        print("\n7. the settings box opens under the row it belongs to")
        pg.set_input_files("#layerImageInput", str(PIC))
        pg.wait_for_timeout(1500)
        pg.set_input_files("#layerImageInput", str(PIC))
        pg.wait_for_timeout(1500)
        # Edit the BOTTOM row in the list — the one that used to be furthest
        # from where the box appeared.
        rows = pg.locator(".lrow")
        n = rows.count()
        print("   rows:", n)
        rows.nth(n - 1).locator(".lbtn.edit").click()
        pg.wait_for_timeout(500)
        where = pg.evaluate("""() => {
          const ed = document.getElementById('layerEdit');
          const rows = [...document.querySelectorAll('.lrow')];
          const prev = ed.previousElementSibling;
          return {inList: !!ed.closest('#layerList'),
                  afterRow: prev ? rows.indexOf(prev) : -1,
                  rows: rows.length,
                  editing: layerEditorId,
                  prevId: prev ? prev.dataset.id : null};
        }""")
        print("   editor:", where)
        check(where["inList"], "the box is inside the list, not after it")
        check(where["prevId"] == where["editing"],
              "and directly below the row being edited (%r)" % where)
        pg.screenshot(path=str(OUT / "stack-editor-inline.png"))
        # Closing it must put it back, or the next list rebuild destroys it.
        pg.click("#layerEdit .lehead .btn")
        pg.wait_for_timeout(400)
        check(pg.evaluate("() => !!document.getElementById('layerEdit')"),
              "closing it does not destroy it")
        check(pg.evaluate("() => !document.getElementById('layerEdit').closest('#layerList')"),
              "and parks it back outside the list")

        print("\n8. an oversized picture can still be grabbed and shrunk")
        stage_in_view(pg)
        pg.evaluate("""() => {
          const img = layers.find(L => L.kind === 'image');
          selectLayer(img.id); layerEditorId = null;
          img.pose.size = 2.6; img.pose.rot = 0; img.pose.x = 0.5; img.pose.y = 0.5;
          renderLayerPanel(); updateOverlayReadout(); drawStage();
        }""")
        pg.wait_for_timeout(400)
        inside = pg.evaluate("""() => {
          const s = document.getElementById('stage');
          const b = activeBox(s.width, s.height);
          const g = overlayHandles(b, s.width, s.height);
          const c = Math.cos(b.rot), sn = Math.sin(b.rot);
          const pt = q => ({x: b.cx + q.x*c - q.y*sn, y: b.cy + q.x*sn + q.y*c});
          const sc = pt(g.scale), tn = pt(g.turn);
          const ok = p => p.x > 0 && p.y > 0 && p.x < s.width && p.y < s.height;
          return {scale: ok(sc), turn: ok(tn), w: s.width, h: s.height, sc, tn,
                  realCorner: {x: b.cx + (b.w/2), y: b.cy + (b.h/2)}};
        }""")
        print("   handles:", inside)
        check(inside["scale"], "the corner handle is inside the canvas (%r)" % (inside["sc"],))
        check(inside["turn"], "and so is the turn knob (%r)" % (inside["tn"],))
        h2 = handle_at(pg, "scale")
        big = pg.evaluate("() => selectedLayer().pose.size")
        drag(pg, h2["x"], h2["y"], h2["x"] - 60, h2["y"] - 60)
        pg.wait_for_timeout(400)
        small = pg.evaluate("() => selectedLayer().pose.size")
        check(small < big - 0.1,
              "and dragging it shrank the picture (%.2f -> %.2f)" % (big, small))
        pg.locator("#stageWrap").screenshot(path=str(OUT / "stack-oversized.png"))

        print("\n9. moving the puppet carries the mouth and NOTHING else")
        stage_in_view(pg)
        pg.set_input_files("#puppetInput", str(PIC))
        pg.wait_for_timeout(2500)
        pg.evaluate("""() => {
          // A known scene: the plate, the mouth, one caption and one picture,
          // both parked well away from the spot the drag will grab. The plate
          // is the full frame and SMALLEST-BOX-WINS, so grabbing it means
          // finding a point no other layer covers.
          layers = layers.filter(L => L.kind === 'plate' || L.kind === 'mouth');
          addTextLayer();
          const t = selectedLayer(); t.pose.x = 0.22; t.pose.y = 0.16; t.pose.size = 0.09;
          addShapeLayer();
          const sh = selectedLayer(); sh.pose.x = 0.82; sh.pose.y = 0.80; sh.pose.size = 0.14;
          overlay.x = 0.5; overlay.y = 0.62;
          selectLayer(layers.find(L => L.kind === 'plate').id);
          bankLayers(); renderLayerPanel(); updateOverlayReadout(); drawStage();
        }""")
        pg.wait_for_timeout(400)
        before = pg.evaluate("""() => ({
          mouth: {x: +overlay.x.toFixed(4), y: +overlay.y.toFixed(4),
                  size: +overlay.size.toFixed(4)},
          others: layers.filter(L => L.kind === 'text' || L.kind === 'shape')
                        .map(L => ({k: L.kind, x: +L.pose.x.toFixed(4),
                                    y: +L.pose.y.toFixed(4),
                                    s: +L.pose.size.toFixed(4)}))
        })""")
        # A point inside the plate and inside nothing else.
        c = pg.evaluate("""() => {
          const s = document.getElementById('stage');
          const r = s.getBoundingClientRect();
          const hit = layerAtPoint({x: s.width * 0.15, y: s.height * 0.52},
                                   s.width, s.height);
          return {x: r.left + 0.15 * r.width, y: r.top + 0.52 * r.height,
                  under: hit ? hit.kind : null};
        }""")
        print("   grabbing at 15%,52% — under the pointer:", c["under"])
        check(c["under"] == "plate", "the grab point is bare puppet (%r)" % c["under"])
        drag(pg, c["x"], c["y"], c["x"] + 45, c["y"] + 30)
        pg.wait_for_timeout(400)
        after = pg.evaluate("""() => ({
          mouth: {x: +overlay.x.toFixed(4), y: +overlay.y.toFixed(4),
                  size: +overlay.size.toFixed(4)},
          others: layers.filter(L => L.kind === 'text' || L.kind === 'shape')
                        .map(L => ({k: L.kind, x: +L.pose.x.toFixed(4),
                                    y: +L.pose.y.toFixed(4),
                                    s: +L.pose.size.toFixed(4)}))
        })""")
        print("   before:", before)
        print("   after: ", after)
        check(abs(after["mouth"]["x"] - before["mouth"]["x"]) > 0.01,
              "dragging the puppet carried the mouth (%.4f -> %.4f)"
              % (before["mouth"]["x"], after["mouth"]["x"]))
        check(before["others"] == after["others"],
              "and left the caption and the picture exactly where they were")

        # And the same through the slider, which had its own copy of the remap.
        b2 = pg.evaluate("""() => layers.filter(L => L.kind === 'text' || L.kind === 'shape')
                              .map(L => +L.pose.size.toFixed(4))""")
        m2 = pg.evaluate("() => +overlay.size.toFixed(4)")
        num = pg.locator("#overlaySizeNum")
        num.fill("64")
        num.press("Enter")
        pg.wait_for_timeout(500)
        a2 = pg.evaluate("""() => layers.filter(L => L.kind === 'text' || L.kind === 'shape')
                              .map(L => +L.pose.size.toFixed(4))""")
        check(abs(pg.evaluate("() => +overlay.size.toFixed(4)") - m2) > 0.005,
              "resizing the puppet rescaled the mouth too")
        check(b2 == a2,
              "and not the other layers (%r -> %r)" % (b2, a2))
        pg.locator("#stageWrap").screenshot(path=str(OUT / "stack-unlinked.png"))

        print("\n10. a puppet imported by mistake can be got rid of")
        # The puppet row lives in Inputs now, with the rest of what is loaded.
        pg.click("#tabBtn-inputs")
        pg.wait_for_timeout(400)
        n0 = pg.evaluate("() => puppetShelf.length")
        on = pg.evaluate("() => activeShelfId()")
        print("   cast of %d, showing %s" % (n0, on))
        check(on and on.startswith("f:"), "a loaded puppet is on the stage (%r)" % on)
        # Remove alone clears the stage but leaves the chip — which is what made
        # it look as though it had done nothing.
        pg.locator("#plateDrop").locator("visible=true").first.click()
        pg.wait_for_timeout(600)
        check(pg.evaluate("() => hasPlate()") is False, "Remove clears the picture")
        check(pg.evaluate("() => puppetShelf.length") == n0,
              "and the chip is still in the cast, one click from coming back")
        # The x is what actually gets rid of it.
        pg.locator('.facepick .chipwrap .chipx').locator("visible=true").first.click(force=True)
        pg.wait_for_timeout(600)
        n1 = pg.evaluate("() => puppetShelf.length")
        check(n1 == n0 - 1, "the x took it out of the cast (%d -> %d)" % (n0, n1))
        check(pg.evaluate("() => puppetShelf.every(e => e.kind === 'drawn')"),
              "leaving only the drawn faces")
        check(pg.evaluate("""() => queue.clips.every(c => !c.puppet)"""),
              "and no clip still points at it")
        check(pg.evaluate("""() => document.querySelectorAll(
                '.facepick .chipwrap').length === 0"""),
              "the drawn faces have no x of their own")

        check(not errs, "no page errors (%r)" % (errs[:4],))
        b.close()


run()
print()
if fails:
    print("%d failed:" % len(fails))
    for f in fails:
        print("  - " + f)
    sys.exit(1)
print("a stack with no puppet behaves like any other stack")
