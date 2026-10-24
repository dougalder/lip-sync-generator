#!/usr/bin/env python3
"""Comic furniture, and a box you can grab by any corner.

   Two claims, both about pixels rather than about state:

   - a balloon, a cloud, a shout, a whisper, a caption and a banner each draw
     something different, with the words inside them, and the tail goes where
     it is aimed;
   - all four corners of the placement box resize the layer, from whichever
     direction is in front of you.

       python3 comictest.py
"""
import base64, io, math, pathlib, sys
from playwright.sync_api import sync_playwright
from PIL import Image

HERE = pathlib.Path(__file__).parent
OUT = HERE / "shots"
OUT.mkdir(exist_ok=True)
URL = (HERE / "lip-sync-generator.html").resolve().as_uri()
VOICE = HERE / "speech.wav"

KINDS = ["speech", "thought", "burst", "whisper", "caption", "banner"]
fails = []


def check(cond, msg):
    if not cond:
        fails.append(msg)
        print("  FAIL  " + msg)
    else:
        print("  ok    " + msg)


W = H = 300
SHOT = """(f) => {
  const c = document.createElement('canvas');
  c.width = %d; c.height = %d;
  compositeLayers(c.getContext('2d'), %d, %d, {frame: 0, pose: poseAt(0)});
  return c.toDataURL('image/png');
}""" % (W, H, W, H)


def pixels(url):
    return Image.open(io.BytesIO(base64.b64decode(url.split(",", 1)[1]))).convert("RGBA")


def coords(im):
    return [(x, y) for y in range(im.height) for x in range(im.width)]


def ink(im):
    """Where the drawing is: the pixels that are not transparent."""
    return {xy for xy, p in zip(coords(im), list(im.getdata())) if p[3] > 24}


