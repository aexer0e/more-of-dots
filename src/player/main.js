import "./player.css";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { addFile, chooseReplay as pickReplay, gameAudio as hostAudio, invoke } from "./host.js";
import { initializeEngine, player, loadReplay, paint } from "./client.js";
import { displayOptions } from "./overlays.js";
import { ReplaySound } from "./sound.js";

// Pointer gestures belong to the player, including when they cross labels or artwork.
document.addEventListener("selectstart", (event) => event.preventDefault());
document.addEventListener("dragstart", (event) => event.preventDefault());

const icon = (paths, className = "") =>
  `<svg viewBox="0 0 24 24" aria-hidden="true" class="${className}">${paths}</svg>`;
const icons = {
  play: icon('<path d="M8 5.5v13l10.5-6.5Z"/>', "solid"),
  pause: icon(
    '<rect x="7" y="5" width="3.4" height="14" rx="1"/><rect x="13.6" y="5" width="3.4" height="14" rx="1"/>',
    "solid",
  ),
  close: icon('<path d="m6 6 12 12M18 6 6 18"/>'),
  full: icon('<path d="M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5"/>'),
  volume: icon('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4Z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>'),
  muted: icon('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4Z"/><path d="m16 10 4.5 4.5m0-4.5L16 14.5"/>'),
  open: icon('<path d="M3.5 7.5V18a1.5 1.5 0 0 0 1.5 1.5h14a1.5 1.5 0 0 0 1.5-1.5V9.5A1.5 1.5 0 0 0 19 8h-7l-2-2.5H5A1.5 1.5 0 0 0 3.5 7Z"/>'),
};
// Rail icons follow the order of displayOptions and their 1–8 shortcuts.
const layerIcons = {
  orders: '<path d="M5 19 19 5M10 5h9v9"/>',
  health:
    '<path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.5-7 10-7 10Z"/>',
  morale: '<path d="M12 3 5 6v6c0 4 3 7 7 9 4-2 7-5 7-9V6Z"/>',
  flags: '<path d="M6 21V4h11l-2.5 4 2.5 4H6"/>',
  stats: '<path d="M5 20V11M12 20V4M19 20v-7"/>',
  icons: '<circle cx="12" cy="12" r="8"/><path d="m9 10 3 4 3-4"/>',
  produce: '<path d="M3 20V10l6 4v-4l6 4V5h5v15Z"/>',
  players: '<path d="M4 7V5h16v2M12 5v14M9 19h6"/>',
};
const speeds = [0.25, 0.5, 1, 2, 4, 8];
const speedLabel = (speed) => `${speed}×`;
document.querySelector("#player-ui").innerHTML = `
  <section id="welcome" class="welcome"><h1 id="welcome-title">Open a replay</h1><p id="status" role="status">Choose a War of Dots replay to watch.</p><button id="open" class="primary">Open replay</button></section>
  <section id="loading" class="loading" role="status" aria-live="polite"><span class="spinner" aria-hidden="true"></span><span>Loading replay…</span></section>
  <nav id="layers" class="rail glass" aria-label="Layers" hidden></nav>
  <section id="controls" class="bar" aria-label="Replay controls" hidden>
    <button id="play" class="icon-button" title="Play / pause (Space)" aria-label="Play">${icons.play}</button>
    <span id="time" class="time">0:00</span>
    <div id="seek" class="seek" role="slider" tabindex="0" aria-label="Replay position" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0">
      <div class="track"><div id="prepared" class="prepared"></div><div id="progress" class="progress"></div></div>
      <div id="ghost" class="ghost" hidden></div><div id="tip" class="tip" hidden></div>
      <div id="head" class="head"></div>
    </div>
    <span id="duration" class="time duration">0:00</span>
    <div class="speed-wrap">
      <button id="speed" class="chip" aria-haspopup="menu" aria-expanded="false" aria-controls="speed-menu" title="Playback speed ([ and ])">1×</button>
      <div id="speed-menu" class="speed-menu glass" role="menu" hidden>${speeds
        .map(
          (speed) =>
            `<button role="menuitemradio" data-speed="${speed}" aria-checked="${speed === 1}">${speedLabel(speed)}</button>`,
        )
        .reverse()
        .join("")}</div>
    </div>
    <div class="volume-wrap">
      <button id="volume" class="icon-button" aria-haspopup="dialog" aria-expanded="false" aria-controls="volume-menu" aria-label="Volume" title="Volume">${icons.volume}</button>
      <div id="volume-menu" class="volume-menu glass" role="dialog" aria-label="Volume" hidden>
        <label><span>Music</span><input id="music-volume" type="range" min="0" max="100" step="1"><output id="music-value"></output></label>
        <label><span>SFX</span><input id="sfx-volume" type="range" min="0" max="100" step="1"><output id="sfx-value"></output></label>
      </div>
    </div>
    <button id="open-replay" class="icon-button" aria-label="Open replay" title="Open replay (Ctrl+O)">${icons.open}</button>
    <button id="fullscreen" class="icon-button" aria-label="Fullscreen" title="Fullscreen (F)">${icons.full}</button>
  </section>
  <div id="toast" class="toast glass" role="status" hidden></div>
`;
const $ = (id) => document.getElementById(id);
const canvas = $("game");
// One screen at a time: the start screen, a single loading state, or the
// replay. The canvas stays hidden until a full-resolution frame is drawn.
function showScreen(screen, title, message) {
  document.body.dataset.screen = screen;
  $("welcome").hidden = screen !== "welcome";
  $("loading").hidden = screen !== "loading";
  $("controls").hidden = $("layers").hidden = screen !== "player";
  if (title) $("welcome-title").textContent = title;
  if (message) $("status").textContent = message;
}
const launch = new URLSearchParams(location.search).get("launch");
// A replay opened from the library starts on the loading state, never on the
// start screen.
showScreen(launch ? "loading" : "welcome");
// The game's music and sound effects follow the replay. The desktop app reads
// them from the installed game, along with its saved volumes.
const gameAudio = hostAudio().catch(() => null);
const sound = new ReplaySound(async () => (await gameAudio)?.files);
const renderer = initializeEngine(canvas, {
  frame: () => {},
  // The engine's own loading messages would flicker over the loading screen.
  status: () => {},
  progress: (info) => {
    updatePosition(player.frame);
    if (info.error && !errorShown) {
      errorShown = true;
      toast(`Playback ends at ${seconds(info.lastFrame)}: ${info.error}`);
    }
  },
  error: (error) => showError(error),
});
let opening = false,
  scrubbing = false,
  errorShown = false,
  toastTimer,
  seekAudioTimer,
  lastFocus;
