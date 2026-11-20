"""Preserve the frozen Yunzai application data under the Core data directory."""

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import tarfile
import tempfile


def digest(filename):
    with filename.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def extract_data(archive, staging):
    manifest = {}
    with tarfile.open(archive, "r|gz") as source:
        for member in source:
            relative = PurePosixPath(member.name)
            if not member.isfile() or len(relative.parts) < 2 or relative.parts[0] != "data":
                continue
            components = relative.parts[1:]
            if any(part == ".." or "\\" in part or "\x00" in part for part in components):
                raise ValueError("The archive contains an invalid data path")
            key = "/".join(components)
            if key in manifest:
                raise ValueError("The archive contains a duplicate data path")
            name = staging.joinpath("data", *components)
            name.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with source.extractfile(member) as input_file, name.open("xb") as output:
                shutil.copyfileobj(input_file, output, 1024 * 1024)
            if name.stat().st_size != member.size:
                raise ValueError("A historical data file could not be read completely")
            os.utime(name, (member.mtime, member.mtime))
            manifest[key] = {"bytes": member.size, "sha256": digest(name)}
    if not manifest:
        raise ValueError("The archive has no application data")
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    destination = args.data_dir.resolve(strict=True)
    archive = args.archive.resolve(strict=True)
    target = destination / "legacy-source"
    os.umask(0o077)
    with tempfile.TemporaryDirectory(dir=destination if args.apply else None, prefix=".legacy-source-") as directory:
        staging = Path(directory) / "ready"
        staging.mkdir(mode=0o700)
        first = archive.stat()
        files = extract_data(archive, staging)
        if archive.stat().st_mtime_ns != first.st_mtime_ns or archive.stat().st_size != first.st_size:
            raise ValueError("The frozen archive changed during extraction")
        manifest = {"version": 1, "sourceSha256": digest(archive), "files": files}
        (staging / "manifest.json").write_text(json.dumps(manifest, sort_keys=True), encoding="utf-8")
        outcome = "preview"
        if args.apply:
            if target.exists():
                saved = json.loads((target / "manifest.json").read_text(encoding="utf-8"))
                if saved != manifest or any(digest(target / "data" / name) != item["sha256"] for name, item in files.items()):
                    raise ValueError("The destination already contains different historical data")
                outcome = "already archived"
            else:
                staging.rename(target)
                outcome = "archived"
        print(json.dumps({"outcome": outcome, "files": len(files), "bytes": sum(item["bytes"] for item in files.values())}))


if __name__ == "__main__":
    main()
