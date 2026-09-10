#!/usr/bin/env python3
"""The manual has to describe the app that exists.

A manual is the one document nobody checks against the thing it documents, and
it rots the moment a button is renamed. So: every control name and shortcut the
manual mentions is looked for in the built app, every image it references is
looked for on disk, and every internal link is resolved.
"""
import pathlib
import re
import sys

from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).parent
DOCS = HERE / "docs"
URL = "http://localhost:8812/lip-sync-generator.html"
fails = []


def check(name, cond, detail=""):
    print(("  ok   " if cond else "  FAIL ") + name +
          (("  — " + str(detail)) if detail and not cond else ""))
    if not cond:
        fails.append(name)


html = (DOCS / "index.html").read_text()
readme = (HERE / "README.md").read_text()

print("1. every picture the manual asks for is on disk")
for doc, pat, base in ((html, r'src="(images/[^"]+)"', DOCS),
                       (readme, r'\]\((docs/images/[^)]+)\)', HERE)):
    refs = sorted(set(re.findall(pat, doc)))
    absent = [r for r in refs if not (base / r).exists()]
    check(f"{len(refs)} referenced, none absent", not absent, str(absent))

print("2. and every picture on disk is used")
on_disk = {p.name for p in (DOCS / "images").glob("*.png")}
used = {pathlib.Path(r).name for r in re.findall(r'src="(images/[^"]+)"', html)}
used |= {pathlib.Path(r).name for r in re.findall(r'\]\((docs/images/[^)]+)\)', readme)}
check("no orphan screenshots left in the folder", on_disk <= used, str(sorted(on_disk - used)))

print("3. the contents list resolves")
ids = set(re.findall(r'\sid="([^"]+)"', html))
links = [h for h in re.findall(r'href="#([^"]+)"', html)]
dead = [l for l in links if l not in ids]
check(f"{len(links)} internal links, none dead", not dead, str(dead))

print("4. every numbered key matches its picture's callout count")
# A figure followed by an ol.keys must have exactly as many list items as the
# screenshot has callouts. The callout count is baked into the file name of the
# harness's output, so it is read from the harness's own table instead.
shots = HERE / "manualshots.py"
src = shots.read_text()
counts = {}
for m in re.finditer(r'shot\(page,\s*"([^"]+)",\s*"[^"]*",\s*\[(.*?)\]\s*\)', src, re.S):
    name, body = m.group(1), m.group(2)
    counts[name] = len(re.findall(r'\(\s*[\'"]', body))
for m in re.finditer(r'<img src="images/([^."]+)\.png"[^>]*>.*?</figure>\s*(<ol class="keys">(.*?)</ol>)?',
                     html, re.S):
    name, keys = m.group(1), m.group(3)
    if name not in counts:
        continue                          # a plain() shot, no callouts
    n_keys = len(re.findall(r'<li>', keys or ""))
    check(f"{name}: {counts[name]} callouts, {n_keys} entries",
          n_keys == counts[name], f"{n_keys} vs {counts[name]}")

print("5. the controls the manual names are really in the app")
# Every quoted button label in the manual, checked against the live page.
LABELS = [
    "Drop a voice track or a video", "Checkerboard", "Diagnostics",
    "Reset", "Engine", "Frame rate", "Silence gate", "Vocal tract size",
    "Minimum hold", "Close the mouth into pauses", "Detect",
    "Clear frames", "Reset all edits",
    "+ Split point", "Find the pauses", "Drop this bit", "Clear points",
    "Whole file", "Delete",
    "Add more", "Clear all",
    "Built-in lips", "Custom lips", "Use my own lips",
    "All clips", "Every other clip",
    "Blur patch", "Keyframes", "Set key", "Delete key",
    "Align to the audio",
    "Include the voice track", "Loop forever", "Compound Clip",
    "Batch Export", "Current Selection Export", "Stop",
    "Chart + exposure sheet", "Final Cut Pro project", "Transparent GIF",
    "Sprite sheet + atlas", "Frame sequence", "Chroma-key MP4",
    "Video with mouth overlay",
]

def sweep(p):
    """The visible text of every tab, including the custom-lips sub-tab.

    innerText, not the DOM: a control on a hidden pane exists but cannot be
    reached, and a manual that names it is describing something the reader
    cannot find.
    """
    out = ""
    for t in ("analysis", "mouth", "export"):
        p.click("#tabBtn-" + t)
        p.wait_for_timeout(280)
        out += p.evaluate("() => document.body.innerText")
        if t == "mouth":
            p.click("#styleBtn-mine")
            p.wait_for_timeout(280)
            out += p.evaluate("() => document.body.innerText")
            p.click("#styleBtn-builtin")
            p.wait_for_timeout(180)
    return out


