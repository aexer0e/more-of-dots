// The game's replay sounds, with the rules of its SoundManager (the export mixer
// in src-tauri/src/audio.rs follows the same ones):
// - music: won.wav on repeat at the music volume, paused when the game ends;
// - fighting: each tick reports how many units are in combat; the count is
//   smoothed (s += 0.03 × (n − s)), the loop starts at 0.2 × sfx once s is
//   non-zero and then plays at min(1, √s / 5) / 3 × sfx;
// - a side that produced units plays produce_unit at the sfx volume;
// - the end plays victory (any result but 0) or defeat at half the sfx volume;
// - eight channels; a sound with no free channel is dropped.
// The sounds are the installed game's own files; without the game, replays are silent.
// Replay speed changes when cues occur, never a clip's pitch or duration.
const CHANNELS = 8;

/** Extends `smoothed` to cover every reported tick. */
export function smoothFighting(counts, smoothed) {
  let s = smoothed.length ? smoothed[smoothed.length - 1] : 0;
  for (let i = smoothed.length; i < counts.length; i++) {
    s += 0.03 * ((counts[i] ?? 0) - s);
    smoothed.push(s);
  }
  return smoothed;
}

/** The fighting loop's volume, before the sfx volume, at `frame`; the loop
 * starts at the first non-zero value (`start`, found when omitted). */
export function fightingVolume(smoothed, frame, start = smoothed.findIndex((s) => s !== 0)) {
  if (start < 0 || frame < start || frame >= smoothed.length) return 0;
  if (frame === start) return 0.2;
  return Math.min(1, Math.sqrt(smoothed[frame]) / 5) / 3;
}

/** Production sounds due between two frames, after `from` up to `to`. */
export function productionCues(produced, from, to) {
  let count = 0;
  for (let frame = Math.max(0, from + 1); frame <= to && frame < produced.length; frame++) {
    let sides = produced[frame] ?? 0;
    while (sides) {
      count += sides & 1;
      sides >>= 1;
    }
  }
  return count;
}

export class ReplaySound {
  // `locate` resolves to a URL for each sound, or null when the game is not installed.
  constructor(locate) {
    this.locate = locate;
    this.volume = { music: 0.3, sfx: 0.3 };
    this.smoothed = [];
    this.fightStart = -1;
    this.frame = 0;
    this.playing = false;
    this.musicNeedsSeek = true;
    this.generation = 0;
    this.voices = new Set();
    // How often each sound started, for QA reports.
    this.played = {};
  }

  // Audio starts on first use, so opening the player costs nothing.
  async ready() {
    this.loading ??= (async () => {
      const urls = await this.locate();
      if (!urls) throw new Error("War of Dots is not installed.");
      const context = new AudioContext();
      const decode = async (name) => {
        const response = await fetch(urls[name]);
        if (!response.ok) throw new Error(`Cannot read the game's ${name} sound.`);
        return context.decodeAudioData(await response.arrayBuffer());
      };
      const [fighting, produce, victory, defeat] = await Promise.all(
        ["fighting", "produce_unit", "victory", "defeat"].map(decode),
      );
      // The 8½-minute music streams from the game's file instead of being decoded whole.
      const music = new Audio(urls.music);
      music.loop = true;
      music.volume = this.volume.music;
      const fightingGain = context.createGain();
      fightingGain.gain.value = 0;
      fightingGain.connect(context.destination);
      Object.assign(this, { context, music, fightingGain, clips: { fighting, produce, victory, defeat } });
      music.addEventListener("loadedmetadata", () => this.syncMusic());
      // Browsers may hold audio until the user interacts with the window.
      const unlock = () => {
        void context.resume();
        if (this.playing) {
          this.syncMusic();
          void music.play().catch(() => {});
        }
      };
      addEventListener("pointerdown", unlock);
      addEventListener("keydown", unlock);
      return this;
    })();
    return this.loading;
  }

  setVolume(music, sfx) {
    this.volume = { music, sfx };
    if (this.music) this.music.volume = music;
    this.updateFighting();
  }

