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
import { addReplay } from "../site/library.js";
import { copyShareLink, downloadKept } from "../site/sharing.js";

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

// The lobby shown over a running match, where a watcher asks to join a side.
let picking = false;
function setPicking(open) {
  picking = open;
  document.body.toggleAttribute("data-picking", open);
  if (open) renderLobby();
  renderSeating();
}

function renderLobby() {
  if (!lobby) return;
  const you = me(),
    host = you?.host,
    started = lobby.started,
    asked = you?.request ?? null;
  const link = roomLink(lobby.code);
  // The match starts once every side has a connected player.
  const ready = Array.from({ length: lobby.sides }, (_, side) => lobby.players.some((p) => p.side === side && p.online)).every(Boolean);
  const seats = Array.from({ length: lobby.sides }, (_, side) => {
    const seated = lobby.players.filter((p) => p.side === side);
    return `<button class="seat${you?.side === side ? " chosen" : ""}${asked === side ? " asked" : ""}" data-side="${side}" style="--side:var(--${colors[side]})">
      <span class="swatch"></span><b>${sideNames[side]}</b><span class="who">${seated.map((p) => escape(p.name) + (p.online ? "" : " (away)")).join(", ")}${asked === side ? `${seated.length ? ", " : ""}${escape(you.name)} (asked)` : ""}</span></button>`;
  }).join("");
  const watching = lobby.players.filter((p) => p.side === null);
  // Typing in the name field survives the lobby redrawing around it.
  const typing = document.activeElement?.id === "name" ? { value: $("name").value, at: $("name").selectionStart } : null;
  // Once the match runs, choosing a side asks the host.
  const actions = !started
    ? host
      ? `<button id="start" class="primary" ${!ready ? "disabled" : ""}>Start match</button>${ready ? "" : `<span class="muted">Waiting for a player on every side.</span>`}`
      : `<span class="muted">The host starts the match.</span>`
    : asked !== null
      ? `<button id="close">Close</button><span class="muted">Waiting for the host to let you join ${sideNames[asked]}.</span>`
      : you?.side !== null && you?.side !== undefined
        ? `<button id="close">Close</button>`
        : `<span class="muted">${host ? "Choose a side to join it, or watch." : "Choose a side to ask the host, or watch."}</span>`;
  ui.innerHTML = `
    ${started ? `<h1>Join the match</h1>
    <p class="muted">${escape(replayName)}</p>` : lobby.frame ? `<h1>Play from ${matchTime(lobby.frame)}</h1>
    <p class="muted">${escape(replayName)}</p>` : `<h1>${escape(replayName)}</h1>`}
    <label class="field"><span>Your name</span><input id="name" maxlength="24" autocomplete="off" spellcheck="false" value="${escape(typing?.value ?? you?.name ?? "")}"></label>
    <label class="field"><span>Room link</span><span class="copy"><input id="link" readonly value="${escape(link)}"><button id="copy">Copy</button></span></label>
    <div class="seats">${seats}</div>
    <button class="seat watch${you?.side === null && asked === null ? " chosen" : ""}" data-side="none"><b>Watch</b><span class="who">${watching.map((p) => escape(p.name)).join(", ")}</span></button>
    <div class="actions">${actions}</div>
    <p id="status" class="status" role="status">${started ? escape(seatingNote) : ""}</p>`;
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
    button.onclick = () => {
      const side = button.dataset.side === "none" ? null : Number(button.dataset.side);
      if (!started) return room.send({ type: "side", side });
      if (side === null) {
        // Watching withdraws a request.
        if (me()?.request !== null) room.send({ type: "request", side: null });
        return setPicking(false);
      }
      if (side === me()?.side) return setPicking(false);
      room.send({ type: "request", side });
    };
  if ($("close")) $("close").onclick = () => setPicking(false);
  if ($("start"))
    $("start").onclick = () => {
      if (!ready) return status("Every side needs a player.");
      room.send({ type: "start" });
    };
}

// Over a running match: a watcher asks to join a side, and the host answers.
const seating = document.createElement("div");
seating.id = "seating";
seating.className = "seating";
seating.setAttribute("aria-live", "polite");
document.body.append(seating);
let seatingNote = "",
  seatingNoteTimer = null;

function noteSeating(message) {
  seatingNote = message;
  clearTimeout(seatingNoteTimer);
  seatingNoteTimer = setTimeout(() => {
    seatingNote = "";
    renderSeating();
  }, 4000);
  renderSeating();
}

