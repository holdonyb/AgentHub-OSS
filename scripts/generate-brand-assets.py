from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
LIGHT = "#6CC8FF"
DARK = "#58B6FF"
BORDER = "#DCE8F6"


ICON_SVG = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img">
  <title>AgentHub</title>
  <rect x="56" y="56" width="912" height="912" rx="196" fill="#ffffff" stroke="{BORDER}" stroke-width="8"/>
  <g transform="rotate(45 512 512)">
    <path fill="{LIGHT}" d="M274 344h116v164h248v116H390v164H274V624H26V508h248z"/>
    <path fill="{DARK}" d="M750 236h116v164h132v116H866v164H750V516H502V400h248z"/>
  </g>
</svg>
"""

MARK_SVG = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img">
  <title>AgentHub</title>
  <g transform="rotate(45 512 512)">
    <path fill="{LIGHT}" d="M330 362h112v158h240v112H442v158H330V632H90V520h240z"/>
    <path fill="{DARK}" d="M694 250h112v158h128v112H806v158H694V520H454V408h240z"/>
  </g>
</svg>
"""


FOREGROUND_SVG = f"""<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <path
        android:fillColor="{LIGHT}"
        android:pathData="M44.53,13.61l8.22,8.22l-13.15,13.15h19.87v11.63h-31.5v16.41h-11.63v-16.41h-19.87v-11.63h19.87v-16.41h11.63v16.41h3.46z" />
    <path
        android:fillColor="{DARK}"
        android:pathData="M75.73,24.24h11.63v16.41h8.74v11.63h-8.74v16.41h-11.63v-16.41h-19.87v-11.63h19.87z" />
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
</vector>
"""


NOTIFICATION_VECTOR = """<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="24"
    android:viewportHeight="24">
    <path
        android:fillColor="#FFFFFFFF"
        android:pathData="M9.91,3.02h2.58v3.64h4.22v2.58h-4.22v3.64H9.91V9.24H5.69V6.66h4.22z" />
    <path
        android:fillColor="#FFFFFFFF"
        android:pathData="M15.04,8.1h2.58v3.64h1.94v2.58h-1.94v3.64h-2.58v-3.64h-4.22v-2.58h4.22z" />
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
    image = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    def s(value: float) -> int:
        return round(value * canvas / 1024)

    light = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    dark = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    light_draw = ImageDraw.Draw(light)
    dark_draw = ImageDraw.Draw(dark)

    light_draw.rectangle([s(330), s(362), s(442), s(790)], fill=LIGHT)
    light_draw.rectangle([s(90), s(520), s(682), s(632)], fill=LIGHT)
    dark_draw.rectangle([s(694), s(250), s(806), s(678)], fill=DARK)
    dark_draw.rectangle([s(454), s(408), s(934), s(520)], fill=DARK)

    light = light.rotate(45, resample=Image.Resampling.BICUBIC, center=(canvas // 2, canvas // 2))
    dark = dark.rotate(45, resample=Image.Resampling.BICUBIC, center=(canvas // 2, canvas // 2))
    image.alpha_composite(light)
    image.alpha_composite(dark)
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
