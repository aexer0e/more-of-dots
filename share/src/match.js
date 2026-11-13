// Matches continued from a replay (the site's play page). One Durable Object holds
// one room: the replay and frame the match starts from, the players and their
// sides, and every turn sent so far. It runs no simulation. Every 15 ticks
// (half a second at the game's 30 ticks a second) it sends each page the commands
// the players gave since the previous turn, in the order they arrived; the pages
// simulate the same commands in the same order and stay identical. Turns are kept,
// so a page that reconnects replays them and catches up.
//
//   GET /matches/new      (WebSocket) opens a room; the first message must be "create"
//   GET /matches/<code>   (WebSocket) joins the room
//
// Messages are JSON, except the replay, which follows "create" and "replay" as
// binary pieces of at most PIECE bytes.
//   page → room: create {name?, frame, sides, side, title, size}, join {name?, token?}, side {side}, name {name},
//                start, command {orders?, production?, message?, peace?}, surrender, hash {turn, hash},
//                request {side} (asks the host for a side once the match runs; null withdraws),
//                answer {player, accept} (the host's reply)
//   room → page: room {code, you, token, players, frame, sides, title, started},
//                replay {size}, start {delay}, turn {turn, commands}, log {turns},
//                desync {turn}, declined {side}, error {error}
import { MAX_SIZE } from "./replay.js";

export const PIECE = 256 << 10;
const TURN_MS = 500;
// The game waits 150 frames before an online match starts.
const START_DELAY_MS = 5000;
const MAX_PLAYERS = 8;
// A big map's orders for thousands of units (packed into groups by the page).
const MAX_MESSAGE = 1 << 20;
const MAX_ORDERS = 10000;
const MAX_GROUPS = 256;
// Rooms are four digits, easy to read out and type.
const CODE = /^\d{4}$/;

export const newCode = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 10000).padStart(4, "0");
export const isCode = (code) => CODE.test(code ?? "");

