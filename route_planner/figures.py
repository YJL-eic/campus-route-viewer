"""Report maps and comparison charts drawn with Pillow."""

from PIL import Image, ImageDraw, ImageFont

from route_planner.config import LOOPS, OUT


def _font(size):
    candidates = [
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/STHeiti Light.ttc",
        "/System/Library/Fonts/Hiragino Sans GB.ttc",
    ]
    for path in candidates:
        try:
            return ImageFont.truetype(path, size, index=0)
        except OSError:
            continue
    return ImageFont.load_default()


def save_map(blocked, routes, path):
    import numpy as np

    scale = 2
    height, width = blocked.shape
    color = np.zeros((height, width, 3), dtype=np.uint8)
    color[:] = (214, 210, 202)
    color[blocked == 0] = (248, 245, 239)
    color[blocked == 1] = (120, 62, 68)
    canvas = np.repeat(np.repeat(color, scale, axis=0), scale, axis=1)
    image = Image.fromarray(canvas, mode="RGB")
    draw = ImageDraw.Draw(image)
    colors = {"junshan_first": (14, 116, 144), "tongji_first": (194, 90, 38)}
    for name, color_name in colors.items():
        for start, end in zip(LOOPS[name], LOOPS[name][1:]):
            route = routes[(1, 1, 1, "00", start, end)]
            if not route["feasible"]:
                continue
            cells = route["cells"]
            for (r1, c1), (r2, c2) in zip(cells, cells[1:]):
                draw.line(
                    [(c1 * scale + 1, r1 * scale + 1), (c2 * scale + 1, r2 * scale + 1)],
                    fill=color_name,
                    width=3,
                )
    image.save(path)


def save_bars(title, labels, series, path, ylabel):
    font = _font(22)
    small = _font(16)
    width, height = 1100, 640
    image = Image.new("RGB", (width, height), (255, 252, 247))
    draw = ImageDraw.Draw(image)
    draw.text((40, 24), title, fill=(28, 32, 38), font=font)
    left, top, right, bottom = 80, 90, 1040, 520
    peak = max(max(values) for values in series.values()) or 1
    group = (right - left) / max(len(labels), 1)
    bar_w = group / (len(series) + 1)
    palette = [(14, 116, 144), (194, 90, 38), (46, 125, 90), (92, 78, 140)]
    for index, (name, values) in enumerate(series.items()):
        color = palette[index % len(palette)]
        for item, value in enumerate(values):
            x = left + item * group + (index + 0.5) * bar_w
            y = bottom - (value / peak) * (bottom - top)
            draw.rectangle([x, y, x + bar_w * 0.8, bottom], fill=color)
            label = f"{value:.1f}"
            draw.text((x, max(top, y - 22)), label, fill=(40, 44, 50), font=small)
        draw.rectangle([40 + index * 180, 560, 64 + index * 180, 584], fill=color)
        draw.text((72 + index * 180, 558), name, fill=(28, 32, 38), font=small)
    for item, label in enumerate(labels):
        draw.text((left + item * group + 8, bottom + 8), label, fill=(28, 32, 38), font=small)
    draw.text((24, 80), ylabel, fill=(80, 84, 90), font=small)
    draw.line([(left, top), (left, bottom), (right, bottom)], fill=(40, 40, 40), width=2)
    image.save(path)
    OUT.mkdir(parents=True, exist_ok=True)
