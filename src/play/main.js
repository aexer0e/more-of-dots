// The play page: a match continued from a frame of a replay, against anyone who
// opens its link.
//   play?from=<id>   opens a room for the replay the player handed over (handoff.js)
//   play?room=<code> joins a room (four digits)
import "../site/base.js";
import "./play.css";
import { Room } from "./net.js";
import { Game, colors } from "./game.js";
import { drop, pick } from "./handoff.js";
import { matchReplay } from "./replay-file.js";

const base = new URL(import.meta.env.BASE_URL, document.baseURI).href;
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const sideNames = ["Blue", "Red", "Purple", "Orange"];
const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const ui = $("lobby");
let room = null,
  game = null,
  lobby = null,
  replayName = "match";
// Opening a room again when its code is already in use.
let creating = null;
// Turns of a running match that arrive before its game is ready.
const early = { started: false, turns: [] };

function status(message) {
  $("status").textContent = message ?? "";
}

const tokenKey = (code) => `wod-play-token-${code}`;
// A name is kept for its room in this tab only, so a reload keeps it while other
// windows and later rooms start from their own Player number.
const nameKey = (code) => `wod-play-name-${code}`;
function rememberName(code, name) {
  try {
    if (name) sessionStorage.setItem(nameKey(code), name);
    else sessionStorage.removeItem(nameKey(code));
  } catch {
    // Without session storage a reload shows the room's name for this player.
  }
}
function savedName(code) {
  try {
    return sessionStorage.getItem(nameKey(code)) || "";
  } catch {
    return "";
  }
}
// Earlier versions kept one name for every window; it is no longer used.
try {
  localStorage.removeItem("wod-play-name");
} catch {
  // Storage may be unavailable.
}
function savedToken(code) {
  try {
    return sessionStorage.getItem(tokenKey(code));
  } catch {
    return null;
  }
}

