import test from "node:test";
import assert from "node:assert/strict";
import { LatestTask, FrameBuffer } from "../src/player/scheduling.js";
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
const tick = () => new Promise((r) => setImmediate(r));
const read = async (start, count) => ({
  rows: Array.from({ length: count }, (_, i) => ({ frame: start + i })),
  bytes: count * 100,
});

test("a stalled renderer retains only the newest of 200 seek requests", async () => {
  const gate = deferred(),
    seen = [];
  const queue = new LatestTask(async (frame) => {
    seen.push(frame);
    if (frame === 0) await gate.promise;
    return frame;
  });
  const first = queue.submit(0),
    pending = Array.from({ length: 200 }, (_, i) => queue.submit(i + 1));
  await tick();
  assert.deepEqual(seen, [0]);
  gate.resolve();
  await first;
  const results = await Promise.all(pending);
  await queue.idle();
  assert.deepEqual(seen, [0, 200]);
  assert.equal(results.filter((result) => result !== false).length, 1);
});
test("cancellation drains active work and drops obsolete pending work", async () => {
  const gate = deferred(),
    seen = [];
  const queue = new LatestTask(async (value) => {
    seen.push(value);
    await gate.promise;
    return true;
  });
  const active = queue.submit(1),
    pending = queue.submit(2);
  queue.cancel();
  assert.equal(await pending, false);
  let idle = false;
  const drain = queue.idle().then(() => (idle = true));
  await tick();
  assert.equal(idle, false);
  gate.resolve();
  await active;
  await drain;
  assert.deepEqual(seen, [1]);
});
test("a failed task does not poison the next frame", async () => {
  const queue = new LatestTask(async (value) => {
    if (!value) throw new Error("failed");
    return value;
  });
  await assert.rejects(queue.submit(0), /failed/);
  assert.equal(await queue.submit(5), 5);
});
test("warm playback reads ahead and remains bounded by count and bytes", async () => {
  let calls = 0;
  const buffer = new FrameBuffer(
    async (...args) => {
      calls++;
      return read(...args);
    },
    { block: 10, maxFrames: 25, maxBytes: 2200 },
  );
  buffer.reset(1000);
  assert.equal((await buffer.get(0)).frame, 0);
  for (let i = 0; i < 5; i++) await tick();
  const misses = buffer.stats().misses;
  for (const index of [1, 5, 12])
    assert.equal((await buffer.get(index)).frame, index);
  assert.equal(buffer.stats().misses, misses);
  assert.ok(calls > 1);
  for (const index of [90, 500, 990, 100]) {
    assert.equal((await buffer.get(index)).frame, index);
    await tick();
  }
  assert.ok(buffer.stats().frames <= 25);
  assert.ok(buffer.stats().bytes <= 2200);
});
test("a late fetch from an old replay cannot fill the new buffer", async () => {
  const gate = deferred();
  const buffer = new FrameBuffer(
    async (start, count) => {
      if (start === 0) await gate.promise;
      return read(start, count);
    },
    { block: 10 },
  );
  buffer.reset(100);
  const obsolete = buffer.get(0);
  buffer.reset(200);
  assert.equal((await buffer.get(100)).frame, 100);
  gate.resolve();
  assert.equal(await obsolete, null);
  await tick();
  assert.equal(buffer.rows.has(0), false);
});
test("a byte-limited partial block can still satisfy a seek near its end", async () => {
  const buffer = new FrameBuffer(
    async (start) => ({ rows: [{ frame: start }], bytes: 100 }),
    { block: 90 },
  );
  buffer.reset(500);
  assert.equal((await buffer.get(89)).frame, 89);
});
test("speculative failure retries on demand without hiding errors", async () => {
  let fail = true;
  const buffer = new FrameBuffer(
    async (start, count) => {
      if (start === 10 && fail) {
        fail = false;
        throw new Error("temporary");
      }
      return read(start, count);
    },
    { block: 10 },
  );
  buffer.reset(50);
  await buffer.get(0);
  await tick();
  assert.equal((await buffer.get(10)).frame, 10);
});
test("only one speculative and one demanded fetch can be outstanding", async () => {
  const gates = [],
    buffer = new FrameBuffer(
      (start, count) => {
        const gate = deferred();
        gates.push({ ...gate, start, count });
        return gate.promise;
      },
      { block: 10 },
    );
  buffer.reset(100);
  const first = buffer.get(0);
  gates[0].resolve(await read(0, 10));
  await first;
  const seek = buffer.get(80);
  await tick();
  assert.equal(buffer.stats().requests, 2);
  gates.find((g) => g.start === 80).resolve(await read(80, 10));
  await seek;
  gates.find((g) => g.start === 10).resolve(await read(10, 10));
  await tick();
  buffer.reset(0);
  for (const gate of gates) gate.resolve(await read(gate.start, gate.count));
});
test("a seek reads only the demanded frames before reading ahead", async () => {
  const reads = [];
  const buffer = new FrameBuffer(
    async (start, count) => {
      reads.push([start, count]);
      return read(start, count);
    },
    { block: 20, demand: 3 },
  );
  buffer.reset(10000);
  assert.equal((await buffer.get(7000)).frame, 7000);
  assert.deepEqual(reads[0], [7000, 3]);
  for (let i = 0; i < 5; i++) await tick();
  assert.deepEqual(reads[1], [7003, 20]);
  assert.ok(buffer.rows.has(7022));
});
test("frames become readable as the simulation extends the replay", async () => {
  const reads = [];
  const buffer = new FrameBuffer(
    async (start, count) => {
      reads.push([start, count]);
      return read(start, count);
    },
    { block: 10, demand: 2 },
  );
  buffer.reset(4);
  await buffer.get(0);
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(buffer.rows.has(4), false);
  assert.ok(reads.every(([start, count]) => start + count <= 4));
  buffer.extend(30);
  assert.equal((await buffer.get(3)).frame, 3);
  for (let i = 0; i < 5; i++) await tick();
  assert.ok(buffer.rows.has(12));
});
