#!/usr/bin/env python3
"""PWA 用アイコンを生成する（開発時に一度だけ実行すればよい）。

    python scripts/tools/make_icons.py

生成物は icons/ に出力され、リポジトリにコミットする前提。
GitHub Actions 側では実行しないので Pillow は開発環境にだけあればよい。
"""

from __future__ import annotations

import os
import sys

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ICON_DIR = os.path.join(ROOT, "icons")

BACKGROUND = (15, 17, 21)
GOLD_TOP = (247, 208, 113)
GOLD_BOTTOM = (191, 135, 40)
GLYPH_COLOR = (32, 25, 8)

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\YuGothB.ttc",
    r"C:\Windows\Fonts\meiryob.ttc",
    r"C:\Windows\Fonts\msgothic.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
    "/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc",
]


def load_font(size: int):
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def gold_gradient(size: int) -> Image.Image:
    gradient = Image.new("RGB", (1, size))
    pixels = gradient.load()
    for y in range(size):
        ratio = y / max(1, size - 1)
        pixels[0, y] = tuple(
            round(GOLD_TOP[i] + (GOLD_BOTTOM[i] - GOLD_TOP[i]) * ratio) for i in range(3)
        )
    return gradient.resize((size, size), Image.BILINEAR)


def rounded_mask(size: int, radius_ratio: float) -> Image.Image:
    mask = Image.new("L", (size * 4, size * 4), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle(
        (0, 0, size * 4 - 1, size * 4 - 1),
        radius=int(size * 4 * radius_ratio),
        fill=255,
    )
    return mask.resize((size, size), Image.LANCZOS)


def draw_glyph(image: Image.Image, scale: float) -> None:
    size = image.size[0]
    draw = ImageDraw.Draw(image)
    font = load_font(int(size * scale))
    box = draw.textbbox((0, 0), "金", font=font)
    x = (size - (box[2] - box[0])) / 2 - box[0]
    y = (size - (box[3] - box[1])) / 2 - box[1]
    draw.text((x, y), "金", font=font, fill=GLYPH_COLOR)


def build(size: int, radius_ratio: float, glyph_scale: float, padding_ratio: float = 0.0) -> Image.Image:
    canvas = Image.new("RGB", (size, size), BACKGROUND)
    inner = size - int(size * padding_ratio * 2)
    tile = gold_gradient(inner)
    tile.putalpha(rounded_mask(inner, radius_ratio))
    draw_glyph(tile, glyph_scale)
    offset = (size - inner) // 2
    canvas.paste(tile, (offset, offset), tile)
    return canvas


FAVICON_SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#f7d071"/>
      <stop offset="100%" stop-color="#bf8728"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="14" fill="url(#g)"/>
  <text x="32" y="45" text-anchor="middle" font-size="40" font-weight="700"
        font-family="Hiragino Sans, Yu Gothic, Noto Sans JP, sans-serif" fill="#201908">金</text>
</svg>
"""


def main() -> int:
    os.makedirs(ICON_DIR, exist_ok=True)

    build(192, 0.22, 0.62).save(os.path.join(ICON_DIR, "icon-192.png"))
    build(512, 0.22, 0.62).save(os.path.join(ICON_DIR, "icon-512.png"))
    build(180, 0.0, 0.62).save(os.path.join(ICON_DIR, "apple-touch-icon.png"))
    # マスカブルは端が切り落とされるため、余白を広めに取る。
    build(512, 0.5, 0.42, padding_ratio=0.06).save(
        os.path.join(ICON_DIR, "icon-maskable-512.png")
    )

    with open(os.path.join(ICON_DIR, "favicon.svg"), "w", encoding="utf-8") as handle:
        handle.write(FAVICON_SVG)

    for name in sorted(os.listdir(ICON_DIR)):
        path = os.path.join(ICON_DIR, name)
        print(name, os.path.getsize(path), "bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
