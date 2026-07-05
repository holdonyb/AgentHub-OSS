from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]

# Brand geometry is reverse-engineered from the original Android splash mark
# (apps/mobile/.../drawable-land-xxxhdpi/splash.png), which is the canonical logo.
# In the axis-aligned frame (before the 45° counter-clockwise rotation) the mark is
# two facing half-crosses: a full-height bar plus a single centered arm each,
# separated by a diagonal negative-space channel.
#
# All coordinates below live on a 1024x1024 design canvas.
GRAD_START = "#79D1FF"  # lower-left end of the diagonal gradient
GRAD_END = "#3EA5FF"  # upper-right end
GRAD_START_RGB = (121, 209, 255)
GRAD_END_RGB = (62, 165, 255)
# Flat per-piece approximations for surfaces that cannot carry a gradient
# (Android vector drawables): sampled at each piece's centroid on the gradient.
LIGHT_FLAT = "#67C4FF"
DARK_FLAT = "#50B2FF"
BORDER = "#DCE8F6"

# (x0, y0, x1, y1) rectangles in the axis-aligned 1024 frame.
RECTS_LIGHT = [
    (348, 234, 460, 790),  # bar
    (125, 456, 460, 568),  # arm pointing outward (left)
]
RECTS_DARK = [
    (564, 234, 676, 790),  # bar
    (564, 456, 899, 568),  # arm pointing outward (right)
]
MARK_X0, MARK_X1 = 125, 899  # gradient span across the mark

# The original mark is the axis frame rotated 45° counter-clockwise (visually).
# PIL Image.rotate(45) is counter-clockwise; SVG/Android rotate(45) is clockwise,
# so vector surfaces must use -45. Do not "fix" one side without the other.
PIL_ROTATION = 45
SVG_ROTATION = -45


def _svg_rects(scale: float = 1.0, dx: float = 0.0, dy: float = 0.0) -> str:
    parts = []
    for x0, y0, x1, y1 in RECTS_LIGHT + RECTS_DARK:
        parts.append(
            f'    <rect x="{x0 * scale + dx:g}" y="{y0 * scale + dy:g}" '
            f'width="{(x1 - x0) * scale:g}" height="{(y1 - y0) * scale:g}"/>'
        )
    return "\n".join(parts)


def _gradient_def(gid: str) -> str:
    return (
        f'<linearGradient id="{gid}" gradientUnits="userSpaceOnUse" '
        f'x1="{MARK_X0}" y1="512" x2="{MARK_X1}" y2="512">'
        f'<stop offset="0" stop-color="{GRAD_START}"/>'
        f'<stop offset="1" stop-color="{GRAD_END}"/></linearGradient>'
    )


MARK_SVG = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img">
  <title>AgentHub</title>
  <defs>{_gradient_def("ahMarkGradient")}</defs>
  <g transform="rotate({SVG_ROTATION} 512 512)" fill="url(#ahMarkGradient)">
{_svg_rects()}
  </g>
</svg>
"""

ICON_SVG = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img">
  <title>AgentHub</title>
  <defs>{_gradient_def("ahIconGradient")}</defs>
  <rect x="56" y="56" width="912" height="912" rx="196" fill="#ffffff" stroke="{BORDER}" stroke-width="8"/>
  <g transform="translate(168 168) scale(0.671875)">
    <g transform="rotate({SVG_ROTATION} 512 512)" fill="url(#ahIconGradient)">
{_svg_rects()}
    </g>
  </g>
</svg>
"""


def _vector_rect_path(x0: float, y0: float, x1: float, y1: float, scale: float) -> str:
    x, y = x0 * scale, y0 * scale
    w, h = (x1 - x0) * scale, (y1 - y0) * scale
    return f"M{x:.2f},{y:.2f}h{w:.2f}v{h:.2f}h-{w:.2f}z"


