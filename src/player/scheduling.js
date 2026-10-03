// One running task and one replaceable target. Slow work cannot grow a queue.
export class LatestTask {
  constructor(run) {
    this.run = run;
    this.active = false;
    this.next = null;
    this.waiters = [];
  }
  submit(value) {
    return new Promise((resolve, reject) => {
      if (this.next) this.next.resolve(false);
      this.next = { value, resolve, reject };
      this.drain();
    });
  }
  async drain() {
    if (this.active) return;
    this.active = true;
    while (this.next) {
      const task = this.next;
      this.next = null;
      try {
        task.resolve(await this.run(task.value));
      } catch (error) {
        task.reject(error);
      }
    }
    this.active = false;
    this.waiters.splice(0).forEach((resolve) => resolve());
  }
  cancel() {
    this.next?.resolve(false);
    this.next = null;
  }
  idle() {
    return this.active
      ? new Promise((resolve) => this.waiters.push(resolve))
      : Promise.resolve();
  }
}

// Read-ahead is bounded by both frame count and encoded bytes. A generation
// prevents an old replay from repopulating the current buffer. A missed frame
// is read on its own first, so a seek waits for one small read instead of a
// whole block, then read-ahead continues from the new position.
export class FrameBuffer {
  constructor(
    read,
    {
      block = 45,
      demand = 3,
      ahead = 240,
      maxFrames = 540,
      maxBytes = 24 * 1024 * 1024,
    } = {},
  ) {
    Object.assign(this, { read, block, demand, maxFrames, maxBytes });
    // Read-ahead stays within half the budget so eviction never removes it.
    this.ahead = Math.max(1, Math.min(ahead, Math.floor((maxFrames - 1) / 2)));
    this.reset(0);
  }
  reset(count) {
    this.generation = (this.generation || 0) + 1;
    this.count = count;
    this.center = 0;
    this.bytes = 0;
    this.rows = new Map();
    this.loading = new Map();
    this.prefetching = false;
    this.hits = 0;
    this.misses = 0;
  }
  // Frames become readable while the simulation is still running.
  extend(count) {
    this.count = Math.max(this.count, count);
  }
  covering(index) {
    for (const [start, task] of this.loading)
      if (index >= start && index < task.end) return task.promise;
    return null;
  }
  load(start, count) {
    count = Math.min(count, this.count - start);
    if (start < 0 || count <= 0) return Promise.resolve();
    const generation = this.generation;
    const loading = this.loading;
    const promise = this.read(start, count)
      .then(({ rows, bytes }) => {
        if (generation !== this.generation) return;
        const cost = Math.max(1, Math.ceil(bytes / Math.max(1, rows.length)));
        rows.forEach((row, index) => {
          const key = start + index;
          if (!this.rows.has(key)) {
            this.rows.set(key, { row, cost });
            this.bytes += cost;
          }
        });
        const farthest = [...this.rows.keys()].sort(
          (a, b) => Math.abs(b - this.center) - Math.abs(a - this.center),
        );
        for (const key of farthest) {
          if (this.rows.size <= this.maxFrames && this.bytes <= this.maxBytes)
            break;
          // Always preserve the demanded frame, even when one frame exceeds the budget.
          if (key === this.center) continue;
          this.bytes -= this.rows.get(key).cost;
          this.rows.delete(key);
        }
      })
      .finally(() => loading.delete(start));
    loading.set(start, { end: start + count, promise });
    return promise;
  }
  async get(index) {
    this.center = index;
    if (this.rows.has(index)) this.hits++;
    else this.misses++;
    const generation = this.generation;
    if (!this.rows.has(index))
      await (this.covering(index) ?? this.load(index, this.demand));
    if (generation !== this.generation) return null;
    // A byte-limited backend batch may stop before the requested row.
    if (!this.rows.has(index)) await this.load(index, 1);
    if (generation !== this.generation) return null;
    const row = this.rows.get(index)?.row;
    if (!row) throw new Error("Replay buffer returned no requested frame.");
    this.prefetch();
    return row;
  }
  // One speculative read at a time, always continuing from the latest position.
  prefetch() {
    if (this.prefetching) return;
    this.prefetching = true;
    const generation = this.generation;
    void (async () => {
      try {
        while (generation === this.generation) {
          const limit = Math.min(this.count, this.center + 1 + this.ahead);
          let next = this.center + 1;
          while (next < limit && (this.rows.has(next) || this.covering(next)))
            next++;
          if (next >= limit) break;
          await this.load(next, this.block);
          // Stop if the byte budget evicted what was just read.
          if (!this.rows.has(next)) break;
        }
      } catch {
        /* A speculative failure is retried and reported on demand. */
      } finally {
        if (generation === this.generation) this.prefetching = false;
      }
    })();
  }
  stats() {
    return {
      frames: this.rows.size,
      bytes: this.bytes,
      requests: this.loading.size,
      hits: this.hits,
      misses: this.misses,
    };
  }
}
