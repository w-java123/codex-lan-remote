import argparse
import hashlib
import struct
from pathlib import Path
from zipfile import ZipFile


def apk_delta(old_path, new_path, output):
    old = old_path.read_bytes()
    new = new_path.read_bytes()
    if max(len(old), len(new)) >= 512 * 1024 * 1024:
        raise ValueError("APK exceeds the updater size limit")

    def entries(path, data):
        with ZipFile(path) as archive:
            offsets = {}
            for entry in archive.infolist():
                header = entry.header_offset
                name, extra = struct.unpack_from("<HH", data, header + 26)
                offsets[entry.filename] = (header + 30 + name + extra, entry.compress_size)
            return offsets

    previous = entries(old_path, old)
    ranges = []
    for name, (offset, size) in entries(new_path, new).items():
        before = previous.get(name)
        if before and size >= 64 and size == before[1] and old[before[0]:before[0] + size] == new[offset:offset + size]:
            ranges.append((offset, size, before[0]))
    cursor = 0
    with output.open("wb") as patch:
        patch.write(struct.pack(">4sI", b"CLD1", len(new)))
        for offset, size, source in sorted(ranges):
            if offset < cursor:
                raise ValueError("Overlapping ZIP entries")
            if offset > cursor:
                patch.write(struct.pack(">i", offset - cursor))
                patch.write(new[cursor:offset])
            patch.write(struct.pack(">iI", -size, source))
            cursor = offset + size
        if cursor < len(new):
            patch.write(struct.pack(">i", len(new) - cursor))
            patch.write(new[cursor:])
    if output.stat().st_size >= len(new):
        output.unlink()
        return False
    return True


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Generate an exact APK delta for a GitHub release.")
    parser.add_argument("previous", type=Path)
    parser.add_argument("current", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    previous_hash = hashlib.file_digest(args.previous.open("rb"), "sha256").hexdigest()
    output = args.destination / f"codex-lan-android-from-{previous_hash}.cld"
    if apk_delta(args.previous, args.current, output):
        print(output)
