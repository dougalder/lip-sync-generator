#!/usr/bin/env python3
"""Two small animations the harness can drive the app with: an animated GIF and
   an animated PNG, each six frames of an unmistakably moving shape.

   Deliberately NOT written by the app's own encoders. A decoder tested against
   the matching encoder only proves the two agree with each other; these come
   out of Pillow, which is a third party that implements the same two specs.

       python3 fixtures/make_anim.py
"""
import pathlib
from PIL import Image, ImageDraw

HERE = pathlib.Path(__file__).parent
W = H = 64
N = 6


def frame(i, rgba=True):
    im = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    # A dot that walks left to right, and a bar that grows. Both big enough to
    # show up in a pixel comparison at any scale the harness renders at.
    x = 6 + i * (W - 20) // (N - 1)
    d.ellipse([x, 8, x + 14, 22], fill=(255, 40, 40, 255))
    d.rectangle([6, 40, 6 + (i + 1) * 8, 52], fill=(40, 90, 255, 255))
    return im if rgba else im.convert("P", palette=Image.ADAPTIVE, colors=64)


def main():
    frames = [frame(i) for i in range(N)]

    # --- animated PNG ------------------------------------------------------
    apng = HERE / "anim.png"
    frames[0].save(apng, save_all=True, append_images=frames[1:],
                   duration=120, loop=0, format="PNG")
    print("wrote", apng.name, apng.stat().st_size, "bytes")

    # --- animated GIF ------------------------------------------------------
    # GIF has one transparent index rather than an alpha channel, so the frames
    # go onto a flat background first; otherwise Pillow picks its own and the
    # fixture stops matching what a real exported GIF looks like.
    gframes = []
    for f in frames:
        bg = Image.new("RGBA", (W, H), (255, 255, 255, 255))
        bg.alpha_composite(f)
        gframes.append(bg.convert("P", palette=Image.ADAPTIVE, colors=64))
    gif = HERE / "anim.gif"
    gframes[0].save(gif, save_all=True, append_images=gframes[1:],
                    duration=120, loop=0, format="GIF", disposal=2)
    print("wrote", gif.name, gif.stat().st_size, "bytes")

    for p in (apng, gif):
        im = Image.open(p)
        n = getattr(im, "n_frames", 1)
        print("  %s: %d frames, %dx%d" % (p.name, n, im.width, im.height))
        assert n == N, "%s came out with %d frames, wanted %d" % (p.name, n, N)


if __name__ == "__main__":
    main()