try {
  const saved = JSON.parse(
    // Apply the new defaults once on upgrade, then remember later choices.
    localStorage.getItem("replay-player-layers-v2") || "null",
  );
  if (saved)
    for (const [name] of displayOptions)
      if (typeof saved[name] === "boolean") player.options[name] = saved[name];
} catch {
  /* Defaults work without preference storage. */
}
// Volumes are 0–1, as in the game's settings, which supply the first values.
const volumeKey = "replay-player-volume-v1";
function showVolume() {
  const { music, sfx } = sound.volume;
  $("music-volume").value = String(Math.round(music * 100));
  $("sfx-volume").value = String(Math.round(sfx * 100));
  $("music-value").textContent = String(Math.round(music * 100));
  $("sfx-value").textContent = String(Math.round(sfx * 100));
  $("volume").innerHTML = soundInstalled && (music || sfx) ? icons.volume : icons.muted;
}
let soundInstalled = true;
void gameAudio.then((game) => {
  if (game?.files) return;
  soundInstalled = false;
  $("volume").disabled = true;
  $("volume").title = isTauri()
    ? "Install War of Dots to hear its music and sounds"
    : "Sound is not available";
  showVolume();
});
function setVolume(music, sfx, remember = true) {
  sound.setVolume(music, sfx);
  showVolume();
  if (remember)
    try {
      localStorage.setItem(volumeKey, JSON.stringify({ music, sfx }));
    } catch {}
}
try {
  const saved = JSON.parse(localStorage.getItem(volumeKey) || "null");
  if (saved && [saved.music, saved.sfx].every((v) => typeof v === "number"))
    setVolume(saved.music, saved.sfx, false);
  else
    void gameAudio.then(
      (game) =>
        typeof game?.music === "number" &&
        setVolume(game.music, game.sfx, false),
    );
} catch {
  /* The game's defaults apply. */
}
showVolume();
function volumeMenu(visible) {
  $("volume-menu").hidden = !visible;
  $("volume").setAttribute("aria-expanded", String(visible));
  if (visible) $("music-volume").focus();
  reveal();
}
function rememberLayers() {
  try {
    localStorage.setItem(
      "replay-player-layers-v2",
      JSON.stringify(player.options),
    );
  } catch {}
}
const seconds = (frame) => {
  const s = Math.floor(frame / 30);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
// Frames past the simulated range are not readable yet.
const seekable = () =>
  player.info?.complete ? player.info.lastFrame : player.info?.prepared || 0;
const percent = (frame) =>
  `${player.info?.lastFrame ? Math.min(100, (100 * frame) / player.info.lastFrame) : 0}%`;
function updatePosition(frame) {
  const last = player.info?.lastFrame || 0;
  $("progress").style.width = percent(frame);
  $("head").style.left = percent(frame);
  $("prepared").style.width = player.info?.complete ? "100%" : percent(seekable());
  $("time").textContent = seconds(frame);
  $("duration").textContent = seconds(last);
  $("seek").setAttribute("aria-valuemax", String(last));
  $("seek").setAttribute("aria-valuenow", String(frame));
  $("seek").setAttribute("aria-valuetext", `${seconds(frame)} of ${seconds(last)}`);
}
for (const [index, [name, label]] of displayOptions.entries()) {
  const button = document.createElement("button");
  button.className = "layer";
  button.dataset.option = name;
  button.setAttribute("aria-label", `${label} (${index + 1})`);
  button.innerHTML = `${icon(layerIcons[name])}<b>${index + 1}</b><span class="layer-tip">${label}<kbd>${index + 1}</kbd></span>`;
  button.onclick = () => toggleLayer(name);
  $("layers").append(button);
}
function showLayers() {
  for (const button of $("layers").children)
    button.setAttribute("aria-pressed", String(!!player.options[button.dataset.option]));
}
function toggleLayer(name) {
  player.options[name] = !player.options[name];
  showLayers();
  rememberLayers();
  redraw();
  reveal();
}
showLayers();
function redraw() {
  if (player.ready) {
    renderer.invalidate();
    updatePosition(player.frame);
    void paint(player.frame).catch(showError);
  }
}
function showError(error) {
  toast(String(error));
  pause();
}
function toast(message) {
  clearTimeout(toastTimer);
  $("toast").textContent = message;
  $("toast").hidden = false;
  toastTimer = setTimeout(() => ($("toast").hidden = true), 7000);
}
// The bar and the layer rail each appear only while the pointer is over their
// own edge of the window, and hide shortly after it leaves.
const zones = { bar: 120, rail: 110 },
  hideDelay = 450,
  timers = {};
let pointer = null,
  cursorTimer;
function busy(part) {
  if (part === "rail") return !!$("layers").querySelector(":focus-visible");
  return (
    scrubbing ||
    !$("speed-menu").hidden ||
    !$("volume-menu").hidden ||
    !!$("controls").querySelector(":focus-visible")
  );
}
function wanted(part) {
  if (busy(part)) return true;
  if (!pointer) return false;
  if (part === "bar") return pointer.y > innerHeight - zones.bar;
  const rail = $("layers").getBoundingClientRect();
  return (
    pointer.x > innerWidth - zones.rail &&
    pointer.y > rail.top - 40 &&
    pointer.y < rail.bottom + 40
  );
}
function settle(part, delay = hideDelay) {
  if (wanted(part)) {
    clearTimeout(timers[part]);
    timers[part] = null;
    document.body.classList.add(`show-${part}`);
  } else if (!timers[part] && document.body.classList.contains(`show-${part}`)) {
    timers[part] = setTimeout(() => {
      timers[part] = null;
      if (!wanted(part)) document.body.classList.remove(`show-${part}`);
    }, delay);
  }
}
function reveal() {
  settle("bar");
  settle("rail");
}
// Keyboard actions show the affected control briefly, like mpv's OSD.
function flash(part, duration = 1200) {
  clearTimeout(timers[part]);
  document.body.classList.add(`show-${part}`);
  timers[part] = setTimeout(() => {
    timers[part] = null;
    settle(part);
  }, duration);
}
function track(event) {
  pointer = { x: event.clientX, y: event.clientY };
  document.body.classList.remove("idle");
  clearTimeout(cursorTimer);
  cursorTimer = setTimeout(() => {
    if (!wanted("bar") && !wanted("rail")) document.body.classList.add("idle");
  }, 1000);
  reveal();
}
function speedMenu(visible) {
  $("speed-menu").hidden = !visible;
  $("speed").setAttribute("aria-expanded", String(visible));
  if (visible) $("speed-menu").querySelector('[aria-checked="true"]')?.focus();
  reveal();
}
function setSpeed(speed) {
  player.speed = speed;
  player.anchor = performance.now();
  player.anchorFrame = player.frame;
  $("speed").textContent = speedLabel(speed);
  for (const option of $("speed-menu").children)
    option.setAttribute("aria-checked", String(Number(option.dataset.speed) === speed));
  reveal();
}
function stepSpeed(direction) {
  const index = speeds.indexOf(player.speed);
  setSpeed(speeds[Math.max(0, Math.min(speeds.length - 1, index + direction))]);
}
function pause() {
  clearTimeout(seekAudioTimer);
  seekAudioTimer = null;
  player.playing = false;
  sound.stop();
  $("play").innerHTML = icons.play;
  $("play").setAttribute("aria-label", "Play");
}
function toggle() {
  if (!player.ready) return;
  if (player.playing) pause();
  else {
    if (player.info.complete && player.frame >= player.info.lastFrame) seek(0);
    player.playing = true;
    player.anchor = performance.now();
    player.anchorFrame = player.frame;
    if (!scrubbing) sound.start(player.frame);
    $("play").innerHTML = icons.pause;
    $("play").setAttribute("aria-label", "Pause");
  }
  reveal();
}
// Seeking keeps the current play state, like mpv: only the newest target is
// drawn and playback continues from it.
function seek(frame) {
  if (!player.ready) return;
  player.frame = Math.round(Math.max(0, Math.min(seekable(), frame)));
  player.anchor = performance.now();
  player.anchorFrame = player.frame;
  sound.seek(player.frame);
  clearTimeout(seekAudioTimer);
  seekAudioTimer = null;
  // Repeated keyboard seeks stay silent until the user settles on a position.
  if (player.playing && !scrubbing)
    seekAudioTimer = setTimeout(() => {
      seekAudioTimer = null;
      if (player.playing && !scrubbing) sound.start(player.frame);
    }, 150);
  updatePosition(player.frame);
  void paint(player.frame).catch(showError);
  reveal();
}
function frameAtPointer(event) {
  const box = $("seek").getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width));
  return { ratio, frame: ratio * (player.info?.lastFrame || 0) };
}
function hoverSeek(event) {
  if (!player.ready) return;
  const { ratio, frame } = frameAtPointer(event);
  const offset = Math.round((frame - player.frame) / 30);
  $("ghost").hidden = $("tip").hidden = false;
  $("ghost").style.left = $("tip").style.left = `${ratio * 100}%`;
  $("tip").innerHTML = `${seconds(frame)}<small>${offset < 0 ? "−" : "+"}${seconds(Math.abs(offset) * 30)}</small>`;
}
$("seek").addEventListener("pointerdown", (event) => {
  if (!player.ready || event.button !== 0) return;
  event.preventDefault();
  $("seek").focus({ preventScroll: true });
  scrubbing = true;
  $("seek").setPointerCapture(event.pointerId);
  $("seek").classList.add("scrubbing");
  seek(frameAtPointer(event).frame);
});
$("seek").addEventListener("pointermove", (event) => {
  hoverSeek(event);
  if (scrubbing) seek(frameAtPointer(event).frame);
});
const endScrub = () => {
  if (!scrubbing) return;
  scrubbing = false;
  $("seek").classList.remove("scrubbing");
  player.anchor = performance.now();
  player.anchorFrame = player.frame;
  if (player.playing) sound.start(player.frame);
};
$("seek").addEventListener("pointerup", endScrub);
$("seek").addEventListener("pointercancel", endScrub);
$("seek").addEventListener("lostpointercapture", endScrub);
$("seek").addEventListener("pointerleave", () => {
  if (!scrubbing) $("ghost").hidden = $("tip").hidden = true;
});
async function openPath(path) {
  if (opening) return;
  opening = true;
  pause();
  showScreen("loading");
  try {
    resize(false);
    await loadReplay(path);
    sound.reset(player.info);
    const names = player.info.playerNames.filter(Boolean).join(" vs ");
    const file = path.split(/[\\/]/).pop();
    document.title = `${names || file} — More of Dots`;
    if (isTauri()) void getCurrentWindow().setTitle(document.title).catch(() => {});
    errorShown = false;
    updatePosition(0);
    // The window may have been resized while loading; draw the first frame at
    // the current size and let it reach the screen before revealing it.
    resize(false);
    await paint(0);
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    showScreen("player");
    toggle();
    flash("bar", 2500);
  } catch (error) {
    showScreen("welcome", "Couldn't open this replay", String(error));
  } finally {
    opening = false;
  }
}
async function chooseReplay() {
  const path = await pickReplay();
  if (path) await openPath(path);
}
function resize(draw = true) {
  const scale = Math.min(window.devicePixelRatio || 1, 7680 / innerWidth, 4320 / innerHeight);
  renderer.resize(
    Math.round(innerWidth * scale),
    Math.round(innerHeight * scale),
  );
  if (draw) redraw();
}
async function fullscreen() {
  if (isTauri()) {
    const window = getCurrentWindow();
    await window.setFullscreen(!(await window.isFullscreen()));
  } else if (document.fullscreenElement) await document.exitFullscreen();
  else await document.documentElement.requestFullscreen();
  reveal();
}
function animate(now) {
  if (player.playing && player.ready && !scrubbing) {
    let frame = Math.min(
      player.info.lastFrame,
      player.anchorFrame +
        Math.floor((now - player.anchor) * 0.03 * player.speed),
    );
    // Wait at the edge of the simulated range without skipping ahead later.
    if (frame > seekable()) {
      sound.stop();
      frame = seekable();
      player.anchor = now;
      player.anchorFrame = frame;
    }
    if (frame !== player.frame) {
      if (!sound.playing && !seekAudioTimer) sound.start(player.frame);
      player.frame = frame;
      sound.advance(frame);
      updatePosition(frame);
      void paint(frame).catch(showError);
    }
    if (player.info.complete && frame >= player.info.lastFrame) {
      pause();
      if (!player.info.error) sound.end(player.info.result);
    }
  }
  requestAnimationFrame(animate);
}
$("play").onclick = toggle;
$("open").onclick = () => chooseReplay().catch(showError);
$("open-replay").onclick = () => chooseReplay().catch(showError);
$("speed").onclick = () => speedMenu($("speed-menu").hidden);
$("speed").addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    stepSpeed(event.deltaY < 0 ? 1 : -1);
  },
  { passive: false },
);
for (const option of $("speed-menu").children)
  option.onclick = () => {
    setSpeed(Number(option.dataset.speed));
    speedMenu(false);
    $("speed").focus();
  };
