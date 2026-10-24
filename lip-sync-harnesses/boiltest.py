#!/usr/bin/env python3
"""Line boil, as a warp rather than a wobble.

   The old version shifted the whole layer rigidly. The test that catches that
   is not "the picture changed" — a rigid shift changes the picture too — it is
   "different parts of the SAME layer moved by different amounts". So this
   renders a grid of dots, tracks where each one lands, and checks that they
   disagree with each other.

       python3 boiltest.py
"""
import base64, io, pathlib, sys
from playwright.sync_api import sync_playwright
from PIL import Image

HERE = pathlib.Path(__file__).parent
OUT = HERE / "shots"
OUT.mkdir(exist_ok=True)
URL = (HERE / "lip-sync-generator.html").resolve().as_uri()
VOICE = HERE / "speech.wav"
GRID = HERE / "fixtures" / "boil-grid.png"
GROUND = HERE / "fixtures" / "boil-ground.png"

fails = []


def check(cond, msg):
    if not cond:
        fails.append(msg)
        print("  FAIL  " + msg)
    else:
        print("  ok    " + msg)


def make_grid():
    """A field of small dots. Each one is an independent marker: if the layer
       moves rigidly they all shift together, and if it warps they do not."""
    from PIL import ImageDraw
    im = Image.new("RGBA", (256, 256), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    for gy in range(6):
        for gx in range(6):
            cx, cy = 28 + gx * 40, 28 + gy * 40
            d.ellipse([cx - 6, cy - 6, cx + 6, cy + 6], fill=(20, 20, 20, 255))
    GRID.parent.mkdir(exist_ok=True)
    im.save(GRID)


# Render one exact frame through the compositor — the path every export uses.
SHOT = """(f) => {
  const W = 320, H = 320;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  compositeLayers(c.getContext('2d'), W, H, {frame: f, pose: poseAt(f)});
  return c.toDataURL('image/png');
}"""


def dots(png_data_url):
    """Centroid of every blob, found by flood-free scanning: the dots are far
       enough apart that a simple column/row clustering is enough."""
    raw = png_data_url.split(",", 1)[1]
    import base64
    im = Image.open(io.BytesIO(base64.b64decode(raw))).convert("RGBA")
    a = im.getchannel("A")
    w, h = im.size
    px = a.load()
    seen = [[False] * h for _ in range(w)]
    out = []
    for x in range(w):
        for y in range(h):
            if px[x, y] < 120 or seen[x][y]:
                continue
            stack, pts = [(x, y)], []
            seen[x][y] = True
            while stack:
                cx, cy = stack.pop()
                pts.append((cx, cy))
                for nx, ny in ((cx+1, cy), (cx-1, cy), (cx, cy+1), (cx, cy-1)):
                    if 0 <= nx < w and 0 <= ny < h and not seen[nx][ny] and px[nx, ny] >= 120:
                        seen[nx][ny] = True
                        stack.append((nx, ny))
            if len(pts) >= 6:
                out.append((sum(p[0] for p in pts) / len(pts),
                            sum(p[1] for p in pts) / len(pts)))
    return sorted(out)


def make_ground():
    """An opaque dark ground with specks on it — a starfield. Opaque so it
       reaches the frame's edge, specked so a warp of it is visible."""
    import random
    from PIL import ImageDraw
    rnd = random.Random(7)
    im = Image.new("RGBA", (256, 256), (9, 9, 16, 255))
    d = ImageDraw.Draw(im)
    for _ in range(220):
        x, y, r = rnd.randrange(256), rnd.randrange(256), rnd.choice([1, 1, 2])
        v = rnd.randrange(170, 256)
        d.ellipse([x - r, y - r, x + r, y + r], fill=(v, v, v, 255))
    GROUND.parent.mkdir(exist_ok=True)
    im.save(GROUND)


def run():
    make_grid()
    make_ground()
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
        pg.click("#tabBtn-inputs")
        pg.wait_for_timeout(400)

        print("\n0. where the settings start, and what a slider does when let go")
        d = pg.evaluate("() => ({...BOIL_DEFAULT})")
        print("   defaults:", d)
        check(d["intensity"] == 1,
              "the boil starts at its gentlest — level 1 (%r)" % (d["intensity"],))
        check(pg.evaluate("() => boil.intensity") == 1,
              "and a fresh clip is at that level too")
        pg.set_input_files("#layerImageInput", str(GRID))
        pg.wait_for_timeout(2000)
        # Turn it on, then move a slider and let go the way a hand does.
        pg.evaluate("() => { boilSetAll(true); syncBoilUI(); }")
        pg.wait_for_timeout(300)
        started = pg.evaluate("""() => {
          window.__demos = 0;
          const real = runBoilDemo;
          window.runBoilDemo = function () { window.__demos++; return real.apply(null, arguments); };
          const el = document.getElementById('boilIntensity');
          el.value = '6';
          el.dispatchEvent(new Event('input', {bubbles: true}));
          return {after_input: window.__demos};
        }""")
        pg.wait_for_timeout(400)
        check(started["after_input"] == 0,
              "dragging alone does not keep restarting it (%r)" % (started,))
        pg.evaluate("""() => {
          const el = document.getElementById('boilIntensity');
          el.dispatchEvent(new Event('change', {bubbles: true}));
        }""")
        pg.wait_for_timeout(600)
        after = pg.evaluate("() => window.__demos")
        check(after >= 1, "letting go plays it (%r demo runs)" % after)
        check(pg.evaluate("() => boil.intensity") == 6,
              "and the value it plays is the one just set")
        # A second release while the first is still going takes over rather
        # than being refused.
        pg.evaluate("""() => {
          const el = document.getElementById('boilIntensity');
          el.value = '9';
          el.dispatchEvent(new Event('input', {bubbles: true}));
          el.dispatchEvent(new Event('change', {bubbles: true}));
        }""")
        pg.wait_for_timeout(600)
        check(pg.evaluate("() => window.__demos") > after,
              "a second nudge supersedes the first rather than being ignored")
        pg.evaluate("() => { window.runBoilDemo = undefined; }")
        # The dot field alone, filling the frame, with a big amount and the
        # edge bias off so every dot is free to move.
        pg.evaluate("""() => {
          const L = layers.filter(x => x.kind === 'image').pop();
          layers = layers.filter(x => x === L);
          selectLayer(L.id);
          L.pose = {x: .5, y: .5, size: 1, rot: 0};
          boil.effect = 'jitter'; boil.intensity = 9; boil.grain = 4;
          boil.edges = 0; boil.smooth = false;
          boil.count = 3; boil.fps = 6; boil.pingpong = false; boil.seed = 1;
          boilForget();
          L.boil = false;
          bankLayers(); drawStage();
        }""")
        pg.wait_for_timeout(300)

        print("\n1. the dots are found")
        rest = dots(pg.evaluate(SHOT, 0))
        print("   %d dots with boil off" % len(rest))
        check(len(rest) >= 30, "a readable grid of dots (%d)" % len(rest))

        print("\n2. boil moves different parts by different amounts")
        pg.evaluate("""() => {
          const L = layers.filter(x => x.kind === 'image').pop();
          L.boil = true; bankLayers(); drawStage();
        }""")
        pg.wait_for_timeout(300)
        moved = dots(pg.evaluate(SHOT, 2))
        check(len(moved) >= 30, "still a readable grid when boiling (%d)" % len(moved))
        # Pair each resting dot with its NEAREST boiled one. Zipping the two
        # sorted lists looks equivalent and is not: a dot that moves far enough
        # changes its place in the sort, and the mismatched pair then reports a
        # 466px "shift" that is really two different dots being subtracted.
        def nearest(pt, pool):
            return min(pool, key=lambda q: (q[0] - pt[0]) ** 2 + (q[1] - pt[1]) ** 2)
        pairs = [(r, nearest(r, moved)) for r in rest]
        dx = [m[0] - r[0] for r, m in pairs]
        dy = [m[1] - r[1] for r, m in pairs]
        spread = max(dx) - min(dx), max(dy) - min(dy)
        print("   x shifts %.2f..%.2f, y shifts %.2f..%.2f"
              % (min(dx), max(dx), min(dy), max(dy)))
        check(max(abs(v) for v in dx + dy) > 1.0,
              "the dots moved at all (max %.2fpx)" % max(abs(v) for v in dx + dy))
        check(max(abs(v) for v in dx + dy) < 40,
              "and by a believable amount, so the dots were paired correctly "
              "(max %.2fpx)" % max(abs(v) for v in dx + dy))
        check(spread[0] > 2.0 or spread[1] > 2.0,
              "AND they disagree with each other — a warp, not a rigid shift "
              "(spread %.2f, %.2f)" % spread)

        print("\n3. it cycles a fixed set of drawings")
        # the clip runs at 12fps and the cycle at 6, so each drawing is held
        # for two clip frames — "on twos"
        shots = [pg.evaluate(SHOT, f) for f in range(12)]
        check(shots[0] == shots[1], "frames 0 and 1 are the same drawing (on twos)")
        check(shots[0] != shots[2], "frame 2 is a different drawing")
        check(shots[0] == shots[6], "and frame 6 is back to the first of three")
        check(len(set(shots)) == 3, "three distinct drawings in twelve frames (%d)"
              % len(set(shots)))
        pg.evaluate("() => { boil.count = 2; boilForget(); }")
        two = [pg.evaluate(SHOT, f) for f in range(12)]
        check(len(set(two)) == 2, "and two when asked for two (%d)" % len(set(two)))
        pg.evaluate("() => { boil.count = 4; boil.pingpong = true; boilForget(); }")
        pp = [pg.evaluate(SHOT, f) for f in range(24)]
        # four drawings ping-ponged is a six-step cycle: 0 1 2 3 2 1
        check(len(set(pp)) == 4, "four drawings, back and forth (%d distinct)"
              % len(set(pp)))
        check(pp[0] == pp[12], "and the cycle is six steps long, not four")
        pg.evaluate("() => { boil.count = 3; boil.pingpong = false; boilForget(); }")

        print("\n4. the same frame twice is the same picture")
        again = [pg.evaluate(SHOT, f) for f in range(12)]
        check(shots == again, "re-rendering gives identical frames")
        back = [pg.evaluate(SHOT, f) for f in reversed(range(12))]
        check(back == list(reversed(shots)), "and backwards agrees with forwards")
        pg.evaluate("() => { boil.seed = 42; boilForget(); }")
        other = [pg.evaluate(SHOT, f) for f in range(12)]
        check(other != shots, "a different seed gives different drawings")
        pg.evaluate("() => { boil.seed = 1; boilForget(); }")
        check([pg.evaluate(SHOT, f) for f in range(12)] == shots,
              "and the old seed brings the old ones back")

        print("\n5. the edge bias keeps flat areas still")
        # A solid square: with edges high, its middle must not move.
        pg.evaluate("""() => {
          layers.length = 0;
          addShapeLayer();
          const L = selectedLayer();
          L.kind = 'shape'; L.shape = 'rect'; L.fill = '#101010'; L.stroke = 'none';
          L.strokeW = 0; L.ar = 1; L.radius = 0;
          L.pose = {x: .5, y: .5, size: .7, rot: 0};
          L.boil = true;
          boil.edges = 100; boil.intensity = 10; boilForget();
          bankLayers(); drawStage();
        }""")
        pg.wait_for_timeout(300)
        import base64
        def centre_block(url):
            im = Image.open(io.BytesIO(base64.b64decode(url.split(",", 1)[1]))).convert("RGBA")
            return im.crop((140, 140, 180, 180)).tobytes()
        a0 = centre_block(pg.evaluate(SHOT, 0))
        a1 = centre_block(pg.evaluate(SHOT, 2))
        a2 = centre_block(pg.evaluate(SHOT, 4))
        check(a0 == a1 == a2,
              "with edges at 100 the middle of a solid block does not swim")
        # Inside a SOLID fill, a warp is invisible by construction — sampling
        # one flat colour from a slightly different place gives that colour.
        # So the comparison has to be on something with interior detail.
        pg.evaluate("""() => {
          layers.length = 0;
          boilForget();
        }""")
        pg.set_input_files("#layerImageInput", str(HERE / "fixtures" / "boil-grid.png"))
        pg.wait_for_timeout(1800)
        pg.evaluate("""() => {
          const L = layers.filter(x => x.kind === 'image').pop();
          layers = layers.filter(x => x === L);
          L.pose = {x:.5,y:.5,size:1,rot:0}; L.boil = true;
          boil.intensity = 10; boil.edges = 0; boilForget();
          bankLayers(); drawStage();
        }""")
        pg.wait_for_timeout(300)
        wide = dots(pg.evaluate(SHOT, 2))
        pg.evaluate("() => { boil.edges = 100; boilForget(); }")
        tight = dots(pg.evaluate(SHOT, 2))
        def travel(after):
            def near(pt, pool):
                return min(pool, key=lambda q: (q[0]-pt[0])**2 + (q[1]-pt[1])**2)
            return sum(((near(r, after)[0]-r[0])**2 + (near(r, after)[1]-r[1])**2) ** .5
                       for r in rest) / len(rest)
        tw, tt = travel(wide), travel(tight)
        print("   mean travel: edges 0 = %.2fpx, edges 100 = %.2fpx" % (tw, tt))
        check(tw > 0.5, "with the bias off the dots travel (%.2fpx)" % tw)
        check(abs(tw - tt) > 0.1,
              "and the bias changes how far they go (%.2f vs %.2f)" % (tw, tt))

        print("\n6. a background that fills the frame keeps its edges")
        # Reported as a white fringe all round a starfield with the boil on.
        # The cause is the warp fetching from just outside the drawing, where
        # there is nothing — so the test is simply: is there anything but the
        # background colour at the border of the finished frame?
        # A dark ground with specks on it — a starfield, which is what was
        # reported. Flat colour would pass the edge check for the wrong
        # reason: a solid fill looks the same however it is warped.
        pg.set_input_files("#layerImageInput", str(GROUND))
        pg.wait_for_timeout(2000)
        pg.evaluate("""() => {
          const L = layers.filter(x => x.kind === 'image').pop();
          layers = [L];
          selectLayer(L.id);
          L.pose = {x: .5, y: .5, size: 1.8, rot: 0};
          L.opacity = 1; L.boil = true;
          boil.effect = 'jitter'; boil.intensity = 12; boil.grain = 4;
          boil.edges = 0; boil.smooth = false; boil.count = 3; boil.fps = 6;
          boilForget(); bankLayers(); drawStage();
        }""")
        pg.wait_for_timeout(400)
        EDGE = """(f) => {
          const W = 320, H = 320;
          const c = document.createElement('canvas');
          c.width = W; c.height = H;
          const x = c.getContext('2d');
          // Magenta, not white: the ground has white specks on it, and the
          // question is whether the PAGE shows through, not whether a star
          // happens to sit on the edge.
          x.fillStyle = '#FF00FF'; x.fillRect(0, 0, W, H);
          compositeLayers(x, W, H, {frame: f, pose: poseAt(f)});
          return c.toDataURL('image/png');
        }"""
        worst = 0
        for f in (0, 2, 4, 6):
            im = Image.open(io.BytesIO(base64.b64decode(
                pg.evaluate(EDGE, f).split(",", 1)[1]))).convert("RGB")
            w, h = im.size
            px = im.load()
            border = ([(x, 0) for x in range(w)] + [(x, h - 1) for x in range(w)] +
                      [(0, y) for y in range(h)] + [(w - 1, y) for y in range(h)])
            pale = sum(1 for p in border
                       if px[p][0] > 150 and px[p][2] > 150 and px[p][1] < 90)
            worst = max(worst, pale)
            if f == 2:
                im.save(OUT / "boil-background-edge.png")
        print("   worst border: %d pixels of page showing of %d" % (worst, 320 * 4))
        check(worst == 0,
              "no page shows through at the frame's edge (%d px)" % worst)
        # The control: take the overscan away and the fringe comes back. A
        # check that cannot fail proves nothing, and this one is cheap.
        pg.evaluate("() => { window.__realOverscan = boilOverscan;"
                    " window.boilOverscan = () => 0; boilForget(); }")
        ctl = Image.open(io.BytesIO(base64.b64decode(
            pg.evaluate(EDGE, 2).split(",", 1)[1]))).convert("RGB")
        cp = ctl.load()
        bled = sum(1 for x in range(ctl.width)
                   for y in (0, ctl.height - 1)
                   if cp[x, y][0] > 150 and cp[x, y][2] > 150 and cp[x, y][1] < 90)
        ctl.save(OUT / "boil-background-edge-bare.png")
        print("   without the overscan: %d px of page on two sides" % bled)
        check(bled > 0, "and the check is a real one — remove the overscan and "
                        "the fringe is back (%d px)" % bled)
        pg.evaluate("() => { window.boilOverscan = window.__realOverscan;"
                    " boilForget(); }")

        # And the thing it is not allowed to cost: the picture still boils.
        frames = {pg.evaluate(EDGE, f) for f in (0, 2, 4)}
        check(len(frames) >= 2,
              "while the background still boils (%d distinct frames)" % len(frames))
        grown = pg.evaluate("""() => {
          const c = document.createElement('canvas');
          c.width = 320; c.height = 320;
          const x = c.getContext('2d');
          const L = layers.find(l => l.kind === 'image');
          let pad = -1;
          withBoil(x, L, 320, 320, 0, cc => drawImageLayer(cc, L, 320, 320, 0), 'k');
          boilCache.forEach(v => { if (v.pad != null) pad = Math.max(pad, v.pad); });
          return {pad, overscan: boilOverscan(320, 320)};
        }""")
        print("   overscan:", grown)
        check(grown["pad"] > 0,
              "the background was blown up to cover the warp (%r)" % (grown,))

        print("\n7. a boiled still puppet is a new picture every frame")
        # The GIF, the animated PNG and the sprite sheet all cache by viseme
        # when the plate is still — which silently threw the boil away.
        pg.evaluate("() => useFace('woman')")
        pg.wait_for_timeout(2200)
        verdict = pg.evaluate("""() => {
          const was = layers.map(L => L.boil);
          layers.forEach(L => { L.boil = false; });
          const off = everyFrameDiffers();
          layers.forEach(L => { L.boil = true; });
          const on = everyFrameDiffers();
          layers.forEach((L, i) => { L.boil = was[i]; });
          return {still: puppet.kind === 'image', off, on};
        }""")
        print("   ", verdict)
        check(verdict["still"], "the puppet is a still drawing with nothing keyed")
        check(verdict["off"] is False,
              "with the boil off the exports may reuse one picture per shape")
        check(verdict["on"] is True,
              "with it on they may not — every frame is its own (%r)" % (verdict,))

        check(not errs, "no page errors (%r)" % (errs[:4],))
        b.close()


run()
print()
if fails:
    print("%d failed:" % len(fails))
    for f in fails:
        print("  - " + f)
    sys.exit(1)
print("line boil warps the drawing, in a set of drawings that repeat")
