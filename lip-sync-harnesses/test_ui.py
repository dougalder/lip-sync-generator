#!/usr/bin/env python3
"""Layout checks for the six changes made to the shell.

   The old suites went down with a reclaimed container; this is the start of
   their replacement and it covers only what was just moved: the tab order and
   which one opens, the sheet pane's height against the preview, the export
   cards with their prose behind the i, the single theme toggle, and the
   privacy line. It drives the real built file in a real browser, because every
   one of those is a layout claim and layout is the thing unit tests cannot see.

   It also leaves its screenshots in shots/ — cheap, and the only way to notice
   that something is technically present but looks wrong.

       python3 test_ui.py            both schemes
       python3 test_ui.py --shots    the same, without failing the run
"""
import pathlib, sys
from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).parent
OUT = HERE / "shots"
OUT.mkdir(exist_ok=True)
URL = (HERE / "lip-sync-generator.html").resolve().as_uri()
VOICE = HERE / "speech.wav"   # built by fixtures/make_fixtures.py
PUPPET = HERE / "fixtures" / "puppet-padded-alpha.png"

fails = []


def check(cond, msg):
    if not cond:
        fails.append(msg)
        print("  FAIL  " + msg)
    else:
        print("  ok    " + msg)


def run(dark):
    tag = "dark" if dark else "light"
    print("\n=== " + tag + " ===")
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        pg = b.new_page(viewport={"width": 1440, "height": 1000},
                        color_scheme="dark" if dark else "light")
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda m: m.type == "error" and errs.append(m.text))
        pg.goto(URL)
        pg.wait_for_timeout(1000)

        # --- tabs: Inputs is first, and it is the one that opens ------------
        # The strip beside the stage — the style and view pickers inside the
        # Mouth tab are tablists too, so this has to name the right one.
        tabs = pg.eval_on_selector_all(
            '.tabs [role="tab"]', "els => els.map(e => e.id)")
        check(tabs == ['tabBtn-inputs', 'tabBtn-mouth', 'tabBtn-export',
                       'tabBtn-settings'],
              "tab order is input, mouth, export, settings — got %r" % (tabs,))
        check(pg.get_attribute("#tabBtn-inputs", "aria-selected") == "true",
              "Inputs is the open tab on arrival")
        check(pg.is_visible(".sheetwrap .sheet-panel"),
              "and the exposure sheet is not in a tab at all — it is always there")
        check(not pg.is_visible("#tab-export"), "the export pane starts closed")

        # --- the version, shown and consistent -------------------------------
        shown = (pg.text_content('#appVersion') or '').strip()
        code = pg.evaluate('APP_VERSION')
        check(shown == 'v' + code,
              "the version under the title is the one in the code (%r vs %r)" % (shown, code))
        check(len(code.split('.')) == 3 and all(x.isdigit() for x in code.split('.')),
              "and it is a three-part number (%r)" % (code,))
        check(code in pg.evaluate('diagnostics()'),
              "the diagnostics carry it too, for a bug report")

        # --- the privacy line -----------------------------------------------
        txt = pg.text_content(".privacy") or ""
        check("never uploaded" in txt and "browser" in txt,
              "the privacy line is in the top and says what it does")
        check(pg.eval_on_selector(".privacy", "e => e.getBoundingClientRect().top") < 140,
              "it sits above the fold, under the header")

        # --- one theme control, and it flips ---------------------------------
        check(pg.eval_on_selector_all(".theme-toggle", "e => e.length") == 1,
              "one theme control, not three")
        check(pg.eval_on_selector_all("[data-theme]", "e => e.length") == 0,
              "the old three-way switch is gone")
        want = "light" if dark else "dark"
        check(want in (pg.get_attribute("#themeToggle", "title") or ""),
              "arriving under a %s system, the toggle offers %s" % (tag, want))
        pg.click("#themeToggle")
        pg.wait_for_timeout(200)
        check(pg.get_attribute("html", "data-theme") == want,
              "clicking it switches to " + want)
        check(pg.evaluate("localStorage.getItem('mouthchart.theme')") == want,
              "and the choice is remembered")
        pg.click("#themeToggle")
        pg.wait_for_timeout(200)
        check(pg.get_attribute("html", "data-theme") == ("dark" if dark else "light"),
              "clicking again goes back")

        # --- export cards: prose behind the i, warnings left on the card ----
        pg.click("#tabBtn-export")
        pg.wait_for_timeout(250)
        n = pg.eval_on_selector_all(".exp:not([hidden])", "e => e.length")
        check(pg.eval_on_selector_all(".exp:not([hidden]) .infobtn", "e => e.length") == n,
              "every visible export card has an info button (%d)" % n)
        check(pg.eval_on_selector_all(".expinfo:not([hidden])", "e => e.length") == 0,
              "all the panels start shut")
        # the estimate, the batch note and the warnings stayed outside the panel
        for el in ("estMp4", "mp4Warn", "estFcp", "fcpBatchNote", "estGif", "estSeq"):
            check(pg.eval_on_selector("#" + el, "e => !e.closest('.expinfo')"),
                  el + " stayed on the card, not in the panel")
        pg.eval_on_selector(".expgrid", "e => e.scrollIntoView({block:'start'})")
        pg.wait_for_timeout(150)
        pg.click(".exp:not([hidden]) .infobtn")
        pg.wait_for_timeout(200)
        check(pg.eval_on_selector_all(".expinfo:not([hidden])", "e => e.length") == 1,
              "clicking the i opens one panel")
        pg.screenshot(path=str(OUT / ("03-export-info-open-%s.png" % tag)))
        pg.eval_on_selector_all(".exp:not([hidden]) .infobtn", "e => e[3].click()")
        pg.wait_for_timeout(200)
        check(pg.eval_on_selector_all(".expinfo:not([hidden])", "e => e.length") == 1,
              "opening a second closes the first")
        pg.keyboard.press("Escape")
        pg.wait_for_timeout(150)
        check(pg.eval_on_selector_all(".expinfo:not([hidden])", "e => e.length") == 0,
              "Escape shuts it")

        # --- layers -----------------------------------------------------------
        pg.click("#tabBtn-inputs")
        pg.wait_for_timeout(300)
        # An empty stage has an empty stack: with no voice track, no puppet and
        # nothing added, there is nothing for a mouth to belong to. (This used
        # to be a lone Mouth row on a blank page, which is also what survived
        # clearing the audio — the lips sitting on an empty stage.)
        n0 = pg.evaluate("layers.length")
        check(n0 == 0, "nothing loaded, nothing in the stack (%d)" % n0)
        pg.click("#layerAddText")
        pg.wait_for_timeout(300)
        check(pg.evaluate("() => layers.some(L => L.kind === 'mouth')"),
              "and the mouth joins the stack as soon as there is one")
        pg.click("#layerAddShape")
        pg.wait_for_timeout(300)
        kinds = pg.evaluate("() => layers.map(L => L.kind)")
        check("text" in kinds and "shape" in kinds, "text and shape layers can be added %r" % (kinds,))
        check(pg.eval_on_selector_all(".lrow", "e => e.length") == len(kinds),
              "the list has one row per layer")
        # the eye hides it from the stage AND from what comes out
        sid = pg.evaluate("() => layers.find(L => L.kind === 'shape').id")
        pg.evaluate("id => setLayerVisible(id, false)", sid)
        pg.wait_for_timeout(200)
        check(pg.evaluate("id => !layerById(id).visible", sid), "the eye hides a layer")
        pg.evaluate("id => setLayerVisible(id, true)", sid)
        # reordering, through the same function the drag calls
        # The array is bottom-first and the list is shown top-first, so sending
        # a layer to the LAST row should put it FIRST in the array. Getting that
        # inversion wrong is the classic bug in a layer list, so the test takes
        # the long way round it on purpose.
        before = pg.evaluate("() => layers.map(L => L.kind).join(',')")
        pg.evaluate("id => moveLayerToDisplayIndex(id, layers.length - 1)", sid)
        pg.wait_for_timeout(200)
        after = pg.evaluate("() => layers.map(L => L.kind).join(',')")
        check(after != before and after.startswith("shape"),
              "sending a layer to the bottom row puts it at the back (%s -> %s)"
              % (before, after))
        check(pg.eval_on_selector_all(".lrow .ltext b", "e => e.map(x => x.textContent)")[-1]
              == "Shape", "and the list shows it on the bottom row")
        # and the trash takes it away again
        pg.evaluate("id => deleteLayer(id)", sid)
        pg.wait_for_timeout(200)
        check(pg.evaluate("() => !layers.some(L => L.kind === 'shape')"), "the trash deletes a layer")
        check(pg.evaluate("() => { const m = layers.find(L=>L.kind==='mouth');"
                          "  return !!m && document.querySelector('.lrow[data-id=\"'+m.id+'\"] .lbtn.danger').disabled; }"),
              "the mouth layer cannot be deleted")
        pg.evaluate("() => { const t = layers.find(L=>L.kind==='text'); if (t) deleteLayer(t.id); }")
        pg.wait_for_timeout(200)

        # --- the sheet sits directly under the stage, in the same column -----
        box = pg.evaluate("""() => {
          const r = s => { const e = document.querySelector(s); if (!e) return null;
            const b = e.getBoundingClientRect();
            return {x: Math.round(b.x), w: Math.round(b.width),
                    top: Math.round(b.top), bottom: Math.round(b.bottom)}; };
          return {stage: r('.deck .stage-panel'), sheet: r('.sheetwrap .sheet-panel'),
                  main: r('.maincol')};
        }""")
        print("   columns:", box)
        check(box["sheet"] and box["stage"], "both are on the page (%r)" % (box,))
        check(abs(box["sheet"]["x"] - box["stage"]["x"]) <= 2 and
              abs(box["sheet"]["w"] - box["stage"]["w"]) <= 2,
              "the sheet is as wide as the stage and under it, not beside it (%r)" % (box,))
        check(0 <= box["sheet"]["top"] - box["stage"]["bottom"] <= 40,
              "directly below it (%dpx gap)"
              % (box["sheet"]["top"] - box["stage"]["bottom"]))
        check(box["stage"]["w"] > box["main"]["w"] * 1.6,
              "and the stage column has about two thirds of the width (%d vs %d)"
              % (box["stage"]["w"], box["main"]["w"]))
        pg.screenshot(path=str(OUT / ("01-sheet-tab-%s.png" % tag)))

        # --- with audio in it, the sheet is allowed to grow past the preview -
        pg.set_input_files("#fileInput", str(VOICE))
        try:
            pg.wait_for_function(
                "() => { const e = document.getElementById('frameCount') || {};"
                "        return (document.querySelector('.deck .stage-panel') &&"
                "                document.querySelectorAll('#xsheet').length); }",
                timeout=20000)
        except Exception:
            pass
        pg.wait_for_timeout(9000)   # analysis runs on the main thread
        after = pg.evaluate("""() => {
          const r = s => { const e = document.querySelector(s);
                           return e ? Math.round(e.getBoundingClientRect().height) : -1; };
          const c = document.getElementById('xsheet');
          return {preview: r('.deck .stage-panel'), sheet: r('.sheetwrap .sheet-panel'),
                  canvas: c ? [c.width, c.height] : null,
                  script: !!document.querySelector('.scriptbar:not([hidden])'),
                  deckSolo: document.getElementById('deck').classList.contains('solo')};
        }""")
        print("   after audio:", after)
        check(after["sheet"] > 300,
              "with a clip in it the sheet has real height (%d)" % after["sheet"])
        check(after["canvas"] and after["canvas"][0] > 600,
              "and the sheet canvas got the wide column (%r)" % (after["canvas"],))
        pg.screenshot(path=str(OUT / ("05-sheet-with-audio-%s.png" % tag)))

        # --- mouth tab: style across the top, chart under it -----------------
        pg.click("#tabBtn-mouth")
        pg.wait_for_timeout(400)
        geo = pg.evaluate("""() => {
          const p = [...document.querySelectorAll('#tab-mouth > .tabcols > .panel')];
          return p.map(e => { const r = e.getBoundingClientRect();
            return {h2: e.querySelector('h2').textContent,
                    x: Math.round(r.x), w: Math.round(r.width), y: Math.round(r.y)}; });
        }""")
        print("   mouth tab:", geo)
        check(len(geo) == 2, "the mouth tab is two panels")
        check(geo[0]["h2"].startswith("Mouth") and geo[1]["h2"].startswith("Chart"),
              "mouth style first, chart second")
        check(geo[0]["x"] == geo[1]["x"] and abs(geo[0]["w"] - geo[1]["w"]) <= 1,
              "they are the same width — stacked, not columned")
        check(geo[1]["y"] > geo[0]["y"], "the chart sits below the style picker")
        pg.screenshot(path=str(OUT / ("06-mouth-%s.png" % tag)))

        # --- a still puppet actually has a stage to be drawn on --------------
        # This asks what the canvas RENDERS at, not what its backing store
        # holds. Those two came apart once: every child of the stack is out of
        # flow, so the box collapsed to 0px high and a correctly painted
        # picture showed as an empty checkerboard. getImageData said all was
        # well, which is exactly why it is not what gets asked here.
        pg.set_input_files("#puppetInput", str(PUPPET))
        pg.wait_for_timeout(2500)
        stage = pg.evaluate("""() => {
          const c = document.getElementById('stage');
          const st = document.getElementById('stageStack');
          const r = c.getBoundingClientRect(), s = st.getBoundingClientRect();
          const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++;
          return {w: Math.round(r.width), h: Math.round(r.height),
                  sh: Math.round(s.height), bw: c.width, bh: c.height, painted: n};
        }""")
        print("   stage:", stage)
        check(stage["sh"] > 100,
              "the stage stack has a height of its own (%dpx)" % stage["sh"])
        check(stage["w"] > 100 and stage["h"] > 100,
              "the stage canvas is rendered at a real size (%d×%d)"
              % (stage["w"], stage["h"]))
        check(abs(stage["w"] / max(1, stage["h"]) -
                  stage["bw"] / max(1, stage["bh"])) < 0.02,
              "and at the shape of the frame it is drawing (%d×%d on %d×%d)"
              % (stage["w"], stage["h"], stage["bw"], stage["bh"]))
        check(stage["painted"] > 1000,
              "with the puppet painted into it (%d pixels)" % stage["painted"])
        pg.locator("#stageWrap").screenshot(
            path=str(OUT / ("07-stage-puppet-%s.png" % tag)))

        # --- the frame is visible, and changes shape with the canvas ---------
        # The checkerboard used to be painted on the whole preview panel, which
        # said "this will export transparent" about parts of the panel that are
        # not in the frame at all — and left no way to see what changing the
        # canvas had done. It now marks the frame itself.
        pg.click("#tabBtn-inputs")
        pg.wait_for_timeout(300)
        shapes = {}
        for preset in ("1920x1080", "1080x1920", "1080x1080"):
            pg.select_option("#canvasPreset", preset)
            pg.wait_for_timeout(500)
            shapes[preset] = pg.evaluate("""() => {
              const w = document.getElementById('stageWrap');
              const k = document.getElementById('stageStack');
              const cw = getComputedStyle(w), ck = getComputedStyle(k);
              const a = w.getBoundingClientRect(), b = k.getBoundingClientRect();
              return {ar: +(b.width / b.height).toFixed(3),
                      insideWrap: b.width <= a.width + 0.5 && b.height <= a.height + 0.5,
                      gap: Math.round(a.width - b.width),
                      frameChecker: ck.backgroundImage !== 'none',
                      wrapChecker: cw.backgroundImage !== 'none',
                      edge: ck.boxShadow};
            }""")
        print("   frames:", {k: (v["ar"], v["gap"]) for k, v in shapes.items()})
        check(abs(shapes["1920x1080"]["ar"] - 16 / 9) < 0.03,
              "a 16:9 canvas gives a 16:9 frame (%.3f)" % shapes["1920x1080"]["ar"])
        check(abs(shapes["1080x1920"]["ar"] - 9 / 16) < 0.03,
              "a vertical canvas gives a vertical frame (%.3f)" % shapes["1080x1920"]["ar"])
        check(abs(shapes["1080x1080"]["ar"] - 1) < 0.03,
              "and a square one a square frame (%.3f)" % shapes["1080x1080"]["ar"])
        check(len({v["ar"] for v in shapes.values()}) == 3,
              "three canvases, three visibly different frames")
        for k, v in shapes.items():
            check(v["frameChecker"], "%s: the checkerboard is on the frame" % k)
            check(not v["wrapChecker"],
                  "%s: and not on the panel behind it" % k)
            check("px" in (v["edge"] or ""), "%s: the frame has an edge drawn" % k)
            check(v["insideWrap"] and v["gap"] >= 2,
                  "%s: with room for it, not clipped at the panel's sides (%dpx)"
                  % (k, v["gap"]))
        pg.screenshot(path=str(OUT / ("08-canvas-frame-%s.png" % tag)))
        pg.select_option("#canvasPreset", "auto")
        pg.wait_for_timeout(400)

        # --- the whole page, laid out ----------------------------------------
        rail = pg.evaluate("""() => {
          const r = s => { const e = document.querySelector(s);
                           return e ? e.getBoundingClientRect() : null; };
          const d = r('#deck'), m = r('.maincol');
          return d && m ? {deckRight: Math.round(d.right), mainLeft: Math.round(m.left),
                           sameRow: Math.abs(d.top - m.top) < 30} : null;
        }""")
        check(rail and rail["mainLeft"] >= rail["deckRight"] and rail["sameRow"],
              "the preview rail and the tabs are side by side (%r)" % (rail,))

        check(not errs, "no page errors (%r)" % (errs[:4],))
        b.close()


run(False)
run(True)
print()
if fails and "--shots" not in sys.argv:
    print("%d failed:" % len(fails))
    for f in fails:
        print("  - " + f)
    sys.exit(1)
print("all good")
