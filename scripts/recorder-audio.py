"""Injected into the isolated game process alongside the video capture hook.

SDL's dummy audio device mixes only this game's music and effects. Advance it
one video frame at a time so slow rendering and accelerated simulation do not
change the length of the audio track. No microphone or desktop audio is used.
"""

import ctypes
import os
import subprocess
import threading
import time


class ReplayAudioCapture:
    def __init__(self, directory, path, fps):
        self.path = path
        self.fps = fps
        self.frames = 0
        self.samples = 0
        self.pending = bytearray()
        self.ready = threading.Event()
        self.required = 0
        self.writer = None
        self.closed = False
        self.mixer = ctypes.CDLL(os.path.join(directory, 'sdl2_mixer.dll'))
        self.sdl = ctypes.CDLL(os.path.join(directory, 'sdl2.dll'))
        self.sdl.SDL_GetAudioDeviceStatus.argtypes = [ctypes.c_uint32]
        self.sdl.SDL_GetAudioDeviceStatus.restype = ctypes.c_int
        self.sdl.SDL_PauseAudioDevice.argtypes = [ctypes.c_uint32, ctypes.c_int]
        self.sdl.SDL_PauseAudioDevice.restype = None
        self.mixer.Mix_QuerySpec.argtypes = [ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_uint16), ctypes.POINTER(ctypes.c_int)]
        self.mixer.Mix_QuerySpec.restype = ctypes.c_int
        rate, audio_format, channels = ctypes.c_int(), ctypes.c_uint16(), ctypes.c_int()
        if not self.mixer.Mix_QuerySpec(ctypes.byref(rate), ctypes.byref(audio_format), ctypes.byref(channels)):
            raise RuntimeError('The game audio mixer is not running.')
        if audio_format.value != 0x8010 or channels.value not in (1, 2):
            raise RuntimeError('Recording requires the game mixer to use 16-bit mono or stereo audio.')
        self.rate, self.channels = rate.value, channels.value
        self.sample_bytes = self.channels * 2
        self.native_pause = getattr(self.mixer, 'Mix_PauseAudio', None)
        if self.native_pause is not None:
            self.native_pause.argtypes = [ctypes.c_int]
            self.native_pause.restype = None
        else:
            # Older game packages predate Mix_PauseAudio. Identify their single
            # SDL device from live handles, not the hardware device index.
            devices = [device for device in range(2, 256) if self.sdl.SDL_GetAudioDeviceStatus(device) != 0]
            if len(devices) != 1:
                raise RuntimeError('Could not identify the isolated game audio device.')
            self.device = devices[0]
        self.pause(True)
        callback_type = ctypes.CFUNCTYPE(None, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int)
        self.callback = callback_type(self.receive)
        self.mixer.Mix_SetPostMix.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        self.mixer.Mix_SetPostMix.restype = None
        try:
            self.writer = open(path, 'wb')
            self.mixer.Mix_SetPostMix(self.callback, None)
        except Exception:
            self.close()
            raise

    def pause(self, paused):
        if self.native_pause is not None:
            self.native_pause(int(paused))
        else:
            self.sdl.SDL_PauseAudioDevice(self.device, int(paused))

    def receive(self, _userdata, stream, length):
        # SDL holds its mixer lock here. Never wait or call mixer APIs here.
        self.pending.extend(ctypes.string_at(stream, length))
        ctypes.memset(stream, 0, length)
        if len(self.pending) >= self.required:
            self.ready.set()

    def capture_frame(self):
        next_samples = (self.frames + 1) * self.rate // self.fps
        needed = (next_samples - self.samples) * self.sample_bytes
        if len(self.pending) < needed:
            self.required = needed
            self.ready.clear()
            self.pause(False)
            try:
                if not self.ready.wait(5):
                    raise RuntimeError('The game audio mixer stopped producing samples.')
            finally:
                self.pause(True)
        # Keep the tail of an SDL mixing block for the next video frame.
        self.writer.write(self.pending[:needed])
        del self.pending[:needed]
        self.frames += 1
        self.samples = next_samples

    def close(self):
        if self.closed:
            return
        self.closed = True
        self.pause(True)
        self.mixer.Mix_SetPostMix(None, None)
        if self.writer is not None:
            self.writer.close()
        self.pause(False)


def mux_replay_audio(ffmpeg, video_path, audio_path, heartbeat, cancel_path='', sample_rate=44100, channels=2):
    output = video_path + '.audio.mp4'
    command = [ffmpeg, '-hide_banner', '-loglevel', 'error', '-y',
               '-i', video_path, '-f', 's16le', '-ar', str(sample_rate), '-ac', str(channels),
               '-i', audio_path, '-map', '0:v:0', '-map', '1:a:0',
               '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest',
               '-movflags', '+faststart', output]
    process = None
    try:
        process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                   creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        deadline = time.monotonic() + 300
        while True:
            if cancel_path and os.path.exists(cancel_path):
                raise RuntimeError('Audio export cancelled.')
            try:
                _, errors = process.communicate(timeout=1)
                break
            except subprocess.TimeoutExpired:
                heartbeat()
                if time.monotonic() >= deadline:
                    raise RuntimeError('Audio export timed out.')
        if process.returncode:
            raise RuntimeError('Audio export failed: ' + errors.decode('utf-8', 'replace')[-4000:])
        os.replace(output, video_path)
    finally:
        if process is not None and process.poll() is None:
            process.kill()
            process.communicate()
        if os.path.exists(output):
            os.remove(output)