def _vector_paths(rects, color: str, scale: float) -> str:
    data = "".join(_vector_rect_path(*r, scale) for r in rects)
    return (
        f'        <path\n'
        f'            android:fillColor="{color}"\n'
        f'            android:pathData="{data}" />'
    )


_FG_SCALE = 108 / 1024
FOREGROUND_SVG = f"""<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <group
        android:rotation="{SVG_ROTATION}"
        android:pivotX="54"
        android:pivotY="54">
{_vector_paths(RECTS_LIGHT, LIGHT_FLAT, _FG_SCALE)}
{_vector_paths(RECTS_DARK, DARK_FLAT, _FG_SCALE)}
    </group>
</vector>
"""


BACKGROUND_VECTOR = """<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportHeight="108"
    android:viewportWidth="108">
    <path
        android:fillColor="#FFFFFFFF"
        android:pathData="M0,0h108v108h-108z" />
</vector>
"""


_NOTIF_SCALE = 24 / 1024
NOTIFICATION_VECTOR = f"""<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="24"
    android:viewportHeight="24">
    <group
        android:rotation="{SVG_ROTATION}"
        android:pivotX="12"
        android:pivotY="12">
{_vector_paths(RECTS_LIGHT, "#FFFFFFFF", _NOTIF_SCALE)}
{_vector_paths(RECTS_DARK, "#FFFFFFFF", _NOTIF_SCALE)}
    </group>
</vector>
"""


ADAPTIVE_ICON_XML = """<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@drawable/ic_launcher_background"/>
    <foreground android:drawable="@drawable/ic_launcher_foreground"/>
</adaptive-icon>
"""


def write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8", newline="\n")


def render_icon(size: int, include_background: bool = True) -> Image.Image:
    scale = 4
    canvas = size * scale
    image = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    def s(value: float) -> int:
        return round(value * canvas / 1024)

    if include_background:
        rect = [s(56), s(56), s(968), s(968)]
        radius = s(196)
        draw.rounded_rectangle(rect, radius=radius, fill="white", outline=BORDER, width=max(1, s(8)))

    mark = render_mark(size)
    if include_background:
        mark = mark.resize((s(688), s(688)), Image.Resampling.LANCZOS)
        image.alpha_composite(mark, (s(168), s(168)))
    else:
        image.alpha_composite(mark)

    return image.resize((size, size), Image.Resampling.LANCZOS)


