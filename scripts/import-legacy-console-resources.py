"""Import frozen console resources into the standalone host's data directory."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tarfile
import tempfile
import time


IMAGE = re.compile(r"[\w.-]{1,200}\.(?:png|jpe?g|gif|webp)(?:\.json)?", re.ASCII | re.IGNORECASE)
GROUP = re.compile(r"[1-9][0-9]{0,19}")
EXPRESSION = re.compile(r"ytbot:expression:([1-9][0-9]{0,19})")


def save_resource(destination, name, data, manifest):
    if name in manifest:
        raise ValueError("The frozen sources contain a duplicate resource")
    filename = destination / name
    filename.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with filename.open("xb") as output:
        output.write(data)
    filename.chmod(0o600)
    manifest[name] = {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}


def extract_archive(source, staging, manifest):
    style_suffix = "/data/global_style_learning/style_memory.json"
    with tarfile.open(source, "r|gz") as archive:
        for member in archive:
            if not member.isfile():
                continue
            name = "/" + member.name.lstrip("./")
            destination = None
            maximum = 8 * 1024 * 1024
            if name.endswith(style_suffix):
                destination = "style/style_memory.json"
            if "/data/semantic_memory/" in name:
                suffix = name.rsplit("/data/semantic_memory/", 1)[1]
                if (suffix in {"eval-report.json", "eval-history.ndjson"}
                        or re.fullmatch(r"group/[1-9][0-9]{0,19}\.ndjson", suffix)
                        or re.fullmatch(r"redactions/[1-9][0-9]{0,19}\.json", suffix)):
                    destination = "semantic/" + suffix
                    maximum = 128 * 1024 * 1024
            if destination:
                if member.size > maximum:
                    raise ValueError("A frozen resource exceeds its supported size")
                data = archive.extractfile(member).read()
                save_resource(staging, destination, data, manifest)


def snapshot_groups(rdb, staging, manifest):
    with tempfile.TemporaryDirectory(prefix="bl-legacy-redis-") as temporary:
        folder = Path(temporary)
        shutil.copyfile(rdb, folder / "frozen.rdb")
        socket = str(folder / "redis.sock")
        service = subprocess.Popen([
            "redis-server", "--port", "0", "--unixsocket", socket, "--unixsocketperm", "700",
            "--dir", str(folder), "--dbfilename", "frozen.rdb", "--save", "", "--appendonly", "no",
            "--daemonize", "no", "--logfile", str(folder / "redis.log"),
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        client = ["redis-cli", "-s", socket, "--raw"]
        try:
            deadline = time.monotonic() + 15
            while True:
                if service.poll() is not None or time.monotonic() >= deadline:
                    raise RuntimeError("The isolated Redis snapshot did not load")
                if Path(socket).exists():
                    ping = subprocess.run(client + ["PING"], capture_output=True, timeout=2)
                    if ping.returncode == 0 and ping.stdout == b"PONG\n":
                        break
                time.sleep(0.05)
            keys = subprocess.check_output(client + ["--scan", "--pattern", "ytbot:expression:*"], timeout=10)
            for key in sorted(set(keys.decode().splitlines())):
                match = EXPRESSION.fullmatch(key)
                if not match:
                    continue
                data = subprocess.check_output(client + ["GET", key], timeout=5).rstrip(b"\n")
                if not data:
                    continue
                if len(data) > 2 * 1024 * 1024 or not isinstance(json.loads(data), dict):
                    raise ValueError("A frozen expression resource is invalid")
                save_resource(staging, "style/groups/" + match[1] + ".json", data, manifest)
        finally:
            service.terminate()
            try:
                service.wait(timeout=5)
            except subprocess.TimeoutExpired:
                service.kill()
                service.wait(timeout=5)


def snapshot_draw(draw, staging, manifest):
    for entry in sorted(draw.iterdir()):
        if not IMAGE.fullmatch(entry.name) or ".." in entry.name or entry.name.startswith("."):
            continue
        status = entry.lstat()
        if not stat.S_ISREG(status.st_mode):
            continue
        limit = 16 * 1024 if entry.name.endswith(".json") else 20 * 1024 * 1024
        if not 0 < status.st_size <= limit:
            raise ValueError("A historical image or sidecar exceeds its supported size")
        data = entry.read_bytes()
        after = entry.lstat()
        if ((after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)
                != (status.st_dev, status.st_ino, status.st_size, status.st_mtime_ns, status.st_ctime_ns)
                or len(data) != status.st_size):
            raise ValueError("The historical image changed during import")
        save_resource(staging, "draw/" + entry.name, data, manifest)
        os.utime(staging / "draw" / entry.name, ns=(status.st_atime_ns, status.st_mtime_ns))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--redis-rdb", type=Path, required=True)
    parser.add_argument("--draw-dir", type=Path, required=True)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--legacy-account", required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    if not GROUP.fullmatch(args.legacy_account):
        parser.error("The legacy account must be an explicit QQ account")
    data_dir = args.data_dir.resolve(strict=True)
    target = data_dir / "legacy-console"
    previous_umask = os.umask(0o077)
    try:
        with tempfile.TemporaryDirectory(dir=data_dir if args.apply else None, prefix=".bl-legacy-console-") as temporary:
            staging = Path(temporary) / "resources"
            staging.mkdir(mode=0o700)
            files = {}
            extract_archive(args.archive, staging, files)
            snapshot_groups(args.redis_rdb, staging, files)
            snapshot_draw(args.draw_dir, staging, files)
            receipt = {"version": 1, "legacyAccount": args.legacy_account, "files": files}
            (staging / "manifest.json").write_text(json.dumps(receipt, sort_keys=True), encoding="utf-8")
            outcome = "preview"
            if args.apply:
                if target.exists():
                    saved = json.loads((target / "manifest.json").read_text(encoding="utf-8"))
                    if saved != receipt or any(
                        hashlib.sha256((target / name).read_bytes()).hexdigest() != entry["sha256"]
                        for name, entry in files.items()
                    ):
                        raise ValueError("The destination contains a different import")
                    outcome = "already imported"
                else:
                    staging.rename(target)
                    outcome = "imported"
            print(json.dumps({
                "outcome": outcome,
                "drawImages": sum(name.startswith("draw/") and not name.endswith(".json") for name in files),
                "drawMetadata": sum(name.startswith("draw/") and name.endswith(".json") for name in files),
                "styleMemory": "style/style_memory.json" in files,
                "styleGroups": sum(name.startswith("style/groups/") for name in files),
                "semanticGroups": sum(name.startswith("semantic/group/") for name in files),
                "semanticEvaluationHistory": "semantic/eval-history.ndjson" in files,
            }))
    finally:
        os.umask(previous_umask)


if __name__ == "__main__":
    main()
