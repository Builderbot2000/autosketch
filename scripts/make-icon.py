"""Original 32x32 pixel-art icon for Autosketch: a blueprint cube being sketched by a pencil."""
import sys
from PIL import Image, ImageDraw

N = 32
img = Image.new("RGBA", (N, N), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# Blueprint background, rounded square with a faint grid.
BG, GRID = (24, 52, 92, 255), (36, 72, 120, 255)
d.rounded_rectangle([0, 0, N - 1, N - 1], radius=5, fill=BG)
for i in range(4, N - 1, 4):
    for j in range(2, N - 2):
        for (x, y) in ((i, j), (j, i)):
            if img.getpixel((x, y)) == BG:
                img.putpixel((x, y), GRID)

# Isometric cube (2:1 edges).
top = [(14, 5), (24, 10), (14, 15), (4, 10)]
left = [(4, 10), (14, 15), (14, 25), (4, 20)]
right = [(14, 15), (24, 10), (24, 20), (14, 25)]
d.polygon(top, fill=(150, 205, 255, 255))
d.polygon(left, fill=(80, 145, 215, 255))
d.polygon(right, fill=(48, 105, 175, 255))
# Sketchy white edges.
EDGE = (235, 246, 255, 255)
for a, b in [((14, 5), (24, 10)), ((24, 10), (14, 15)), ((14, 15), (4, 10)), ((4, 10), (14, 5)),
             ((4, 10), (4, 20)), ((4, 20), (14, 25)), ((14, 25), (24, 20)), ((24, 20), (24, 10)), ((14, 15), (14, 25))]:
    d.line([a, b], fill=EDGE, width=1)
# A dashed construction line continuing the right edge, as if still being drawn.
for k, (x, y) in enumerate([(25, 10), (26, 9), (27, 9), (28, 8)]):
    if k % 2 == 0:
        img.putpixel((x, y), EDGE)

# Pencil, from the lower right up to the cube's right corner.
YEL, YEL_D = (246, 196, 48, 255), (205, 150, 30, 255)
d.line([(28, 28), (22, 17)], fill=YEL, width=3)
d.line([(29, 27), (23, 16)], fill=YEL_D, width=1)
d.line([(22, 17), (20, 14)], fill=(232, 196, 150, 255), width=2)  # sharpened wood
img.putpixel((20, 13), (40, 40, 48, 255))  # graphite tip
img.putpixel((19, 13), (40, 40, 48, 255))
d.line([(29, 30), (28, 28)], fill=(236, 130, 150, 255), width=3)  # eraser
d.line([(28, 28), (27, 27)], fill=(190, 190, 200, 255), width=3)  # ferrule

out = img.resize((512, 512), Image.NEAREST)
out.save(sys.argv[1])
print("wrote", sys.argv[1], out.size)