$("fullscreen").onclick = () => fullscreen().catch(showError);
$("volume").onclick = () => volumeMenu($("volume-menu").hidden);
for (const name of ["music", "sfx"])
  $(`${name}-volume`).addEventListener("input", () =>
    setVolume(
      Number($("music-volume").value) / 100,
      Number($("sfx-volume").value) / 100,
    ),
  );
addEventListener("pointermove", track);
document.documentElement.addEventListener("pointerleave", () => {
  pointer = null;
  reveal();
});
addEventListener("pointerdown", (event) => {
  track(event);
  if (!$("speed-menu").hidden && !event.target.closest(".speed-wrap"))
    speedMenu(false);
  if (!$("volume-menu").hidden && !event.target.closest(".volume-wrap"))
    volumeMenu(false);
});
addEventListener("focusin", reveal);
addEventListener("focusout", reveal);
addEventListener("resize", resize);
canvas.addEventListener("dblclick", () => void fullscreen().catch(showError));
canvas.addEventListener("wheel", (event) => {
  if (!player.ready || !event.deltaY) return;
  event.preventDefault();
  const box = canvas.getBoundingClientRect();
  const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? box.height : 1);
  renderer.zoomAt((event.clientX - box.left) / box.width, (event.clientY - box.top) / box.height,
    Math.exp(-Math.max(-200, Math.min(200, delta)) * 0.002));
  redraw();
}, { passive: false });
let dragOrigin = null;
canvas.addEventListener("pointerdown", (event) => {
  if (isTauri() && event.button === 0 && event.detail < 2)
    dragOrigin = { x: event.clientX, y: event.clientY, id: event.pointerId };
});
canvas.addEventListener("pointermove", (event) => {
  if (!dragOrigin || dragOrigin.id !== event.pointerId) return;
  if (!(event.buttons & 1)) { dragOrigin = null; return; }
  if (Math.hypot(event.clientX - dragOrigin.x, event.clientY - dragOrigin.y) < 4) return;
  dragOrigin = null;
  const window = getCurrentWindow();
  void window.isFullscreen().then(full => { if (!full) return window.startDragging(); }).catch(showError);
});
addEventListener("pointerup", () => { dragOrigin = null; });
addEventListener("pointercancel", () => { dragOrigin = null; });
addEventListener("blur", () => { dragOrigin = null; });
canvas.addEventListener("contextmenu", (event) => event.preventDefault());
addEventListener("keydown", (event) => {
  const editing =
    /^(INPUT|SELECT|TEXTAREA)$/.test(event.target?.tagName) &&
    event.target?.type !== "checkbox";
  if (event.key === "Escape") {
    if (!$("speed-menu").hidden) {
      speedMenu(false);
      $("speed").focus();
    } else if (!$("volume-menu").hidden) {
      volumeMenu(false);
      $("volume").focus();
    } else if (isTauri()) getCurrentWindow().setFullscreen(false);
    return;
  }
  if (editing) return;
  // Held arrow keys repeat seeks, as in mpv; other shortcuts ignore repeats.
  const jumps = { ArrowLeft: -150, ArrowRight: 150, ArrowDown: -1800, ArrowUp: 1800 };
  if (event.key in jumps && player.ready && $("speed-menu").hidden && $("volume-menu").hidden) {
    event.preventDefault();
    seek(player.frame + jumps[event.key]);
    flash("bar");
    return;
  }
  if (event.repeat) return;
  if (
    /^[1-8]$/.test(event.key) &&
    !event.ctrlKey &&
    !event.altKey &&
    player.ready
  ) {
    event.preventDefault();
    toggleLayer(displayOptions[Number(event.key) - 1][0]);
    flash("rail");
  }
  if (
    event.code === "Space" &&
    !event.target?.closest("button")
  ) {
    event.preventDefault();
    toggle();
    flash("bar");
  }
  if (event.key === "[" || event.key === "]") {
    stepSpeed(event.key === "]" ? 1 : -1);
    flash("bar");
  }
  if (event.key === "f") void fullscreen().catch(showError);
  if (event.ctrlKey && event.key.toLowerCase() === "o") {
    event.preventDefault();
    void chooseReplay().catch(showError);
  }
});
resize();
requestAnimationFrame(animate);
reveal();
if (launch)
  invoke("replay_launch_request", { launchId: launch })
    .then(async (request) => {
      await openPath(request.filePath);
      const args = await invoke("player_debug_options");
      const value = (name) => args[args.indexOf(name) + 1];
      if (
        args.includes("--replay") &&
        request.filePath.replace(/\\/g, "/").toLowerCase() !==
          value("--replay").replace(/\\/g, "/").toLowerCase()
      )
        return;
      if (args.includes("--qa-capture") && player.ready) {
        pause();
        renderer.resize(1920, 1200);
        player.frame = Number(value("--frame")) || 0;
        if (args.includes("--all-layers")) {
          for (const [name] of displayOptions) player.options[name] = true;
          showLayers();
        }
        await paint(player.frame);
        await invoke("save_player_snapshot", {
          path: value("--qa-capture"),
          png: await renderer.snapshot(true),
        });
        resize();
      }
      // Plays a few seconds and reports the sound engine's state.
      if (args.includes("--qa-audio") && player.ready) {
        while (!player.info.complete) await new Promise((resolve) => setTimeout(resolve, 100));
        seek(Number(value("--frame")) || 0);
        if (!player.playing) toggle();
        await new Promise((resolve) => setTimeout(resolve, 4000));
        await invoke("save_player_diagnostics", {
          path: value("--qa-audio"),
          report: {
            frame: player.frame,
            playing: player.playing,
            cues: player.info.fighting.length,
            result: player.info.result ?? null,
            volume: sound.volume,
            context: sound.context?.state ?? null,
            musicPaused: sound.music?.paused ?? null,
            musicSource: sound.music?.currentSrc ?? null,
            soundError: sound.error ?? null,
            musicTime: sound.music?.currentTime ?? null,
            fightingVolume: sound.fightingVolume(),
            fightingGain: sound.fightingGain?.gain.value ?? null,
            voices: sound.voices.size,
            played: sound.played,
          },
        });
      }
      if (args.includes("--qa-performance") && player.ready) {
        pause();
        renderer.resize(1920, 1080);
        const first = Math.min(
          player.info.lastFrame,
          Number(value("--qa-performance-start")) || 0,
        );
        const total = Math.min(player.info.lastFrame, first + 300),
          times = [],
          drawTimes = [],
          gaps = [];
        let previous = performance.now();
        const heartbeat = setInterval(() => {
          const now = performance.now();
          gaps.push(now - previous);
          previous = now;
        }, 10);
        try {
          for (let frame = first; frame <= total; frame++) {
            const start = performance.now();
            await paint(frame);
            times.push(performance.now() - start);
            drawTimes.push(renderer.metrics.renderMs);
          }
        } finally {
          clearInterval(heartbeat);
        }
        const summarize = (values) => {
          const sorted = [...values].sort((a, b) => a - b);
          return {
            median: sorted[Math.floor(sorted.length / 2)],
            p95: sorted[Math.floor(sorted.length * 0.95)],
            max: Math.max(...sorted),
          };
        };
        const drawRequest = await renderer.drawRequest();
        await invoke("save_player_diagnostics", {
          path: value("--qa-performance"),
          report: {
            frames: times.length,
            firstFrame: first,
            elapsedMs: times.reduce((a, b) => a + b, 0),
            frameMs: summarize(times),
            drawingMs: summarize(drawTimes),
            heartbeatMs: summarize(gaps),
            buffer: renderer.metrics.buffer,
            drawRequest,
          },
        });
        if (args.includes("--qa-preview"))
          await invoke("save_player_snapshot", {
            path: value("--qa-preview"),
            png: await renderer.snapshot(),
          });
        resize();
      }
    })
    .catch((error) => {
      if (!player.ready) showScreen("welcome", "Couldn't open this replay", String(error));
      else toast(String(error));
    });
if (isTauri())
  getCurrentWindow().onDragDropEvent((event) => {
    if (
      event.payload.type === "drop" &&
      event.payload.paths?.length
    )
      void openPath(event.payload.paths[0]);
  });
else {
  addEventListener("dragover", (event) => event.preventDefault());
  addEventListener("drop", async (event) => {
    event.preventDefault();
    const file = event.dataTransfer?.files[0];
    if (file) void openPath(await addFile(file));
  });
  // A link can name the replay to play: ?replay=<url>
  const linked = new URLSearchParams(location.search).get("replay");
  if (linked) void openPath(linked);
}
// QA can inspect and render a fixed frame through the same production path.
window.replayPlayer = {
  player,
  paint,
  loadReplay: openPath,
  renderer,
  pause,
  seek,
  sound,
};
