#!/usr/bin/env python3
"""A long line is a long job, not a broken clip.

   Reported as "it exported three out of four clips". The fourth ran 1:04, and
   anything over a minute used to be marked `error: 'too long'` as it loaded —
   which a batch skips, silently, with the reason in a grey status line after
   the run had finished. Four clips were chosen; three came back.

   So: length is advisory. The clip is marked long, the batch card says what
   the run will cost BEFORE it starts, and the export takes it like any other.
   The checks below are about exactly that: what the queue shows, what the card
   says, and how many clips come out of the zip.

       python3 longclip.py
"""
import io, pathlib, sys, wave, zipfile
from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).parent
OUT = HERE / "shots"
OUT.mkdir(exist_ok=True)
URL = (HERE / "lip-sync-generator.html").resolve().as_uri()
VOICE = HERE / "speech.wav"
LONG = HERE / "fixtures" / "long-voice.wav"
CUT = 10.5          # where the one file is cut into a short piece and a long one

fails = []


def check(cond, msg):
    if not cond:
        fails.append(msg)
        print("  FAIL  " + msg)
    else:
        print("  ok    " + msg)


def make_long(seconds=76):
    """One file that runs over the minute, built by repeating the voice."""
    if LONG.exists():
        with wave.open(str(LONG)) as w:
            if w.getnframes() / w.getframerate() >= seconds - 1:
                return
    with wave.open(str(VOICE)) as w:
        p, frames = w.getparams(), w.readframes(w.getnframes())
    reps = int(seconds * p.framerate / (len(frames) / p.sampwidth / p.nchannels)) + 1
    LONG.parent.mkdir(exist_ok=True)
    with wave.open(str(LONG), "wb") as o:
        o.setparams(p)
        for _ in range(reps):
            o.writeframes(frames)


def run():
    make_long()
    with wave.open(str(LONG)) as w:
        dur = w.getnframes() / w.getframerate()
    print("   the long file runs %.1fs" % dur)

    with sync_playwright() as pw:
        b = pw.chromium.launch()
        ctx = b.new_context(viewport={"width": 1440, "height": 1100},
                            accept_downloads=True)
        pg = ctx.new_page()
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda m: m.type == "error" and errs.append(m.text))
        pg.goto(URL)
        pg.wait_for_timeout(900)
        limit = pg.evaluate("() => BATCH_MAX_SECONDS")
        check(dur > limit, "the fixture is over the limit (%.1fs > %ds)" % (dur, limit))

        pg.set_input_files("#fileInput", str(LONG))
        pg.wait_for_function("() => state.frames.length > 0", timeout=180000)
        pg.wait_for_timeout(1500)
        pg.evaluate("() => useFace('woman')")
        pg.wait_for_timeout(2200)

        print("\n1. cut it into a short piece and a long one")
        n = pg.evaluate("(t) => splitClipAt(activeClip(), [t])", CUT)
        pg.wait_for_function("() => queue.clips.length === 2 && queue.clips.every(c => (c.duration || 0) > 0)", timeout=180000)
        pg.wait_for_timeout(1500)
        clips = pg.evaluate("""() => queue.clips.map(c => ({
          name: c.name, dur: c.duration, err: c.error,
          long: clipIsLong(c), cls: clipStatus(c).cls, label: clipStatus(c).label
        }))""")
        for c in clips:
            print("   %-28s %6.2fs  %-5s %s" % (c["name"], c["dur"] or 0,
                                                c["cls"], c["label"]))
        check(n == 2 and len(clips) == 2, "two clips (%d)" % len(clips))
        long_ones = [c for c in clips if c["long"]]
        check(len(long_ones) == 1, "one of them is over the minute (%d)" % len(long_ones))

        print("\n2. a long clip is marked, not failed")
        check(not any(c["err"] for c in clips),
              "no clip is in error (%r)" % ([c["err"] for c in clips],))
        check(long_ones and long_ones[0]["cls"] == "long",
              "it carries its own mark rather than the red one (%r)"
              % (long_ones[0]["cls"] if long_ones else None,))
        check(long_ones and "does export" in long_ones[0]["label"],
              "and the queue says it still exports (%r)"
              % (long_ones[0]["label"] if long_ones else None,))

        print("\n3. the cost is stated before the run, not after it")
        pg.click("#tabBtn-export")
        pg.wait_for_timeout(600)
        hint = pg.text_content("#batchHint") or ""
        print("   …%s" % hint[-160:].strip())
        check("take a while" in hint,
              "the batch card warns that this run is a long one")
        check("still exports" in hint, "while saying it does export")

        print("\n4. and the export brings back both clips")
        pg.evaluate("""() => {
          Object.keys(EXPORT_CARDS).forEach(k => { cardScope[k] = 'queue'; });
          updateBatchUI();
        }""")
        pg.wait_for_timeout(300)
        with pg.expect_download(timeout=600000) as dl:
            pg.click("#expChart")
        zp = zipfile.ZipFile(io.BytesIO(pathlib.Path(dl.value.path()).read_bytes()))
        names = zp.namelist()
        print("   %s · %d files" % (dl.value.suggested_filename, len(names)))
        for nm in names[:12]:
            print("     " + nm)
        said = pg.text_content("#batchStatus") or ""
        print("   status: %s" % said.strip())
        check("2 of 2 exported" in said,
              "both clips went through (%r)" % said.strip())
        check("skipped" not in said, "and nothing was skipped (%r)" % said.strip())
        stems = {nm.split("-")[0] for nm in names}
        check(len(names) >= 4, "the zip holds both clips' files (%d)" % len(names))
        check(all("/" not in nm for nm in names), "all in one folder")
        csv = [nm for nm in names if nm.endswith(".csv")]
        check(len(csv) == 2, "a timing file per clip, long one included (%d)" % len(csv))

        print("\n5. and a split cannot make more clips than the queue holds")
        # The other half of the same fault: "find the pauses" on a long
        # conversation would hand back thirty pieces, the queue would take
        # them, and the batch had no way to carry the run.
        cap = pg.evaluate("() => BATCH_MAX_CLIPS")
        before = pg.evaluate("() => queue.clips.length")
        made = pg.evaluate("""() => {
          const c = queue.clips[0];
          const pts = [];
          for (let t = 0.3; t < 10.2; t += 0.25) pts.push(+t.toFixed(3));
          window.__asked = pts.length + 1;
          return splitClipAt(c, pts);
        }""")
        pg.wait_for_timeout(4000)
        asked = pg.evaluate("() => window.__asked")
        after = pg.evaluate("() => queue.clips.length")
        print("   asked for %d pieces from a queue of %d; ended with %d of %d"
              % (asked, before, after, cap))
        check(asked > cap, "the split was asked for more than the queue holds (%d)" % asked)
        check(after <= cap, "and the queue stayed inside its limit (%d)" % after)
        check(after == cap, "taking as many as it could (%d of %d)" % (after, cap))
        check(not any(c is None for c in pg.evaluate("() => queue.clips.map(c => c.id)")),
              "every clip in it is a real one")

        pg.screenshot(path=str(OUT / "longclip-queue.png"))
        check(not errs, "no page errors (%r)" % (errs[:4],))
        b.close()


run()
print()
if fails:
    print("%d failed:" % len(fails))
    for f in fails:
        print("  - " + f)
    sys.exit(1)
print("a clip over the minute is slow, and it exports")
