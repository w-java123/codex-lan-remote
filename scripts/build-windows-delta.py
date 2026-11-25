import argparse
import base64
import gzip
import hashlib
import json
from pathlib import Path, PurePosixPath
from zipfile import ZipFile

PREFIX = "plugins/codex-lan-desktop/"
ROOTS = ("desktop/", "server/")


def payload(path):
    with ZipFile(path) as archive:
        return {name[len(PREFIX):]: archive.read(name) for name in archive.namelist()
                if name.startswith(PREFIX) and not name.endswith("/")}


def digest(data):
    return hashlib.sha256(data).hexdigest() if data is not None else None


def desktop_delta(previous, current, output):
    old, new = payload(previous), payload(current)
    from_version = json.loads(old["desktop/release.json"])["version"]
    to_version = json.loads(new["desktop/release.json"])["version"]
    if tuple(map(int, to_version.split("."))) <= tuple(map(int, from_version.split("."))):
        raise ValueError("Windows version must increase")
    names = sorted(old.keys() | new.keys())
    files = []
    for name in names:
        before, after = old.get(name), new.get(name)
        if before == after:
            continue
        if not name.startswith(ROOTS):
            raise ValueError("Windows bundle dependencies changed; publish the full installer for this baseline")
        parent = str(PurePosixPath(name).parent) + "/"
        if not any(entry.startswith(parent) for entry in old):
            raise ValueError("New Windows installation directory requires a full upgrade")
        files.append({"path": name, "before": digest(before), "after": digest(after),
                      "data": base64.b64encode(after).decode("ascii") if after is not None else None})
    result = output / f"codex-lan-windows-from-{from_version}.json.gz"
    contents = json.dumps({"from": from_version, "to": to_version, "files": files}, separators=(",", ":")).encode()
    if len(contents) >= 16 * 1024 * 1024 or len(files) > 100:
        raise ValueError("Windows delta exceeds updater limits; publish the full installer")
    result.write_bytes(gzip.compress(contents, mtime=0))
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Build a Windows update from two installer payload ZIP files.")
    parser.add_argument("previous", type=Path)
    parser.add_argument("current", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    print(desktop_delta(args.previous, args.current, args.destination))