def differs(a, b):
    """Which pixels actually CHANGED colour between two renders.

    Not "which became opaque": words are drawn in black on a balloon that is
    already white, so the alpha channel is identical with and without them and
    an ink-only comparison says nothing was drawn."""
    return {xy for xy, pa, pb in zip(coords(a), list(a.getdata()), list(b.getdata()))
            if pa != pb}


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

        print("\n1. the shape list offers the comic set")
        pg.click("#tabBtn-inputs")
        pg.wait_for_timeout(400)
        opts = pg.evaluate("() => SHAPE_KINDS.map(k => k[0])")
        print("   shapes:", opts)
        for k in KINDS:
            check(k in opts, "%s is offered" % k)
        check(pg.is_visible("#layerAddBalloon"), "and a balloon is one press away")

        print("\n2. one press gives a balloon with words in it")
        pg.click("#layerAddBalloon")
        pg.wait_for_timeout(600)
        L = pg.evaluate("""() => { const L = layers[layers.length - 1];
          return {kind: L.kind, shape: L.shape, text: L.text, tail: L.tailAt}; }""")
        print("   layer:", L)
        check(L["kind"] == "shape" and L["shape"] == "speech", "it is a speech balloon (%r)" % L)
        check(bool(L["text"]), "with something written in it (%r)" % L["text"])

        print("\n3. each shape draws something of its own")
        seen = {}
        for k in KINDS:
            pg.evaluate("""(k) => {
              const L = layers[layers.length - 1];
              L.shape = k; L.text = 'ABC';
              L.pose = {x: 0.5, y: 0.5, size: 0.6, rot: 0};
              bankLayers(); drawStage();
            }""", k)
            pg.wait_for_timeout(250)
            im = pixels(pg.evaluate(SHOT, 0))
            seen[k] = ink(im)
            im.save(OUT / ("comic-%s.png" % k))
        for k in KINDS:
            check(len(seen[k]) > 400, "%s puts ink on the frame (%d px)" % (k, len(seen[k])))
        pairs = [(a, b2) for i, a in enumerate(KINDS) for b2 in KINDS[i + 1:]]
        same = [(a, b2) for a, b2 in pairs if seen[a] == seen[b2]]
        check(not same, "and no two are the same drawing (%r)" % (same,))

        print("\n4. the words are inside the balloon, not beside it")
        # With words and without: the difference has to land INSIDE the shape.
        pg.evaluate("""() => { const L = layers[layers.length - 1];
          L.shape = 'speech'; L.text = ''; bankLayers(); drawStage(); }""")
        pg.wait_for_timeout(250)
        empty = pixels(pg.evaluate(SHOT, 0))
        pg.evaluate("""() => { const L = layers[layers.length - 1];
          L.text = 'HELLO'; bankLayers(); drawStage(); }""")
        pg.wait_for_timeout(250)
        worded = pixels(pg.evaluate(SHOT, 0))
        added = differs(empty, worded)
        print("   words added %d px" % len(added))
        check(len(added) > 80, "the words were drawn (%d px)" % len(added))
        # The balloon's own box, in the same 300px frame.
        bx = pg.evaluate("""() => { const L = layers[layers.length - 1];
          const b = layerBox(L, %d, %d);
          return {cx: b.cx, cy: b.cy, w: b.w, h: b.h}; }""" % (W, H))
        inside = [1 for (x, y) in added
                  if abs(x - bx["cx"]) < bx["w"] / 2 and abs(y - bx["cy"]) < bx["h"] / 2]
        check(len(inside) == len(added),
              "and every one of them inside the balloon (%d of %d)" % (len(inside), len(added)))

        print("\n5. the tail goes where it is aimed")
        def tail_side(deg):
            pg.evaluate("""(d) => { const L = layers[layers.length - 1];
              L.shape = 'speech'; L.text = ''; L.tailAt = d; L.tailLen = 0.9;
              bankLayers(); drawStage(); }""", deg)
            pg.wait_for_timeout(250)
            px = ink(pixels(pg.evaluate(SHOT, 0)))
            # The furthest ink from the centre is the tip of the tail.
            far = max(px, key=lambda q: (q[0] - bx["cx"]) ** 2 + (q[1] - bx["cy"]) ** 2)
            return math.degrees(math.atan2(far[1] - bx["cy"], far[0] - bx["cx"])) % 360
        for want in (0, 90, 180, 270):
            got = tail_side(want)
            d = min((got - want) % 360, (want - got) % 360)
            check(d < 35, "aimed at %d°, the tip is at %d° (%d° out)" % (want, got, d))

        print("\n6. all four corners resize")
        pg.evaluate("""() => {
          const L = layers[layers.length - 1];
          L.shape = 'speech'; L.text = ''; L.tailLen = 0;
          L.pose = {x: 0.5, y: 0.5, size: 0.4, rot: 0};
          selectLayer(L.id); bankLayers(); renderLayerPanel(); drawStage();
        }""")
        pg.wait_for_timeout(300)
        n = pg.evaluate("""() => {
          const s = document.getElementById('stage');
          return overlayHandles(activeBox(s.width, s.height), s.width, s.height).corners.length;
        }""")
        check(n == 4, "the box has four handles (%d)" % n)
        for i in range(4):
            pg.evaluate("""() => { const L = layers[layers.length - 1];
              L.pose.size = 0.4; bankLayers(); drawStage(); }""")
            pg.wait_for_timeout(200)
            pg.evaluate("() => document.getElementById('stageWrap')"
                        ".scrollIntoView({block: 'center'})")
            pg.wait_for_timeout(150)
            h = pg.evaluate("""(i) => {
              const s = document.getElementById('stage');
              const r = s.getBoundingClientRect();
              const b = activeBox(s.width, s.height);
              const q = overlayHandles(b, s.width, s.height).corners[i];
              const c = Math.cos(b.rot), sn = Math.sin(b.rot);
              const px = b.cx + q.x * c - q.y * sn, py = b.cy + q.x * sn + q.y * c;
              return {x: r.left + px / s.width * r.width,
                      y: r.top + py / s.height * r.height,
                      ux: Math.sign(q.x), uy: Math.sign(q.y)};
            }""", i)
            # Pull the corner OUTWARD, away from the centre, whichever way that is.
            drag(pg, h["x"], h["y"], h["x"] + 45 * h["ux"], h["y"] + 45 * h["uy"])
            pg.wait_for_timeout(250)
            now = pg.evaluate("() => layers[layers.length - 1].pose.size")
            check(now > 0.44, "corner %d grew it (0.40 -> %.2f)" % (i, now))

        pg.locator("#stageWrap").screenshot(path=str(OUT / "comic-handles.png"))
        check(not errs, "no page errors (%r)" % (errs[:4],))
        b.close()


run()
print()
if fails:
    print("%d failed:" % len(fails))
    for f in fails:
        print("  - " + f)
    sys.exit(1)
print("balloons draw, and every corner resizes")
