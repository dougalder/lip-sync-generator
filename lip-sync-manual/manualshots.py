#!/usr/bin/env python3
"""Screenshots for the user manual, with the callouts drawn at the real
positions of the real controls.

The point of doing this with Playwright rather than by hand is that the numbers
in the manual cannot drift away from the buttons they label. Every callout names
a CSS selector; the marker is drawn wherever that element actually is when the
page runs. Move a button and the arrow follows it. Delete a button and this
script fails loudly instead of quietly pointing at empty space.

Run it after any UI change:  python3 manualshots.py
"""
import io
import pathlib
import sys

from PIL import Image, ImageDraw, ImageFont
from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).parent
OUT = HERE / "docs" / "images"
URL = "http://localhost:8812/lip-sync-generator.html"
DSF = 2                                   # device scale factor of the captures

ACCENT = (198, 40, 58)                    # the callout colour, on every shot
RING = (255, 255, 255)
missing = []


def font(size):
    for p in ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
              "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"):
        if pathlib.Path(p).exists():
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


F_BADGE = font(30)


def rect_of(page, sel):
    """The element's box in CSS pixels, in DOCUMENT coordinates.

    Document, not viewport, and that distinction is the whole reason the first
    version of this drew its numbers in the wrong place. `locator.screenshot()`
    scrolls the element into view before capturing, so any rect read before the
    call and any rect read after it are measured from different origins — the
    callouts ended up clamped to the corners of the image. Adding the scroll
    offset makes every measurement absolute, so it does not matter when it is
    taken.
    """
    return page.evaluate("""(sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) return null;
      return {x: r.x + window.scrollX, y: r.y + window.scrollY,
              w: r.width, h: r.height};
    }""", sel)


MAX_W = 2000


def cap(im):
    """Wide captures come down to MAX_W. Still sharper than the manual displays
    them, and it keeps the repo from carrying megabytes of empty panel."""
    if im.width <= MAX_W:
        return im
    h = round(im.height * MAX_W / im.width)
    return im.resize((MAX_W, h), Image.LANCZOS)


def rounded(draw, box, radius, outline, width):
    draw.rounded_rectangle(box, radius=radius, outline=outline, width=width)


def badge(draw, cx, cy, n):
    """A numbered disc, ringed in white so it reads on any background."""
    r = 21
    draw.ellipse([cx - r - 3, cy - r - 3, cx + r + 3, cy + r + 3], fill=RING)
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=ACCENT)
    t = str(n)
    bb = draw.textbbox((0, 0), t, font=F_BADGE)
    draw.text((cx - (bb[2] - bb[0]) / 2 - bb[0], cy - (bb[3] - bb[1]) / 2 - bb[1]),
              t, font=F_BADGE, fill=(255, 255, 255))


def shot(page, name, container, marks, pad=0):
    """Capture `container` and draw a numbered outline round each mark.

    marks: list of (selector, corner) where corner is one of
    'tl' 'tr' 'bl' 'br' 'l' 'r' — which side of the outline the number sits on.
    """
    base = rect_of(page, container)
    if not base:
        missing.append(f"{name}: container {container} is not on the page")
        return
    raw = page.locator(container).screenshot()
    im = Image.open(io.BytesIO(raw)).convert("RGB")
    d = ImageDraw.Draw(im)

    for i, (sel, corner) in enumerate(marks, 1):
        r = rect_of(page, sel)
        if not r:
            missing.append(f"{name}: callout {i} points at {sel}, which is not on the page")
            continue
        x0 = (r["x"] - base["x"]) * DSF
        y0 = (r["y"] - base["y"]) * DSF
        x1 = x0 + r["w"] * DSF
        y1 = y0 + r["h"] * DSF
        rounded(d, [x0 - 5, y0 - 5, x1 + 5, y1 + 5], 10, ACCENT, 4)
        cx, cy = {
            "tl": (x0 - 5, y0 - 5), "tr": (x1 + 5, y0 - 5),
            "bl": (x0 - 5, y1 + 5), "br": (x1 + 5, y1 + 5),
            "l":  (x0 - 5, (y0 + y1) / 2), "r": (x1 + 5, (y0 + y1) / 2),
            "t":  ((x0 + x1) / 2, y0 - 5), "b": ((x0 + x1) / 2, y1 + 5),
        }[corner]
        cx = min(max(cx, 26), im.width - 26)
        cy = min(max(cy, 26), im.height - 26)
        badge(d, cx, cy, i)

    im = cap(im)
    OUT.mkdir(parents=True, exist_ok=True)
    im.save(OUT / (name + ".png"), optimize=True)
    print(f"  {name}.png  {im.width}x{im.height}  {len(marks)} callouts")


