from __future__ import annotations

import json
import sys
import zipfile
from pathlib import Path


def fail(message: str) -> int:
    print(message, file=sys.stderr)
    return 1


def main() -> int:
    if len(sys.argv) != 2:
      return fail("usage: verify_android_runtime.py <apk-path>")

    apk_path = Path(sys.argv[1]).resolve()
    script_dir = Path(__file__).resolve().parent
    app_json_path = script_dir.parent / "app.json"

    if not apk_path.is_file():
      return fail(f"APK not found: {apk_path}")
    if not app_json_path.is_file():
      return fail(f"app.json not found: {app_json_path}")

    config = json.loads(app_json_path.read_text(encoding="utf-8"))
    expo = config.get("expo", {})
    engine = str(expo.get("jsEngine") or "hermes").strip().lower()
    new_arch = bool(expo.get("newArchEnabled"))

    with zipfile.ZipFile(apk_path) as archive:
      entries = {item.filename for item in archive.infolist()}

    has_jsc = any(name.endswith("/libjsc.so") for name in entries)
    has_hermes = any(name.endswith("/libhermes.so") for name in entries)
    has_hermes_tooling = any(name.endswith("/libhermestooling.so") for name in entries)

    print(
      f"verify_android_runtime: engine={engine} newArchEnabled={str(new_arch).lower()} "
      f"jsc={str(has_jsc).lower()} hermes={str(has_hermes).lower()} "
      f"hermesTooling={str(has_hermes_tooling).lower()}"
    )

    if new_arch and engine == "jsc":
      return fail(
        "Unsafe native runtime config: Android new architecture is enabled while jsEngine=jsc. "
        "This combination already shipped a crashing APK and is blocked until revalidated."
      )

    if engine == "jsc":
      if not has_jsc:
        return fail("APK is missing libjsc.so while app.json requests jsEngine=jsc")
      return 0

    if engine == "hermes":
      if not has_hermes:
        return fail("APK is missing libhermes.so while app.json requests jsEngine=hermes")
      if not has_hermes_tooling:
        return fail("APK is missing libhermestooling.so while app.json requests jsEngine=hermes")
      return 0

    return fail(f"Unsupported jsEngine value in app.json: {engine}")


if __name__ == "__main__":
    raise SystemExit(main())
