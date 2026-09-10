#!/usr/bin/env python3
"""The file must reach the network for nothing at all.

The README says "nothing is uploaded", "no network request for your media" and
"you can put it on a USB stick and use it on a machine with no network at all".
Those are the strongest claims the project makes, and until now nothing checked
them — the page linked its two fonts from Google on every open, which made the
third claim plainly untrue and the other two look careless by association.

So this watches every request the page makes and insists there is nothing but
the page itself. It runs twice: once served over HTTP, and once from a file://
URL with the network refused outright, which is the USB stick for real.
"""
import pathlib
import re
import sys

from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).parent
APP = HERE / "lip-sync-generator.html"
URL = "http://localhost:8812/lip-sync-generator.html"
fails = []


def check(name, cond, detail=""):
    print(("  ok   " if cond else "  FAIL ") + name +
          (("  — " + str(detail)) if detail and not cond else ""))
    if not cond:
        fails.append(name)


print("0. the source carries no link to anywhere")
src = APP.read_text(errors="ignore")
outbound = re.findall(r'(?:href|src)\s*=\s*["\'](https?://[^"\']+)', src)
print(f"      {len(outbound)} absolute http(s) references in the built file")
check("no stylesheet, script or image is loaded from another host",
      not outbound, str(sorted(set(outbound))[:5]))
# A link a person can click is fine; one the page fetches is not. Nothing in
# this file should be doing either, so both are reported.
check("and no @import either", "@import" not in src)
check("the fonts are embedded, not referenced",
      src.count("data:font/woff2;base64,") == 6,
      f'{src.count("data:font/woff2;base64,")} embedded faces')

with sync_playwright() as pw:
    b = pw.chromium.launch()

    print("1. served over HTTP, it asks for nothing but itself")
    ctx = b.new_context()
    p = ctx.new_page()
    seen = []
    p.on("request", lambda r: seen.append(r.url))
    p.goto(URL)
    p.wait_for_timeout(2500)
    # Give it a real clip, so anything lazy has run.
    p.select_option("#fps", "12")
    p.set_input_files("#fileInput", str(HERE / "speech.wav"))
    p.wait_for_function("state.frames.length > 0", timeout=120000)
    p.wait_for_timeout(1200)
    for t in ("analysis", "mouth", "export"):
        p.click("#tabBtn-" + t)
        p.wait_for_timeout(300)

    external = [u for u in seen
                if not u.startswith(("http://localhost:8812/", "data:", "blob:"))]
    print(f"      {len(seen)} requests in total; {len(external)} left the page")
    check("nothing is fetched from anywhere else", not external, str(external[:6]))
    # The lips folder probe is expected and is same-origin; name it so the count
    # above is not mistaken for "the page fetches nothing".
    lips = [u for u in seen if "/lips" in u]
    print(f"      (of those, {len(lips)} were the optional lips/ folder, on this origin)")

    print("2. the embedded fonts actually load")
    got = p.evaluate("""() => ({
      archivo: document.fonts.check('600 16px Archivo'),
      mono: document.fonts.check('400 12px "DM Mono"'),
      loaded: [...document.fonts].map(f => f.family + ' ' + f.weight + ' ' + f.status)
    })""")
    print("      " + ", ".join(sorted(set(got["loaded"]))))
    check("Archivo is available to the page", got["archivo"], str(got["loaded"]))
    check("DM Mono is available to the page", got["mono"], str(got["loaded"]))
    check("all six faces are registered", len(got["loaded"]) == 6, str(len(got["loaded"])))
    ctx.close()

    print("3. from a file:// URL with the network refused — the USB stick")
    ctx2 = b.new_context()
    # Refuse everything that is not the file itself. If the page needs the
    # network for anything, it now fails rather than quietly succeeding because
    # the test machine happens to be online.
    blocked = []

    def gate(route, request):
        if request.url.startswith(("file://", "data:", "blob:")):
            route.continue_()
        else:
            blocked.append(request.url)
            route.abort()

    ctx2.route("**/*", gate)
    p2 = ctx2.new_page()
    errs = []
    p2.on("pageerror", lambda e: errs.append(str(e)))
    p2.goto(APP.as_uri())
    p2.wait_for_timeout(2500)
    print(f"      {len(blocked)} requests were refused")
    check("it needed nothing that was refused", not blocked, str(blocked[:5]))
    check("and it came up without throwing", not errs, "; ".join(errs[:2]))
    check("the interface is really there",
          p2.is_visible("#tabBtn-analysis") and p2.is_visible("#drop"))
    got2 = p2.evaluate("() => document.fonts.check('600 16px Archivo')")
    check("with its own fonts, offline", got2)
    # And it still works, not just renders.
    p2.select_option("#fps", "12")
    p2.set_input_files("#fileInput", str(HERE / "speech.wav"))
    p2.wait_for_function("state.frames.length > 0", timeout=120000)
    p2.wait_for_timeout(800)
    n = p2.evaluate("state.frames.length")
    print(f"      analysed {n} frames with the network cut off")
    check("a clip still analyses offline", n > 50, str(n))
    ctx2.close()

    print("4. the manual does not reach out either")
    ctx3 = b.new_context()
    p3 = ctx3.new_page()
    seen3 = []
    p3.on("request", lambda r: seen3.append(r.url))
    p3.goto("http://localhost:8812/docs/index.html")
    p3.wait_for_timeout(2000)
    ext3 = [u for u in seen3 if not u.startswith(("http://localhost:8812/", "data:"))]
    check("the HTML manual is self-contained too", not ext3, str(ext3[:5]))
    ctx3.close()

    b.close()

print()
if fails:
    print(f"{len(fails)} FAILED: " + ", ".join(fails))
    sys.exit(1)
print("the file reaches the network for nothing")
