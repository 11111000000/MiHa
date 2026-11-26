#!/usr/bin/env python3
"""
The geometry check for the site's inline diagrams.

For every <svg> in site/index.html it estimates the bounding box of each
text (mono width ≈ 0.62 × font-size per character), and checks:

  - texts do not overlap each other;
  - texts, rects and lines stay inside the viewBox.

Exits non-zero with one line per problem. The width estimate is a lower
bound by design: if it says "fits", a marginal overflow is still possible,
so run the diagrams through a renderer when in doubt.
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PAGE = ROOT / "site" / "index.html"

text_re = re.compile(r'<text x="(-?[\d.]+)"([^>]*)y="(-?[\d.]+)"([^>]*)>([^<]*)</text>')
rect_re = re.compile(r'<rect x="(-?[\d.]+)" y="(-?[\d.]+)" width="([\d.]+)" height="([\d.]+)"')
line_re = re.compile(r'<line x1="(-?[\d.]+)" y1="(-?[\d.]+)" x2="(-?[\d.]+)" y2="(-?[\d.]+)"')

def char_width(font_size: float) -> float:
    return font_size * 0.62

def text_box(x, y, attrs, content):
    fs_m = re.search(r'font-size="([\d.]+)"', attrs)
    fs = float(fs_m.group(1)) if fs_m else 11.5
    an_m = re.search(r'text-anchor="(\w+)"', attrs)
    anchor = an_m.group(1) if an_m else "start"
    w = len(content) * char_width(fs)
    x0 = x - (w if anchor == "end" else w / 2 if anchor == "middle" else 0)
    return x0, x0 + w, y - fs, y + 2, content

def main() -> int:
    page = PAGE.read_text()
    findings: list[str] = []
    svgs = [(m.group(1), m.group(0)) for m in
            re.finditer(r'<svg viewBox="([^"]+)"[^>]*>(.*?)</svg>', page, re.S)]
    for index, (vbw, svg) in enumerate(svgs):
        dims = re.match(r"([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)", vbw)
        if dims is None:
            findings.append(f"svg {index}: unreadable viewBox")
            continue
        width, height = float(dims.group(3)), float(dims.group(4))
        name = f"svg {index} ({width:.0f}x{height:.0f})"

        boxes = []
        for tm in text_re.finditer(svg):
            x, y = float(tm.group(1)), float(tm.group(3))
            box = text_box(x, y, tm.group(2) + tm.group(4), tm.group(5))
            boxes.append(box)
            if box[0] < -2 or box[1] > width + 2 or box[3] > height + 2:
                findings.append(f"{name}: text out of viewBox: '{box[4][:30]}'")

        for a in range(len(boxes)):
            for b in range(a + 1, len(boxes)):
                ax0, ax1, ay0, ay1, at = boxes[a]
                bx0, bx1, by0, by1, bt = boxes[b]
                if ax0 < bx1 and bx0 < ax1 and ay0 < by1 and by0 < ay1:
                    findings.append(f"{name}: texts overlap: '{at[:26]}' × '{bt[:26]}'")

        for rm in rect_re.finditer(svg):
            x, y, w, h = (float(rm.group(i)) for i in (1, 2, 3, 4))
            if x + w > width + 2 or y + h > height + 2 or x < -2 or y < -2:
                findings.append(f"{name}: rect out of viewBox ({x},{y},{w},{h})")

        for lm in line_re.finditer(svg):
            x1, y1, x2, y2 = (float(lm.group(i)) for i in (1, 2, 3, 4))
            if min(x1, x2, x2, x1) < -2 or max(x1, x2) > width + 2 or min(y1, y2) < -2 or max(y1, y2) > height + 2:
                findings.append(f"{name}: line out of viewBox ({x1},{y1})-({x2},{y2})")

    for finding in findings:
        print(finding)
    return 1 if findings else 0

if __name__ == "__main__":
    sys.exit(main())