def plain(page, name, container):
    """No callouts — just the region."""
    if not rect_of(page, container):
        missing.append(f"{name}: container {container} is not on the page")
        return
    raw = page.locator(container).screenshot()
    im = cap(Image.open(io.BytesIO(raw)).convert("RGB"))
    OUT.mkdir(parents=True, exist_ok=True)
    im.save(OUT / (name + ".png"), optimize=True)
    print(f"  {name}.png  {im.width}x{im.height}")


def load(page, asset, fps="12"):
    page.set_input_files("#fileInput", str(HERE / asset))
    page.wait_for_function("state.frames.length > 0", timeout=120000)
    page.wait_for_timeout(900)


def tab(page, name):
    page.click("#tabBtn-" + name)
    page.wait_for_timeout(300)


with sync_playwright() as pw:
    b = pw.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
    ctx = b.new_context(viewport={"width": 1480, "height": 1200},
                        device_scale_factor=DSF, color_scheme="light")
    page = ctx.new_page()
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.goto(URL)
    page.wait_for_timeout(1200)
    # The manual is shot in the light theme so the callouts read the same way
    # in every picture.
    page.evaluate("() => document.documentElement.setAttribute('data-theme','light')")
    page.wait_for_timeout(200)

    print("first run")
    shot(page, "01-first-run", "header.topbar", [
        ("#engineChip", "b"),
        ("#modeChip", "b"),
        ("#themeSwitch", "bl"),
    ])
    shot(page, "02-drop", ".stage-panel", [
        ("#drop", "tr"),
        ("#stageWrap", "r"),
        (".transport", "l"),
    ])
    plain(page, "03-tabs", "nav.tabs")

    print("analysis")
    tab(page, "analysis")
    shot(page, "04-analysis", "#tab-analysis .panel", [
        ("#engineSel", "l"),
        ("#fps", "l"),
        ("#gate", "l"),
        ("#vs", "l"),
        ("#hold", "l"),
        ("#closures", "l"),
        ("#detectL", "l"),
        ("#resetBtn", "tl"),
    ])

    print("a clip loaded")
    page.select_option("#fps", "12")
    load(page, "speech.wav")
    page.evaluate("seekTo(1.2)")
    page.wait_for_timeout(400)
    shot(page, "05-preview", ".stage-panel", [
        ("#loaded", "r"),
        (".stage-badge", "r"),
        ("#stageWrap", "l"),
        ("#headBtn", "b"),
        ("#playBtn", "b"),
        ("#stopBtn", "b"),
        ("#tailBtn", "b"),
        ("#loopBtn", "b"),
        ("#frameCount", "t"),
    ])
    shot(page, "06-sheet", ".sheet-panel", [
        ("#overview", "l"),
        ("#xsScroll", "l"),
        ("#legend", "t"),
        ("#selInfo", "t"),
        ("#undoBtn", "t"),
        ("#eraseBtn", "t"),
        ("#clearEdits", "t"),
    ])

    print("trim and split")
    page.click("#trimAuto")
    page.wait_for_timeout(500)
    page.evaluate("seekTo(1.6)")
    page.wait_for_timeout(300)
    shot(page, "07-trim", ".sheet-panel .panel-body", [
        ("#overview", "l"),
        ("#trimRead", "b"),
        ("#trimMark", "t"),
        ("#trimAuto", "t"),
        ("#trimDrop", "t"),
        ("#trimCommit", "b"),
        ("#trimReset", "b"),
        ("#trimDelete", "b"),
    ])

    print("placement, blur and keys — needs a video, on its own")
    # A fresh page, or loading the video would put a SECOND clip in the queue
    # and every export button below would say "Export 2 …". The single-clip
    # pictures have to be taken with a single clip.
    page.goto(URL)
    page.wait_for_timeout(1200)
    page.evaluate("() => document.documentElement.setAttribute('data-theme','light')")
    page.select_option("#fps", "12")
    load(page, "codec-vp9.mp4", "12")
    page.wait_for_timeout(600)
    page.evaluate("overlay.x=0.5; overlay.y=0.66; overlay.size=0.30; drawStage(); "
                  "patch.on = true; syncPatchUI();")
    page.evaluate("() => { overlay.keyed = true; updateMotionUI(); "
                  "setKeyAt(0, {x:0.42,y:0.62,size:0.28,rot:0}); "
                  "setKeyAt(Math.round(state.frames.length*0.6), {x:0.58,y:0.66,size:0.3,rot:8}); "
                  "updateMotionUI(); drawOverview(); }")
    page.wait_for_timeout(600)

    print("mouth and motion")
    tab(page, "mouth")
    shot(page, "08-mouth", "#tab-mouth", [
        ("#styleBtn-builtin", "tr"),
        ("#styleBtn-mine", "tr"),
        ("#styles", "l"),
        ("#chart", "r"),
    ])
    page.click("#styleBtn-mine")
    page.wait_for_timeout(300)
    shot(page, "09-custom-lips", "#tab-mouth .panel:first-of-type", [
        ("#lipsets", "l"),
        ("#lipsPick", "r"),
    ])
    page.click("#styleBtn-builtin")
    page.wait_for_timeout(300)

    shot(page, "10-placement", ".stage-panel", [
        ("#stageStack", "r"),
        ("#overlaySize", "t"),
        ("#overlayAngle", "t"),
        ("#overlayReset", "t"),
    ])
    shot(page, "11-motion", "#motionPanel", [
        ("#patchOn", "l"),
        ("#patchBlur", "t"),
        ("#patchCover", "t"),
        ("#keyToggle", "b"),
        ("#keyPrev", "b"),
        ("#keyAdd", "b"),
        ("#keyDel", "b"),
        ("#keyCount", "b"),
    ])
    plain(page, "12-script", "#scriptBar")

    print("export, single clip")
    tab(page, "export")
    page.wait_for_timeout(400)
    shot(page, "13-export-card", ".expgrid .exp:nth-child(2)", [
        ("#fcpSize", "l"),
        ("#fcpFolder", "l"),
        ("#fcpCompound", "l"),
        ("#audFcp", "l"),
        ("#estFcp", "r"),
        ("#expFcp", "l"),
    ])
    shot(page, "13b-output-size", "#tab-export .field", [("#outSize", "r")])

    print("a queue")
    page.goto(URL)
    page.wait_for_timeout(1200)
    page.evaluate("() => document.documentElement.setAttribute('data-theme','light')")
    page.select_option("#fps", "12")
    load(page, "trim-marks.wav")
    page.click("#trimAuto")
    page.wait_for_timeout(400)
    page.click("#trimCommit")
    page.wait_for_timeout(6000)
    tab(page, "mouth")
    page.evaluate("[...document.querySelectorAll('#styles .style-opt')][3].click()")
    page.wait_for_timeout(300)
    page.click("#styleToEvery2")
    page.wait_for_timeout(400)
    page.evaluate("() => openClip(queue.clips[1].id)")
    page.wait_for_timeout(3000)
    tab(page, "mouth")
    page.evaluate("[...document.querySelectorAll('#styles .style-opt')][9].click()")
    page.wait_for_timeout(300)
    page.click("#styleToEvery2")
    page.wait_for_timeout(500)
    shot(page, "14-queue", "#queueWrap", [
        ("#queueCount", "r"),
        (".qrow:nth-child(2) .qlips", "r"),
        (".qrow.on", "l"),
        (".qrow:nth-child(1) .qx", "t"),
        ("#queueAdd", "b"),
        ("#queueClear", "b"),
    ])
    shot(page, "15-lips-per-clip", "#tab-mouth .panel:first-of-type", [
        ("#styleScopeText", "l"),
        ("#styleToAll", "b"),
        ("#styleToEvery2", "b"),
    ])

    tab(page, "export")
    page.wait_for_timeout(500)
    shot(page, "16-export-batch", "#batchCard", [
        ("#batchCount", "r"),
        ("#batchHint", "l"),
        ("#batchStatus", "r"),
    ])
    shot(page, "16b-scope-toggle", ".expgrid .exp:nth-child(2)", [
        ('.scoperow[data-card="fcp"] [data-scope="queue"]', "l"),
        ('.scoperow[data-card="fcp"] [data-scope="one"]', "r"),
        ("#expFcp", "l"),
        ("#fcpBatchNote", "l"),
    ])
    plain(page, "17-export-grid", ".expgrid")

    if errs:
        print("  page errors: " + "; ".join(errs[:3]))
    ctx.close()
    b.close()

print()
if missing:
    print("A callout points at something that is not there:")
    for m in missing:
        print("  " + m)
    sys.exit(1)
print("all manual screenshots written to docs/images/")
