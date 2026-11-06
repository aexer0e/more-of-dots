// A match's sounds, by the rules the replay player follows (src/player/sound.js):
// the music on repeat, the fighting loop at a volume that follows how many units
// are in combat, a sound when the player's side produces a unit, and the end.
// The site plays silently when its audio folder is missing.
const files = {
  music: "music.mp3",
  fighting: "fighting.flac",
  produce_unit: "produce_unit.wav",
  victory: "victory.wav",
  defeat: "defeat.wav",
};
const VOLUME = 0.3;

export class MatchSound {
  constructor(base) {
    this.base = base;
    this.smoothed = 0;
    this.audio = {};
    this.available = fetch(`${base}audio/${files.produce_unit}`, { method: "HEAD" })
      .then((response) => response.ok)
      .catch(() => false);
  }
  async clip(name, loop = false) {
    if (!(await this.available)) return null;
    const audio = new Audio(`${this.base}audio/${files[name]}`);
    audio.loop = loop;
    return audio;
  }
  async start() {
    this.music = await this.clip("music", true);
    this.fighting = await this.clip("fighting", true);
    if (this.music) {
      this.music.volume = VOLUME;
      void this.music.play().catch(() => {});
    }
  }
  /** Each drawn frame reports units in combat and the sides that produced units. */
  frame(state, side) {
    const [fighting = 0, produced = 0] = state.audio || [];
    this.smoothed += 0.03 * (fighting - this.smoothed);
    if (this.fighting) {
      const volume = this.smoothed > 0.01 ? (Math.min(1, Math.sqrt(this.smoothed) / 5) / 3) * VOLUME : 0;
      this.fighting.volume = volume;
      if (volume && this.fighting.paused) void this.fighting.play().catch(() => {});
      if (!volume && !this.fighting.paused) this.fighting.pause();
    }
    if (side !== null && produced & (1 << side))
      void this.clip("produce_unit").then((audio) => {
        if (!audio) return;
        audio.volume = VOLUME;
        void audio.play().catch(() => {});
      });
  }
  end(result) {
    this.music?.pause();
    this.fighting?.pause();
    void this.clip(result === 0 ? "defeat" : "victory").then((audio) => {
      if (!audio) return;
      audio.volume = VOLUME / 2;
      void audio.play().catch(() => {});
    });
  }
  stop() {
    this.music?.pause();
    this.fighting?.pause();
  }
}
