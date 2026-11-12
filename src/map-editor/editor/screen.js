// The map editor's screen (layout A): a title bar, the tool rail, the current
// tool's options above the map, a dock for teams and what to show, and a status
// bar. The map and its tools are in engine.js; Run plays a test match (runner.js).
import { mount, TERRAIN, PAINT_TOOLS } from "./engine.js";
import { TestMatch } from "./runner.js";
import "./editor.css";

const DOT = String.fromCharCode(183);
const TEAM_NAME = ["Blue", "Red", "Purple", "Orange"];
const TEAM_COLOR = ["blue", "red", "purple", "orange"];
const TEAM_HEX = ["#4b8dff", "#eb5a58", "#b881ff", "#ff9c47"];
const TOOLS = {
  move: { name: "Move", key: "V", hint: "Click or drag a box to select units and cities, then drag to move them." },
  hand: { name: "Hand", key: "H", hint: "Drag to move the view. Hold Space for this with any tool." },
  brush: { name: "Brush", key: "B", hint: "Paints the front colour. Right-click paints the back colour." },
  line: { name: "Line", key: "N", hint: "Drag to draw a straight line with the brush. Shift keeps to 15 degree steps." },
  curve: { name: "Curve", key: "P", hint: "Click points for a smooth curve through them. Double-click or Enter finishes, Esc cancels, Backspace removes the last point." },
  shape: { name: "Shape", key: "M", hint: "Drag a rectangle or ellipse; Shift makes it square or round. A polygon is clicked point by point; Enter or a click on the first point closes it." },
  lasso: { name: "Lasso fill", key: "L", hint: "Drag around an area to fill it." },
  bucket: { name: "Paint bucket", key: "G", hint: "Fills the connected area under the cursor." },
  smooth: { name: "Smooth", key: "R", hint: "Drag over jagged edges to smooth them; the changes show before you let go. Colours stay the game's own." },
  picker: { name: "Eyedropper", key: "I", hint: "Click picks the front colour, right-click the back colour." },
  bridge: { name: "Bridge", key: "J", hint: "Drag from one bank to the other. Right-click removes a bridge." },
  infantry: { name: "Infantry", key: "U", hint: "Click to place. Units already placed keep their shock unit status. Right-click removes the nearest unit." },
  tank: { name: "Tank", key: "T", hint: "Click to place. Right-click removes the nearest unit." },
  city: { name: "City", key: "C", hint: "Click to place a city; a team's first city becomes its capital. Right-click removes one." },
};
const GROUPS = [["move", "hand"], ["brush", "line", "curve", "shape", "lasso", "bucket", "smooth", "picker"], ["bridge"], ["infantry", "tank", "city"]];
const PAINT = ["brush", "line", "curve", "shape", "lasso", "bucket", "picker"];
const SYMMETRIC = ["brush", "line", "curve", "shape", "lasso", "bucket", "smooth", "bridge", "infantry", "tank", "city"];
const FIGURES = [["rect", "frect", "Rectangle"], ["ellipse", "fellipse", "Ellipse"], ["polygon", "fpolygon", "Polygon"]];
const CURVE_STYLES = [["line", "Line", "An open curve drawn with the brush"], ["loop", "Loop", "A closed curve drawn with the brush"], ["fill", "Fill", "A closed curve, filled"]];
const STRENGTHS = [[1, "Light", "Removes specks and single-pixel steps. Lines 1 pixel wide go."], [2, "Medium", "Straightens steps a few pixels wide. Lines thinner than 3 pixels go."], [3, "Strong", "Straightens larger steps and rounds corners. Lines thinner than 4 pixels go."]];
// [id, icon, name, description]
const SYMMETRY = [
  ["off", "symoff", "Off", "No symmetry"],
  ["x", "symx", "Left and right", "Mirror across the vertical centre line"],
  ["y", "symy", "Top and bottom", "Mirror across the horizontal centre line"],
  ["rotate", "symrotate", "Half turn", "Turn half a turn around the centre: copies land in the opposite corner"],
  ["quad", "symquad", "Four ways", "Mirror across both centre lines: one copy in each quarter"],
];
const PATHS = {
  back: '<path d="M15 18l-6-6 6-6"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>',
  move: '<path d="M5 3l5.5 15 2.2-6.3L19 9.5z"/><path d="M13 13l6 6"/>',
  hand: '<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V11"/><path d="M11 10.5V4a1.5 1.5 0 0 1 3 0v6.5"/><path d="M14 10.5V5.5a1.5 1.5 0 0 1 3 0V13"/><path d="M17 12a1.5 1.5 0 0 1 3 0v2a7 7 0 0 1-7 7h-1a7 7 0 0 1-5.6-2.8L4 15.5a1.6 1.6 0 0 1 2.4-2.1L8 15"/>',
  brush: '<path d="M18.5 3.5l2 2-9.5 9.5-2-2z"/><path d="M9 13c-2.5 0-4 1.6-4 3.8 0 1.4-.8 2.4-2 2.7 1.3 1 3.3 1.5 5 1 2.4-.7 3.6-2.6 3-5z"/>',
  bucket: '<path d="M11 4l8 8-6.5 6.5a2.1 2.1 0 0 1-3 0L4.5 13.5a2.1 2.1 0 0 1 0-3z"/><path d="M5 12h13"/><path d="M20.5 15.5c0 1.6 1 2.3 1 3.3a1 1 0 0 1-2 0c0-1 1-1.7 1-3.3z"/>',
  lasso: '<path d="M7 18.5C3.8 16.9 3 14 3 12c0-5 4-8 9-8s9 3 9 7-4 7-9 7c-1.2 0-2.3-.1-3.3-.4"/><path d="M8.7 17.6c.3 1.4-.4 2.6-1.7 3.1-.9.3-1.8 0-2.2-.7"/>',
  rect: '<rect x="4" y="5" width="16" height="14" rx="1" stroke-dasharray="3 2.4"/><rect x="8" y="9" width="8" height="6" fill="currentColor" stroke="none" opacity="0.6"/>',
  picker: '<path d="M14.5 4.5a2.8 2.8 0 0 1 4 4L17 10l-3-3z"/><path d="M14 7l-9 9-1 4 4-1 9-9"/>',
  line: '<path d="M5.5 18.5l13-13"/><circle cx="5.5" cy="18.5" r="1.8" fill="currentColor" stroke="none"/><circle cx="18.5" cy="5.5" r="1.8" fill="currentColor" stroke="none"/>',
  curve: '<path d="M4 18c2.5-8 5.5-10 8-5.5s5.5 2.5 8-6"/><circle cx="4" cy="18" r="1.8" fill="currentColor" stroke="none"/><circle cx="12" cy="12.5" r="1.8" fill="currentColor" stroke="none"/><circle cx="20" cy="6.5" r="1.8" fill="currentColor" stroke="none"/>',
  shape: '<rect x="3.5" y="10" width="10" height="10" rx="1"/><circle cx="15.5" cy="8.5" r="5"/>',
  smooth: '<path d="M3 16h3v-3h3v-3h3"/><path d="M12 10c3 0 4.5 1 6 3.5S20 17 21 17" stroke-dasharray="2 2"/><path d="M3 20h18"/>',
  frect: '<rect x="4" y="6" width="16" height="12" rx="1"/>',
  fellipse: '<ellipse cx="12" cy="12" rx="8.5" ry="6"/>',
  fpolygon: '<path d="M12 4.5l8 6-3 8.5H7l-3-8.5z"/>',
  bridge: '<path d="M2 15h20"/><path d="M4 15c2-4 5-6 8-6s6 2 8 6"/><path d="M8 15v-3.5M12 15V9M16 15v-3.5"/>',
  eye: '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/>',
  eyeoff: '<path d="M3 3l18 18"/><path d="M10.6 5.6A10 10 0 0 1 12 5.5c6.4 0 10 6.5 10 6.5a17 17 0 0 1-3.2 3.9M6.6 6.6A17 17 0 0 0 2 12s3.6 6.5 10 6.5a9.8 9.8 0 0 0 4.4-1"/>',
  swap: '<path d="M7 4h9a4 4 0 0 1 4 4v9"/><path d="M17 14l3 3 3-3"/><path d="M10 1L7 4l3 3"/>',
  reset: '<rect x="3" y="3" width="10" height="10"/><rect x="11" y="11" width="10" height="10"/>',
  // Symmetry: the map's frame, its axes and a dot where each copy lands.
  symoff: '<rect x="2.5" y="5" width="19" height="14" rx="2"/><circle cx="7.5" cy="9.5" r="1.9" fill="currentColor" stroke="none"/>',
  symx: '<rect x="2.5" y="5" width="19" height="14" rx="2"/><path d="M12 5v14" stroke-dasharray="1.6 1.9"/><circle cx="7.5" cy="9.5" r="1.9" fill="currentColor" stroke="none"/><circle cx="16.5" cy="9.5" r="1.9" fill="currentColor" stroke="none"/>',
  symy: '<rect x="2.5" y="5" width="19" height="14" rx="2"/><path d="M2.5 12h19" stroke-dasharray="1.6 1.9"/><circle cx="7.5" cy="8.7" r="1.9" fill="currentColor" stroke="none"/><circle cx="7.5" cy="15.3" r="1.9" fill="currentColor" stroke="none"/>',
  symrotate: '<rect x="2.5" y="5" width="19" height="14" rx="2"/><circle cx="7.5" cy="9" r="1.9" fill="currentColor" stroke="none"/><circle cx="16.5" cy="15" r="1.9" fill="currentColor" stroke="none"/><path d="M10.2 13.6a2.4 2.4 0 1 0-.4-2.6"/><path d="M9.6 9.3l.2 1.8 1.7-.4"/>',
  symquad: '<rect x="2.5" y="5" width="19" height="14" rx="2"/><path d="M12 5v14M2.5 12h19" stroke-dasharray="1.6 1.9"/><circle cx="7.5" cy="8.7" r="1.9" fill="currentColor" stroke="none"/><circle cx="16.5" cy="8.7" r="1.9" fill="currentColor" stroke="none"/><circle cx="7.5" cy="15.3" r="1.9" fill="currentColor" stroke="none"/><circle cx="16.5" cy="15.3" r="1.9" fill="currentColor" stroke="none"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  copy: '<path d="M12 3v18" stroke-dasharray="2 2.5"/><rect x="3" y="7" width="6" height="10" rx="1"/><rect x="15" y="7" width="6" height="10" rx="1" stroke-dasharray="2 2"/>',
  play: '<path d="M7 5l12 7-12 7z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>',
};
const svg = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${PATHS[name]}</svg>`;
const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const terrainName = (hex) => TERRAIN.find(([, h]) => h === hex)?.[0] ?? "";

/**
 * Builds the editor in `root`. `map` is in the game's coordinates, with the
 * terrain as a data URL. `onSave(data, publish)` stores the map and resolves to
 * its status ("draft" or "published"); `onClose()` returns to the library.
 */
export function mountEditor(root, { map, name, status, base, saveLabel = "Save to game", onSave, onClose, onTerrainImage, onDirty, onRename }) {
  const sprite = (team, kind) => `${base}player-assets/${TEAM_COLOR[team]}_${kind}_100.png`;
  const toolInner = (id, team) =>
    id === "infantry" ? `<img alt="" src="${sprite(team, "infantry")}">` : id === "tank" ? `<img alt="" src="${sprite(team, "tank")}">`
    : id === "city" ? `<span class="city-dot" style="width:14px;height:14px"></span>` : svg(id);
  const ui = { tool: "brush", cursor: null, size: 12, shape: "round", figure: "rect", figureStyle: "fill", curveStyle: "line", strength: 2, symmetry: "off", team: 0, front: TERRAIN[1][1], back: TERRAIN[0][1], selection: 0, status, saving: false, savedVersion: 0, error: "", running: null };

  root.innerHTML = `
    <div class="mod-editor" data-tool="brush">
      <div class="me-topbar">
        <button class="btn ghost" type="button" data-close>${svg("back")}Library</button>
        <div class="sep"></div>
        <button class="title title-button" type="button" data-title title="Rename the map">${escape(name)}</button><span class="badge" data-badge></span>
        <div style="flex:1"></div>
        <span class="row" data-edit><button class="icon" type="button" data-undo title="Undo (Ctrl+Z)">${svg("undo")}</button><button class="icon" type="button" data-redo title="Redo (Ctrl+Shift+Z)">${svg("redo")}</button></span>
        <div class="sep"></div>
        <label class="btn" data-edit title="Replace the terrain with an image, snapped to the terrain colours">${svg("image")}Terrain from image<input type="file" accept="image/*" hidden data-image></label>
        <button class="btn run" type="button" data-run title="Play the map from its first frame">${svg("play")}Run</button>
        <div class="sep"></div>
        <button class="btn" type="button" data-save="draft" data-edit>Save draft</button>
        <button class="btn primary" type="button" data-save="game" data-edit>${escape(saveLabel)}</button>
      </div>
      <div class="rail" data-edit data-slot="rail"></div>
      <div class="options" data-edit data-slot="options"></div>
      <div class="canvas-area" data-area><div class="stage" data-stage><canvas class="sim"></canvas><span class="stage-note" data-note>Loading the map</span></div></div>
      <div class="dock">
        <div class="dock-sec"><div class="dock-head">Teams <span class="seg" data-edit data-slot="teamcount"></span></div><div data-slot="teamrows"></div></div>
        <div class="dock-sec" data-edit><div class="dock-head">Show</div><div data-slot="layers"></div></div>
      </div>
      <div class="status" data-slot="status"></div>
      <div class="me-size" hidden aria-hidden="true"><span class="me-size-ring"></span><span class="me-size-label"></span></div>
    </div>`;
  const screen = root.querySelector(".mod-editor");
  const q = (s) => [...screen.querySelectorAll(s)];
  const slot = (n) => q(`[data-slot="${n}"]`);
  const note = screen.querySelector("[data-note]");
  const stage = screen.querySelector("[data-stage]");
  const area = screen.querySelector("[data-area]");

  const engine = mount({
    canvas: screen.querySelector("canvas.sim"), base, map,
    hooks: {
      change: () => { renderTeams(); renderBadge(); },
      cursor: (c) => { ui.cursor = c; renderStatus(); },
      colors: (m) => { ui.front = m.front; ui.back = m.back; renderAll(); },
      selection: (m) => { ui.selection = m.selection.length; renderOptions(); },
    },
  });
  engine.set({ tool: ui.tool, size: ui.size, shape: ui.shape, symmetry: ui.symmetry, team: ui.team, front: ui.front, back: ui.back });
  engine.ready.then(() => { note.hidden = true; ui.savedVersion = engine.version; renderAll(); }, (error) => { note.textContent = `The map could not be drawn: ${error.message}`; });

  // The map keeps 16:9 and fills the space between the bars.
  const resize = () => {
    const { width, height } = area.getBoundingClientRect(), margin = 16;
    const w = Math.max(0, Math.min(width - margin, ((height - margin) * 16) / 9));
    stage.style.width = `${Math.floor(w)}px`;
    stage.style.height = `${Math.floor((w * 9) / 16)}px`;
    engine.draw();
  };
  const fit = new ResizeObserver(resize);
  fit.observe(area);
  resize();

  const dirty = () => engine.version !== ui.savedVersion;
  const sizeControl = () => `<span class="row"><span class="label">Size</span><input class="range" type="range" min="1" max="60" value="${ui.size}" data-size style="width:96px" aria-label="Brush size"><span class="mono" data-size-label style="width:34px">${ui.size} px</span></span>`;
  const shapeControl = () => `<span class="row"><span class="label">Tip</span><span class="seg">${["round", "square"].map((s) => `<button type="button" class="${ui.shape === s ? "on" : ""}" data-shape="${s}">${s === "round" ? "Round" : "Square"}</button>`).join("")}</span></span>`;
  const symmetryControl = (label = "Symmetry") => {
    const current = SYMMETRY.find(([id]) => id === ui.symmetry);
    return `<span class="row"><span class="label">${label}</span><span class="seg symmetry" role="group" aria-label="${label}">${SYMMETRY.map(([id, icon, title, detail]) => `<button type="button" class="${ui.symmetry === id ? "on" : ""}" data-symmetry="${id}" title="${title}. ${detail}." aria-pressed="${ui.symmetry === id}">${svg(icon)}</button>`).join("")}</span><span class="symmetry-name">${current[2]}</span></span>`;
  };
  const seg = (label, items, current, attr) => `<span class="row"><span class="label">${label}</span><span class="seg">${items.map(([id, text, title, icon]) => `<button type="button" class="${String(current) === String(id) ? "on" : ""}" data-${attr}="${id}" title="${title ?? text}">${icon ? svg(icon) : text}</button>`).join("")}</span></span>`;
  const figureControl = () => seg("Shape", FIGURES.map(([id, icon, name]) => [id, name, name, icon]), ui.figure, "figure");
  const figureStyleControl = () => seg("Style", [["fill", "Fill"], ["outline", "Outline", "Drawn with the brush"]], ui.figureStyle, "figure-style");
  const curveStyleControl = () => seg("Style", CURVE_STYLES, ui.curveStyle, "curve-style");
  const strengthControl = () => seg("Strength", STRENGTHS.map(([id, name, title]) => [id, name, title]), ui.strength, "strength");
  const swatches = () => `<span class="row"><span class="swatches">${TERRAIN.map(([title, hex], i) => `<button class="swatch${hex === ui.front ? " front" : ""}${hex === ui.back ? " back" : ""}" type="button" data-terrain="${hex}" title="${title} (${i + 1}). Right-click sets the back colour." style="background:${hex}"><span class="tag">${i + 1}</span></button>`).join("")}</span><span class="label terrain-name" style="min-width:110px">${terrainName(ui.front)} on ${terrainName(ui.back)}</span></span>`;
  const teamChips = () => `<span class="row">${Array.from({ length: engine.teams }, (_, t) => `<button class="chip${t === ui.team ? " on" : ""}" type="button" data-team="${t}" style="--c:${TEAM_HEX[t]}"><span class="dot" style="background:${TEAM_HEX[t]}"></span>${TEAM_NAME[t]}</button>`).join("")}</span>`;
  const copyTeams = () => {
    const copies = { x: 1, y: 1, rotate: 1, quad: 3 }[ui.symmetry] ?? 0;
    const names = Array.from({ length: copies }, (_, k) => TEAM_NAME[(ui.team + k + 1) % engine.teams]);
    return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
  };
  const mirrorNote = () => (ui.symmetry !== "off" ? `<span class="hint">Copies go to ${copyTeams()}.</span>` : "");
  const selectionActions = () => `<span class="label">${ui.selection ? `${ui.selection} selected` : "Nothing selected"}</span><button class="btn" type="button" data-action="mirror" ${ui.selection ? "" : "disabled"} title="Copy the selection to the other side of the map, for the next team">${svg("copy")}Mirror copy</button><button class="btn" type="button" data-action="delete" ${ui.selection ? "" : "disabled"}>${svg("trash")}Delete</button>`;

  function renderRail() {
    slot("rail").forEach((rail) => {
      rail.innerHTML = GROUPS.map((group) => group.map((id) => `<button class="icon${ui.tool === id ? " on" : ""}" type="button" data-tool="${id}" title="${TOOLS[id].name} (${TOOLS[id].key})">${toolInner(id, ui.team)}</button>`).join("")).join('<div class="gap"></div>') +
        `<div style="flex:1"></div><div class="colors" title="Front and back colours"><span class="c back" style="background:${ui.back}"></span><span class="c front" style="background:${ui.front}"></span><button class="swap" type="button" data-swap title="Swap colours (X)">${svg("swap")}</button><button class="reset" type="button" data-reset title="Default colours (D)">${svg("reset")}</button></div>`;
    });
  }

  function renderOptions() {
    const tool = ui.tool, parts = [];
    if (tool === "brush" || tool === "line") parts.push(sizeControl(), shapeControl());
    if (tool === "shape") parts.push(figureControl(), figureStyleControl(), ...(ui.figureStyle === "outline" ? [sizeControl(), shapeControl()] : []));
    if (tool === "curve") parts.push(curveStyleControl(), ...(ui.curveStyle === "fill" ? [] : [sizeControl(), shapeControl()]));
    if (tool === "smooth") parts.push(sizeControl(), strengthControl(), `<button class="btn" type="button" data-action="smooth-all" title="Smooth every edge on the map once, at this strength">${svg("smooth")}Smooth whole map</button>`);
    if (SYMMETRIC.includes(tool)) parts.push(symmetryControl());
    if (PAINT.includes(tool)) parts.push(swatches());
    if (tool === "infantry" || tool === "tank") parts.push(teamChips(), mirrorNote(), engine.layers.duo && engine.teams === 2 ? `<span class="hint">2v2: units go to players in pairs (1, 1, 2, 2, ...), infantry first, then tanks. New infantry joins the end, so placed units keep their player.</span>` : "");
    if (tool === "move") parts.push(selectionActions(), symmetryControl("Mirror across"));
    if (["hand", "picker", "bridge", "city", "lasso", "bucket", "line", "curve", "shape"].includes(tool)) parts.push(`<span class="hint">${TOOLS[tool].hint}</span>`);
    slot("options").forEach((box) => (box.innerHTML = `<span class="title" style="font-size:12.5px">${TOOLS[tool].name}</span><div class="sep"></div>` + parts.join('<div class="sep"></div>')));
    screen.dataset.tool = tool;
    renderTeams();
  }

  function renderTeams() {
    const teams = engine.teams, counts = engine.counts();
    slot("teamrows").forEach((box) => (box.innerHTML = Array.from({ length: teams }, (_, t) => {
      const c = counts[t];
      // Funds per payment as the engine pays them (economy.rs): 5 for each city the
      // team starts with, less 1 for each unit, counting units that stand on cities.
      const funds = c ? c.cities * 5 - c.infantry - c.tanks : 0;
      const fundsTag = c ? `<span class="funds" data-sign="${funds < 0 ? "negative" : funds ? "positive" : "zero"}" title="Funds each payment: 5 per city, less 1 per unit, counting units on cities">${funds < 0 ? "-" : "+"}$${Math.abs(funds)}</span>` : "";
      return `<button class="team-row${t === ui.team ? " on" : ""}" type="button" data-team="${t}" style="--c:${TEAM_HEX[t]}"><span class="dot" style="background:${TEAM_HEX[t]}"></span><span><span class="name">${TEAM_NAME[t]}${fundsTag}</span>${c ? `<small class="counts" title="${c.infantry} infantry (${c.shocks} shock), ${c.tanks} tanks, ${c.cities} cities"><img alt="Infantry" src="${sprite(t, "infantry")}">${c.infantry}<img alt="Tanks" src="${sprite(t, "tank")}">${c.tanks}<span class="city-dot" aria-label="Cities"></span>${c.cities}</small>` : ""}${c && engine.layers.duo && teams === 2 ? `<small class="counts duo" title="In 2v2 the two players of ${TEAM_NAME[t]} take its units in pairs: player 1 the first two, player 2 the next two, and so on">P1 ${c.players[0]} ${DOT} P2 ${c.players[1]}</small>` : ""}</span></button>`;
    }).join("")));
    slot("teamcount").forEach((box) => (box.innerHTML = [2, 3, 4].map((n) => `<button type="button" class="${n === teams ? "on" : ""}" data-teams="${n}">${n}</button>`).join("")));
    renderStatus();
  }

  function renderLayers() {
    const names = [["lines", "Front lines"], ["shocks", "Shock units"], ...(engine.teams === 2 ? [["duo", "2v2 control"]] : []), ["units", "Units"], ["cities", "Cities"], ["bridges", "Bridges"]];
    slot("layers").forEach((box) => (box.innerHTML = names.map(([id, title]) => `<button class="layer-row" type="button" data-layer="${id}" aria-pressed="${engine.layers[id]}">${svg(engine.layers[id] ? "eye" : "eyeoff")}${title}</button>`).join("")));
  }

  function renderStatus() {
    const c = ui.cursor;
    slot("status").forEach((box) => (box.innerHTML = [
      `<span class="mono">${c ? `x ${c.x} ${DOT} y ${c.y}` : `x - ${DOT} y -`}</span>`,
      `<span>${c?.terrain || ""}</span>`,
      `<span>${Math.round(engine.painter.renderer.view.zoom * 100)}%</span>`,
      ui.symmetry !== "off" ? `<span>Symmetry: ${SYMMETRY.find(([id]) => id === ui.symmetry)[2]}</span>` : "",
      `<span class="hint" style="flex:1">${ui.running ? `Test match: click any team's unit, then click or drag to move it. The economy shown is ${TEAM_NAME[ui.team]}'s. Space: options. Production is locked.` : ui.notice || TOOLS[ui.tool].hint}</span>`,
      ui.error ? `<span class="error" title="${escape(ui.error)}">${escape(ui.error)}</span>` : `<span>${engine.undoStack.length} to undo</span>`,
    ].join("")));
  }

  function renderBadge() {
    const unsaved = dirty();
    if (unsaved !== ui.reportedDirty) { ui.reportedDirty = unsaved; onDirty?.(unsaved); }
    const badge = screen.querySelector("[data-badge]");
    const text = ui.running ? "Test match, all teams" : ui.saving ? "Saving" : dirty() ? "Unsaved changes" : ui.status === "published" ? "Saved to game" : "Draft saved";
    badge.textContent = text;
    badge.dataset.state = ui.running ? "running" : ui.saving || dirty() ? "dirty" : "saved";
  }

  function renderRun() {
    screen.dataset.running = String(!!ui.running);
    const button = screen.querySelector("[data-run]");
    button.innerHTML = `${svg(ui.running ? "stop" : "play")}${ui.running ? "Stop" : "Run"}`;
    button.dataset.state = ui.running ? "running" : "edit";
    renderBadge();
    renderStatus();
  }

  function renderAll() { renderRail(); renderOptions(); renderLayers(); renderBadge(); }

  function apply(changes) {
    Object.assign(ui, changes);
    engine.set(Object.fromEntries(Object.entries(changes).filter(([k]) => ["tool", "size", "shape", "figure", "figureStyle", "curveStyle", "strength", "symmetry", "team", "front", "back"].includes(k))));
  }
  function setTool(tool) { ui.notice = ""; apply({ tool }); renderAll(); }
  function setTeam(team) {
    apply({ team });
    ui.running?.setSide(team);
    renderAll();
    renderStatus();
  }

  async function save(publish) {
    if (ui.saving || ui.running) return false;
    ui.saving = true;
    ui.error = "";
    renderBadge();
    const version = engine.version;
    try {
      ui.status = await onSave(engine.toMapData(), publish);
      ui.savedVersion = version;
      return true;
    } catch (error) {
      ui.error = error instanceof Error ? error.message : String(error);
      return false;
    } finally {
      ui.saving = false;
      renderBadge();
      renderStatus();
    }
  }

  async function run() {
    if (ui.running) return;
    await engine.ready;
    const canvas = document.createElement("canvas");
    canvas.className = "match";
    stage.append(canvas);
    const match = new TestMatch({ canvas, base, side: ui.team, teams: engine.teams, onEnd: (result, exit) => { if (exit) stop(); } });
    ui.running = match;
    ui.error = "";
    renderRun();
    try {
      await match.run(engine.toReplay());
    } catch (error) {
      ui.error = `The test match could not start: ${error instanceof Error ? error.message : error}`;
      stop();
    }
  }

  function stop() {
    const match = ui.running;
    if (!match) return;
    ui.running = null;
    match.destroy();
    match.canvas.remove();
    renderRun();
  }

  /** With unsaved changes, asks whether to save them as a draft or discard them.
   * Resolves to true when the editor may close. */
  function confirmLeave() {
    stop();
    if (!dirty()) return Promise.resolve(true);
    if (ui.asking) return ui.asking;
    ui.asking = new Promise((resolve) => {
      const dialog = document.createElement("div");
      dialog.className = "me-leave";
      dialog.innerHTML = `
        <div class="me-leave-card" role="alertdialog" aria-modal="true" aria-labelledby="meLeaveTitle" aria-describedby="meLeaveText">
          <h3 id="meLeaveTitle">Unsaved changes</h3>
          <p id="meLeaveText">${escape(name)} has changes that are not saved. A draft stays in More of Dots and does not change the copy in the game.</p>
          <p class="me-leave-error" role="alert" hidden></p>
          <div class="row"><button class="btn" type="button" data-leave="stay">Stay</button><div style="flex:1"></div><button class="btn" type="button" data-leave="discard">Discard changes</button><button class="btn primary" type="button" data-leave="save">Save draft</button></div>
        </div>`;
      screen.append(dialog);
      const buttons = () => [...dialog.querySelectorAll("button")];
      const finish = (value) => {
        dialog.remove();
        removeEventListener("keydown", onKey, true);
        ui.asking = null;
        resolve(value);
      };
      const onKey = (event) => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finish(false); }
        else if (event.key === "Tab") {
          // Focus stays in the dialog.
          const list = buttons(), at = list.indexOf(document.activeElement);
          if (event.shiftKey && at <= 0) { event.preventDefault(); list.at(-1).focus(); }
          else if (!event.shiftKey && at === list.length - 1) { event.preventDefault(); list[0].focus(); }
        }
      };
      addEventListener("keydown", onKey, true);
      dialog.addEventListener("click", async (event) => {
        const choice = event.target.closest("[data-leave]")?.dataset.leave;
        if (choice === "stay") finish(false);
        else if (choice === "discard") finish(true);
        else if (choice === "save") {
          buttons().forEach((button) => (button.disabled = true));
          if (await save(false)) return finish(true);
          const error = dialog.querySelector(".me-leave-error");
          error.hidden = false;
          error.textContent = ui.error || "The draft could not be saved.";
          buttons().forEach((button) => (button.disabled = false));
        }
      });
      dialog.querySelector('[data-leave="save"]').focus();
    });
    return ui.asking;
  }

  // The brush size as it changes: the brush at its size on screen, just under the
  // size slider, following the pointer along it.
  const onPointer = (event) => { ui.pointer = [event.clientX, event.clientY]; };
  addEventListener("pointermove", onPointer, true);
  addEventListener("pointerdown", onPointer, true);
  function showSize(fromSlider = false) {
    const box = screen.querySelector(".me-size"), ring = box.querySelector(".me-size-ring"), slider = screen.querySelector("[data-size]");
    const d = Math.max(2, engine.brushCssSize());
    let x, y;
    if (slider) {
      const r = slider.getBoundingClientRect(), thumb = r.left + ((ui.size - Number(slider.min)) / (Number(slider.max) - Number(slider.min))) * r.width;
      x = fromSlider && ui.pointer ? Math.max(r.left, Math.min(r.right, ui.pointer[0])) : thumb;
      y = r.bottom + 10 + d / 2;
    } else {
      // Tools without a size slider: under the pointer.
      [x, y] = ui.pointer ?? (() => { const r = stage.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })();
    }
    Object.assign(box.style, { left: `${x}px`, top: `${y}px` });
    Object.assign(ring.style, { width: `${d}px`, height: `${d}px`, borderRadius: ui.shape === "square" ? "2px" : "50%", background: ui.front });
    box.querySelector(".me-size-label").textContent = `${ui.size} px`;
    box.style.setProperty("--offset", `${d / 2 + 8}px`);
    box.hidden = false;
    box.classList.remove("fading");
    clearTimeout(ui.sizeTimer);
    ui.sizeTimer = setTimeout(() => {
      box.classList.add("fading");
      ui.sizeTimer = setTimeout(() => (box.hidden = true), 250);
    }, 900);
  }

  // The map's name: clicking it renames the map.
  function editTitle() {
    if (ui.running || !onRename || screen.querySelector(".title-input")) return;
    const button = screen.querySelector("[data-title]"), current = button.textContent;
    const input = document.createElement("input");
    input.className = "title-input";
    input.value = current;
    input.maxLength = 64;
    input.setAttribute("aria-label", "Map name");
    button.hidden = true;
    button.after(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async (commit) => {
      if (done) return;
      done = true;
      const next = input.value.trim();
      if (commit && next && next !== current) {
        input.disabled = true;
        try {
          button.textContent = await onRename(next);
          ui.error = "";
        } catch (error) {
          ui.error = error instanceof Error ? error.message : String(error);
        }
        renderStatus();
      }
      input.remove();
      button.hidden = false;
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); void finish(true); }
      else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); void finish(false); }
    });
    input.addEventListener("blur", () => void finish(true));
  }

  async function close() {
    if (await confirmLeave()) onClose();
  }

  screen.addEventListener("click", (event) => {
    const el = event.target.closest("button");
    if (!el || !screen.contains(el)) return;
    const d = el.dataset;
    if (d.tool) setTool(d.tool);
    else if (d.terrain) { apply({ front: d.terrain }); if (!PAINT.includes(ui.tool)) apply({ tool: "brush" }); renderAll(); }
    else if (d.shape) { apply({ shape: d.shape }); renderOptions(); }
    else if (d.figure) { apply({ figure: d.figure }); renderOptions(); }
    else if (d.figureStyle) { apply({ figureStyle: d.figureStyle }); renderOptions(); }
    else if (d.curveStyle) { apply({ curveStyle: d.curveStyle }); renderOptions(); }
    else if (d.strength) { apply({ strength: Number(d.strength) }); renderOptions(); }
    else if (d.action === "smooth-all") {
      const changed = engine.smoothAll();
      ui.error = "";
      ui.notice = changed ? `Smoothed ${changed.toLocaleString()} ${changed === 1 ? "pixel" : "pixels"}. Ctrl+Z undoes it.` : "Nothing to smooth at this strength.";
      renderStatus();
      clearTimeout(ui.noticeTimer);
      ui.noticeTimer = setTimeout(() => { ui.notice = ""; renderStatus(); }, 6000);
    }
    else if (d.symmetry) { apply({ symmetry: d.symmetry }); renderOptions(); }
    else if (d.team !== undefined) setTeam(Number(d.team));
    else if (d.teams) { engine.setTeams(Number(d.teams)); ui.team = engine.team; renderAll(); }
    else if (d.layer) { engine.setLayer(d.layer, !engine.layers[d.layer]); renderLayers(); renderOptions(); }
    else if (d.action === "mirror") engine.mirrorSelection();
    else if (d.action === "delete") engine.deleteSelection();
    else if (d.save) void save(d.save === "game");
    else if (el.hasAttribute("data-swap")) engine.swapColors();
    else if (el.hasAttribute("data-reset")) engine.resetColors();
    else if (el.hasAttribute("data-undo")) engine.undo();
    else if (el.hasAttribute("data-redo")) engine.redo();
    else if (el.hasAttribute("data-run")) void (ui.running ? stop() : run());
    else if (el.hasAttribute("data-close")) void close();
    else if (el.hasAttribute("data-title")) editTitle();
  });
  screen.addEventListener("contextmenu", (event) => {
    const swatch = event.target.closest("[data-terrain]");
    if (!swatch) return;
    event.preventDefault();
    apply({ back: swatch.dataset.terrain });
    renderAll();
  });
  screen.addEventListener("input", (event) => {
    if (!event.target.matches("[data-size]")) return;
    apply({ size: Number(event.target.value) });
    showSize(true);
    q("[data-size-label]").forEach((n) => (n.textContent = `${ui.size} px`));
  });
  screen.querySelector("[data-image]").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      engine.replaceTerrain(await onTerrainImage(file, engine.terrainCanvas.width, engine.terrainCanvas.height));
    } catch (error) {
      ui.error = error instanceof Error ? error.message : String(error);
      renderStatus();
    }
  });

  const key = (down) => (event) => {
    if (ui.running || ui.asking || event.target.closest?.("input:not([type=range]), textarea, select, [contenteditable]")) return;
    if (event.code === "Space") {
      event.preventDefault();
      engine.spaceHeld = down;
      engine.draw();
      screen.dataset.tool = down ? "hand" : ui.tool;
      return;
    }
    if (!down) return;
    const k = event.key.toLowerCase(), mod = event.ctrlKey || event.metaKey;
    if (mod && k === "z") { event.preventDefault(); return event.shiftKey ? engine.redo() : engine.undo(); }
    if (mod && k === "y") { event.preventDefault(); return engine.redo(); }
    if (mod && k === "s") { event.preventDefault(); return void save(false); }
    if (mod || event.altKey) return;
    if ((k === "enter" || k === "escape" || k === "backspace") && engine.pathKey(k)) { event.preventDefault(); return; }
    if (k === "delete" || k === "backspace") { event.preventDefault(); return engine.deleteSelection(); }
    if (k === "x") return engine.swapColors();
    if (k === "d") return engine.resetColors();
    if (k === "[" || k === "]") { apply({ size: Math.max(1, Math.min(60, ui.size + (k === "]" ? 2 : -2))) }); showSize(); return renderOptions(); }
    if (/^[1-8]$/.test(k)) {
      const n = Number(k) - 1;
      if (ui.tool === "infantry" || ui.tool === "tank" || ui.tool === "move") { if (n < engine.teams) setTeam(n); }
      else { apply({ front: TERRAIN[n][1] }); renderAll(); }
      return;
    }
    const tool = Object.entries(TOOLS).find(([, t]) => t.key.toLowerCase() === k)?.[0];
    if (tool) { event.preventDefault(); setTool(tool); }
  };
  const keydown = key(true), keyup = key(false);
  addEventListener("keydown", keydown);
  addEventListener("keyup", keyup);

  renderAll();
  renderRun();
  return {
    dirty,
    confirmLeave,
    save,
    stop,
    destroy() {
      stop();
      fit.disconnect();
      removeEventListener("keydown", keydown);
      removeEventListener("pointermove", onPointer, true);
      removeEventListener("pointerdown", onPointer, true);
      removeEventListener("keyup", keyup);
      engine.destroy();
      root.innerHTML = "";
    },
  };
}

export { PAINT_TOOLS };
