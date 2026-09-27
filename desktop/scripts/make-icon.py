"""Build desktop/build/icon.png (1024x1024) from desktop/build/logo.png.

electron-builder turns build/icon.png into the macOS .icns and Windows .ico, so this one PNG is
the app icon everywhere. Replace logo.png (any size of at least ~700px wide; SVG not needed) and
run:  uv run --with pillow python scripts/make-icon.py
"""
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
BUILD = os.path.join(HERE, "..", "build")
SIZE, TILE, RADIUS = 1024, 824, 185  # macOS icon grid: an 824px rounded square on a 1024 canvas

logo = Image.open(os.path.join(BUILD, "logo.png")).convert("RGBA")
icon = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
margin = (SIZE - TILE) // 2
ImageDraw.Draw(icon).rounded_rectangle(
    [margin, margin, SIZE - margin, SIZE - margin], radius=RADIUS,
    fill=(250, 248, 242, 255), outline=(226, 222, 212, 255), width=4,
)
width = 660
height = round(logo.height * width / logo.width)
logo = logo.resize((width, height), Image.LANCZOS)
icon.alpha_composite(logo, ((SIZE - width) // 2, (SIZE - height) // 2 + 8))
icon.save(os.path.join(BUILD, "icon.png"))
print("wrote build/icon.png", icon.size)
