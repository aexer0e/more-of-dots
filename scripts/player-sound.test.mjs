import assert from 'node:assert/strict';
import test from 'node:test';
import { ReplaySound, fightingVolume, productionCues, smoothFighting } from '../src/player/sound.js';

test('the fighting count is smoothed per tick and extends as cues arrive', () => {
  const counts = [0, 100];
  const smoothed = smoothFighting(counts, []);
  assert.deepEqual(smoothed, [0, 3]);
  counts.push(100);
  smoothFighting(counts, smoothed);
  assert.equal(smoothed.length, 3);
  assert.ok(Math.abs(smoothed[2] - (3 + 0.03 * 97)) < 1e-12);
});

test('the fighting loop starts at 0.2 and is never louder than a third', () => {
  const smoothed = smoothFighting([0, 0, 100, ...Array(500).fill(100)], []);
  assert.equal(fightingVolume(smoothed, 1), 0, 'silent before the first fight');
  assert.equal(fightingVolume(smoothed, 2), 0.2, 'the loop starts at 0.2 × sfx');
  assert.ok(Math.abs(fightingVolume(smoothed, 3) - Math.sqrt(smoothed[3]) / 5 / 3) < 1e-12);
  assert.ok(Math.abs(fightingVolume(smoothed, 500) - 1 / 3) < 1e-12);
  assert.equal(fightingVolume(smoothed, 900), 0, 'frames not simulated yet are silent');
});

test('production cues count each producing side once per crossed tick', () => {
  const produced = [0, 0b01, 0, 0b11, 0b10];
  assert.equal(productionCues(produced, 0, 1), 1);
  assert.equal(productionCues(produced, 1, 4), 3, 'starts after the previous frame');
  assert.equal(productionCues(produced, 4, 4), 0);
  assert.equal(productionCues(produced, -1, 10), 4, 'clamped to known frames');
});

function audioFixture() {
  const sources = [];
  const sound = new ReplaySound(async () => null);
  const gain = () => ({ gain: {
    value: 0, setTargetAtTime(value) { this.value = value; },
    setValueAtTime(value) { this.value = value; }, cancelScheduledValues() {},
  }, connect() {} });
  sound.context = {
    currentTime: 0, destination: {}, resume: async () => {}, createGain: gain,
    createBufferSource() {
      const source = { playbackRate: { value: 1 }, stopped: false,
        connect(target) { return target; },
        start(when = 0, offset = 0) { this.offset = offset; }, stop() { this.stopped = true; } };
      sources.push(source);
      return source;
    },
  };
  sound.music = { duration: 10, currentTime: 0, paused: true,
    play: async function () { this.paused = false; }, pause() { this.paused = true; } };
  sound.fightingGain = gain();
  sound.clips = Object.fromEntries(['fighting', 'produce', 'victory', 'defeat'].map(name => [name, { duration: 2 }]));
  sound.loading = Promise.resolve(sound);
  sound.reset({ fighting: Array(1000).fill(100), produced: Array(1000).fill(1) });
  return { sound, sources };
}

test('seeking silences all old audio and resumes at the new replay time', async () => {
  const { sound, sources } = audioFixture();
  await sound.start(30);
  sound.advance(31);
  assert.ok(sources.length >= 2, 'combat and production are audible before seeking');
  sound.seek(450);
  assert.equal(sound.playing, false);
  assert.equal(sound.music.paused, true);
  assert.equal(sound.music.currentTime, 5, '15 seconds into a 10-second looping track');
  assert.equal(sound.voices.size, 0);
  assert.equal(sound.loop, null);
  assert.equal(sound.fightingGain.gain.value, 0);
  assert.ok(sources.every(source => source.stopped));
  const produced = sound.played.produce;
  sound.advance(600);
  assert.equal(sound.played.produce, produced, 'scrubbing skips production cues');
  await sound.start(600);
  assert.equal(sound.music.paused, false);
  assert.equal(sound.music.currentTime, 0);
  assert.equal(sound.music.playbackRate, 1);
  assert.equal(sound.loop.playbackRate.value, 1);
  sound.advance(601);
  assert.equal(sound.played.produce, produced + 1, 'resume plays only the new tick');
});

test('pause cancels audio loading, and backwards seeks reset loop phase', async () => {
  const { sound } = audioFixture();
  let resolve;
  sound.loading = new Promise(done => { resolve = done; });
  const starting = sound.start(300);
  sound.stop();
  resolve(sound);
  await starting;
  assert.equal(sound.music.paused, true, 'late audio readiness cannot restart a paused replay');
  sound.seek(75);
  await sound.start(75);
  assert.equal(sound.loop.offset, .5);
  assert.equal(sound.music.currentTime, 2.5);
  assert.equal(sound.loop.playbackRate.value, 1);
  sound.stop();
  sound.seek(0);
  assert.equal(sound.music.currentTime, 0);
  assert.equal(sound.music.paused, true);
});

test('fast and slow replay advancement leaves audio at its natural rate and position', async () => {
  const { sound, sources } = audioFixture();
  await sound.start(0);
  sound.music.currentTime = 1;
  sound.advance(240); // Eight replay seconds in one wall-clock second.
  assert.equal(sound.music.currentTime, 1);
  sound.syncMusic(); // Unlocking audio must not jump to replay time either.
  assert.equal(sound.music.currentTime, 1);
  sound.advance(241); // A slow tick must not stretch existing clips.
  assert.equal(sound.music.playbackRate, 1);
  assert.ok(sources.every(source => source.playbackRate.value === 1));
  sound.stop();
  await sound.start(241);
  assert.equal(sound.music.currentTime, 1, 'pause/resume preserves the music position');
  sound.end(1);
  assert.equal(sources.at(-1).playbackRate.value, 1, 'victory also plays at its natural rate');
});
