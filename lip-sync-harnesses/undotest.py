#!/usr/bin/env python3
"""Undo on the stage, and typing that stays in the box.

   Two reports in one harness, because both are about the same thing — an
   action you took being thrown away by the program:

   - "after each letter is entered, the system throws the cursor out of the
     box": the settings box lives inside the layer list, and rebuilding the
     list while you type destroys the textarea under the caret;
   - there was no way to take back a move, a resize or a deleted layer.

   Every check reads the state back out of the page after the gesture, rather
   than trusting that a function ran.

       python3 undotest.py
"""
import pathlib, sys
from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).parent
OUT = HERE / "shots"
OUT.mkdir(exist_ok=True)
URL = (HERE / "lip-sync-generator.html").resolve().as_uri()
VOICE = HERE / "speech.wav"

fails = []


def check(cond, msg):
    if not cond:
        fails.append(msg)
        print("  FAIL  " + msg)
    else:
        print("  ok    " + msg)


def drag(pg, x0, y0, x1, y1):
    pg.mouse.move(x0, y0)
    pg.mouse.down()
    for i in range(1, 13):
        pg.mouse.move(x0 + (x1 - x0) * i / 12, y0 + (y1 - y0) * i / 12)
    pg.mouse.up()


def run():
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        pg = b.new_page(viewport={"width": 1500, "height": 1050})
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda m: m.type == "error" and errs.append(m.text))
        pg.goto(URL)
        pg.wait_for_timeout(900)
        pg.set_input_files("#fileInput", str(VOICE))
        pg.wait_for_timeout(9000)

        print("\n1. typing a balloon's words keeps the cursor in the box")
        pg.click("#tabBtn-inputs")
        pg.wait_for_timeout(400)
        pg.click("#layerAddBalloon")
        pg.wait_for_timeout(700)
        ta = pg.locator(".layeredit textarea").first
        ta.click()
        ta.fill("")
        pg.wait_for_timeout(200)
        # Typed a letter at a time, through the keyboard, the way a person does.
        for ch in "hello there":
            pg.keyboard.type(ch)
            pg.wait_for_timeout(45)
        pg.wait_for_timeout(400)
        got = pg.evaluate("() => layers[layers.length - 1].text")
        print("   text:", repr(got))
        check(got == "hello there", "every letter arrived (%r)" % got)
        focused = pg.evaluate("() => document.activeElement && document.activeElement.tagName")
        check(focused == "TEXTAREA", "and the cursor is still in the box (%r)" % focused)
        # The list has to catch up eventually, or the row would lie about the
        # layer for the rest of the session.
        pg.click("#tabBtn-mouth")
        pg.wait_for_timeout(300)
        pg.click("#tabBtn-inputs")
        pg.wait_for_timeout(400)

        print("\n2. moving something on the stage can be taken back")
        pg.evaluate("""() => {
          const L = layers[layers.length - 1];
          L.pose = {x: 0.5, y: 0.5, size: 0.4, rot: 0};
          selectLayer(L.id); layerEditorId = null;
          bankLayers(); renderLayerPanel(); drawStage(); pushStageHistory();
        }""")
        pg.wait_for_timeout(400)
        pg.evaluate("() => document.getElementById('stageWrap').scrollIntoView({block:'center'})")
        pg.wait_for_timeout(200)
        was = pg.evaluate("() => +layers[layers.length - 1].pose.x.toFixed(3)")
        c = pg.evaluate("""() => {
          const s = document.getElementById('stage');
          const r = s.getBoundingClientRect();
          const b = activeBox(s.width, s.height);
          return {x: r.left + b.cx / s.width * r.width,
                  y: r.top + b.cy / s.height * r.height};
        }""")
        drag(pg, c["x"], c["y"], c["x"] + 60, c["y"])
        pg.wait_for_timeout(400)
        moved = pg.evaluate("() => +layers[layers.length - 1].pose.x.toFixed(3)")
        check(moved > was + 0.02, "the drag moved it (%.3f -> %.3f)" % (was, moved))
        check(not pg.evaluate("() => document.getElementById('stageUndo').disabled"),
              "and Undo woke up")
        pg.click("#stageUndo")
        pg.wait_for_timeout(400)
        back = pg.evaluate("() => +layers[layers.length - 1].pose.x.toFixed(3)")
        check(abs(back - was) < 0.005, "Undo put it back (%.3f)" % back)
        pg.click("#stageRedo")
        pg.wait_for_timeout(400)
        again = pg.evaluate("() => +layers[layers.length - 1].pose.x.toFixed(3)")
        check(abs(again - moved) < 0.005, "and Redo moved it again (%.3f)" % again)

        print("\n3. one drag is one step, not one per pointer move")
        # Count the POSITION in the history, not its length: a push after an
        # undo throws away the redo tail, so the length can stay the same while
        # a step was properly added.
        depth = pg.evaluate("() => stageHistory.at")
        drag(pg, c["x"] + 60, c["y"], c["x"] + 60, c["y"] + 40)
        pg.wait_for_timeout(400)
        after = pg.evaluate("() => stageHistory.at")
        print("   history %d -> %d" % (depth, after))
        check(after == depth + 1, "the whole drag added one step (%d -> %d)" % (depth, after))

        print("\n4. a deleted layer comes back")
        n0 = pg.evaluate("() => layers.length")
        pg.evaluate("() => deleteLayer(layers[layers.length - 1].id)")
        pg.wait_for_timeout(400)
        check(pg.evaluate("() => layers.length") == n0 - 1, "it went")
        pg.click("#stageUndo")
        pg.wait_for_timeout(500)
        kinds = pg.evaluate("() => layers.map(L => L.kind)")
        check(len(kinds) == n0, "and Undo brought it back (%r)" % (kinds,))
        check("shape" in kinds, "as the shape it was (%r)" % (kinds,))

        print("\n5. a slider dragged across its range is one step")
        depth = pg.evaluate("() => stageHistory.at")
        print("   before:", pg.evaluate("""() => ({sel: (selectedLayer()||{}).kind,
          size: +activePose().size.toFixed(3),
          slider: document.getElementById('overlaySizeRange').value,
          shown: document.getElementById('overlaySizeRange').offsetParent !== null})"""))
        pg.evaluate("""() => {
          const el = document.getElementById('overlaySizeRange');
          for (let v = 20; v <= 60; v += 2) {
            el.value = String(v);
            el.dispatchEvent(new Event('input', {bubbles: true}));
          }
          el.dispatchEvent(new Event('change', {bubbles: true}));
        }""")
        pg.wait_for_timeout(900)
        after = pg.evaluate("() => stageHistory.at")
        print("   after:", pg.evaluate("() => ({size: +activePose().size.toFixed(3)})"))
        print("   history %d -> %d" % (depth, after))
        check(after == depth + 1, "twenty ticks, one step (%d -> %d)" % (depth, after))

        print("\n6. the keyboard takes back whichever surface was touched last")
        # Edit the sheet, then the stage, then press undo twice: the stage
        # first, the sheet second.
        pg.evaluate("() => { selectFrame(3, true); setViseme('G'); }")
        pg.wait_for_timeout(300)
        sheet_was = pg.evaluate("() => state.frames[3].v")
        pg.evaluate("""() => {
          const L = layers.find(x => x.kind === 'shape') || layers[layers.length - 1];
          selectLayer(L.id);
          L.pose.y = 0.8; bankLayers(); drawStage(); pushStageHistory();
        }""")
        pg.wait_for_timeout(300)
        pg.evaluate("() => document.body.focus()")
        pg.keyboard.press("Meta+z")
        pg.wait_for_timeout(500)
        y = pg.evaluate("""() => { const L = layers.find(x => x.kind === 'shape');
          return L ? +L.pose.y.toFixed(2) : null; }""")
        check(y is not None and abs(y - 0.8) > 0.01,
              "the first press undid the stage (y=%r)" % (y,))
        check(pg.evaluate("() => state.frames[3].v") == sheet_was,
              "and left the sheet alone")
        pg.keyboard.press("Meta+z")
        pg.wait_for_timeout(500)
        check(pg.evaluate("() => state.frames[3].v") != sheet_was,
              "the second press undid the sheet")

        print("\n7. opening another clip starts its own history")
        pg.evaluate("() => splitClipAt(activeClip(), silenceCuts(0.25))")
        pg.wait_for_timeout(9000)
        pg.evaluate("() => openClip(queue.clips[1].id, {force: true})")
        pg.wait_for_timeout(9000)
        check(pg.evaluate("() => stageHistory.stack.length") == 1,
              "a freshly opened clip has nothing to undo")
        check(pg.evaluate("() => document.getElementById('stageUndo').disabled"),
              "and the button says so")

        check(not errs, "no page errors (%r)" % (errs[:4],))
        b.close()


run()
print()
if fails:
    print("%d failed:" % len(fails))
    for f in fails:
        print("  - " + f)
    sys.exit(1)
print("the stage can be taken back, and typing stays where it is typed")
