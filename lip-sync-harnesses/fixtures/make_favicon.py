#!/usr/bin/env python3
"""The favicon, drawn from the app's own mark.

   Not a separate piece of art: the two paths here are the ones in the header's
   SVG, so the tab icon and the thing at the top of the page are the same
   drawing. They are given to Path2D verbatim as SVG path data and painted on a
   canvas in a real browser, which is both exact and shorter than reimplementing
   bezier maths in PIL.

   PNG rather than SVG. An SVG favicon is smaller and scales, but support for it
   is the one thing in this area that is still uneven, and a tab icon that is
   missing in one browser is worse than a few kilobytes. Three sizes come out:
   32 and 64 for the tab, 180 for "Add to Dock" and the iOS home screen, all as
   data URIs so the file still asks the network for nothing.

       python3 fixtures/make_favicon.py      writes fixtures/favicon.txt
"""
import base64, json, pathlib
from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).parent
OUT = HERE / "favicon.txt"

# The header mark, from app.html: a lens, and the smile inside it. viewBox 22.
LENS = "M2 11c3-5 15-5 18 0-3 5-15 5-18 0Z"
SMILE = "M6.5 9.4h9c-.6 1.2-1.9 1.9-4.5 1.9S7.1 10.6 6.5 9.4Z"

JS = """
(S) => {
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const x = c.getContext('2d');
  const k = S / 22, pad = S * 0.085;          // a little air inside the tile
  // The tile. A favicon sits on whatever colour the browser's tab strip is, so
  // it carries its own background rather than relying on one.
  const r = S * 0.22;
  x.fillStyle = '#0F7EA8';
  x.beginPath();
  x.moveTo(r, 0); x.arcTo(S, 0, S, S, r); x.arcTo(S, S, 0, S, r);
  x.arcTo(0, S, 0, 0, r); x.arcTo(0, 0, S, 0, r);
  x.closePath(); x.fill();
  x.save();
  x.translate(pad, pad);
  x.scale((S - pad * 2) / S, (S - pad * 2) / S);
  x.scale(k, k);
  // Filled, not stroked. The header draws the lens as an outline with the
  // smile inside it, which is right at 34px and mud at 16: the stroke and the
  // smile merge into a blob. Filling the lens and cutting the smile out of it
  // in the tile colour keeps two tones and one silhouette, which is all a
  // favicon has room to say.
  x.fillStyle = '#FFFFFF';
  x.fill(new Path2D(%s));
  x.fillStyle = '#0F7EA8';
  x.fill(new Path2D(%s));
  x.restore();
  return c.toDataURL('image/png');
}
""" % (json.dumps(LENS), json.dumps(SMILE))

with sync_playwright() as pw:
    b = pw.chromium.launch()
    pg = b.new_page()
    pg.goto("about:blank")
    urls = {}
    for size in (32, 64, 180):
        urls[size] = pg.evaluate(JS, size)
        raw = base64.b64decode(urls[size].split(",", 1)[1])
        (HERE / ("favicon-%d.png" % size)).write_bytes(raw)
        print("  %dpx  %d bytes raw, %d as a data URI"
              % (size, len(raw), len(urls[size])))
    b.close()

OUT.write_text("\n".join(
    '<link rel="%s"%s href="%s">' % (
        "apple-touch-icon" if s == 180 else "icon",
        "" if s == 180 else ' type="image/png" sizes="%dx%d"' % (s, s),
        urls[s])
    for s in (32, 64, 180)) + "\n")
print("link tags written to", OUT)
