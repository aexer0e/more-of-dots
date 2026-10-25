"""Generate a readable Python reference from War of Dots runtime snapshots.

This is deliberately a source *skeleton*, not a decompiler. Nuitka preserves
useful interface metadata (names, signatures, source lines, and local names),
but replaces the Python bytecode visible through ``__code__`` with a guard
stub. The generated module therefore keeps every recovered fact and uses an
explicit unavailable-code exception for method bodies.
"""

from __future__ import annotations

import argparse
import ast
import json
import keyword
from collections import defaultdict
from pathlib import Path
from typing import Any


FORMAT_VERSION = 1
GAME_SOURCE_NAME = "game.py"
SENSITIVE_WORDS = (
    "password",
    "passwd",
    "secret",
    "token",
    "credential",
    "cookie",
    "authorization",
)
PRIVATE_FIELD_NAMES = {
    "steam_id",
    "username",
    "email",
    "player_name",
    "account_name",
}


def load_runtime(path: Path) -> dict[str, Any]:
    result = json.loads(path.read_text(encoding="utf-8-sig"))
    if result.get("status") != "ok" or not isinstance(result.get("runtime"), dict):
        raise ValueError(f"{path} is not a successful runtime capture")
    return result["runtime"]


def is_identifier(name: str) -> bool:
    return name.isidentifier() and not keyword.iskeyword(name)


def sensitive_name(name: str) -> bool:
    lowered = name.casefold()
    return lowered in PRIVATE_FIELD_NAMES or any(word in lowered for word in SENSITIVE_WORDS)


def source_details(value: dict[str, Any]) -> tuple[str | None, int | None, list[str]]:
    code = value.get("code") or {}
    filename = code.get("filename")
    line = code.get("firstLine")
    locals_ = [str(name) for name in code.get("varNames", [])]
    return filename, line if isinstance(line, int) else None, locals_


def is_original_game_callable(value: dict[str, Any]) -> bool:
    filename, _, _ = source_details(value)
    return bool(filename and Path(filename).name.casefold() == GAME_SOURCE_NAME.casefold())


def callable_sort_key(item: tuple[str, dict[str, Any]]) -> tuple[int, int, str]:
    name, value = item
    _, line, _ = source_details(value)
    return (
        0 if is_original_game_callable(value) else 1,
        line if line is not None else 2**31,
        name.casefold(),
    )


def class_source_line(candidate: dict[str, Any]) -> int | None:
    lines = []
    for value in candidate.get("attributes", {}).values():
        if value.get("kind") != "callable" or not is_original_game_callable(value):
            continue
        _, line, _ = source_details(value)
        if line is not None:
            lines.append(line)
    return min(lines) if lines else None


def python_signature(name: str, value: dict[str, Any]) -> str:
    signature = value.get("signature") or "(*args, **kwargs)"
    try:
        parsed = ast.parse(f"def {name}{signature}:\n    pass\n")
    except SyntaxError:
        return "(*args, **kwargs)"
    function = parsed.body[0]
    assert isinstance(function, (ast.FunctionDef, ast.AsyncFunctionDef))
    defaults = [*function.args.defaults, *[d for d in function.args.kw_defaults if d]]
    for default in defaults:
        try:
            ast.literal_eval(default)
        except (ValueError, TypeError, SyntaxError, MemoryError, RecursionError):
            replacement = ast.Name(id="_RUNTIME_DEFAULT", ctx=ast.Load())
            for index, candidate in enumerate(function.args.defaults):
                if candidate is default:
                    function.args.defaults[index] = replacement
            for index, candidate in enumerate(function.args.kw_defaults):
                if candidate is default:
                    function.args.kw_defaults[index] = replacement
    return f"({ast.unparse(function.args)})"


def normalize_literal(value: Any) -> Any:
    """Undo the safe JSON normalization used by the probe where possible."""
    if isinstance(value, list):
        return [normalize_literal(item) for item in value]
    if isinstance(value, dict):
        normalized = {}
        for key, item in value.items():
            normalized_key: Any = key
            try:
                parsed = ast.literal_eval(key)
                if isinstance(parsed, (str, int, float, bool, tuple, type(None))):
                    normalized_key = parsed
            except (SyntaxError, ValueError):
                pass
            normalized[normalized_key] = normalize_literal(item)
        return normalized
    return value


