from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
BLUE = "#68C5FF"
GRID = "#E5ECF5"
BORDER = "#D9E4EF"


ICON_SVG = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img">
  <title>AgentHub</title>
  <defs>
    <clipPath id="agenthub-icon-mask">
      <rect x="56" y="56" width="912" height="912" rx="196"/>
    </clipPath>
  </defs>
  <rect x="56" y="56" width="912" height="912" rx="196" fill="#ffffff" stroke="{BORDER}" stroke-width="8"/>
  <g clip-path="url(#agenthub-icon-mask)" stroke="{GRID}" stroke-width="4" opacity="0.82">
    <path d="M-160 36 L988 1184"/>
    <path d="M-64 36 L1084 1184"/>
    <path d="M32 36 L1180 1184"/>
    <path d="M128 36 L1276 1184"/>
    <path d="M224 36 L1372 1184"/>
    <path d="M320 36 L1468 1184"/>
    <path d="M416 36 L1564 1184"/>
    <path d="M512 36 L1660 1184"/>
    <path d="M608 36 L1756 1184"/>
    <path d="M704 36 L1852 1184"/>
    <path d="M800 36 L1948 1184"/>
    <path d="M896 36 L2044 1184"/>
    <path d="M-1020 1184 L128 -36"/>
    <path d="M-924 1184 L224 -36"/>
    <path d="M-828 1184 L320 -36"/>
    <path d="M-732 1184 L416 -36"/>
    <path d="M-636 1184 L512 -36"/>
    <path d="M-540 1184 L608 -36"/>
    <path d="M-444 1184 L704 -36"/>
    <path d="M-348 1184 L800 -36"/>
    <path d="M-252 1184 L896 -36"/>
    <path d="M-156 1184 L992 -36"/>
    <path d="M-60 1184 L1088 -36"/>
    <path d="M36 1184 L1184 -36"/>
  </g>
  <g stroke="{BLUE}" stroke-width="96" stroke-linecap="butt" stroke-linejoin="miter">
    <path d="M318 334 L690 706"/>
    <path d="M318 690 L690 318"/>
  </g>
</svg>
"""

MARK_SVG = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img">
  <title>AgentHub mark</title>
  <path fill="#0D66D0" d="M512 64 816 240v352l-104 60V300L512 184 312 300v352l-104-60V240z"/>
  <path fill="#2F9CF4" d="M392 352 496 292v512l-104-60z"/>
  <path fill="#0D66D0" d="M528 292 632 352v392l-104 60z"/>
  <path fill="#5CB8FF" d="M496 292h32v512l-16 10-16-10z"/>
</svg>
"""


FOREGROUND_SVG = f"""<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <path
        android:fillColor="#00000000"
        android:pathData="M0,0h108v108h-108z" />
    <path
        android:fillColor="#00000000"
        android:pathData="M33.5,35.2L72.7,74.4"
        android:strokeColor="{BLUE}"
        android:strokeLineCap="butt"
        android:strokeLineJoin="miter"
        android:strokeWidth="10.2" />
    <path
        android:fillColor="#00000000"
        android:pathData="M33.5,72.7L72.7,33.5"
        android:strokeColor="{BLUE}"
        android:strokeLineCap="butt"
        android:strokeLineJoin="miter"
        android:strokeWidth="10.2" />
</vector>
"""


BACKGROUND_VECTOR = f"""<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportHeight="108"
    android:viewportWidth="108">
    <path
        android:fillColor="#FFFFFFFF"
        android:pathData="M0,0h108v108h-108z" />
    <path android:fillColor="#00000000" android:pathData="M-20,5L103,128" android:strokeColor="#CCE5ECF5" android:strokeWidth="0.45" />
    <path android:fillColor="#00000000" android:pathData="M-10,5L113,128" android:strokeColor="#CCE5ECF5" android:strokeWidth="0.45" />
    <path android:fillColor="#00000000" android:pathData="M0,5L123,128" android:strokeColor="#CCE5ECF5" android:strokeWidth="0.45" />
    <path android:fillColor="#00000000" android:pathData="M10,5L133,128" android:strokeColor="#CCE5ECF5" android:strokeWidth="0.45" />
    <path android:fillColor="#00000000" android:pathData="M20,5L143,128" android:strokeColor="#CCE5ECF5" android:strokeWidth="0.45" />
    <path android:fillColor="#00000000" android:pathData="M30,5L153,128" android:strokeColor="#CCE5ECF5" android:strokeWidth="0.45" />
    <path android:fillColor="#00000000" android:pathData="M40,5L163,128" android:strokeColor="#CCE5ECF5" android:strokeWidth="0.45" />
    <path android:fillColor="#00000000" android:pathData="M50,5L173,128" android:strokeColor="#CCE5ECF5" android:strokeWidth="0.45" />
    <path android:fillColor="#00000000" android:pathData="M60,5L183,128" android:strokeColor="#CCE5ECF5" android:strokeWidth="0.45" />
    <path android:fillColor="#00000000" android:pathData="M70,5L193,128" android:strokeColor="#CCE5ECF5" android:strokeWidth="0.45" />
    <path android:fillColor="#00000000" android:pathData="M80,5L203,128" android:strokeColor="#CCE5ECF5" android:strokeWidth="0.45" />
    <path android:fillColor="#00000000" android:pathData="M90,5L213,128" android:strokeColor="#CCE5ECF5" android:strokeWidth="0.45" />
    <path android:fillColor="#00000000" android:pathData="M-104,128L19,5" android:strokeColor="#CCE5ECF5" android:strokeWidth="0.45" />
    <path android:fillColor="#00000000" android:pathData="M-94,128L29,5" android:strokeColor="#CCE5ECF5" android:strokeWidth="0.45" />
    <path android:fillColor="#00000000" android:pathData="M-84,128L39,5" android:strokeColor="#CCE5ECF5" android:strokeWidth="0.45" />
    <path android:fillColor="#00000000" android:pathData="M-74,128L49,5" android:strokeColor="#CCE5ECF5" android:strokeWidth="0.45" />
    <path android:fillColor="#00000000" android:pathData="M-64,128L59,5" android:strokeColor="#CCE5ECF5" android:strokeWidth="0.45" />
    <path android:fillColor="#00000000" android:pathData="M-54,128L69,5" android:strokeColor="#CCE5ECF5" android:strokeWidth="0.45" />
    <path android:fillColor="#00000000" android:pathData="M-44,128L79,5" android:strokeColor="#CCE5ECF5" android:strokeWidth="0.45" />
    <path android:fillColor="#00000000" android:pathData="M-34,128L89,5" android:strokeColor="#CCE5ECF5" android:strokeWidth="0.45" />
    <path android:fillColor="#00000000" android:pathData="M-24,128L99,5" android:strokeColor="#CCE5ECF5" android:strokeWidth="0.45" />
    <path android:fillColor="#00000000" android:pathData="M-14,128L109,5" android:strokeColor="#CCE5ECF5" android:strokeWidth="0.45" />
    <path android:fillColor="#00000000" android:pathData="M-4,128L119,5" android:strokeColor="#CCE5ECF5" android:strokeWidth="0.45" />
    <path android:fillColor="#00000000" android:pathData="M6,128L129,5" android:strokeColor="#CCE5ECF5" android:strokeWidth="0.45" />
</vector>
"""


