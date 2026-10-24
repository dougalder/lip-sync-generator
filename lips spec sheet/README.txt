Hand-drawn lip set for Lip Sync Generator
=========================================

Put this `lips/` folder BESIDE lip-sync-generator.html on a web server, so you
end up with:

    lip-sync-generator.html
    lips/
      hand-drawn/
        X.png A.png B.png C.png D.png E.png F.png

The sets in `lips/` are read when the page loads, and appear on the Custom lips
shelf in the Mouth tab. This only works when the page is SERVED over http —
from a file:// page the browser refuses to read the folder. For a local try:

    python3 -m http.server     # then open http://localhost:8000/...

To use the set without a server, open the Mouth tab, go to Custom lips and
pick this folder with the folder picker. That works from file:// too, but the
set lasts until you reload the tab.

Two shapes are missing, G (teeth on lip — f, v) and H (tongue — l, th), so the
chip will say 7/9 and those two frames fall back to A. Drop G.png and H.png in
beside the rest when you draw them.