  // A new replay; `cues` grow while it is being simulated.
  reset(cues) {
    this.stop();
    this.cues = cues;
    this.smoothed = [];
    this.fightStart = -1;
    this.frame = 0;
    this.musicNeedsSeek = true;
    if (this.music) this.music.currentTime = 0;
  }

  start(frame) {
    const generation = ++this.generation;
    this.playing = true;
    if (this.frame !== frame) this.musicNeedsSeek = true;
    this.frame = frame;
    return this.ready()
      .then(() => {
        if (!this.playing || generation !== this.generation) return;
        void this.context.resume();
        this.syncMusic();
        void this.music.play().catch(() => {});
        this.updateFighting();
      })
      .catch((error) => {
        // Without the game installed, replays play silently.
        this.error = String(error);
      });
  }

  stop() {
    this.generation++;
    this.playing = false;
    this.music?.pause();
    for (const voice of this.voices) voice.stop();
    this.voices.clear();
    this.loop?.stop();
    this.loop = null;
    this.updateFighting();
  }

  // A jump skips the cues in between.
  seek(frame) {
    this.stop();
    this.frame = frame;
    this.musicNeedsSeek = true;
    this.syncMusic();
    this.updateFighting();
  }

  syncMusic() {
    if (!this.music) return;
    this.music.playbackRate = 1;
    if (!this.musicNeedsSeek) return;
    const time = this.frame / 30;
    // Duration is only available after the streamed file's metadata arrives.
    if (Number.isFinite(this.music.duration) && this.music.duration > 0) {
      this.music.currentTime = time % this.music.duration;
      this.musicNeedsSeek = false;
    }
  }

  // Playback moved forward to `frame`.
  advance(frame) {
    if (!this.playing || !this.cues || !this.context) {
      if (!this.playing && this.frame !== frame) this.musicNeedsSeek = true;
      this.frame = frame;
      return;
    }
    const count = productionCues(this.cues.produced, this.frame, frame);
    for (let i = 0; i < count; i++) this.play("produce", this.volume.sfx);
    this.frame = frame;
    this.updateFighting();
  }

  // The game ended: the loop and music stop, then victory or defeat plays.
  end(result) {
    this.stop();
    if (this.context && result !== null && result !== undefined)
      this.play(Number(result) === 0 ? "defeat" : "victory", 0.5 * this.volume.sfx);
  }

  play(name, volume) {
    const fighting = this.fightingVolume() > 0 ? 1 : 0;
    if (this.voices.size + fighting >= CHANNELS || volume <= 0) return;
    const source = this.context.createBufferSource();
    const gain = this.context.createGain();
    source.buffer = this.clips[name];
    source.playbackRate.value = 1;
    gain.gain.value = volume;
    source.connect(gain).connect(this.context.destination);
    source.onended = () => this.voices.delete(source);
    this.voices.add(source);
    source.start();
    this.played[name] = (this.played[name] ?? 0) + 1;
  }

  fightingVolume() {
    if (!this.cues) return 0;
    const known = this.smoothed.length;
    smoothFighting(this.cues.fighting, this.smoothed);
    if (this.fightStart < 0) {
      const found = this.smoothed.findIndex((s, i) => i >= known && s !== 0);
      this.fightStart = found;
    }
    return fightingVolume(this.smoothed, this.frame, this.fightStart);
  }

  updateFighting() {
    if (!this.context) return;
    const volume = this.playing ? this.fightingVolume() * this.volume.sfx : 0;
    if (volume > 0 && !this.loop) {
      this.loop = this.context.createBufferSource();
      this.loop.buffer = this.clips.fighting;
      this.loop.loop = true;
      this.loop.playbackRate.value = 1;
      this.loop.connect(this.fightingGain);
      this.loop.start(0, ((this.frame - this.fightStart) / 30) % this.clips.fighting.duration);
    }
    if (volume === 0) {
      this.loop?.stop();
      this.loop = null;
      this.fightingGain.gain.cancelScheduledValues(this.context.currentTime);
      this.fightingGain.gain.setValueAtTime(0, this.context.currentTime);
    } else this.fightingGain.gain.setTargetAtTime(volume, this.context.currentTime, 0.015);
  }
}
