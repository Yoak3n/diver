"""Emit a high-res Diver brand source icon for `cargo tauri icon`."""
from __future__ import annotations

import math
from PIL import Image, ImageDraw

INK = (44, 42, 38, 255)  # #2c2a26
PAPER = (247, 246, 243, 255)  # #f7f6f3
SIZE = 1024
OUT = r"E:\Project\RustProject\diver\src-tauri\app-icon.png"


def main() -> None:
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    # 圆角墨底（透明外角，便于 iOS/桌面自适应）
    mask = Image.new("L", (SIZE, SIZE), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle((0, 0, SIZE - 1, SIZE - 1), radius=int(SIZE * 0.22), fill=255)
    fill = Image.new("RGBA", (SIZE, SIZE), INK)
    img.paste(fill, (0, 0), mask)

    # 四角星 ✦
    star = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    ds = ImageDraw.Draw(star)
    cx = cy = SIZE / 2
    R = SIZE * 0.28
    waist = SIZE * 0.055
    pts = []
    for ang_deg in (270, 0, 90, 180):
        a = math.radians(ang_deg)
        pts.append((cx + R * math.cos(a), cy + R * math.sin(a)))
        b = math.radians(ang_deg + 45)
        pts.append((cx + waist * math.cos(b), cy + waist * math.sin(b)))
    ds.polygon(pts, fill=PAPER)
    img.alpha_composite(star)
    img.save(OUT)
    print("wrote", OUT, img.size)


if __name__ == "__main__":
    main()
