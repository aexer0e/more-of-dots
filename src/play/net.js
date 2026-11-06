// The page's side of a match room (share/src/match.js): one WebSocket that carries
// the lobby, the replay the match starts from, and the turns.
const API = import.meta.env.VITE_SHARE_API ?? "https://wod-replays.moreofdots.workers.dev";
const PIECE = 256 << 10;

const socketUrl = (path) => `${API.replace(/^http/, "ws")}${path}`;

export class Room {
  constructor(handlers) {
    this.handlers = handlers;
    this.socket = null;
    this.download = null;
  }

  /** Opens a room for a replay and a frame of it; resolves once the replay is uploaded. */
  create(replay, { frame, sides, side, title }) {
    return this.connect("/matches/new", () => {
      this.send({ type: "create", frame, sides, side, title, size: replay.length });
      for (let at = 0; at < replay.length; at += PIECE) this.socket.send(replay.subarray(at, at + PIECE));
      // The room keeps its own copy; this page has the replay already.
      this.replay = replay;
    });
  }

  join(code, { token, name }) {
    return this.connect(`/matches/${encodeURIComponent(code)}`, () => this.send({ type: "join", token, name }));
  }

  connect(path, opened) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = (this.socket = new WebSocket(socketUrl(path)));
      socket.binaryType = "arraybuffer";
      socket.onopen = () => {
        opened();
        settled = true;
        resolve();
      };
      socket.onerror = () => {
        if (!settled) reject(new Error("Could not reach the match server."));
      };
      socket.onclose = (event) => {
        if (this.socket === socket) this.handlers.closed?.(event.reason);
      };
      socket.onmessage = ({ data }) => this.receive(data);
    });
  }

  receive(data) {
    if (typeof data !== "string") {
      const download = this.download;
      if (!download) return;
      download.bytes.set(new Uint8Array(data), download.at);
      download.at += data.byteLength;
      if (download.at >= download.bytes.length) {
        this.download = null;
        this.replay = download.bytes;
        this.handlers.replay?.(download.bytes);
      }
      return;
    }
    const message = JSON.parse(data);
    if (message.type === "replay") this.download = { bytes: new Uint8Array(message.size), at: 0 };
    else this.handlers[message.type]?.(message);
  }

  send(message) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  close() {
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }
}