/** A frame as the player's clock shows it, at the game's 30 frames a second. */
const matchTime = (frame) => {
  const s = Math.floor(frame / 30);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const me = () => lobby?.players.find((p) => p.id === lobby.you);
const roomLink = (code) => new URL(`play?room=${encodeURIComponent(code)}`, base).href;
/** Player names by side, for the battlefield. */
const namesBySide = () => {
  const names = Array.from({ length: lobby?.sides ?? 2 }, () => []);
  for (const player of lobby?.players || []) if (player.side !== null && names[player.side]) names[player.side].push(player.name);
  return names;
};

function renderLobby() {
  if (!lobby) return;
  const you = me(),
    host = you?.host;
  const link = roomLink(lobby.code);
  // The match starts once every side has a connected player.
  const ready = Array.from({ length: lobby.sides }, (_, side) => lobby.players.some((p) => p.side === side && p.online)).every(Boolean);
  const seats = Array.from({ length: lobby.sides }, (_, side) => {
    const seated = lobby.players.filter((p) => p.side === side);
    return `<button class="seat${you?.side === side ? " chosen" : ""}" data-side="${side}" style="--side:var(--${colors[side]})" ${lobby.started ? "disabled" : ""}>
      <span class="swatch"></span><b>${sideNames[side]}</b><span class="who">${seated.map((p) => escape(p.name) + (p.online ? "" : " (away)")).join(", ")}</span></button>`;
  }).join("");
  const watching = lobby.players.filter((p) => p.side === null);
  // Typing in the name field survives the lobby redrawing around it.
  const typing = document.activeElement?.id === "name" ? { value: $("name").value, at: $("name").selectionStart } : null;
  ui.innerHTML = `
    <h1>Play from ${matchTime(lobby.frame)}</h1>
    <p class="muted">${escape(replayName)}</p>
    <label class="field"><span>Your name</span><input id="name" maxlength="24" autocomplete="off" spellcheck="false" value="${escape(typing?.value ?? you?.name ?? "")}"></label>
    <label class="field"><span>Room link</span><span class="copy"><input id="link" readonly value="${escape(link)}"><button id="copy">Copy</button></span></label>
    <div class="seats">${seats}</div>
    <button class="seat watch${you?.side === null ? " chosen" : ""}" data-side="none" ${lobby.started ? "disabled" : ""}><b>Watch</b><span class="who">${watching.map((p) => escape(p.name)).join(", ")}</span></button>
    <div class="actions">${host ? `<button id="start" class="primary" ${lobby.started || !ready ? "disabled" : ""}>Start match</button>${ready ? "" : `<span class="muted">Waiting for a player on every side.</span>`}` : `<span class="muted">The host starts the match.</span>`}</div>
    <p id="status" class="status" role="status"></p>`;
  const name = $("name");
  if (typing) {
    name.focus();
    name.setSelectionRange(typing.at, typing.at);
  }
  let renaming = null;
  const rename = () => {
    clearTimeout(renaming);
    const value = name.value.trim();
    if (value === me()?.name) return;
    rememberName(lobby.code, value);
    room.send({ type: "name", name: value });
  };
  name.oninput = () => {
    clearTimeout(renaming);
    renaming = setTimeout(rename, 400);
  };
  name.onchange = rename;
  // A handler that returns false cancels the key, so this one returns nothing.
  name.onkeydown = (event) => {
    if (event.key === "Enter") name.blur();
  };
  $("copy").onclick = async () => {
    await navigator.clipboard?.writeText(link).catch(() => {});
    $("copy").textContent = "Copied";
  };
  for (const button of ui.querySelectorAll(".seat"))
    button.onclick = () => room.send({ type: "side", side: button.dataset.side === "none" ? null : Number(button.dataset.side) });
  if ($("start"))
    $("start").onclick = () => {
      if (!ready) return status("Every side needs a player.");
      room.send({ type: "start" });
    };
}

async function startGame(replay) {
  if (game) return;
  game = new Game({
    canvas: $("game"),
    base,
    replay,
    frame: lobby?.frame ?? 0,
    side: me()?.side ?? null,
    room,
    names: namesBySide(),
    onStatus: status,
    onEnd: (result, exit) => (exit ? leaveMatch() : showEnd(result)),
  });
  // QA can inspect the match, as window.replayPlayer does in the player.
  window.playGame = game;
  try {
    await game.load();
    document.body.dataset.screen = early.started || lobby?.started ? "match" : "lobby";
    if (early.started || lobby?.started) game.start(0);
    for (const turn of early.turns.splice(0)) game.addTurn(turn);
  } catch (error) {
    showError(error.message);
  }
}

function showEnd() {
  const panel = $("end");
  panel.hidden = false;
  panel.innerHTML = `<button id="save" class="primary">Download replay</button><button id="exit">Leave</button>`;
  $("save").onclick = async () => {
    const bytes = await matchReplay({
      replay: room.replay,
      startFrame: game.startFrame,
      log: game.log,
      end: game.ended.tick,
      result: game.ended.result,
      names: namesBySide(),
    });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
    link.download = `${replayName.replace(/\.rep$/i, "")} continued.rep`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
  };
  $("exit").onclick = leaveMatch;
}

function leaveMatch() {
  room?.close();
  location.href = base;
}

function showError(message) {
  document.body.dataset.screen = "error";
  ui.innerHTML = `<h1>This match cannot be played</h1><p class="status">${escape(message)}</p><div class="actions"><a class="button" href="${escape(base)}">Back to replays</a></div>`;
}

/** Connects at once; the room names its players Player 1, Player 2 and so on. */
function connect(action) {
  ui.innerHTML = `<h1>${params.get("room") ? "Joining the match" : "Opening a room"}</h1><p id="status" class="status" role="status"></p>`;
  action().catch((error) => showError(error.message));
}

function handlers() {
  return {
    room(message) {
      const first = !lobby;
      lobby = message;
      if (message.title) replayName = message.title;
      try {
        sessionStorage.setItem(tokenKey(message.code), message.token);
      } catch {
        // Without session storage a reload joins as a new player.
      }
      if (first) history.replaceState(null, "", `play?room=${encodeURIComponent(message.code)}`);
      if (game) {
        game.names = namesBySide();
        const side = me()?.side ?? null;
        if (!lobby.started && game.side !== side) game.setSide(side);
      }
      if (!lobby.started || !game?.started) renderLobby();
      if (first && room.replay) void startGame(room.replay);
    },
    replay(bytes) {
      if (lobby) void startGame(bytes);
    },
    start(message) {
      document.body.dataset.screen = "match";
      game?.start(message.delay);
    },
    log({ turns }) {
      // A page that joins a running match replays every turn so far.
      if (!game) {
        early.started = true;
        early.turns.push(...turns);
        return;
      }
      if (!game.started) {
        game.start(0);
        document.body.dataset.screen = "match";
      }
      for (const turn of turns) game.addTurn(turn);
    },
    turn(turn) {
      if (game) game.addTurn(turn);
      else early.turns.push(turn);
    },
    desync() {
      if (game) game.desynced = true;
    },
    error({ error }) {
      if (!lobby && creating && /taken/.test(error) && creating.tries++ < 5) return void creating.open();
      if (!game) showError(error);
      else status(error);
    },
    closed(reason) {
      if (game?.ended) return;
      document.body.dataset.screen = "lobby";
      ui.innerHTML = `<h1>Disconnected</h1><p class="status">${escape(reason || "The connection to the match was lost.")}</p><div class="actions"><button id="again" class="primary">Reconnect</button></div>`;
      $("again").onclick = () => location.reload();
    },
  };
}

async function main() {
  document.body.dataset.screen = "lobby";
  const code = params.get("room"),
    from = params.get("from");
  if (code) {
    connect(async () => {
      room = new Room(handlers());
      await room.join(code, { token: savedToken(code), name: savedName(code) });
    });
    return;
  }
  const handoff = from ? await pick(from).catch(() => null) : null;
  if (!handoff) return showError("Open a replay in the player, pause where the match should continue, and choose Play from here.");
  replayName = handoff.name || "match";
  const bytes = new Uint8Array(handoff.replay);
  const sides = await sideCount(bytes).catch(() => 2);
  creating = {
    tries: 0,
    open: () => {
      room?.close();
      room = new Room(handlers());
      return room.create(bytes, { frame: handoff.frame, sides, side: 0, title: replayName }).then(() => void drop(from));
    },
  };
  connect(() => creating.open());
}

/** The number of colours in a replay's map: its deployment, or the game's
 * numbering (100 to 199 for three colours, 200 and up for four). */
async function sideCount(bytes) {
  const text =
    bytes[0] === 0x1f && bytes[1] === 0x8b
      ? await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text()
      : new TextDecoder().decode(bytes);
  const root = JSON.parse(text),
    map = root.map ?? root.custom_map;
  if (Array.isArray(map?.infantry)) return Math.max(2, Math.min(4, map.infantry.length));
  const number = Number(String(map?.index ?? map ?? "").match(/\d+/)?.[0]);
  return number >= 200 ? 4 : number >= 100 ? 3 : 2;
}

void main();
