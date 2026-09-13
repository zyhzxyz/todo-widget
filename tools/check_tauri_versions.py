#!/usr/bin/env python3
"""Check the npm/Rust Tauri release pairs without a native Rust toolchain."""

import json
import re
import sys
import tomllib
from pathlib import Path


def release_line(version: str) -> tuple[int, int]:
    match = re.fullmatch(r"(\d+)\.(\d+)\.\d+(?:[-+].*)?", version)
    if match is None:
        raise ValueError(f"Invalid locked version: {version!r}")
    return int(match[1]), int(match[2])


def compatibility_errors(npm_lock: dict, cargo_lock: dict) -> list[str]:
    packages = npm_lock["packages"]
    root = packages[""]
    dependencies = {**root.get("dependencies", {}), **root.get("devDependencies", {})}
    errors: list[str] = []
    checked = 0
    for name in sorted(dependencies):
        if name == "@tauri-apps/api":
            crate = "tauri"
        elif name.startswith("@tauri-apps/plugin-"):
            crate = name.replace("@tauri-apps/", "tauri-", 1)
        else:
            continue
        checked += 1
        npm_version = packages.get(f"node_modules/{name}", {}).get("version")
        if not npm_version:
            errors.append(f"{name}: missing from npm lockfile")
            continue
        rust_versions = sorted({p["version"] for p in cargo_lock["package"] if p["name"] == crate})
        if not rust_versions:
            errors.append(f"{name}: {crate} missing from Cargo.lock")
            continue
        # Like the Tauri CLI, allow patch differences, not major/minor drift.
        if any(release_line(version) != release_line(npm_version) for version in rust_versions):
            errors.append(f"{name} {npm_version} != {crate} {', '.join(rust_versions)} (major.minor)")
    if not checked:
        errors.append("No frontend Tauri packages found in npm lockfile")
    return errors


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    try:
        npm_lock = json.loads((root / "package-lock.json").read_text(encoding="utf-8"))
        cargo_lock = tomllib.loads((root / "src-tauri/Cargo.lock").read_text(encoding="utf-8"))
        errors = compatibility_errors(npm_lock, cargo_lock)
    except (OSError, KeyError, TypeError, ValueError) as error:
        print(f"Cannot check Tauri lockfiles: {error}", file=sys.stderr)
        return 1
    if errors:
        print("Tauri package versions must use matching npm/Rust major.minor releases:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print("Tauri npm/Rust major.minor versions match.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
