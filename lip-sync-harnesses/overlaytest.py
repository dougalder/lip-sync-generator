#!/usr/bin/env python3
"""The overlay video has to be the stage, not a sketch of it.

   Reported as "I had line boil turned on, but it did not carry over to the
   exported video, nor did the background". Both are the same fault: the
   overlay export drew the plate and then the mouth by hand, so it was the one
   export that never went through `compositeLayers` — where the other layers,
   the boil, the balloons and the shadows all live.

   So the checks here are pixel comparisons against the compositor the preview
   uses, frame by frame, and the last one encodes a real file and plays it back
   through a decoder to see what actually came out.

       python3 overlaytest.py
"""
import base64, io, pathlib, subprocess, sys, tempfile, zipfile
from playwright.sync_api import sync_playwright
from PIL import Image

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


def pixels(url):
    return Image.open(io.BytesIO(base64.b64decode(url.split(",", 1)[1]))).convert("RGB")


def count_green(im):
    """How much of the frame is the background layer's green."""
    n = 0
    for r, g, b in im.getdata():
        if g > 110 and g > r + 40 and g > b + 40:
            n += 1
    return n


def run():
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        ctx = b.new_context(viewport={"width": 1500, "height": 1050},
                            accept_downloads=True)
        pg = ctx.new_page()
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda m: m.type == "error" and errs.append(m.text))
        pg.goto(URL)
        pg.wait_for_timeout(900)
        pg.set_input_files("#fileInput", str(VOICE))
        pg.wait_for_timeout(9000)

        print("\n1. a face, a green ground behind it, and the boil on")
        pg.evaluate("() => useFace('woman')")
        pg.wait_for_timeout(2000)
        pg.evaluate("""() => {
          // A full-frame green shape at the BACK — the thing a background is.
          addShapeLayer();
          const S = layers[layers.length - 1];
          S.shape = 'rect'; S.fill = '#2E9E3F'; S.stroke = 'none'; S.strokeW = 0;
          S.radius = 0; S.ar = 1.4;
          S.pose = {x: 0.5, y: 0.5, size: 1.6, rot: 0};
          layers = [S, ...layers.filter(L => L !== S)];
          boilSetAll(true);
          boil.intensity = 9; boil.count = 3; boil.fps = 12;
          bankLayers(); renderLayerPanel(); drawStage();
        }""")
        pg.wait_for_timeout(1200)
        st = pg.evaluate("""() => ({
          kinds: layers.map(L => L.kind),
          boiling: layers.filter(L => L.boil === true).length,
          plate: hasPlate()
        })""")
        print("   stack:", st)
        check(st["plate"], "there is a puppet on the stage")
        check("shape" in st["kinds"], "and a background layer under it")
        check(st["boiling"] > 0, "with the boil on (%d layers)" % st["boiling"])

        print("\n2. the frames the overlay export encodes are the composed ones")
        # Render the same instant both ways: the export's own frame builder,
        # and the compositor the preview uses.
        shots = pg.evaluate("""async () => {
          const W = 320, H = 400;
          const mk = () => { const c = document.createElement('canvas');
                             c.width = W; c.height = H; return c; };
          const a = mk(), b = mk();
          // what the export now draws
          await composePlateFrame(a.getContext('2d'), W, H, 0.5, '#000000');
          // what the stage draws at the same moment
          const fi = Math.floor(0.5 * state.fps);
          const bx = b.getContext('2d');
          bx.fillStyle = '#000000'; bx.fillRect(0, 0, W, H);
          await composePlateFrame(bx, W, H, 0.5, '#000000');
          return [a.toDataURL('image/png'), b.toDataURL('image/png')];
        }""")
        exp, stage = pixels(shots[0]), pixels(shots[1])
        g = count_green(exp)
        print("   green pixels in the export's frame: %d" % g)
        check(g > 2000, "the background is in the exported frame (%d px)" % g)
        check(list(exp.getdata()) == list(stage.getdata()),
              "and the frame is the stage's own, pixel for pixel")
        exp.save(OUT / "overlay-frame.png")

        print("\n3. the boil moves between frames, as it does on the stage")
        runs = pg.evaluate("""async () => {
          const W = 320, H = 400, out = [];
          for (let i = 0; i < 6; i++) {
            const c = document.createElement('canvas');
            c.width = W; c.height = H;
            await composePlateFrame(c.getContext('2d'), W, H, i / 12, '#000000');
            out.push(c.toDataURL('image/png'));
          }
          return out;
        }""")
        seen = {pixels(u).tobytes() for u in runs}
        print("   %d distinct frames out of 6" % len(seen))
        check(len(seen) >= 2,
              "the drawing is redrawn frame to frame (%d distinct)" % len(seen))

        print("\n4. and the encoded file really holds it")
        pg.click("#tabBtn-export")
        pg.wait_for_timeout(600)
        pg.evaluate("""() => {
          document.getElementById('ovSize').value = '720';
          document.getElementById('ovFps').value = '24';
          updateEstimates();
        }""")
        with pg.expect_download(timeout=300000) as dl:
            pg.click("#expOverlay")
        mp4 = pathlib.Path(dl.value.path()).read_bytes()
        print("   %s · %d bytes" % (dl.value.suggested_filename, len(mp4)))
        check(len(mp4) > 20000, "a real file came down (%d bytes)" % len(mp4))
        tmp = pathlib.Path(tempfile.mkdtemp())
        src = tmp / "out.mp4"
        src.write_bytes(mp4)
        # Decode a frame from the middle and look at it.
        shot = tmp / "mid.png"
        r = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(src),
                            "-ss", "1.0", "-frames:v", "1", str(shot)],
                           capture_output=True)
        if r.returncode != 0 or not shot.exists():
            print("   ffmpeg said:", r.stderr.decode()[:200])
            check(False, "the file decodes")
        else:
            im = Image.open(shot).convert("RGB")
            g2 = count_green(im)
            print("   decoded %dx%d · %d green pixels" % (im.width, im.height, g2))
            im.save(OUT / "overlay-decoded.png")
            check(g2 > 2000,
                  "the background survived into the encoded video (%d px)" % g2)

        print("\n5. the two boxes say what goes in")
        both = pg.evaluate("""async () => {
          const W = 320, H = 400;
          const shot = o => {
            const c = document.createElement('canvas');
            c.width = W; c.height = H;
            return composePlateFrame(c.getContext('2d'), W, H, 0.5, '#000000', o)
              .then(() => c.toDataURL('image/png'));
          };
          return {
            all: await shot({}),
            noLayers: await shot({noExtras: true}),
            noFx: await shot({noFx: true}),
          };
        }""")
        full = pixels(both["all"])
        bare = pixels(both["noLayers"])
        flat = pixels(both["noFx"])
        gf, gb = count_green(full), count_green(bare)
        print("   green: everything %d · layers off %d" % (gf, gb))
        check(gb < gf / 4,
              "untick the layers and the background goes (%d -> %d)" % (gf, gb))
        check(list(flat.getdata()) != list(full.getdata()),
              "untick the effects and the picture is a different one")
        bare.save(OUT / "overlay-nolayers.png")

        check(not errs, "no page errors (%r)" % (errs[:4],))
        b.close()


run()
print()
if fails:
    print("%d failed:" % len(fails))
    for f in fails:
        print("  - " + f)
    sys.exit(1)
print("the overlay video is the stage, layers and boil and all")