NOTIFICATION_VECTOR = """<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="24"
    android:viewportHeight="24">
    <path
        android:fillColor="#00000000"
        android:pathData="M7.1,7.9L16.1,16.9"
        android:strokeColor="#FFFFFFFF"
        android:strokeLineCap="butt"
        android:strokeLineJoin="miter"
        android:strokeWidth="2.8" />
    <path
        android:fillColor="#00000000"
        android:pathData="M7.1,16.1L16.1,7.1"
        android:strokeColor="#FFFFFFFF"
        android:strokeLineCap="butt"
        android:strokeLineJoin="miter"
        android:strokeWidth="2.8" />
</vector>
"""


ADAPTIVE_ICON_XML = """<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@drawable/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
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

        mask = Image.new("L", (canvas, canvas), 0)
        mask_draw = ImageDraw.Draw(mask)
        mask_draw.rounded_rectangle(rect, radius=radius, fill=255)
    else:
        mask = Image.new("L", (canvas, canvas), 255)

    grid_layer = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    grid_draw = ImageDraw.Draw(grid_layer)
    for offset in range(-160, 920, 96):
        grid_draw.line([(s(offset), s(36)), (s(offset + 1148), s(1184))], fill=GRID, width=max(1, s(4)))
    for offset in range(-1020, 132, 96):
        grid_draw.line([(s(offset), s(1184)), (s(offset + 1148), s(-36))], fill=GRID, width=max(1, s(4)))
    grid_layer.putalpha(Image.composite(grid_layer.getchannel("A"), Image.new("L", (canvas, canvas), 0), mask))
    image.alpha_composite(grid_layer)

    mark_layer = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    mark_draw = ImageDraw.Draw(mark_layer)
    width = max(1, s(96))
    mark_draw.line([(s(318), s(334)), (s(690), s(706))], fill=BLUE, width=width)
    mark_draw.line([(s(318), s(690)), (s(690), s(318))], fill=BLUE, width=width)
    mark_layer.putalpha(Image.composite(mark_layer.getchannel("A"), Image.new("L", (canvas, canvas), 0), mask))
    image.alpha_composite(mark_layer)

    return image.resize((size, size), Image.Resampling.LANCZOS)


def render_mark(size: int) -> Image.Image:
    scale = 4
    canvas = size * scale
    image = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    def s(value: float) -> int:
        return round(value * canvas / 1024)

    draw.polygon(
        [
            (s(512), s(64)),
            (s(816), s(240)),
            (s(816), s(592)),
            (s(712), s(652)),
            (s(712), s(300)),
            (s(512), s(184)),
            (s(312), s(300)),
            (s(312), s(652)),
            (s(208), s(592)),
            (s(208), s(240)),
        ],
        fill="#0D66D0",
    )
    draw.polygon([(s(392), s(352)), (s(496), s(292)), (s(496), s(804)), (s(392), s(744))], fill="#2F9CF4")
    draw.polygon([(s(528), s(292)), (s(632), s(352)), (s(632), s(744)), (s(528), s(804))], fill="#0D66D0")
    draw.polygon([(s(496), s(292)), (s(528), s(292)), (s(528), s(804)), (s(512), s(814)), (s(496), s(804))], fill="#5CB8FF")
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
    write_text(ROOT / "apps/web/public/favicon.svg", ICON_SVG)
    write_text(ROOT / "apps/mobile/android/app/src/main/assets/public/favicon.svg", ICON_SVG)
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
