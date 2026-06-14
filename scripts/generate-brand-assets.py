from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
INK = "#111827"
BORDER = "#D9E4EF"


ICON_SVG = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img">
  <title>AgentHub</title>
  <rect x="56" y="56" width="912" height="912" rx="196" fill="#ffffff" stroke="{BORDER}" stroke-width="8"/>
  <g fill="none" stroke="{INK}" stroke-width="72" stroke-linecap="round" stroke-linejoin="round">
    <rect x="168" y="216" width="688" height="592" rx="72"/>
    <path d="M326 408 462 512 326 616"/>
    <path d="M536 632h170"/>
  </g>
</svg>
"""

MARK_SVG = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img">
  <title>AgentHub terminal mark</title>
  <g fill="none" stroke="{INK}" stroke-width="72" stroke-linecap="round" stroke-linejoin="round">
    <rect x="144" y="192" width="736" height="640" rx="76"/>
    <path d="M312 388 454 512 312 636"/>
    <path d="M526 646h184"/>
  </g>
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
        android:pathData="M19,26h70q8,0 8,8v50q0,8 -8,8h-70q-8,0 -8,-8v-50q0,-8 8,-8z"
        android:strokeColor="{INK}"
        android:strokeLineCap="round"
        android:strokeLineJoin="round"
        android:strokeWidth="7.5" />
    <path
        android:fillColor="#00000000"
        android:pathData="M31,47l14,12l-14,12"
        android:strokeColor="{INK}"
        android:strokeLineCap="round"
        android:strokeLineJoin="round"
        android:strokeWidth="7.5" />
    <path
        android:fillColor="#00000000"
        android:pathData="M54,73h21"
        android:strokeColor="{INK}"
        android:strokeLineCap="round"
        android:strokeLineJoin="round"
        android:strokeWidth="7.5" />
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
        android:fillColor="#00000000"
        android:pathData="M4.5,5.5h15q1.8,0 1.8,1.8v9.4q0,1.8 -1.8,1.8h-15q-1.8,0 -1.8,-1.8v-9.4q0,-1.8 1.8,-1.8z"
        android:strokeColor="#FFFFFFFF"
        android:strokeLineCap="round"
        android:strokeLineJoin="round"
        android:strokeWidth="1.8" />
    <path
        android:fillColor="#00000000"
        android:pathData="M7.4,9.2l3.1,2.8l-3.1,2.8"
        android:strokeColor="#FFFFFFFF"
        android:strokeLineCap="round"
        android:strokeLineJoin="round"
        android:strokeWidth="1.8" />
    <path
        android:fillColor="#00000000"
        android:pathData="M12.4,15h4.2"
        android:strokeColor="#FFFFFFFF"
        android:strokeLineCap="round"
        android:strokeLineJoin="round"
        android:strokeWidth="1.8" />
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

    stroke = max(1, s(72))
    draw.rounded_rectangle(
        [s(144), s(192), s(880), s(832)],
        radius=s(76),
        outline=INK,
        width=stroke,
    )
    draw.line([(s(312), s(388)), (s(454), s(512)), (s(312), s(636))], fill=INK, width=stroke, joint="curve")
    draw.line([(s(526), s(646)), (s(710), s(646))], fill=INK, width=stroke)
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
