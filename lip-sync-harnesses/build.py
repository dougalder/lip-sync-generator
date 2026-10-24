#!/usr/bin/env python3
"""Stitch the source back into the one file the app ships as.

   prefix.html   head, licence note, embedded fonts, <body>, and the Rhubarb
                 payload as one enormous line. Never edited by hand — it is
                 carried across builds byte for byte.
   app.html      the stylesheet, the pre-paint theme stamp, and the markup.
   app.js        everything else.
   tail.html     </body></html>.

This file was rewritten after the original build script was lost with a
reclaimed container; the split above was recovered from a shipped build and
verified by rebuilding it byte-for-byte against the original. `python3 build.py
--verify <file>` repeats that check.
"""
import hashlib, pathlib, sys

HERE = pathlib.Path(__file__).parent


def build() -> bytes:
    out = []
    out.append((HERE / "prefix.html").read_bytes())
    out.append((HERE / "app.html").read_bytes())
    out.append(b"<script>\n")
    out.append((HERE / "app.js").read_bytes())
    out.append(b"</script>\n")
    out.append((HERE / "tail.html").read_bytes())
    return b"".join(out)


def main() -> int:
    data = build()
    if len(sys.argv) > 2 and sys.argv[1] == "--verify":
        want = pathlib.Path(sys.argv[2]).read_bytes()
        same = data == want
        print(("identical to " if same else "DIFFERS from ") + sys.argv[2])
        print(f"  built {len(data):,} bytes  sha {hashlib.sha256(data).hexdigest()[:16]}")
        print(f"  theirs {len(want):,} bytes  sha {hashlib.sha256(want).hexdigest()[:16]}")
        return 0 if same else 1

    target = HERE / "lip-sync-generator.html"
    target.write_bytes(data)
    print(f"lip-sync-generator.html  {len(data)/1024:10.1f} KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