with sync_playwright() as pw:
    b = pw.chromium.launch()
    ctx = b.new_context(viewport={"width": 1480, "height": 1100})
    p = ctx.new_page()
    p.goto(URL)
    p.wait_for_timeout(1200)

    # Several states, because plenty of controls only exist in one of them: the
    # drop area goes once a queue is up, "Clear points" only exists while split
    # points are down, and the keyframe row needs a video. Sweeping one state
    # would report the manual as wrong about controls that are perfectly real.
    text = sweep(p)                                   # empty
    p.click("#tabBtn-analysis"); p.wait_for_timeout(250)
    p.select_option("#fps", "12")
    p.set_input_files("#fileInput", str(HERE / "codec-vp9.mp4"))
    p.wait_for_function("state.frames.length > 0", timeout=120000)
    p.wait_for_timeout(1200)
    text += sweep(p)                                  # a video, on its own
    p.click("#trimAuto"); p.wait_for_timeout(500)
    text += sweep(p)                                  # with split points down
    p.click("#trimCommit"); p.wait_for_timeout(6000)
    text += sweep(p)                                  # a queue
    # The Stop button only exists while a run is going.
    p.click("#tabBtn-export"); p.wait_for_timeout(300)
    p.evaluate("() => { batchRunning = true; "
               "document.getElementById('batchStop').hidden = false; }")
    p.wait_for_timeout(150)
    text += p.evaluate("() => document.body.innerText")
    p.evaluate("() => { batchRunning = false; "
               "document.getElementById('batchStop').hidden = true; }")

    absent = [l for l in LABELS if l.lower() not in text.lower()]
    check(f"all {len(LABELS)} named controls appear in the app", not absent, str(absent))

    print("6. the shortcuts the manual promises are really wired")
    # The transport keys deliberately do nothing while a field or a button has
    # focus — space on a focused button belongs to the button. So: blur first,
    # which is the state the manual is describing.
    p.evaluate("() => { document.activeElement && document.activeElement.blur(); }")
    p.evaluate("seekTo(0)")
    p.wait_for_timeout(200)
    # Space plays
    p.keyboard.press("Space")
    p.wait_for_timeout(700)
    check("Space starts playback", p.evaluate("playing") is True)
    p.keyboard.press("Space")
    p.wait_for_timeout(400)
    check("and stops it again", p.evaluate("playing") is False)
    p.evaluate("() => { document.activeElement && document.activeElement.blur(); }")
    # End / Home
    p.keyboard.press("End")
    p.wait_for_timeout(400)
    at_end = p.evaluate("playTime()")
    p.keyboard.press("Home")
    p.wait_for_timeout(400)
    at_start = p.evaluate("playTime()")
    print(f"      End -> {at_end:.2f}s, Home -> {at_start:.2f}s")
    check("End jumps to the tail", at_end > 0.5, str(at_end))
    check("Home jumps to the head", at_start < 0.1, str(at_start))
    # A letter key retimes the selection
    p.evaluate("() => { selectFrame(3, true); document.getElementById('xsScroll').focus(); }")
    p.wait_for_timeout(200)
    p.keyboard.press("g")
    p.wait_for_timeout(300)
    check("a letter key sets the shape on the sheet",
          p.evaluate("state.frames[3].v") == "G", p.evaluate("state.frames[3].v"))
    p.keyboard.press("Delete")
    p.wait_for_timeout(300)
    check("Delete clears it back to rest",
          p.evaluate("state.frames[3].v") == "X", p.evaluate("state.frames[3].v"))
    # The app takes either modifier; this runs on Linux, so Control.
    p.keyboard.press("Control+z")
    p.wait_for_timeout(300)
    check("undo puts it back", p.evaluate("state.frames[3].v") == "G",
          p.evaluate("state.frames[3].v"))

    print("7. the limits the manual quotes are the ones in the code")
    lim = p.evaluate("({clips: BATCH_MAX_CLIPS, secs: BATCH_MAX_SECONDS, bytes: BATCH_MAX_BYTES})")
    print(f"      {lim}")
    for doc, label in ((html, "manual"), (readme, "README")):
        check(f"{label} quotes the clip limit ({lim['clips']})", str(lim["clips"]) in doc)
        check(f"{label} quotes the length limit ({lim['secs']}s)", str(lim["secs"]) in doc)
        check(f"{label} quotes the size limit ({lim['bytes'] // (1024*1024)} MB)",
              str(lim["bytes"] // (1024 * 1024)) in doc)

    print("8. the nine shapes are described the way the app names them")
    names = p.evaluate("VNAME")
    vis = p.evaluate("VIS")
    check("the manual lists all nine keys",
          all(f">{v}<" in html or f"`{v}`" in readme for v in vis), str(vis))
    # The app's own one-line description of each shape should agree with the
    # manual's wording for the shape column.
    for v in vis:
        word = names[v].split("—")[0].strip()
        check(f"{v} is called “{word}” in both",
              word.lower() in html.lower() and word.lower() in readme.lower(), word)

    ctx.close(); b.close()

print()
if fails:
    print(f"{len(fails)} FAILED: " + ", ".join(fails))
    sys.exit(1)
print("the manual describes the app that exists")
