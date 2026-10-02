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

        # --- tabs: the sheet is first, and it is the one that opens ---------
        # The strip under the deck — the style and view pickers inside the
        # Mouth tab are tablists too, so this has to name the right one.
        tabs = pg.eval_on_selector_all(
            '.tabs [role="tab"]', "els => els.map(e => e.id)")
        check(tabs == ['tabBtn-sheet', 'tabBtn-analysis', 'tabBtn-mouth', 'tabBtn-export'],
              "tab order is sheet, analysis, mouth, export — got %r" % (tabs,))
        check(pg.get_attribute("#tabBtn-sheet", "aria-selected") == "true",
              "the exposure sheet is the open tab on arrival")
        check(not pg.is_visible("#tab-export"), "the export pane starts closed")

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

        # --- the sheet pane opens at the preview's height --------------------
        pg.click("#tabBtn-sheet")
        pg.wait_for_timeout(250)
        h = pg.evaluate("""() => {
          const r = s => { const e = document.querySelector(s);
                           return e ? Math.round(e.getBoundingClientRect().height) : -1; };
          return {preview: r('.deck .stage-panel'), sheet: r('.sheetpane > .sheet-panel')};
        }""")
        check(h["sheet"] >= h["preview"] - 1,
              "the empty sheet is at least as tall as the preview (%d vs %d)"
              % (h["sheet"], h["preview"]))
        check(abs(h["sheet"] - h["preview"]) <= 2,
              "and no taller than it needs to be with nothing in it")
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
          return {preview: r('.deck .stage-panel'), sheet: r('.sheetpane > .sheet-panel'),
                  canvas: c ? [c.width, c.height] : null,
                  script: !!document.querySelector('.scriptbar:not([hidden])'),
                  deckSolo: document.getElementById('deck').classList.contains('solo')};
        }""")
        print("   after audio:", after)
        check(after["sheet"] >= after["preview"] - 1,
              "with a clip in it the sheet is still no shorter than the preview "
              "(%d vs %d)" % (after["sheet"], after["preview"]))
        check(after["canvas"] and after["canvas"][0] > 400,
              "the sheet canvas got a real width in the tab (%r)" % (after["canvas"],))
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
