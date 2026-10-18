"""Check the distributed source, data and reference files against their hashes."""
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent


def main():
    manifest = json.loads((ROOT / "package_manifest.json").read_text(encoding="utf-8"))
    failures = []
    for name, expected in manifest["files"].items():
        path = (ROOT / name).resolve()
        if not path.is_relative_to(ROOT) or not path.is_file():
            failures.append(f"Missing file or invalid path: {name}")
            continue
        with path.open("rb") as stream:
            actual = hashlib.file_digest(stream, "sha256").hexdigest()
        if actual != expected:
            failures.append(f"Changed file: {name}")
    for failure in failures:
        print(failure)
    print(f"Checked {len(manifest['files'])} files; {len(failures)} differences.")
    return bool(failures)


if __name__ == "__main__":
    sys.exit(main())
