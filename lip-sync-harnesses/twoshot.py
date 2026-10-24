#!/usr/bin/env python3
"""Two characters on screen at once, the mouth moving on whichever is talking.

   The claim is not "a panel appeared". It is that at any moment exactly one of
   the two faces has a moving mouth and the other has a resting one, and that
   this holds in the EXPORT path rather than only in the preview. So the checks
   render exact frames through the compositor and read the pixels in each
   character's own half of the frame.

       python3 twoshot.py
"""
import base64, io, pathlib, sys
from playwright.sync_api import sync_playwright
from PIL import Image

HERE = pathlib.Path(__file__).parent
OUT = HERE / "shots"
OUT.mkdir(exist_ok=True)
URL = (HERE / "lip-sync-generator.html").resolve().as_uri()
VOICE = HERE / "trim-marks.wav"          # the one with real pauses in it

fails = []


def check(cond, msg):
    if not cond:
        fails.append(msg)
        print("  FAIL  " + msg)
    else:
        print("  ok    " + msg)


W = H = 320
SHOT = """(f) => {
  const c = document.createElement('canvas');
  c.width = %d; c.height = %d;
  compositeLayers(c.getContext('2d'), %d, %d, {frame: f, pose: poseAt(f)});
  return c.toDataURL('image/png');
}""" % (W, H, W, H)


