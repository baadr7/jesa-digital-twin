"""
Combine multiple screenshots into one grid image.

Usage:
    1. Put your screenshots in the same folder as this script
    2. Edit INPUT_FILES below with your screenshot filenames
    3. Run: python combine_screenshots.py

Output: report/figures/fig29_a3_ml_ensemble_threshold.png
"""
from pathlib import Path
from PIL import Image
import math

# ── Edit these filenames to match your screenshots ──────────────────────────
INPUT_FILES = [
    "A.png",   # histogram / score distribution
    "B.png",   # threshold table
    "C.png",   # 4/4 windows detected summary
    "D.png",   # timeline plot
]
OUTPUT = "report/figures/fig29_a3_ml_ensemble_threshold.png"
COLS   = 2          # columns in grid (2x2 for 4 images, change to 1 for single column)
GAP    = 12         # gap between images in pixels
BG     = (10, 14, 26)  # background color (dark theme)
# ─────────────────────────────────────────────────────────────────────────────

root = Path(__file__).parent

# Filter to only existing files
images_paths = [root / f for f in INPUT_FILES if (root / f).exists()]
if not images_paths:
    print("No input files found. Put your screenshots in:", root)
    print("Expected files:", INPUT_FILES)
    exit(1)

print(f"Found {len(images_paths)} screenshot(s):")
for p in images_paths:
    print(f"  {p.name}")

# Open all images
imgs = [Image.open(p).convert("RGB") for p in images_paths]

# Determine grid dimensions
n    = len(imgs)
cols = min(COLS, n)
rows = math.ceil(n / cols)

# Resize all to same width (max width among inputs)
target_w = max(img.width for img in imgs)
resized  = []
for img in imgs:
    if img.width != target_w:
        ratio = target_w / img.width
        new_h = int(img.height * ratio)
        img   = img.resize((target_w, new_h), Image.LANCZOS)
    resized.append(img)

# Pad to same height per row
max_h = max(img.height for img in resized)
padded = []
for img in resized:
    if img.height < max_h:
        canvas = Image.new("RGB", (img.width, max_h), BG)
        canvas.paste(img, (0, 0))
        padded.append(canvas)
    else:
        padded.append(img)

# Build grid
total_w = cols * target_w + (cols - 1) * GAP
total_h = rows * max_h    + (rows - 1) * GAP
grid    = Image.new("RGB", (total_w, total_h), BG)

for idx, img in enumerate(padded):
    row = idx // cols
    col = idx  % cols
    x   = col * (target_w + GAP)
    y   = row * (max_h    + GAP)
    grid.paste(img, (x, y))

out_path = root / OUTPUT
out_path.parent.mkdir(parents=True, exist_ok=True)
grid.save(out_path, quality=95)

size_kb = out_path.stat().st_size // 1024
print(f"\nSaved: {out_path}")
print(f"Size:  {grid.width} x {grid.height} px  ({size_kb} KB)")
