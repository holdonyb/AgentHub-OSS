from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


DEFAULT_EXCLUDES = {
    ".git",
    ".venv",
    ".runtime",
    "__pycache__",
    "node_modules",
    "artifacts",
    "output",
    ".pytest_cache",
    ".playwright-cli",
    ".gstack",
    "build",
    "dist",
}


@dataclass(frozen=True)
class AuditRule:
    label: str
    patterns: tuple[str, ...]


RULES = (
    AuditRule("private-domain", ("agenthub.ifix.xin",)),
    AuditRule("owner-handle", ("holdonyb",)),
    AuditRule("private-deploy-env", ("AGENTHUB_DEPLOY_HOST", "AGENTHUB_DEPLOY_USER", "AGENTHUB_DEPLOY_SSH_KEY")),
    AuditRule("private-publish-script", ("publish-apk.ps1", "deploy-vm.ps1")),
)


def iter_candidate_files(root: Path, extra_excludes: set[str]) -> Iterable[Path]:
    excluded = DEFAULT_EXCLUDES | extra_excludes
    excluded_prefixes = (
        root / "docs" / "oss",
        root / "apps" / "mobile" / "android" / "app" / "src" / "main" / "assets",
        root / "docs" / "OSS_RELEASE.md",
        root / "scripts" / "export-oss.ps1",
    )
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        if path.name == "audit-public-export.py":
            continue
        if any(path.is_relative_to(prefix) for prefix in excluded_prefixes):
            continue
        if any(part in excluded for part in path.parts):
            continue
        yield path


def audit_file(path: Path) -> list[tuple[str, int, str]]:
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return []
    matches: list[tuple[str, int, str]] = []
    lines = text.splitlines()
    for index, line in enumerate(lines, start=1):
        for rule in RULES:
            if rule.label == "owner-handle" and path.name == "CODEOWNERS":
                continue
            for pattern in rule.patterns:
                if pattern in line:
                    matches.append((rule.label, index, line.strip()))
                    break
    return matches


def main() -> int:
    parser = argparse.ArgumentParser(description="Scan the repo for strings that block a clean public export.")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--exclude", action="append", default=[], help="Additional path segment to exclude.")
    args = parser.parse_args()

    root = args.root.resolve()
    extra_excludes = {value.strip() for value in args.exclude if value.strip()}

    findings: list[tuple[Path, str, int, str]] = []
    for path in iter_candidate_files(root, extra_excludes):
        for label, line_number, snippet in audit_file(path):
            findings.append((path.relative_to(root), label, line_number, snippet))

    if not findings:
        print("No public-export blockers found.")
        return 0

    print("Public export audit findings:")
    for relative_path, label, line_number, snippet in findings:
        print(f"- [{label}] {relative_path}:{line_number} :: {snippet}")
    print(f"\nTotal findings: {len(findings)}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
