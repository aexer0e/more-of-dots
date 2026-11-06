// Hands a replay and a frame from the player to the play page. The replay can be
// several megabytes, more than a link or session storage holds, so it waits in
// IndexedDB under a random id until the play page takes it.
const DB = "wod-play",
  STORE = "handoff";

function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function run(mode, action) {
  return database().then(
    (db) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE, mode),
          request = action(transaction.objectStore(STORE));
        transaction.oncomplete = () => resolve(request.result);
        transaction.onerror = () => reject(transaction.error);
      }),
  );
}

/** Keeps `{ replay, frame, name }` and returns its id. */
export async function leave(entry) {
  const id = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
  // Entries nobody picked up are cleared after a day.
  await run("readwrite", (store) => store.put({ ...entry, at: Date.now() }, id));
  return id;
}

/** The entry left under `id`, or null. Entries older than a day are cleared. */
export async function pick(id) {
  const entry = await run("readonly", (store) => store.get(id));
  await run("readwrite", (store) => {
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (Date.now() - (cursor.value.at ?? 0) > 864e5) cursor.delete();
      cursor.continue();
    };
    return request;
  });
  return entry ?? null;
}

/** Forgets the entry once its room is open. */
export const drop = (id) => run("readwrite", (store) => store.delete(id)).catch(() => {});
