"""Merge historic Yunzai token ledger days into the Core ledger."""

import argparse
from collections import Counter
from datetime import datetime, timedelta, timezone
import json
import math
import os
from pathlib import Path
import re
import tarfile
import tempfile


DAY_FILE = re.compile(r"/data/token_usage/(\d{4}-\d{2}-\d{2}\.ndjson)$")
ZONE = timezone(timedelta(hours=8))


def local_day(timestamp):
    return datetime.fromtimestamp(timestamp / 1000, ZONE).date().isoformat()


def decode(line):
    try:
        row = json.loads(line)
        if not isinstance(row, dict):
            return None
        usage = row.get("u")
        required_numbers = [row.get("t"), row.get("cny"), usage.get("total") if isinstance(usage, dict) else None]
        if (
            not all(type(item) in (int, float) and math.isfinite(item) and item >= 0 for item in required_numbers)
            or not all(isinstance(row.get(key), str) for key in ("scope", "stage", "model"))
            or row["t"] <= 0
        ):
            return None
        identity = json.dumps(row, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
        return row["t"], identity
    except (ValueError, UnicodeError, OverflowError):
        return None


def read_days(archive):
    days = {}
    with tarfile.open(archive, "r|gz") as source:
        for item in source:
            match = DAY_FILE.search("/" + item.name.lstrip("./"))
            if not match or not item.isfile():
                continue
            name = match[1]
            if name in days or item.size > 64 * 1024 * 1024:
                raise ValueError("The frozen ledger contains an unsupported day file")
            days[name] = source.extractfile(item).read()
    return days


def merge(original, existing, day):
    seen = Counter(parsed[1] for line in existing.splitlines() if (parsed := decode(line)) is not None)
    missing = []
    excluded = Counter()
    for line in original.splitlines():
        if not line.strip():
            continue
        parsed = decode(line)
        if parsed is None:
            excluded["malformed"] += 1
        elif local_day(parsed[0]) != day:
            excluded["dayMismatch"] += 1
        elif seen[parsed[1]]:
            seen[parsed[1]] -= 1
        else:
            missing.append(line)
    return missing, excluded


def publish(filename, previous, content, backup):
    descriptor, temporary = tempfile.mkstemp(prefix=".legacy-ledger-", dir=filename.parent)
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        fresh = filename.read_bytes() if filename.exists() else None
        if fresh != previous:
            raise ValueError("The target ledger day changed during import")
        if previous is not None:
            backup.mkdir(mode=0o700, exist_ok=True)
            with (backup / filename.name).open("xb") as copy:
                copy.write(previous)
        os.replace(temporary, filename)
    finally:
        Path(temporary).unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    data = args.data_dir.resolve(strict=True)
    root = data / "token_usage"
    now_day = datetime.now(ZONE).date().isoformat()
    old = read_days(args.archive)
    plans = []
    skipped = Counter()
    for name, original in sorted(old.items()):
        if name[:10] >= now_day:
            raise ValueError("A historical import cannot replace the current ledger day")
        filename = root / name
        if filename.is_symlink():
            raise ValueError("A ledger day is a symbolic link")
        previous = filename.read_bytes() if filename.exists() else None
        extra, excluded = merge(original, previous or b"", name[:10])
        skipped.update(excluded)
        if extra:
            plans.append((filename, previous, extra))
    if args.apply and plans:
        os.umask(0o077)
        root.mkdir(exist_ok=True, mode=0o700)
        backup = Path(tempfile.mkdtemp(prefix="legacy-token-usage-backup-", dir=data))
        for filename, previous, extra in plans:
            publish(filename, previous, b"\n".join(extra) + b"\n" + (previous or b""), backup)
    print(json.dumps({
        "outcome": "applied" if args.apply else "preview",
        "archivedDays": len(old), "updatedDays": len(plans),
        "restoredRows": sum(len(extra) for _, _, extra in plans), "excludedRows": dict(skipped),
    }))


if __name__ == "__main__":
    main()