def half(url, side):
    """The pixels of one character's half of the frame."""
    im = Image.open(io.BytesIO(base64.b64decode(url.split(",", 1)[1]))).convert("RGBA")
    box = (0, 0, W // 2, H) if side == "left" else (W // 2, 0, W, H)
    return im.crop(box).tobytes()


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
        pg.wait_for_timeout(10000)

        print("\n1. two drawn faces, side by side, both on screen")
        pg.evaluate("""async () => {
          // Two of the app's own drawn faces, as picture layers — one left,
          // one right, both visible for the whole clip.
          for (const kind of ['woman', 'older']) {
            const f = await faceFile(kind);
            await addImageLayerFromFile(f);
            const L = layers.filter(x => x.kind === 'image').pop();
            L.name = kind;
            L.pose = {x: kind === 'woman' ? 0.26 : 0.74, y: 0.5, size: 0.46, rot: 0};
          }
          setCanvas('fixed', 1920, 1080);
          bankLayers(); drawStage();
        }""")
        pg.wait_for_timeout(1500)
        kinds = pg.evaluate("() => layers.map(L => [L.kind, L.name])")
        print("   layers:", kinds)
        check(sum(1 for k, _ in kinds if k == "image") == 2, "two characters (%r)" % kinds)

        print("\n2. each gets its own mouth spot")
        pg.evaluate("""() => {
          const st = document.getElementById('stage');
          layers.filter(L => L.kind === 'image').forEach(L => {
            // Roughly where a mouth sits on these drawings.
            L.mouthSpot = {x: 0.5, y: 0.55, size: 0.22, rot: 0};
          });
          liftMouthOverFaces();
          bankLayers(); renderLayerPanel(); drawStage();
        }""")
        pg.click("#tabBtn-inputs")
        pg.wait_for_timeout(500)
        spots = pg.evaluate("() => mouthSpotLayers().map(L => L.name)")
        check(spots == ["woman", "older"], "both are pinned (%r)" % spots)
        check(not pg.is_hidden("#turnsWrap"),
              "and the turns panel appears now there are two to choose between")

        print("\n3. the split points become the turns")
        n = pg.evaluate("""() => {
          const c = activeClip();
          c.marks = silenceCuts(0.25);
          seedTurns(c);
          renderTurns();
          return (c.turns || []).length;
        }""")
        pg.wait_for_timeout(400)
        turns = pg.evaluate("""() => activeClip().turns.map(t =>
          [+t.from.toFixed(2), +t.to.toFixed(2), (layerById(t.layerId)||{}).name || null])""")
        print("   turns:", turns)
        check(n >= 3, "the pauses divided the take into stretches (%d)" % n)
        check(all(t[2] for t in turns), "every stretch has a speaker")
        check(turns[0][2] != turns[1][2], "and they alternate (%s then %s)"
              % (turns[0][2], turns[1][2]))
        rows = pg.eval_on_selector_all(".trow select", "els => els.length")
        check(rows == n, "the list shows one picker per stretch (%d)" % rows)

        print("\n4. the mouth moves on the speaker and rests on the listener")
        # A frame well inside turn 1 (the woman, on the left) and one well
        # inside turn 2 (the older man, on the right).
        fps = pg.evaluate("() => state.fps")
        mid = lambda i: int((turns[i][0] + turns[i][1]) / 2 * fps)
        a, b2 = mid(0), mid(1)
        print("   sampling frames %d and %d" % (a, b2))
        # Over a run of frames the SPEAKER's half must change (the shape moves)
        # and the LISTENER's half must not (it is held at rest).
        def run_of(f0, k=8):
            return [pg.evaluate(SHOT, f0 + j) for j in range(k)]
        t1 = run_of(a)
        t2 = run_of(b2)
        l1 = {half(u, "left") for u in t1}
        r1 = {half(u, "right") for u in t1}
        l2 = {half(u, "left") for u in t2}
        r2 = {half(u, "right") for u in t2}
        print("   turn 1: left %d states, right %d" % (len(l1), len(r1)))
        print("   turn 2: left %d states, right %d" % (len(l2), len(r2)))
        check(len(l1) > 1, "on her turn the woman's mouth moves (%d states)" % len(l1))
        check(len(r1) == 1, "while his stays shut (%d states)" % len(r1))
        check(len(r2) > 1, "on his turn the man's mouth moves (%d states)" % len(r2))
        check(len(l2) == 1, "while hers stays shut (%d states)" % len(l2))

        print("\n5. the mouth is pinned TO the character, not to the frame")
        before = pg.evaluate("""() => {
          const st = document.getElementById('stage');
          const L = layers.find(x => x.name === 'woman');
          const b = mouthSpotBox(L, st.width, st.height);
          return {cx: +b.cx.toFixed(2), cy: +b.cy.toFixed(2), s: +b.s.toFixed(2)};
        }""")
        after = pg.evaluate("""() => {
          const st = document.getElementById('stage');
          const L = layers.find(x => x.name === 'woman');
          L.pose.x = 0.18; L.pose.size = 0.30;     // move her and shrink her
          const b = mouthSpotBox(L, st.width, st.height);
          return {cx: +b.cx.toFixed(2), cy: +b.cy.toFixed(2), s: +b.s.toFixed(2)};
        }""")
        print("   mouth box %r -> %r" % (before, after))
        check(after["cx"] < before["cx"] - 1, "moving her took her mouth with her")
        check(after["s"] < before["s"] - 1, "and shrinking her shrank it")
        pg.evaluate("() => { const L = layers.find(x => x.name === 'woman');"
                    "  L.pose.x = 0.26; L.pose.size = 0.46; bankLayers(); drawStage(); }")

        print("\n6. the turns survive a split point moving")
        moved = pg.evaluate("""() => {
          const c = activeClip();
          const was = c.turns.map(t => (layerById(t.layerId)||{}).name || null);
          // Drop an extra mark in the FIRST stretch: an index-based carry
          // would shunt every later line onto the wrong person.
          c.marks = [...c.marks, clipToSrc(c, c.turns[0].to * 0.5)].sort((a,b)=>a-b);
          rebuildTurns(c);
          return {was, now: c.turns.map(t => (layerById(t.layerId)||{}).name || null)};
        }""")
        print("   %r -> %r" % (moved["was"], moved["now"]))
        check(len(moved["now"]) == len(moved["was"]) + 1, "an extra stretch appeared")
        check(moved["now"][-1] == moved["was"][-1],
              "and the last line still belongs to who it did")
        check(moved["now"][0] == moved["was"][0],
              "as does the first")

        print("\n7. a character can arrive and leave")
        pg.evaluate("""() => {
          const c = activeClip();
          c.marks = []; rebuildTurns(c);
          const L = layers.find(x => x.name === 'older');
          L.from = 2; L.to = null;
          bankLayers(); drawStage();
        }""")
        pg.wait_for_timeout(300)
        early = half(pg.evaluate(SHOT, 2), "right")
        late = half(pg.evaluate(SHOT, int(3 * fps)), "right")
        blank = Image.new("RGBA", (W // 2, H)).tobytes()
        check(early == blank, "before his time his half of the frame is empty")
        check(late != blank, "and after it he is there")
        pg.evaluate("() => { const L = layers.find(x => x.name === 'older');"
                    "  L.from = null; bankLayers(); drawStage(); }")

        pg.locator("#stageWrap").screenshot(path=str(OUT / "twoshot-stage.png"))
        pg.screenshot(path=str(OUT / "twoshot-turns.png"))
        check(not errs, "no page errors (%r)" % (errs[:4],))
        b.close()


run()
print()
if fails:
    print("%d failed:" % len(fails))
    for f in fails:
        print("  - " + f)
    sys.exit(1)
print("two on screen, and the mouth moves on whoever is talking")