const token = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
const clean = (name) => String(name ?? "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 24);

export class MatchRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.code = null;
    this.replay = null;
    this.frame = 0;
    this.sides = 2;
    this.players = []; // {id, token, name, side, socket, host, request}
    this.nextId = 1;
    this.started = false;
    this.turns = [];
    this.queue = [];
    this.hashes = new Map();
    this.timer = null;
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket.", { status: 426 });
    this.code ??= request.headers.get("X-Room-Code");
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.listen(server, request.headers.get("X-Room-Create") === "1");
    return new Response(null, { status: 101, webSocket: client });
  }

  listen(socket, creating) {
    let player = null,
      upload = null;
    const send = (message) => this.send(socket, message);
    const fail = (error) => {
      send({ type: "error", error });
      socket.close(1008, error.slice(0, 120));
    };
    // Binary messages can arrive as Blobs, which are read asynchronously; messages
    // are handled one after another so the replay's pieces stay in order.
    let queue = Promise.resolve();
    socket.addEventListener("message", ({ data }) => {
      queue = queue.then(async () => receive(typeof data === "string" ? data : new Uint8Array(data instanceof Blob ? await data.arrayBuffer() : data)));
    });
    const receive = (data) => {
      try {
        if (typeof data !== "string") {
          // A piece of the replay its creator uploads.
          if (!upload || !player?.host) return fail("Unexpected data.");
          const piece = data;
          if (upload.at + piece.length > upload.bytes.length) return fail("The replay is larger than announced.");
          upload.bytes.set(piece, upload.at);
          upload.at += piece.length;
          if (upload.at === upload.bytes.length) {
            this.replay = upload.bytes;
            upload = null;
            this.broadcastRoom();
          }
          return;
        }
        if (data.length > MAX_MESSAGE) return fail("Message too large.");
        const message = JSON.parse(data);
        if (!player) {
          if (creating) {
            if (message.type !== "create") return fail("Create the room first.");
            if (this.replay || this.players.length) return fail("This room is taken. Try again.");
            const size = Number(message.size);
            if (!Number.isInteger(size) || size <= 0 || size > MAX_SIZE) return fail("This replay is too large to play.");
            this.frame = Math.max(0, Math.trunc(Number(message.frame) || 0));
            this.sides = Math.min(4, Math.max(2, Math.trunc(Number(message.sides) || 2)));
            this.title = String(message.title ?? "").slice(0, 120);
            upload = { bytes: new Uint8Array(size), at: 0 };
            player = this.add(socket, message.name, true, message.side);
            return;
          }
          if (message.type !== "join") return fail("Join the room first.");
          if (!this.replay) return fail("This room does not exist or has closed.");
          const returning = this.players.find((p) => p.token && p.token === message.token);
          if (returning) {
            returning.socket?.close(1000, "Opened elsewhere.");
            returning.socket = socket;
            player = returning;
            if (clean(message.name)) player.name = clean(message.name);
          } else {
            if (this.players.filter((p) => p.socket).length >= MAX_PLAYERS) return fail("This room is full.");
            // Once the match runs a newcomer watches, and asks the host for a side.
            player = this.add(socket, message.name, false, this.started ? null : undefined);
          }
          this.sendReplay(socket);
          if (this.started) {
            send({ type: "log", turns: this.turns });
            // Turns stop while nobody is connected.
            this.timer ??= setInterval(() => this.turn(), TURN_MS);
          }
          this.broadcastRoom();
          return;
        }
        if (message.type === "name") {
          // An empty name goes back to the player's number.
          player.name = clean(message.name) || this.numbered();
          this.broadcastRoom();
        } else if (message.type === "side") {
          if (this.started) return;
          const side = message.side === null ? null : Math.trunc(Number(message.side));
          if (side !== null && !(side >= 0 && side < this.sides)) return;
          player.side = side;
          this.broadcastRoom();
        } else if (message.type === "request") {
          if (!this.started) return;
          const side = message.side === null ? null : Math.trunc(Number(message.side));
          if (side !== null && !(side >= 0 && side < this.sides)) return;
          if (side !== null && side === player.side) return;
          // The host needs nobody's leave.
          if (player.host && side !== null) player.side = side;
          else player.request = side;
          this.broadcastRoom();
        } else if (message.type === "answer") {
          if (!player.host) return;
          const asking = this.players.find((p) => p.id === message.player);
          if (asking?.request === undefined || asking.request === null) return;
          const side = asking.request;
          asking.request = null;
          if (message.accept === true) asking.side = side;
          else this.send(asking.socket, { type: "declined", side });
          this.broadcastRoom();
        } else if (message.type === "start") {
          if (!player.host || this.started || !this.replay) return;
          if (!this.everySideSeated()) return send({ type: "error", error: "Each side needs a player." });
          this.start();
        } else if (message.type === "command") {
          if (!this.started || player.side === null) return;
          const entry = { side: player.side };
          if (Array.isArray(message.orders) && message.orders.length) entry.orders = message.orders.slice(0, MAX_ORDERS);
          if (Array.isArray(message.groups) && message.groups.length) entry.groups = message.groups.slice(0, MAX_GROUPS);
          if (Array.isArray(message.production) && message.production.length) entry.production = message.production.slice(0, 8);
          if (typeof message.message === "string" && message.message.trim()) entry.message = message.message.trim().slice(0, 200);
          if (message.peace === true) entry.peace = true;
          if (Object.keys(entry).length > 1) this.queue.push(entry);
        } else if (message.type === "surrender") {
          if (this.started && player.side !== null) this.queue.push({ side: player.side, surrender: true });
        } else if (message.type === "hash") {
          this.checkHash(message.turn, String(message.hash));
        }
      } catch {
        fail("The room could not read a message.");
      }
    };
    const leave = () => {
      if (!player || player.socket !== socket) return;
      player.socket = null;
      player.request = null;
      // Before the match a player who leaves gives up their seat.
      if (!this.started) this.players = this.players.filter((p) => p !== player);
      if (!this.players.some((p) => p.socket)) this.stop();
      else this.broadcastRoom();
    };
    socket.addEventListener("close", leave);
    socket.addEventListener("error", leave);
  }

  /** `side` is the player's side, null to watch, or undefined for the first side
   * nobody has yet. */
  add(socket, name, host, side) {
    const taken = new Set(this.players.filter((p) => p.socket).map((p) => p.side));
    const open = [...Array(this.sides).keys()].find((s) => !taken.has(s)) ?? null;
    const seat = side === null ? null : Number.isInteger(side) && side >= 0 && side < this.sides ? side : open;
    const id = this.nextId++;
    const player = { id, token: token(), name: clean(name) || this.numbered(), side: seat, socket, host, request: null };
    this.players.push(player);
    return player;
  }

  send(socket, message) {
    try {
      socket?.send(JSON.stringify(message));
    } catch {
      // The page has gone; its close event tidies up.
    }
  }

  sendReplay(socket) {
    this.send(socket, { type: "replay", size: this.replay.length });
    try {
      for (let at = 0; at < this.replay.length; at += PIECE) socket.send(this.replay.subarray(at, at + PIECE));
    } catch {
      // The page has gone.
    }
  }

  broadcastRoom() {
    if (!this.replay) return;
    // Someone connected can always start the match.
    if (!this.players.some((p) => p.host && p.socket)) {
      const next = this.players.find((p) => p.socket);
      for (const player of this.players) player.host = player === next;
    }
    const players = this.players.map(({ id, name, side, host, socket, request }) => ({ id, name, side, host, online: !!socket, request: request ?? null }));
    for (const player of this.players)
      this.send(player.socket, {
        type: "room",
        code: this.code,
        you: player.id,
        token: player.token,
        players,
        frame: this.frame,
        sides: this.sides,
        title: this.title,
        started: this.started,
      });
  }

  broadcast(message) {
    for (const player of this.players) this.send(player.socket, message);
  }

  /** Player 1, Player 2 and so on, in the order players join: the lowest number
   * no player in the room is named after. */
  numbered() {
    const names = new Set(this.players.map((p) => p.name));
    let n = 1;
    while (names.has(`Player ${n}`)) n++;
    return `Player ${n}`;
  }

  everySideSeated() {
    return [...Array(this.sides).keys()].every((side) => this.players.some((p) => p.side === side && p.socket));
  }

  start() {
    this.started = true;
    this.broadcastRoom();
    this.broadcast({ type: "start", delay: START_DELAY_MS });
    this.timer = setTimeout(() => {
      this.turn();
      this.timer = setInterval(() => this.turn(), TURN_MS);
    }, START_DELAY_MS);
  }

  turn() {
    const turn = { turn: this.turns.length, commands: this.queue.splice(0) };
    this.turns.push(turn);
    this.broadcast({ type: "turn", ...turn });
  }

  checkHash(turn, hash) {
    if (!Number.isInteger(turn) || turn < 0 || turn >= this.turns.length) return;
    const known = this.hashes.get(turn);
    if (known === undefined) {
      this.hashes.set(turn, hash);
      // Only recent turns are compared.
      this.hashes.delete(turn - 240);
    } else if (known !== hash) this.broadcast({ type: "desync", turn });
  }

  stop() {
    clearTimeout(this.timer);
    clearInterval(this.timer);
    this.timer = null;
  }
}