def render_mark(size: int) -> Image.Image:
    scale = 4
    canvas = size * scale

    def s(value: float) -> int:
        return round(value * canvas / 1024)

    mask = Image.new("L", (canvas, canvas), 0)
    mask_draw = ImageDraw.Draw(mask)
    for x0, y0, x1, y1 in RECTS_LIGHT + RECTS_DARK:
        mask_draw.rectangle([s(x0), s(y0), s(x1), s(y1)], fill=255)

    # Horizontal gradient across the mark extent in the axis-aligned frame;
    # after rotation it runs along the mark's diagonal like the original splash.
    gradient_row = Image.new("RGBA", (canvas, 1))
    gx0, gx1 = s(MARK_X0), s(MARK_X1)
    span = max(1, gx1 - gx0)
    for x in range(canvas):
        t = min(1.0, max(0.0, (x - gx0) / span))
        color = tuple(
            round(GRAD_START_RGB[i] + t * (GRAD_END_RGB[i] - GRAD_START_RGB[i])) for i in range(3)
        )
        gradient_row.putpixel((x, 0), color + (255,))
    gradient = gradient_row.resize((canvas, canvas), Image.Resampling.NEAREST)

    image = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    image.paste(gradient, (0, 0), mask)
    image = image.rotate(PIL_ROTATION, resample=Image.Resampling.BICUBIC, center=(canvas // 2, canvas // 2))
    return image.resize((size, size), Image.Resampling.LANCZOS)


def save_png(path: Path, image: Image.Image) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, "PNG")


def replace_logo_in_docs(mark: Image.Image) -> None:
    replacements = {
        "docs/assets/agenthub-readme-hero.png": [
            ((478, 5, 576, 106), 58),
            ((568, 337, 628, 407), 34),
        ],
        "docs/assets/agenthub-architecture-overview.png": [
            ((486, 0, 565, 85), 50),
            ((1242, 369, 1276, 408), 24),
        ],
    }
    for relative, entries in replacements.items():
        path = ROOT / relative
        image = Image.open(path).convert("RGBA")
        draw = ImageDraw.Draw(image)
        for box, icon_size in entries:
            draw.rectangle(box, fill=(255, 255, 255, 255))
            icon_small = mark.resize((icon_size, icon_size), Image.Resampling.LANCZOS)
            x = box[0] + (box[2] - box[0] - icon_size) // 2
            y = box[1] + (box[3] - box[1] - icon_size) // 2
            image.alpha_composite(icon_small, (x, y))
        image.convert("RGB").save(path, "PNG", optimize=True)


def main() -> None:
    write_text(ROOT / "assets/brand/agenthub-icon.svg", ICON_SVG)
    write_text(ROOT / "assets/brand/agenthub-mark.svg", MARK_SVG)
    write_text(ROOT / "apps/web/public/favicon.svg", MARK_SVG)
    write_text(ROOT / "apps/mobile/android/app/src/main/assets/public/favicon.svg", MARK_SVG)
    write_text(ROOT / "apps/mobile/android/app/src/main/res/drawable-v24/ic_launcher_foreground.xml", FOREGROUND_SVG)
    write_text(ROOT / "apps/mobile/android/app/src/main/res/drawable/ic_launcher_background.xml", BACKGROUND_VECTOR)
    write_text(ROOT / "apps/mobile/android/app/src/main/res/drawable/ic_stat_agenthub.xml", NOTIFICATION_VECTOR)
    write_text(ROOT / "apps/mobile/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml", ADAPTIVE_ICON_XML)
    write_text(ROOT / "apps/mobile/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher_round.xml", ADAPTIVE_ICON_XML)

    icon_1024 = render_icon(1024, include_background=True)
    mark_1024 = render_mark(1024)
    foreground_1024 = render_icon(1024, include_background=False)
    save_png(ROOT / "assets/brand/agenthub-icon.png", icon_1024)
    save_png(ROOT / "assets/brand/agenthub-mark.png", mark_1024)
    save_png(ROOT / "apps/desktop/assets/icon.png", icon_1024.resize((512, 512), Image.Resampling.LANCZOS))

    ico_sizes = [16, 24, 32, 48, 64, 128, 256]
    ico_images = [icon_1024.resize((size, size), Image.Resampling.LANCZOS) for size in ico_sizes]
    (ROOT / "apps/desktop/assets").mkdir(parents=True, exist_ok=True)
    ico_images[-1].save(ROOT / "apps/desktop/assets/icon.ico", sizes=[image.size for image in ico_images])

    launcher_sizes = {
        "mipmap-mdpi": 48,
        "mipmap-hdpi": 72,
        "mipmap-xhdpi": 96,
        "mipmap-xxhdpi": 144,
        "mipmap-xxxhdpi": 192,
    }
    foreground_sizes = {
        "mipmap-mdpi": 108,
        "mipmap-hdpi": 162,
        "mipmap-xhdpi": 216,
        "mipmap-xxhdpi": 324,
        "mipmap-xxxhdpi": 432,
    }
    res_root = ROOT / "apps/mobile/android/app/src/main/res"
    for directory, size in launcher_sizes.items():
        image = icon_1024.resize((size, size), Image.Resampling.LANCZOS)
        save_png(res_root / directory / "ic_launcher.png", image)
        save_png(res_root / directory / "ic_launcher_round.png", image)
    for directory, size in foreground_sizes.items():
        save_png(
            res_root / directory / "ic_launcher_foreground.png",
            foreground_1024.resize((size, size), Image.Resampling.LANCZOS),
        )

    replace_logo_in_docs(mark_1024)


if __name__ == "__main__":
    main()
