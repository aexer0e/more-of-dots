export const displayOptions = [
  ["orders", "Orders", true],
  ["health", "Health", true],
  ["morale", "Morale", true],
  ["flags", "City flags", true],
  ["icons", "Status icons", true],
  ["stats", "Stats", true],
  ["produce", "City connections", false],
  ["players", "Player names", true],
];
export const teamColors = ["blue", "red", "purple", "orange"];
const rgb = [
  [0, 0, 255],
  [255, 0, 0],
  [156, 0, 187],
  [255, 140, 57],
];
export function iconFor(dot) {
  if (dot.ship_timer > 0) return ["ship_icon", [32, 26]];
  if (dot.water_timer > 0) return ["water_icon", [32, 31]];
  if (dot.in_city) return ["city_icon", [36, 34]];
  if (dot.healing) return ["healing_icon", [32, 31]];
  if (dot.type === "tank" && dot.zrtyqz === "forest")
    return ["forest_icon", [32, 36]];
  return null;
}
export function drawBars(renderer, dot, options) {
  if (!options.health && !options.morale) return;
  const [x, y] = dot.position,
    both = options.health && options.morale;
  const rect = (x1, y1, x2, y2, color) =>
    renderer.polygon(
      [
        [x1, y1],
        [x1, y2],
        [x2, y2],
        [x2, y1],
      ],
      color,
    );
  const top = y - (both ? 22.8 : 20.8),
    bottom = y - (both ? 10.8 : 12.8);
  rect(x - 14.4, top, x + 14.4, bottom, [0, 0, 0, 1]);
  rect(x - 12, top + 2, x + 12, bottom - 2, [0.3, 0.3, 0.3, 1]);
  if (options.morale)
    rect(
      x - 12,
      bottom - 6,
      x - 12 + (24 * Math.max(0, dot.morale)) / 100,
      bottom - 2,
      [0, 1, 0.94, 1],
    );
  if (options.health) {
    const fraction = dot.health / dot.max_health;
    rect(
      x - 12,
      top + 2,
      x - 12 + 24 * fraction,
      top + 6,
      fraction > 0.5
        ? [0, 1, 0, 1]
        : fraction > 0.15
          ? [1, 1, 0, 1]
          : [1, 0.498, 0.314, 1],
    );
  }
}
export function drawProduction(renderer, state) {
  const economy = state.core.economy?.fields || {},
    cities = state.core.city_positions || [];
  const groupsBySide = economy.city_enc?.length
    ? economy.city_enc
    : (economy.industrial_zone || []).map((indices) => [indices]);
  for (const [side, groups] of groupsBySide.entries())
    for (const group of groups) {
      const indices = group.filter((index) =>
        (economy.industrial_zone?.[side] || []).includes(index),
      );
      if (indices.length === 1)
        renderer.circle(cities[indices[0]], 10, [0.2, 0.2, 0.2, 0.8]);
      for (let i = 0; i < indices.length; i++)
        for (let j = i + 1; j < indices.length; j++)
          renderer.line(
            [cities[indices[i]], cities[indices[j]]],
            [0.2, 0.2, 0.2, 0.8],
            10,
            2,
          );
    }
}
export function drawStats(renderer, state) {
  const economy = state.core.economy?.fields || {},
    sides = state.core.strength?.length || 2,
    gray = [200, 200, 200];
  renderer.text(
    "tcasualties",
    "Casualties: ",
    [0.00313, 0.05 * (sides + 1)],
    gray,
  );
  renderer.text(
    "tstrength",
    "Troops:  ",
    [0.99688, 0.05 * (sides + 1)],
    gray,
    "right",
  );
  renderer.text("tmoney", "Funds:  ", [0.99688, 0.95], gray, "right");
  for (let side = sides - 1; side >= 0; side--) {
    const y = 0.05 * (sides - side),
      income = economy.zasdxz?.[side]?.[0] || 0,
      arrow = income > 0 ? "▲" : income < 0 ? "▼" : "►";
    const count = (value, includeZero = false) =>
      state.frame > 1 && (value || includeZero)
        ? `~${((value || 0) * 100).toLocaleString("en-US")} `
        : "0";
    renderer.text(
      `${side}casualties`,
      count(state.core.troop_casualties?.[side]),
      [0.00313, y],
      rgb[side],
    );
    renderer.text(
      `${side}strength`,
      count(state.core.strength?.[side], true),
      [0.99688, y],
      rgb[side],
      "right",
    );
    renderer.text(
      `${side}money`,
      `${arrow}${Math.round(economy.zrtyz?.[side] || 0)} `,
      [0.99688, 0.95 - 0.05 * (sides - side)],
      rgb[side],
      "right",
    );
  }
}