function renderSeating() {
  const you = me();
  if (picking && lobby?.started) renderLobby();
  if (!lobby?.started || !game?.started || game.ended || !you) {
    seating.innerHTML = "";
    return;
  }
  const swatch = (side) => `<span class="swatch" style="--side:var(--${colors[side]})"></span>`;
  const cards = [];
  if (you.host)
    for (const player of lobby.players)
      if (player.request !== null && player.request !== undefined && player.id !== you.id)
        cards.push(`<div class="seating-card">${swatch(player.request)}<span><b>${escape(player.name)}</b> wants to join ${sideNames[player.request]}</span>
          <button class="primary" data-answer="${player.id}" data-accept="1">Accept</button><button data-answer="${player.id}">Decline</button></div>`);
  if (you.side === null && !picking) {
    if (you.request !== null && you.request !== undefined)
      cards.push(`<div class="seating-card">${swatch(you.request)}<span>Asked the host to join ${sideNames[you.request]}</span><button data-request="none">Cancel</button></div>`);
    else cards.push(`<div class="seating-card"><span>Watching</span><button data-join>Join...</button></div>`);
  }
  if (seatingNote && !picking) cards.push(`<div class="seating-card note">${escape(seatingNote)}</div>`);
  seating.innerHTML = cards.join("");
  for (const button of seating.querySelectorAll("[data-answer]"))
    button.onclick = () => room.send({ type: "answer", player: Number(button.dataset.answer), accept: !!button.dataset.accept });
  for (const button of seating.querySelectorAll("[data-request]"))
    button.onclick = () => room.send({ type: "request", side: button.dataset.request === "none" ? null : Number(button.dataset.request) });
  for (const button of seating.querySelectorAll("[data-join]")) button.onclick = () => setPicking(true);
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
    renderSeating();
  } catch (error) {
    showError(error.message);
  }
}

// The finished match, kept in this browser's library with the visitor's other replays.
let kept = null;
function keepMatch() {
  kept ??= matchReplay({
    replay: room.replay,
    startFrame: game.startFrame,
    log: game.log,
    end: game.ended.tick,
    result: game.ended.result,
    names: namesBySide(),
  }).then(async (bytes) => (await addReplay(new File([bytes], `${replayName.replace(/\.rep$/i, "")}${game.startFrame ? " continued" : ""}.rep`))).record);
  return kept;
}

function showEnd() {
  renderSeating();
  const panel = $("end");
  panel.hidden = false;
  panel.innerHTML = `<div class="end-actions"><button id="share" class="primary">Copy link</button><button id="save">Download</button><button id="exit">Leave</button></div>
    <p id="end-note" class="end-note" role="status"></p>`;
  const note = (message) => ($("end-note").textContent = message);
  keepMatch().then(
    () => note("Saved to your replays."),
    (error) => note(`This match could not be saved: ${error.message}`),
  );
  $("share").onclick = async () => {
    const button = $("share");
    button.disabled = true;
    try {
      // Waits for the match to be kept, then copies its link while the click still counts.
      note(await copyShareLink(keepMatch().then((record) => record.id)));
    } catch (error) {
      note(error.message);
    } finally {
      button.disabled = false;
    }
  };
  $("save").onclick = async () => {
    try {
      downloadKept(await keepMatch());
    } catch (error) {
      note(error.message);
    }
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
        if (game.side !== side) {
          // The host let this player join a running match.
          if (lobby.started && game.started && side !== null) {
            picking = false;
            document.body.removeAttribute("data-picking");
            noteSeating(`You joined ${sideNames[side]}.`);
          }
          game.setSide(side);
        }
      }
      // Whoever arrives after the start chooses a side or to watch.
      if (first && message.started && me()?.side === null) setPicking(true);
      if (!lobby.started || !game?.started) renderLobby();
      renderSeating();
      if (first && room.replay) void startGame(room.replay);
    },
    replay(bytes) {
      if (lobby) void startGame(bytes);
    },
    start(message) {
      document.body.dataset.screen = "match";
      game?.start(message.delay);
      renderSeating();
    },
    declined({ side }) {
      noteSeating(`The host declined your request to join ${sideNames[side] ?? "the match"}.`);
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
      renderSeating();
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
      seating.innerHTML = "";
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
