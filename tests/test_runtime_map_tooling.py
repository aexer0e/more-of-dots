import ast
import inspect
import json
from pathlib import Path
import runpy


ROOT = Path(__file__).resolve().parents[1]


def test_runtime_probe_and_snapshot_helpers_are_valid_python() -> None:
    for relative in (
        "tools/runtime-map/runtime_probe.py",
        "tools/runtime-map/summarize_snapshot.py",
        "tools/runtime-map/inventory_artifacts.py",
        "tools/runtime-map/reconstruct_source.py",
    ):
        ast.parse((ROOT / relative).read_text(encoding="utf-8"), filename=relative)


def test_runtime_capture_is_read_only_and_versioned() -> None:
    probe = (ROOT / "tools/runtime-map/runtime_probe.py").read_text(encoding="utf-8")
    launcher = (ROOT / "scripts/capture-runtime-map.ps1").read_text(encoding="utf-8")

    assert "FORMAT_VERSION = 1" in probe
    assert "inspect.signature" in probe
    assert "gc.get_objects()" in probe
    assert "func()" not in probe
    assert "SENSITIVE_WORDS" in probe
    assert '"previewHex"' not in probe
    assert "invoke-python-probe.ps1" in launcher
    assert "Get-FileHash" in launcher


def test_canonical_runtime_snapshot_has_required_indexes() -> None:
    snapshot_index = json.loads(
        (ROOT / "docs/runtime-map/snapshots/index.json").read_text(encoding="utf-8")
    )
    snapshot = ROOT / "docs/runtime-map/snapshots" / snapshot_index["canonical"]
    summary = json.loads((snapshot / "summary.json").read_text(encoding="utf-8"))
    target_names = {candidate["name"] for candidate in summary["targetClasses"]}

    assert snapshot_index["formatVersion"] == 1
    assert {"WorldModeScene", "MapGenerator", "ServerManager", "ReplayManager"} <= target_names
    assert summary["classCount"] >= 4
    assert (snapshot / "runtime.json").is_file()
    assert (snapshot / "process.json").is_file()
    assert (snapshot / "game-files.json").is_file()
    assert (snapshot / "artifacts.json").is_file()


def test_canonical_runtime_snapshot_redacts_sensitive_instance_fields() -> None:
    snapshot_index = json.loads(
        (ROOT / "docs/runtime-map/snapshots/index.json").read_text(encoding="utf-8")
    )
    snapshot = ROOT / "docs/runtime-map/snapshots" / snapshot_index["canonical"]
    runtime = json.loads((snapshot / "runtime.json").read_text(encoding="utf-8-sig"))["runtime"]
    sensitive = ("password", "passwd", "secret", "token", "credential", "cookie", "authorization")
    found = 0
    for instance in runtime["instances"]:
        for name, value in instance.get("attributes", {}).items():
            if any(word in name.lower() for word in sensitive):
                found += 1
                assert value.get("redacted") is True, (instance.get("class"), name)
    assert found > 0


def test_reconstructed_source_is_importable_and_preserves_recovered_api() -> None:
    tooling = runpy.run_path(str(ROOT / "tools/runtime-map/reconstruct_source.py"))
    runtime_paths = [
        ROOT / "docs/runtime-map/snapshots/20260812-062438-pid2888/runtime.json",
        ROOT / "docs/runtime-map/snapshots/20260812-062236-pid2888/runtime.json",
    ]
    runtimes = [tooling["load_runtime"](path) for path in runtime_paths]
    source = tooling["generate_module"](
        runtimes[0], runtimes, [path.parent.name for path in runtime_paths]
    )

    namespace = {"__name__": "wod_runtime_reference"}
    exec(compile(source, "game_runtime_reference.py", "exec"), namespace)

    assert str(inspect.signature(namespace["WorldModeScene"].prepare_map)) == "(self, position)"
    assert namespace["MapGenerator"].MAP_SIZE == [1600, 900]
    assert namespace["MapGenerator"].COLOR_TO_HEIGHT[(39, 155, 255)] == 0.0
    assert "class ServerManager:" in source
    assert "Nuitka-retained local names" in source
    assert "def collect_world_mode_classes" not in source
    steam_id = next(
        instance["attributes"]["steam_id"]["preview"]
        for instance in runtimes[0]["instances"]
        if instance.get("class") == "ServerManager"
    )
    assert steam_id not in source
    assert "steam_id: str  # observed: str (redacted)" in source
