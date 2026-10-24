#!/usr/bin/env python3
"""The seven things reported after a real session with several graphics in it.

   Each check drives the UI the way a person does — real pointer drags, real
   clicks on real controls — because every one of these was a thing that looked
   present and did not work.

       python3 uxtest.py
"""
import pathlib, sys
from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).parent
OUT = HERE / "shots"
OUT.mkdir(exist_ok=True)
URL = (HERE / "lip-sync-generator.html").resolve().as_uri()
VOICE = HERE / "speech.wav"
PUP = HERE / "fixtures" / "puppet-padded-alpha.png"
PIC = HERE / "fixtures" / "puppet-full-bleed.png"

fails = []


def check(cond, msg):
    if not cond:
        fails.append(msg)
        print("  FAIL  " + msg)
    else:
        print("  ok    " + msg)


def tap(pg, sel):
    pg.locator(sel).locator("visible=true").first.click()


def drag(pg, x0, y0, x1, y1):
    pg.mouse.move(x0, y0)
    pg.mouse.down()
    for i in range(1, 11):
        pg.mouse.move(x0 + (x1 - x0) * i / 10, y0 + (y1 - y0) * i / 10)
    pg.mouse.up()


def box_of(pg, what):
    """Where a layer's box is, in page coordinates."""
    return pg.evaluate("""(what) => {
      const s = document.getElementById('stage');
      const r = s.getBoundingClientRect();
      const L = what === 'sel' ? selectedLayer() : layers.find(x => x.kind === what);
      const b = boxForLayer(L, s.width, s.height);
      return {cx: r.left + b.cx / s.width * r.width,
              cy: r.top + b.cy / s.height * r.height};
    }""", what)


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
        pg.set_input_files("#puppetInput", str(PUP))
        pg.wait_for_timeout(2500)

        print("\n1. a second picture can be added, and a second puppet offered")
        # "Add a picture…" used to sit on the puppet row; it is a LAYER, so it
        # lives with the other layer buttons now. What the puppet row owes you
        # is the other thing that was hard to find: a second character.
        pg.click("#tabBtn-inputs")
        pg.wait_for_timeout(300)
        check(pg.is_visible("#puppetPick"),
              "the puppet row offers 'Add a puppet…' with one already on")
        pg.click("#tabBtn-inputs")
        pg.wait_for_timeout(300)
        check(pg.is_visible("#layerAddImage"),
              "and the Layers tab is where a picture is added")
        pg.set_input_files("#layerImageInput", str(PIC))
        pg.wait_for_timeout(1500)
        pg.set_input_files("#layerImageInput", str(PIC))
        pg.wait_for_timeout(1500)
        kinds = pg.evaluate("() => layers.map(L => L.kind)")
        print("   layers:", kinds)
        check(kinds.count("image") == 2, "two pictures are on the stack (%r)" % kinds)

        print("\n2. clicking the mouth selects and moves THE MOUTH")
        check(pg.evaluate("() => (selectedLayer()||{}).kind") == "image",
              "a picture has the selection, as it does after an import")
        m = box_of(pg, "mouth")
        before = pg.evaluate("() => ({...overlay})")
        pics = pg.evaluate("() => layers.filter(L=>L.kind==='image').map(L=>L.pose.x)")
        drag(pg, m["cx"], m["cy"], m["cx"] + 35, m["cy"] + 25)
        pg.wait_for_timeout(300)
        after = pg.evaluate("() => ({...overlay})")
        pics2 = pg.evaluate("() => layers.filter(L=>L.kind==='image').map(L=>L.pose.x)")
        check(pg.evaluate("() => (selectedLayer()||{}).kind") == "mouth",
              "the click moved the selection to the mouth")
        check(abs(after["x"] - before["x"]) > 0.01,
              "and the mouth moved (%.4f)" % (after["x"] - before["x"]))
        check(pics == pics2, "while the pictures stayed put (%r -> %r)" % (pics, pics2))

        print("\n3. the corner still resizes it")
        got = pg.evaluate("""() => {
          const s = document.getElementById('stage');
          const r = s.getBoundingClientRect();
          const b = activeBox(s.width, s.height);
          const g = overlayHandles(b, s.width, s.height);
          const c = Math.cos(b.rot), sn = Math.sin(b.rot);
          const px = b.cx + g.scale.x * c - g.scale.y * sn;
          const py = b.cy + g.scale.x * sn + g.scale.y * c;
          return {x: r.left + px / s.width * r.width,
                  y: r.top + py / s.height * r.height, size: overlay.size};
        }""")
        drag(pg, got["x"], got["y"], got["x"] + 30, got["y"] + 30)
        pg.wait_for_timeout(300)
        now = pg.evaluate("() => overlay.size")
        check(abs(now - got["size"]) > 0.005,
              "dragging the corner changed the size (%.3f -> %.3f)" % (got["size"], now))

        print("\n4. the size slider resizes without typing")
        pg.click("#tabBtn-inputs")
        pg.wait_for_timeout(400)
        pg.evaluate("() => selectLayer(layers.find(L => L.kind === 'image').id)")
        pg.wait_for_timeout(300)
        was = pg.evaluate("() => selectedLayer().pose.size")
        sl = pg.locator("#overlaySizeRange")
        check(sl.get_attribute("type") == "range", "the stage size control is a slider")
        sl.focus()
        for _ in range(12):
            pg.keyboard.press("ArrowLeft")
        pg.wait_for_timeout(300)
        nowsz = pg.evaluate("() => selectedLayer().pose.size")
        check(nowsz < was - 0.01,
              "nudging it shrank the picture (%.3f -> %.3f)" % (was, nowsz))
        check(pg.locator("#overlayAngle").get_attribute("type") == "range",
              "and the angle control is a slider too")

        print("\n5. every placement field in the layer editor is a slider")
        pg.evaluate("() => { layerEditorId = selectedLayerId; renderLayerPanel(); }")
        pg.wait_for_timeout(400)
        types = pg.evaluate("""() => [...document.querySelectorAll('#layerEdit .lfield')]
          .map(f => ({label: f.querySelector('span').textContent,
                      kind: (f.querySelector('input,select,textarea,button') || {}).type
                            || (f.querySelector('input[type=range]') ? 'range' : '?')}))""")
        print("   fields:", types)
        # The point of this check is that the PLACEMENT controls are sliders —
        # a value you hunt for by eye. It is not that number fields are banned:
        # every slider has one beside it now, and a time like "on from" is a
        # value you state, where a slider would only be imprecise.
        placement = {"Size", "Angle", "Opacity"}
        bare = [t for t in types if t["label"] in placement and t["kind"] == "number"]
        check(not bare, "size, angle and opacity are sliders, not bare numbers (%r)" % bare)
        labels = [t["label"] for t in types]
        check("Size" in labels and "Angle" in labels,
              "and they are still there at all (%r)" % labels)

        print("\n6. the blur patch lives in the mouth's settings")
        pg.evaluate("""() => {
          const m = layers.find(L => L.kind === 'mouth');
          selectLayer(m.id); layerEditorId = m.id; renderLayerPanel();
        }""")
        pg.wait_for_timeout(400)
        check(pg.evaluate("() => !!document.querySelector('#layerEdit #patchRow')"),
              "the blur patch row is inside the layer editor")
        check(pg.evaluate("() => !document.getElementById('motionBar')"),
              "and the panel it used to share with the keyframes is gone")
        check(pg.evaluate("() => !document.getElementById('keyToggle')"),
              "along with the keyframes themselves")
        pg.screenshot(path=str(OUT / "ux-mouth-editor.png"))
        # And they survive being switched away from and back — the editor wipes
        # its own contents, so moving these is only safe if they are parked first.
        pg.evaluate("() => { layerEditorId = null; renderLayerPanel(); }")
        pg.wait_for_timeout(300)
        check(pg.evaluate("() => !!document.getElementById('patchOn')"),
              "closing the editor did not destroy them")
        pg.evaluate("""() => {
          const m = layers.find(L => L.kind === 'mouth');
          layerEditorId = m.id; renderLayerPanel();
        }""")
        pg.wait_for_timeout(300)
        check(pg.evaluate("() => !!document.querySelector('#layerEdit #patchRow')"),
              "and they come back on reopening")

        print("\n7. line boil is off by default, and the tick turns it on")
        pg.evaluate("() => { layerEditorId = null; renderLayerPanel(); }")
        pg.wait_for_timeout(300)
        check(not pg.is_hidden("#boilControls"),
              "the boil sliders are visible before anything is ticked")
        check(pg.locator("#boilIntensity").get_attribute("type") == "range",
              "and they are sliders")
        check(pg.locator("#boilIntensityNum").get_attribute("type") == "number",
              "each with a number field beside it")
        fx = pg.eval_on_selector_all("#boilFx button", "els => els.map(e => e.textContent)")
        print("   effects:", fx)
        check(len(fx) == 6, "six kinds of boil to choose from (%r)" % fx)
        check(pg.evaluate("() => layers.every(L => L.boil !== true)"),
              "every layer starts with boil OFF")
        amt = pg.text_content("#boilIntensityOut")
        print("   amount reads:", amt)
        check("px" in amt, "the amount says what it is worth in pixels (%r)" % amt)

        # Compare the SAME frame with boil off and on. Boil is a per-frame
        # offset, so one still frame is the honest comparison — and NOT frame
        # 0, whose offset happens to be almost nothing, which is most of why
        # this was reported as broken three times.
        hold = """(f) => {
          const W = 300, H = 300;
          const c = document.createElement('canvas');
          c.width = W; c.height = H;
          compositeLayers(c.getContext('2d'), W, H, {frame: f, pose: poseAt(f)});
          return c.toDataURL('image/png');
        }"""
        off = [pg.evaluate(hold, f) for f in (0, 4, 8, 12)]
        pg.check("#boilOn")
        pg.wait_for_timeout(300)
        check(pg.evaluate("() => layers.every(L => L.boil === true)"),
              "the tick turned it on for every layer")
        on = [pg.evaluate(hold, f) for f in (0, 4, 8, 12)]
        check(off != on, "and the picture actually changed")
        check(sum(1 for a, b in zip(off, on) if a != b) >= 3,
              "at most frames, not just one (%d of 4 moved)"
              % sum(1 for a, b in zip(off, on) if a != b))
        print("   boil:", pg.evaluate("() => ({...boil})"))
        # The default is the GENTLEST setting — level 1 — which is what a drawn
        # line usually wants. The claim that matters is not the number but the
        # one just made above: at that setting, ticking it on changes the
        # picture, on most frames rather than one.
        check(pg.evaluate("() => boil.intensity") == 1,
              "and it does that at the gentlest setting there is (%s)"
              % pg.evaluate("() => boil.intensity"))

        print("\n7b. ticking it on SHOWS you, without being asked")
        pg.uncheck("#boilOn")
        pg.wait_for_timeout(3400)        # let any running demo finish
        seen = []
        pg.check("#boilOn")
        # It warps the drawings before it plays them, so the first second is a
        # deliberately still "Boiling…" pass. Sampling through that and calling
        # it "not animating" is testing the wrong window.
        pg.wait_for_function(
            "() => document.getElementById('boilTry').textContent.indexOf('Watch') === 0",
            timeout=20000)
        for _ in range(8):
            pg.wait_for_timeout(110)
            seen.append(pg.evaluate(
                "() => document.getElementById('stage').toDataURL('image/png')"))
        # Three, not more: the playhead is sitting on a silent stretch where the
        # mouth shape does not change, so what you see is exactly the three
        # drawings cycling. That IS the feature, and demanding more distinct
        # pictures would be demanding that the mouth move as well.
        want = pg.evaluate("() => boil.count")
        check(len(set(seen)) >= min(3, want),
              "the stage cycled the drawings once they were ready "
              "(%d distinct, %d drawings)" % (len(set(seen)), want))
        check(pg.evaluate("() => boilCache.size") > 2,
              "and the drawings were cached, so playback is free afterwards (%d)"
              % pg.evaluate("() => boilCache.size"))
        pg.wait_for_timeout(3400)
        check(pg.evaluate("() => demoFrame === null"),
              "and the stage goes back to the playhead when it finishes")
        check(pg.text_content("#boilTry").strip() == "Try it", "with the label restored")
        check(not pg.locator("#boilTry").is_disabled(), "Try it is there to watch it again")

        print("\n8. the frame trap has a way out")
        pg.evaluate("""() => {
          const img = layers.find(L => L.kind === 'image');
          selectLayer(img.id); img.pose.size = 2.2; drawStage(); syncCanvasUI();
        }""")
        pg.wait_for_timeout(400)
        note = pg.text_content("#canvasNote")
        print("   canvas note:", note)
        check("off the edge" in note, "the canvas row says something is outside (%r)" % note)
        f0 = pg.evaluate("() => frameSize()")
        pg.select_option("#canvasPreset", "fit")
        pg.wait_for_timeout(600)
        f1 = pg.evaluate("() => frameSize()")
        print("   frame %r -> %r" % (f0, f1))
        check(f1["w"] > f0["w"] or f1["h"] > f0["h"],
              "Fit everything grew the frame (%r -> %r)" % (f0, f1))
        check("off the edge" not in pg.text_content("#canvasNote"),
              "and nothing is outside it any more")
        pg.locator("#stageWrap").screenshot(path=str(OUT / "ux-fit.png"))

        check(not errs, "no page errors (%r)" % (errs[:4],))
        b.close()


run()
print()
if fails:
    print("%d failed:" % len(fails))
    for f in fails:
        print("  - " + f)
    sys.exit(1)
print("all seven reported problems are gone")
