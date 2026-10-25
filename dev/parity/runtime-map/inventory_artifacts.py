"""Record map artifact schemas and image geometry without copying user maps."""

import gzip
import json
import pathlib
import struct
import sys


def png_size(path):
    try:
        data = path.read_bytes()[:24]
        if data[:8] != b"\x89PNG\r\n\x1a\n":
            return None
        return list(struct.unpack(">II", data[16:24]))
    except Exception:
        return None


def shape(value, depth=3):
    if depth <= 0:
        return type(value).__name__
    if isinstance(value, dict):
        return {str(key): shape(child, depth - 1) for key, child in value.items()}
    if isinstance(value, list):
        types = []
        for child in value[:20]:
            candidate = shape(child, depth - 1)
            if candidate not in types:
                types.append(candidate)
        return {"type": "list", "length": len(value), "itemShapes": types}
    if isinstance(value, str):
        return {"type": "str", "length": len(value)}
    return type(value).__name__


def map_artifact(path):
    result = {"path": path.name, "size": path.stat().st_size}
    try:
        with gzip.open(path, "rt", encoding="utf-8") as handle:
            data = json.load(handle)
        result["encoding"] = "gzip-json"
        result["schema"] = shape(data)
        if isinstance(data, dict):
            result["counts"] = {
                key: len(data.get(key, [])) for key in
                ("infantry", "tanks", "cities", "capitals", "bridges")
                if isinstance(data.get(key), list)
            }
    except Exception as exc:
        result["error"] = repr(exc)
    return result


def main():
    game_root = pathlib.Path(sys.argv[1])
    output = pathlib.Path(sys.argv[2])
    map_editor = game_root / "map_editor"
    zolamare = game_root / "assets" / "zolamare_maps"
    temporary = map_editor / "map_temporary_zolamare_export.txt"
    payload = {
        "temporaryGeneratedMap": map_artifact(temporary) if temporary.is_file() else None,
        "mapEditorFiles": [
            {"name": path.name, "size": path.stat().st_size, "pngSize": png_size(path)}
            for path in sorted(map_editor.glob("*")) if path.is_file()
        ],
        "zolamareAssets": [
            {"name": path.name, "size": path.stat().st_size, "pngSize": png_size(path)}
            for path in sorted(zolamare.glob("*")) if path.is_file()
        ],
    }
    output.write_text(json.dumps(payload, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