def literal_source(value: Any) -> str:
    normalized = normalize_literal(value)
    rendered = repr(normalized)
    try:
        ast.literal_eval(rendered)
    except (SyntaxError, ValueError):
        return "None  # value could not be represented safely"
    return rendered


def one_line(value: str, limit: int = 150) -> str:
    compact = " ".join(value.replace("\x00", "").split())
    return compact if len(compact) <= limit else compact[: limit - 3] + "..."


def describe_shape(shape: dict[str, Any]) -> str:
    if shape.get("redacted"):
        length = f", length={shape['length']}" if "length" in shape else ""
        return f"{shape.get('type', 'unknown')} (redacted{length})"
    if "value" in shape:
        return f"{shape.get('type', 'unknown')} = {shape['value']!r}"
    if "preview" in shape:
        return f"{shape.get('type', 'unknown')} = {shape['preview']!r}"
    if "repr" in shape:
        return f"{shape.get('type', 'unknown')} = {one_line(str(shape['repr']))}"
    if "length" in shape:
        return f"{shape.get('type', 'unknown')}, length={shape['length']}"
    return str(shape.get("type", "unknown"))


def annotation_for(shape: dict[str, Any]) -> str:
    type_name = str(shape.get("type", ""))
    return {
        "bool": "bool",
        "builtins.bool": "bool",
        "int": "int",
        "builtins.int": "int",
        "float": "float",
        "builtins.float": "float",
        "str": "str",
        "builtins.str": "str",
        "bytes": "bytes",
        "builtins.bytes": "bytes",
        "list": "list[Any]",
        "builtins.list": "list[Any]",
        "dict": "dict[Any, Any]",
        "builtins.dict": "dict[Any, Any]",
        "tuple": "tuple[Any, ...]",
        "builtins.tuple": "tuple[Any, ...]",
        "set": "set[Any]",
        "builtins.set": "set[Any]",
        "NoneType": "None",
        "builtins.NoneType": "None",
    }.get(type_name, "Any")


