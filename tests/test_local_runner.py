from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from wod_replay_server.local_runner import LocalSessionRunner


def test_runner_command_contains_local_capture_arguments(tmp_path: Path) -> None:
    runner_script = tmp_path / "local-runner.ps1"
    runner_script.write_text("param()", encoding="utf-8")
    runtime_dir = tmp_path / "runtime"
    staged_game_dir = runtime_dir / "staged-game"
    staged_game_dir.mkdir(parents=True)

    settings = SimpleNamespace(
        local_runner_script=runner_script,
        runtime_dir=runtime_dir,
        staged_game_dir=staged_game_dir,
        game_window_title="War of Dots",
        game_desktop_strategy="automation-desktop",
        game_window_strategy="offscreen",
    )
    runner = LocalSessionRunner(settings, owner_pid=4321)

    command = runner._runner_command(  # noqa: SLF001
        ["-CaptureReplay", "-JobId", "abc123", "-SampleHz", "10"],
        timeout_ms=5000,
    )

    assert "powershell.exe" in command
    assert str(runner_script) in command
    assert "-CaptureReplay" in command
    assert "-DesktopStrategy" in command
    assert "automation-desktop" in command
    assert "-OwnerProcessId" in command
    assert "4321" in command
    assert "abc123" in command
    assert str(runtime_dir) in command
