from __future__ import annotations

import ctypes
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess

import pytest

from wod_replay_server import desktop_cli
from wod_replay_server.config import DEFAULT_STEAM_GAME_DIR


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("recorder_audio", ROOT / "scripts" / "recorder-audio.py")
audio_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audio_module)


def test_audio_options_default_to_silent_and_report_capabilities():
    args = desktop_cli.build_parser().parse_args(["--desktop-command", "record-replay"])
    assert (args.music_volume, args.sfx_volume) == (0, 0)
    assert desktop_cli.command_recorder_capabilities()["audio_controls"] == ["music", "sfx"]


@pytest.mark.parametrize("music,sfx", [(-1, 0), (0, 101)])
def test_invalid_volumes_fail_before_creating_a_job(music, sfx, tmp_path):
    with pytest.raises(ValueError, match="between 0 and 100"):
        desktop_cli.command_record_replay(tmp_path, tmp_path / "missing.rep", None,
                                         tmp_path / "video.mp4", None, tmp_path / "cancel",
                                         tmp_path / "status.json", 10, 5000, 720,
                                         music_volume=music, sfx_volume=sfx)
    assert not (tmp_path / "jobs").exists()


@pytest.mark.skipif(os.name != "nt" or not (DEFAULT_STEAM_GAME_DIR / "sdl2_mixer.dll").is_file(),
                    reason="Requires the game's bundled Windows mixer")
def test_native_mixer_capture_has_exact_frame_duration_and_muxes_audio(monkeypatch, tmp_path):
    monkeypatch.setenv("SDL_AUDIODRIVER", "dummy")
    with os.add_dll_directory(str(DEFAULT_STEAM_GAME_DIR)):
        sdl = ctypes.CDLL(str(DEFAULT_STEAM_GAME_DIR / "sdl2.dll"))
        mixer = ctypes.CDLL(str(DEFAULT_STEAM_GAME_DIR / "sdl2_mixer.dll"))
        assert sdl.SDL_InitSubSystem(0x10) == 0
        assert mixer.Mix_OpenAudio(44100, 0x8010, 2, 512) == 0
        mixer.Mix_QuickLoad_RAW.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
        mixer.Mix_QuickLoad_RAW.restype = ctypes.c_void_p
        mixer.Mix_PlayChannelTimed.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_int, ctypes.c_int]
        mixer.Mix_FreeChunk.argtypes = [ctypes.c_void_p]
        audio = None
        chunk = None
        try:
            audio = audio_module.ReplayAudioCapture(str(DEFAULT_STEAM_GAME_DIR), str(tmp_path / "audio.pcm"), 29)
            # A known PCM signal makes lost or silent samples detectable.
            signal = b"\x00\x20\x00\x20" * 44100
            buffer = ctypes.create_string_buffer(signal)
            chunk = mixer.Mix_QuickLoad_RAW(buffer, len(signal))
            assert mixer.Mix_PlayChannelTimed(-1, chunk, -1, -1) >= 0
            for _ in range(58):
                audio.capture_frame()
            assert audio.samples == 88200
            audio.close()
            audio.close()  # Error handling can close an already finished track.
            data = Path(audio.path).read_bytes()
            assert len(data) == 88200 * 4
            assert any(data)

            ffmpeg, ffprobe = shutil.which("ffmpeg"), shutil.which("ffprobe")
            if ffmpeg and ffprobe:
                video = tmp_path / "video.mp4"
                subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
                                "-i", "color=size=64x64:rate=29:duration=2", "-c:v", "libx264", str(video)], check=True)
                audio_module.mux_replay_audio(ffmpeg, str(video), audio.path, lambda: None)
                probe = subprocess.run([ffprobe, "-v", "error", "-show_streams", "-of", "json", str(video)],
                                       check=True, capture_output=True, text=True)
                streams = json.loads(probe.stdout)["streams"]
                assert {stream["codec_type"] for stream in streams} == {"video", "audio"}
                assert all(abs(float(stream["duration"]) - 2) < 0.05 for stream in streams)
                assert not Path(str(video) + ".audio.mp4").exists()
        finally:
            if audio is not None:
                audio.close()
            mixer.Mix_HaltChannel(-1)
            if chunk:
                mixer.Mix_FreeChunk(chunk)
            mixer.Mix_CloseAudio()
            sdl.SDL_QuitSubSystem(0x10)


def test_failed_audio_mux_preserves_video_and_cleans_partial_file(monkeypatch, tmp_path):
    video = tmp_path / "video.mp4"
    video.write_bytes(b"original")

    class FailedEncoder:
        returncode = 1

        def __init__(self, command, **kwargs):
            Path(command[-1]).write_bytes(b"incomplete")

        def communicate(self, **kwargs):
            return None, b"encoding failed"

        def poll(self):
            return self.returncode

    monkeypatch.setattr(audio_module.subprocess, "Popen", FailedEncoder)
    with pytest.raises(RuntimeError, match="encoding failed"):
        audio_module.mux_replay_audio("ffmpeg", str(video), "audio.pcm", lambda: None)
    assert video.read_bytes() == b"original"
    assert not Path(str(video) + ".audio.mp4").exists()