def collect_live_instances(runtimes: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    result: dict[str, list[dict[str, Any]]] = defaultdict(list)
    seen: set[tuple[str, str, str]] = set()
    for runtime in runtimes:
        captured_at = str(runtime.get("capturedAt", "unknown"))
        for instance in runtime.get("instances", []):
            if instance.get("module") != "__main__":
                continue
            class_name = str(instance.get("class", ""))
            key = (captured_at, class_name, str(instance.get("id", "")))
            if key not in seen:
                seen.add(key)
                result[class_name].append(instance)
    return result


def merge_instance_fields(instances: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    fields: dict[str, dict[str, Any]] = {}
    for instance in instances:
        for name, shape in instance.get("attributes", {}).items():
            if is_identifier(name):
                fields.setdefault(name, shape)
    return fields


def best_literals(instances: list[dict[str, Any]]) -> dict[str, Any]:
    best: dict[str, Any] = {}
    for instance in instances:
        best.update(instance.get("literalAttributes", {}))
    return best


def render_callable(name: str, value: dict[str, Any], indent: str = "") -> list[str]:
    filename, line, locals_ = source_details(value)
    original = is_original_game_callable(value)
    origin = "original game" if original else "runtime-added/injected"
    location = f"{Path(filename).name}:{line}" if filename and line else "unknown"
    recovered_signature = value.get("signature") or "(*args, **kwargs)"
    signature = python_signature(name, value)
    lines = [f"{indent}def {name}{signature}:"]
    lines.append(f'{indent}    """Recovered signature; {origin}, location {location}.')
    if signature != recovered_signature:
        lines.append("")
        lines.append(f"{indent}    Exact runtime signature: {recovered_signature}")
        lines.append(
            f"{indent}    A non-literal default was replaced with _RUNTIME_DEFAULT so this file imports."
        )
    if locals_:
        lines.append("")
        lines.append(f"{indent}    Nuitka-retained local names: {', '.join(locals_)}")
    lines.append(f'{indent}    """')
    lines.append(
        f'{indent}    raise RuntimeCodeUnavailable("Implementation unavailable: {name} ({location})")'
    )
    return lines


def render_class(
    candidate: dict[str, Any], instances: list[dict[str, Any]]
) -> list[str]:
    name = candidate["name"]
    methods = [
        (method_name, value)
        for method_name, value in candidate.get("attributes", {}).items()
        if value.get("kind") == "callable" and is_identifier(method_name)
    ]
    methods.sort(key=callable_sort_key)
    method_names = {method_name for method_name, _ in methods}
    fields = merge_instance_fields(instances)
    literals = best_literals(instances)
    source_line = class_source_line(candidate)
    bases = ", ".join(candidate.get("bases", [])) or "builtins.object"

    lines = [f"class {name}:"]
    lines.append('    """Recovered runtime interface.')
    lines.append("")
    lines.append(f"    Original bases: {bases}")
    lines.append(f"    First observed game.py line: {source_line or 'unknown'}")
    lines.append(f"    Live snapshots containing an instance: {len(instances)}")
    lines.append('    """')

    emitted = False
    for field_name in sorted(fields, key=str.casefold):
        if field_name in method_names:
            continue
        shape = fields[field_name]
        if sensitive_name(field_name) and not shape.get("redacted"):
            shape = {"type": shape.get("type", "unknown"), "redacted": True}
        if field_name in literals and not sensitive_name(field_name):
            lines.append(f"    {field_name} = {literal_source(literals[field_name])}")
        else:
            lines.append(
                f"    {field_name}: {annotation_for(shape)}  # observed: {describe_shape(shape)}"
            )
        emitted = True

    if emitted and methods:
        lines.append("")
    for index, (method_name, value) in enumerate(methods):
        lines.extend(render_callable(method_name, value, indent="    "))
        if index != len(methods) - 1:
            lines.append("")
    if not emitted and not methods:
        lines.append("    pass")
    return lines


def category_for(name: str) -> str:
    lowered = name.casefold()
    if "scene" in lowered:
        return "Scenes"
    if "manager" in lowered:
        return "Managers"
    if any(word in lowered for word in ("map", "terrain", "unit", "city", "bridge")):
        return "Map and gameplay"
    if any(word in lowered for word in ("button", "input", "text", "slider", "ui")):
        return "UI helpers"
    return "Other runtime types"


def generate_module(
    runtime: dict[str, Any], runtimes: list[dict[str, Any]], snapshot_names: list[str]
) -> str:
    live_instances = collect_live_instances(runtimes)
    classes = [
        candidate
        for candidate in runtime.get("classes", [])
        if candidate.get("module") == "__main__" and is_identifier(str(candidate.get("name", "")))
    ]
    classes.sort(key=lambda item: (class_source_line(item) or 2**31, item["name"].casefold()))
    class_names = {candidate["name"] for candidate in classes}
    functions = []
    for name, value in runtime.get("mainGlobals", {}).items():
        if (
            name in class_names
            or not is_identifier(name)
            or value.get("kind") != "callable"
            or value.get("module") != "__main__"
            or "." in str(value.get("qualname", ""))
            or not is_original_game_callable(value)
        ):
            continue
        functions.append((name, value))
    functions.sort(key=callable_sort_key)

    lines = [
        '"""Generated War of Dots Python runtime reference.',
        "",
        "This is a readable interface skeleton reconstructed from live runtime",
        "metadata. It is not decompiled source and cannot run the game.",
        f"Snapshots: {', '.join(snapshot_names)}",
        f"Generator format: {FORMAT_VERSION}",
        '"""',
        "",
        "from __future__ import annotations",
        "",
        "from typing import Any",
        "",
        "_RUNTIME_DEFAULT = object()",
        "",
        "",
        "class RuntimeCodeUnavailable(NotImplementedError):",
        '    """Raised when a Nuitka-compiled implementation was not recoverable."""',
        "",
        "",
    ]
    for index, (name, value) in enumerate(functions):
        lines.extend(render_callable(name, value))
        lines.extend(["", ""] if index != len(functions) - 1 or classes else [""])
    for index, candidate in enumerate(classes):
        lines.extend(render_class(candidate, live_instances.get(candidate["name"], [])))
        if index != len(classes) - 1:
            lines.extend(["", ""])
    lines.append("")
    result = "\n".join(lines)
    ast.parse(result, filename="game_runtime_reference.py")
    return result


def generate_index(
    runtime: dict[str, Any], runtimes: list[dict[str, Any]], snapshot_names: list[str]
) -> str:
    live_instances = collect_live_instances(runtimes)
    classes = [c for c in runtime.get("classes", []) if c.get("module") == "__main__"]
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for candidate in classes:
        grouped[category_for(candidate["name"])].append(candidate)

    lines = [
        "# Reconstructed Python reference",
        "",
        "This directory is generated from live runtime captures. It presents the",
        "recoverable parts of the compiled game as ordinary Python: class names,",
        "call signatures, original source line numbers, local-variable names, live",
        "field shapes, and safe constants.",
        "",
        "It is **not decompiled game source**. Nuitka's exposed code objects are guard",
        "stubs, so every unavailable implementation raises `RuntimeCodeUnavailable`.",
        "",
        "Credential-like fields and personal account identifiers are redacted from",
        "the generated Python even if they were present in a private raw snapshot.",
        "",
        f"Snapshots used: `{ '`, `'.join(snapshot_names) }`",
        "",
        "Open [`game_runtime_reference.py`](game_runtime_reference.py) for the",
        "searchable source-shaped view.",
        "",
        "## Important recovered map path",
        "",
        "```python",
        "position = world_scene.pick_map_location()",
        "world_scene.prepare_map(position)",
        "# Internally related recovered APIs:",
        "world_scene.generate_bias_map(point, size)",
        "generator.generate_terrain(bias_map=None)",
        "generator.generate_content(image)",
        "```",
        "",
        "`prepare_map` requires `position`. The call relationship beyond that is an",
        "evidence-based model, not recovered method bytecode.",
        "",
    ]
    for category in ("Scenes", "Managers", "Map and gameplay", "UI helpers", "Other runtime types"):
        candidates = grouped.get(category, [])
        if not candidates:
            continue
        lines.extend([f"## {category}", "", "| Class | Source line | Methods | Live fields |", "| --- | ---: | ---: | ---: |"])
        for candidate in sorted(candidates, key=lambda c: (class_source_line(c) or 2**31, c["name"])):
            methods = sum(
                value.get("kind") == "callable"
                for value in candidate.get("attributes", {}).values()
            )
            fields = len(merge_instance_fields(live_instances.get(candidate["name"], [])))
            lines.append(
                f"| `{candidate['name']}` | {class_source_line(candidate) or '—'} | {methods} | {fields} |"
            )
        lines.append("")
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("runtime", type=Path, help="Primary runtime.json interface capture")
    parser.add_argument("output", type=Path, help="Generated reference directory")
    parser.add_argument(
        "--merge-runtime",
        action="append",
        default=[],
        type=Path,
        help="Additional runtime.json whose live instance fields should be merged",
    )
    args = parser.parse_args()

    paths = [args.runtime, *args.merge_runtime]
    runtimes = [load_runtime(path) for path in paths]
    snapshot_names = [path.parent.name for path in paths]
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "game_runtime_reference.py").write_text(
        generate_module(runtimes[0], runtimes, snapshot_names), encoding="utf-8"
    )
    (args.output / "README.md").write_text(
        generate_index(runtimes[0], runtimes, snapshot_names), encoding="utf-8"
    )
    manifest = {
        "formatVersion": FORMAT_VERSION,
        "snapshots": snapshot_names,
        "primaryCaptureTime": runtimes[0].get("capturedAt"),
        "classCount": sum(c.get("module") == "__main__" for c in runtimes[0].get("classes", [])),
        "generatedFiles": ["README.md", "game_runtime_reference.py"],
        "limitations": [
            "Nuitka-compiled method bodies are not present in exposed Python bytecode.",
            "Live fields only cover objects reachable in the captured scenes.",
            "JSON-safe constants may represent original tuples as lists.",
            "Credential-like fields and personal account identifiers are redacted.",
        ],
    }
    (args.output / "manifest.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8"
    )
    print(json.dumps(manifest))


if __name__ == "__main__":
    main()
