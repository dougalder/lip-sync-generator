#!/usr/bin/env python3
"""Draw the whole chart — nine shapes across, one style per row — at a size you
   can actually look at.

   The style chips in the app are 94px wide, which is enough to choose with and
   nowhere near enough to judge a drawing by. Every attempt to tune the profile
   construction from the chips has gone wrong in the same way: a shape reads
   fine at thumbnail size and turns out to be a slab at 240.

       python3 sheet.py profile            every style, side on
       python3 sheet.py profile glossy cartoon stubble
       python3 sheet.py front three        a whole view at a time
"""
import pathlib, sys
from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).parent
URL = (HERE / "lip-sync-generator.html").resolve().as_uri()
OUT = HERE / "shots"
OUT.mkdir(exist_ok=True)

views = [a for a in sys.argv[1:] if a in ("front", "three", "profile")] or ["profile"]
styles = [a for a in sys.argv[1:] if a not in views]

JS = """
([view, want, S]) => {
  const ids = Object.keys(STYLE_DEFS);
  const list = want.length ? want : ids;
  const cv = document.createElement('canvas');
  const pad = 10, labelW = 120, head = 26;
  cv.width = labelW + VIS.length * (S + pad) + pad;
  cv.height = head + list.length * (S + pad) + pad;
  const c = cv.getContext('2d');
  c.fillStyle = '#fff'; c.fillRect(0, 0, cv.width, cv.height);
  c.fillStyle = '#222'; c.font = '600 15px sans-serif'; c.textBaseline = 'middle';
  VIS.forEach((v, i) => c.fillText(v, labelW + i * (S + pad) + S / 2 - 4, head / 2));
  list.forEach((id, r) => {
    const y = head + r * (S + pad);
    c.fillStyle = '#222'; c.font = '600 13px sans-serif';
    c.fillText(id, 6, y + S / 2);
    VIS.forEach((v, i) => {
      const x = labelW + i * (S + pad);
      c.save(); c.translate(x, y);
      c.fillStyle = '#f2f4f7'; c.fillRect(0, 0, S, S);
      paintMouthArt(c, S, S, v, styleViewId(id, view));
      c.restore();
      c.strokeStyle = '#d6dae2'; c.strokeRect(x + .5, y + .5, S, S);
    });
  });
  return cv.toDataURL('image/png');
}
"""

with sync_playwright() as pw:
    b = pw.chromium.launch()
    pg = b.new_page(viewport={"width": 1200, "height": 800})
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(URL)
    pg.wait_for_timeout(900)
    for view in views:
        url = pg.evaluate(JS, [view, styles, 170])
        name = OUT / ("sheet-%s%s.png" % (view, "-" + "-".join(styles) if styles else ""))
        import base64
        name.write_bytes(base64.b64decode(url.split(",", 1)[1]))
        print(name, name.stat().st_size, "bytes")
    if errs:
        print("page errors:", errs[:3])
    b.close()
