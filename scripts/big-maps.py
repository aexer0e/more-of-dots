"""Builds the big map matches: the game's Zolamare world map as a 1v1 replay at its
first frame, cut into provinces.

    python scripts/big-maps.py [--game <War of Dots folder>] [--only <id>]

Writes public/play-assets/maps/<id>.rep and <id>.webp (a picture of the layout) for each
layout, and public/play-assets/maps/index.json, which the site lists. The layouts are
fixed by their seeds, so running it again writes the same files.

Scale: the game's 9600x5400 world map plays at 9600x5400, a battlefield pixel a map
pixel, as the game plays a 1920x1080 map (the replay names that size; the engine keeps
its terrain at the picture's resolution). The replay carries the picture at 4800x2700
to stay within a match room's 1 MB.

Density: 2000 units a side (1500 infantry, 500 tanks) and 400 cities a side. Income
is paid for each connected region of a side's territory, 5 per city minus 1 per unit
outside a city, and a region cut off from the capital pays from nothing, so its units
decay as soon as it holds more than five units a city. Every region starts with exactly
five units a city: the engine (mass-patches) reports each region's units and cities, and
whole packs move from regions with too many to the cities of regions with too few until
none is left over.

The land is cut into provinces by walking time from points spread over it, and the
provinces are dealt to the sides for the longest front between them, with both sides
holding the same area and terrain. Each side's cities are the one of many even spreads
that best matches the other side's numbers at each distance from the front, with a
capital at the same distance behind it. Units stand as on the game's own maps: a line
along every front, facing the enemy's about 42 pixels away, and the rest in packs of
three or five behind it with open ground between them.

Every distance below is in battlefield pixels. The script works on the picture's pixels
(PX battlefield pixels each) and converts.
"""

import argparse
import base64
import gzip
import io
import json
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import dijkstra
from scipy.spatial import cKDTree

Image.MAX_IMAGE_PIXELS = None
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public/play-assets/maps"
# The big-map engine's report of each side's supply regions (engine/mass-sim).
PATCHES = ROOT / "engine/target/release/mass-patches"

UNITS = 2000       # a side
TANKS = 500
CITIES = 400       # a side: one for every five units
LINE_SHARE = 0.75  # of a side in its front lines, as on the game's maps
LINE_GAP = 27      # between units of a line (30 on the game's maps)
LINE_OFFSET = 21   # from the enemy's land: lines about 42 apart; units fight within 36
GROUP_GAP = 26     # between units of a group
GROUP_SPACING = 110  # between the centres of groups
GROUP_SIZES = (3, 5)  # the packs behind the lines

# The game's terrain colours (engine/replay-sim/src/surface.rs) and the time infantry
# takes per pixel on each (1 / speed in sim.rs; mountains all but stop it).
PALETTE = {
    "plains": ((161, 194, 70), 2.0),
    "forest": ((56, 131, 54), 2.0),
    "sand": ((238, 227, 176), 3.3),
    "hills": ((136, 138, 135), 2.0),
    "snow": ((227, 242, 242), 2.5),
    "mud": ((120, 75, 35), 5.0),
    "water": ((39, 155, 255), 10.0),
    "mountain": ((109, 107, 111), 200.0),
}
COLORS = np.array([c for c, _ in PALETTE.values()])
COSTS = np.array([t for _, t in PALETTE.values()])
NAMES = list(PALETTE)
WATER, MOUNTAIN = NAMES.index("water"), NAMES.index("mountain")

MAPS = {
    "zolamare": {
        "name": "Zolamare",
        "file": "assets/zolamare_maps/world_map_9600_indexed.png",
        "picture": (4800, 2700),   # carried in the replay
        "size": (9600, 5400),      # the battlefield: the map at the scale of a 1080p map
        "cell": 20,                # of the walking-time grid
        "speck": 30000,            # land masses smaller than this hold no units or cities
    },
}

# provinces: how many regions the land is cut into.
LAYOUTS = [
    {"id": "zolamare-world", "map": "zolamare", "name": "World", "provinces": 30, "seed": 61,
     "about": "The whole world at the scale of a 1080p map: thirty provinces, 2000 units a side."},
]


class Field:
    """The battlefield's terrain at the picture's pixels, and a walking-time grid."""

    def __init__(self, game: Path, spec):
        image = Image.open(game / spec["file"]).convert("RGB").resize(spec["picture"], Image.NEAREST)
        pixels = np.array(image).astype(int)
        # Snap every pixel to the nearest terrain colour: the engine reads exact colours only.
        colors, inverse = np.unique(pixels.reshape(-1, 3), axis=0, return_inverse=True)
        snapped = np.argmin(((colors[:, None, :] - COLORS[None]) ** 2).sum(-1), axis=1).astype(np.uint8)
        self.terrain = snapped[inverse.ravel()].reshape(pixels.shape[:2])
        self.surface = Image.fromarray(COLORS[self.terrain].astype(np.uint8))
        self.W, self.H = spec["size"]
        self.ph, self.pw = self.terrain.shape
        self.px = self.W / self.pw  # battlefield pixels a picture pixel
        self.cell = spec["cell"]
        blocked = (self.terrain == WATER) | (self.terrain == MOUNTAIN)
        # Distance to the nearest water or mountain, in battlefield pixels.
        self.clear = ndimage.distance_transform_edt(~blocked) * self.px
        labels, _ = ndimage.label(self.terrain != WATER, structure=np.ones((3, 3)))
        sizes = np.bincount(labels.ravel()) * self.px ** 2
        self.big_land = (sizes[labels] >= spec["speck"]) & (self.terrain != WATER)
        self.land_masses = labels
        # The walking-time grid samples the picture at each cell's centre.
        gh, gw = self.H // self.cell, self.W // self.cell
        self.grid = self.terrain[self.pix_rows(np.arange(gh) * self.cell + self.cell // 2)][:, self.pix_cols(np.arange(gw) * self.cell + self.cell // 2)]
        self.water = self.grid == WATER
        self.land = (self.grid != WATER) & (self.grid != MOUNTAIN)
        self.graph, self.index = walking_graph(COSTS[self.grid], self.cell)
        self.grid_big = self.big_land[self.pix_rows(np.arange(gh) * self.cell + self.cell // 2)][:, self.pix_cols(np.arange(gw) * self.cell + self.cell // 2)]

    def pix_rows(self, y):
        return np.clip((np.asarray(y) / self.px).astype(int), 0, self.ph - 1)

    def pix_cols(self, x):
        return np.clip((np.asarray(x) / self.px).astype(int), 0, self.pw - 1)

    def at(self, points):
        """Picture indices (rows, columns) of battlefield points."""
        points = np.asarray(points, float).reshape(-1, 2)
        return self.pix_rows(points[:, 1]), self.pix_cols(points[:, 0])

    def times(self, sources):
        return dijkstra(self.graph, indices=sources, min_only=True).reshape(self.grid.shape)

    def mix(self, mask):
        counts = np.bincount(self.grid[mask & self.land], minlength=len(NAMES))
        return counts / max(counts.sum(), 1)


def walking_graph(cost, cell):
    gh, gw = cost.shape
    index = np.arange(gw * gh).reshape(gh, gw)
    rows, cols, values = [], [], []
    for dy, dx in [(0, 1), (1, 0), (1, 1), (1, -1)]:
        if dx >= 0:
            a, b = index[: gh - dy, : gw - dx], index[dy:, dx:]
        else:
            a, b = index[: gh - dy, -dx:], index[dy:, : gw + dx]
        weight = (cost.ravel()[a.ravel()] + cost.ravel()[b.ravel()]) / 2 * cell * (2**0.5 if dx and dy else 1)
        rows += [a.ravel(), b.ravel()]
        cols += [b.ravel(), a.ravel()]
        values += [weight, weight]
    n = gw * gh
    return coo_matrix((np.concatenate(values), (np.concatenate(rows), np.concatenate(cols))), shape=(n, n)).tocsr(), index


def province_split(field, count, rng):
    """Provinces from points spread loosely over the land, dealt to the sides for the
    longest front between them while both hold the same area and terrain."""
    land = np.argwhere(field.land & field.grid_big)
    seeds = [land[rng.integers(len(land))]]
    for _ in range(count - 1):
        # The farthest of a few random points: spread out, but not a regular grid.
        picks = land[rng.integers(0, len(land), 6)]
        gaps = np.min(np.linalg.norm(picks[:, None] - np.array(seeds)[None], axis=2), axis=1)
        seeds.append(picks[np.argmax(gaps)])
    times = dijkstra(field.graph, indices=[field.index[tuple(s)] for s in seeds])
    province = np.argmin(times, axis=0).reshape(field.grid.shape)
    # Border between provinces, counted over neighbouring land cells.
    border = np.zeros((count, count))
    pairs = [
        (province[:, :-1], province[:, 1:], field.land[:, :-1] & field.land[:, 1:]),
        (province[:-1], province[1:], field.land[:-1] & field.land[1:]),
    ]
    for a, b, both in pairs:
        differ = both & (a != b)
        np.add.at(border, (a[differ], b[differ]), 1)
    border += border.T
    areas = np.array([(field.land & (province == p)).sum() for p in range(count)], float)
    mixes = np.array([field.mix(province == p) for p in range(count)]) * areas[:, None]

    def score(deal):
        front = border[deal][:, ~deal].sum() / border.sum() * 2
        area = abs(areas[deal].sum() / areas.sum() - 0.5)
        mix = np.abs(mixes[deal].sum(0) - mixes[~deal].sum(0)).sum() / areas.sum()
        return front - 20 * area - 4 * mix

    best, best_score = None, -np.inf
    for _ in range(40):
        deal = rng.permutation(count) < count // 2
        current = score(deal)
        for _ in range(3000):
            trial = deal.copy()
            if rng.random() < 0.5:
                trial[rng.choice(np.flatnonzero(deal))] = False
                trial[rng.choice(np.flatnonzero(~deal))] = True
            else:
                trial[rng.integers(count)] ^= True
            if 0 < trial.sum() < count:
                value = score(trial)
                if value >= current:
                    deal, current = trial, value
        if current > best_score:
            best, best_score = deal, current
    return best[province].astype(int)


class Sides:
    def __init__(self, field, side):
        self.field = field
        self.side_grid = side
        # Each picture pixel's side, from the grid cell under its centre.
        rows = np.minimum(((np.arange(field.ph) + 0.5) * field.px / field.cell).astype(int), side.shape[0] - 1)
        cols = np.minimum(((np.arange(field.pw) + 0.5) * field.px / field.cell).astype(int), side.shape[1] - 1)
        self.side_pix = side[rows][:, cols]
        open_ground = (field.terrain != WATER) & (field.terrain != MOUNTAIN)
        # Distance from each picture pixel to the nearest open land of each side.
        self.to_land = [ndimage.distance_transform_edt(~(open_ground & (self.side_pix == s))) * field.px for s in (0, 1)]
        # The front: land within 30 pixels of the other side's land. Depth is the walking
        # distance from it, in pixels at infantry speed on open ground.
        gh, gw = side.shape
        centre_rows = field.pix_rows(np.arange(gh) * field.cell + field.cell // 2)[:, None]
        centre_cols = field.pix_cols(np.arange(gw) * field.cell + field.cell // 2)[None]
        front = np.zeros_like(field.land)
        for s in (0, 1):
            front |= field.land & (side == s) & (self.to_land[1 - s][centre_rows, centre_cols] <= max(30, field.cell))
        self.depth_grid = field.times(field.index[front]) / 2

    def cell_of(self, points):
        points = np.asarray(points, float).reshape(-1, 2)
        gh, gw = self.side_grid.shape
        return np.clip((points[:, 1] // self.field.cell).astype(int), 0, gh - 1), np.clip((points[:, 0] // self.field.cell).astype(int), 0, gw - 1)

    def depth(self, p):
        return float(self.depths(p)[0])

    def depths(self, points):
        return self.depth_grid[self.cell_of(points)]

    def valid(self, points, side, clearance):
        """Points on the side's land, clear of water and mountains by `clearance`."""
        points = np.asarray(points, float).reshape(-1, 2)
        field = self.field
        inside = (points[:, 0] >= 20) & (points[:, 0] < field.W - 20) & (points[:, 1] >= 20) & (points[:, 1] < field.H - 20)
        r, c = field.at(points)
        return inside & (field.clear[r, c] >= clearance) & field.big_land[r, c] & (self.side_pix[r, c] == side)

    def candidates(self, side, clearance, rng, count, min_depth=0.0):
        found = np.zeros((0, 2))
        while len(found) < count:
            points = np.c_[rng.uniform(20, self.field.W - 20, count * 8), rng.uniform(20, self.field.H - 20, count * 8)]
            depth = self.depths(points)
            keep = self.valid(points, side, clearance) & (depth >= min_depth) & np.isfinite(depth)
            found = np.vstack([found, points[keep]])
        return found[:count]


def spread(candidates, count, rng, keep_from=(), min_gap=0.0, tries=24):
    """Mitchell's best candidate: each new point is the one of `tries` random candidates
    farthest from the points chosen so far (and from `keep_from`)."""
    chosen = []
    others = np.array(keep_from, dtype=float).reshape(-1, 2)
    for _ in range(count):
        for attempt in (tries, tries * 20):
            picks = candidates[rng.integers(0, len(candidates), attempt)]
            existing = np.vstack([others, np.array(chosen).reshape(-1, 2)])
            gaps = cKDTree(existing).query(picks)[0] if len(existing) else np.full(attempt, np.inf)
            best = int(np.argmax(gaps))
            if gaps[best] >= min_gap:
                break
        else:
            raise RuntimeError(f"No room for point {len(chosen) + 1} of {count} at a gap of {min_gap}")
        chosen.append(picks[best])
    return np.array(chosen)


def band_counts(sides, points):
    """Points in each band of distance from the front (the layout's own fifths)."""
    return np.histogram(sides.depths(points), bins=sides.bands)[0]


def place_cities(sides, rng):
    """CITIES a side: of many even spreads on each side, the pair with the closest numbers
    of cities in each band of distance from the front. Cities stand at least 35 pixels
    behind the front, or closer where that leaves no room."""
    for min_depth, clearance, gap in [(35, 10, 34), (35, 10, 28), (28, 8, 28), (22, 6, 28), (22, 6, 22), (16, 5, 22)]:
        pools = [np.round(sides.candidates(side, clearance, rng, 30000, min_depth=min_depth)) for side in (0, 1)]
        depths = np.concatenate([sides.depths(pool) for pool in pools])
        sides.bands = np.quantile(depths, np.linspace(0, 1, 6))
        sides.bands[-1] = np.inf
        try:
            spreads = [[], []]
            for side, pool in enumerate(pools):
                for _ in range(40):
                    spreads[side].append(spread(pool, CITIES, rng, min_gap=gap))
            break
        except RuntimeError:
            if min_depth == 16:
                raise
    counted = [[(c, band_counts(sides, c)) for c in side] for side in spreads]
    a, b = min(((a, b) for a in counted[0] for b in counted[1]), key=lambda pair: np.abs(pair[0][1] - pair[1][1]).sum())
    return [a[0], b[0]]


def pick_capitals(sides, cities):
    """A city of each side on the land mass that holds most of its cities, the pair as
    deep behind the front as possible while at the same distance from it."""
    field = sides.field
    depths = []
    for side in cities:
        masses = field.land_masses[field.at(side)]
        home = masses == np.bincount(masses).argmax()
        depths.append(np.where(home, sides.depths(side), -1e6))
    score = np.minimum(depths[0][:, None], depths[1][None]) - 3 * np.abs(depths[0][:, None] - depths[1][None])
    a, b = np.unravel_index(np.argmax(score), score.shape)
    return [int(a), int(b)]


def near(points, others, gap):
    others = np.asarray(others, float).reshape(-1, 2)
    points = np.asarray(points, float).reshape(-1, 2)
    if not len(others) or not len(points):
        return np.zeros(len(points), bool)
    return cKDTree(others).query(points, distance_upper_bound=gap)[0] < gap


def front_line(sides, side, cities, enemy_cities, enemy, rng):
    """A line along every front, LINE_OFFSET pixels from the enemy's land and about
    LINE_GAP apart (wider where the fronts are longer than LINE_SHARE of the side can
    line), each unit the farthest of random points from those already placed, then every
    gap left filled."""
    field = sides.field
    limit = int(UNITS * LINE_SHARE)
    tolerance = max(1.5, field.px * 0.75)
    band = (
        (sides.side_pix == side) & field.big_land & (field.clear >= 3)
        & (np.abs(sides.to_land[1 - side] - LINE_OFFSET) <= tolerance)
    )
    points = (np.argwhere(band)[:, ::-1] + 0.5) * field.px
    # Off its own cities, and away from the enemy's so that each starts with its side.
    points = points[~near(points, cities, 16) & ~near(points, enemy_cities, 60) & ~near(points, enemy, 40)]
    row = []
    while len(row) < limit and len(points):
        for tries in (40, 600):
            picks = points[rng.integers(0, len(points), tries)]
            gaps = cKDTree(np.array(row)).query(picks)[0] if row else np.full(tries, np.inf)
            best = int(np.argmax(gaps))
            if gaps[best] >= LINE_GAP:
                break
        else:
            break
        row.append(picks[best])
    tree = cKDTree(np.array(row)) if row else None
    for point in points[rng.permutation(len(points))]:
        if len(row) >= limit:
            break
        if tree is None or tree.query(point)[0] >= LINE_GAP:
            row.append(point)
            tree = cKDTree(np.array(row))
    return np.round(np.array(row)).reshape(-1, 2)


def whole(n):
    """Whether n units make whole packs."""
    return n == 0 or n in (3, 5, 6) or n >= 8


def pack_sizes(n, rng):
    """Packs of three and five adding up to n, in random order; n that makes no whole
    packs ends with a smaller one."""
    sizes = []
    while n > 0:
        options = [k for k in GROUP_SIZES if k <= n and whole(n - k)]
        if not options:
            sizes.append(n)
            break
        sizes.append(int(rng.choice(options)))
        n -= sizes[-1]
    return sizes


# A hexagonal grid round a group's centre, nearest spots first.
HEX = sorted(
    ((x + (0.5 if y % 2 else 0), y * np.sqrt(3) / 2) for y in range(-6, 7) for x in range(-6, 7)),
    key=lambda p: (round(p[0] ** 2 + p[1] ** 2, 6), np.arctan2(p[1], p[0])),
)


def groups(sides, side, cities, enemy_cities, taken, enemy, sizes, rng, pool=None):
    """Groups of the given sizes behind the lines, most of them near the front or a city,
    with open ground between them. A group fills the nearest spots of a hexagonal grid
    around its centre that are clear of water, cities, friends and the enemy, so it
    takes the shape of the ground it stands on."""
    if pool is None:
        pool = sides.candidates(side, 6, rng, 60000)
        weight = np.exp(-sides.depths(pool) / 600) + 1.5 * near(pool, cities, 200)
    else:
        weight = np.ones(len(pool))
    weight /= weight.sum()
    placed, centres, members = [], [], np.asarray(taken, float).reshape(-1, 2)
    ring = np.array(HEX, float) * GROUP_GAP
    # Groups keep 30 pixels from other units and GROUP_SPACING between centres, closer
    # where the side runs out of room.
    gap, spacing = 30, GROUP_SPACING

    def grow(centre, size, angle):
        turn = np.array([[np.cos(angle), -np.sin(angle)], [np.sin(angle), np.cos(angle)]])
        spots = np.round(centre + ring @ turn.T)
        ok = sides.valid(spots, side, 3) & ~near(spots, cities, 13) & ~near(spots, enemy_cities, 60) & ~near(spots, members, gap) & ~near(spots, enemy, 60)
        chosen = spots[ok][:size]
        # The group must stay compact: all of it within one and a half rings of a full
        # block of its size.
        reach = np.linalg.norm(ring[min(size, len(ring)) - 1]) + 1.5 * GROUP_GAP
        if len(chosen) < size or np.linalg.norm(chosen - centre, axis=1).max() > reach:
            return None
        return chosen

    # A group with no room splits in two.
    queue = list(sizes)
    while queue:
        size = queue.pop(0)
        found = None
        for _ in range(60):
            # Random spots, most near the front or a city, at least GROUP_SPACING from
            # the other groups: clusters with open ground between them.
            picks = pool[rng.choice(len(pool), 30, p=weight)]
            if centres:
                picks = picks[cKDTree(np.array(centres)).query(picks)[0] >= spacing]
            for centre in picks:
                found = grow(centre, size, rng.uniform(0, np.pi / 3))
                if found is not None:
                    break
            if found is not None:
                break
        if found is None:
            if size == 1:
                if gap <= 25:
                    raise RuntimeError(f"No room for a unit on side {side} after {len(placed)} groups ({len(members)} units)")
                gap, spacing = gap - 1, spacing - 10
                queue = [1] + queue
                continue
            queue = [size - size // 2, size // 2] + queue
            continue
        placed.append(found)
        centres.append(found.mean(0))
        members = np.vstack([members, found])
    return placed


def place_units(sides, cities, enemy_cities, side, enemy, rng):
    """One side's infantry and tanks: front lines, then packs behind them. Also returns
    each unit's pack (-1 in a line), as (infantry, tanks)."""
    line = front_line(sides, side, cities, enemy_cities, enemy, rng)
    sizes = pack_sizes(UNITS - len(line), rng)
    placed = groups(sides, side, cities, enemy_cities, line, enemy, sorted(sizes, reverse=True), rng)
    # A quarter of the line are tanks, as on the game's maps; the rest of the tanks make
    # up whole packs, and the line takes what the packs leave.
    target = TANKS - min(TANKS, round(len(line) / 4))
    tank_packs, in_packs = set(), 0
    for i in rng.permutation(len(placed)):
        if in_packs + len(placed[i]) <= target:
            tank_packs.add(int(i))
            in_packs += len(placed[i])
    line_tanks = set(rng.permutation(len(line))[: TANKS - in_packs].tolist())
    infantry, tanks, infantry_pack, tanks_pack = [], [], [], []
    for i, p in enumerate(line):
        if i in line_tanks:
            tanks.append(p)
            tanks_pack.append(-1)
        else:
            infantry.append(p)
            infantry_pack.append(-1)
    for i, group in enumerate(placed):
        for p in group:
            if i in tank_packs:
                tanks.append(p)
                tanks_pack.append(i)
            else:
                infantry.append(p)
                infantry_pack.append(i)
    packs = [np.array(infantry_pack), np.array(tanks_pack)]
    return np.array(infantry), np.array(tanks), packs, len(line), len(placed)


def hold_cities(sides, cities, units, packs):
    """The engine gives each city to its nearest unit. Where that is an enemy, the nearest
    infantry unit of the side that holds none of its cities, from a line unless none is
    within 400 pixels, moves beside the city (so it stays in the city's supply region),
    until every city starts with its own side."""
    angles = np.linspace(0, 2 * np.pi, 24, endpoint=False)
    for _ in range(5):
        moved = False
        for s in (0, 1):
            mine, theirs = np.vstack(units[s]), np.vstack(units[1 - s])
            own_gap = cKDTree(mine).query(cities[s])[0]
            enemy_gap = cKDTree(theirs).query(cities[s])[0]
            for c, gap in zip(cities[s][own_gap >= enemy_gap], enemy_gap[own_gap >= enemy_gap]):
                mine = np.vstack(units[s])
                for radius in (16, 20, 24, 28):
                    spots = np.round(c + radius * np.c_[np.cos(angles), np.sin(angles)])
                    ok = sides.valid(spots, s, 3) & ~near(spots, mine, 26) & ~near(spots, theirs, 40)
                    ok &= np.linalg.norm(spots - c, axis=1) < gap - 2
                    if ok.any():
                        break
                else:
                    raise RuntimeError(f"No room to hold the city at {c} for side {s}")
                infantry = units[s][0]
                holding = set(cKDTree(mine).query(cities[s])[1].tolist())
                free = np.array([i not in holding for i in range(len(infantry))])
                distance = np.where(free, np.linalg.norm(infantry - c, axis=1), np.inf)
                distance = distance + np.where(packs[s][0] >= 0, 400, 0)
                infantry[int(np.argmin(distance))] = spots[np.flatnonzero(ok)[0]]
                moved = True
        if not moved:
            return


def supply_regions(data):
    """Each side's supply regions at the first payment, from the big-map engine:
    [{"units": unit ids outside a city, "cities": city indices}, ...] a side."""
    exe = PATCHES.with_suffix(".exe") if PATCHES.with_suffix(".exe").exists() else PATCHES
    if not exe.exists():
        subprocess.run(["cargo", "build", "--release", "--manifest-path", str(ROOT / "engine/Cargo.toml"), "-p", "mass-sim", "--bin", "mass-patches"], check=True)
        exe = PATCHES.with_suffix(".exe") if PATCHES.with_suffix(".exe").exists() else PATCHES
    path = OUT / ".regions.rep"
    path.write_bytes(data)
    try:
        report = subprocess.run([str(exe), str(path)], capture_output=True, text=True, check=True).stdout
    finally:
        path.unlink()
    return json.loads(report)["sides"]


def take(members, extra, packs, distance):
    """The units a region gives up, `extra` of them, leaving its packs whole: whole packs
    and two of a five (which leaves a three), farthest from the enemy first, and a line
    unit only for a single one left over. `members` are (kind, index) pairs."""
    by_pack = {}
    for m in members:
        by_pack.setdefault(int(packs[m[0]][m[1]]), []).append(m)
    line = sorted(by_pack.pop(-1, []), key=distance, reverse=True)
    order = sorted(by_pack.values(), key=lambda pack: -min(distance(m) for m in pack))
    fives = [pack for pack in order if len(pack) == 5]
    taken = []
    while extra > 0:
        wanted = None
        if extra in (2, 4) and fives:
            pack = fives.pop(0)
            order.remove(pack)
            pack.sort(key=distance, reverse=True)
            taken.append(pack[:2])
            order.append(pack[2:])
            extra -= 2
            continue
        for pack in order:
            size = len(pack)
            if size <= extra and whole(extra - size) or size == extra:
                wanted = pack
                break
        if wanted is not None:
            order.remove(wanted)
            if wanted in fives:
                fives.remove(wanted)
            taken.append(wanted)
            extra -= len(wanted)
        elif line:
            taken.append([line.pop(0)])
            extra -= 1
        else:
            # Only broken packs are left: any of their units.
            rest = sorted((m for pack in order for m in pack), key=distance, reverse=True)
            taken.append(rest[:extra])
            extra = 0
    return [m for chunk in taken for m in chunk]


def top_up(sides, side, cities, enemy_cities, units, packs, members, movers, count, enemy):
    """Moves `count` pairs of movers into packs of three among `members` (in the region),
    making them packs of five. Returns how many pairs it placed."""
    labels = packs[side]
    where = np.vstack(units[side])
    flat = np.concatenate(labels)
    sizes = np.bincount(flat[flat >= 0])
    threes = sorted({int(labels[k][i]) for k, i in members if labels[k][i] >= 0 and sizes[labels[k][i]] == 3})
    done = 0
    for label in threes:
        if done == count:
            break
        pack = where[flat == label]
        # The pack's middle unit, and its turn on the hexagonal grid.
        centre = pack[np.argmin(((pack[:, None] - pack[None]) ** 2).sum(-1).sum(1))]
        other = next(q for q in pack if np.any(q != centre))
        angle = np.arctan2(*(other - centre)[::-1])
        turns = angle + np.arange(6) * np.pi / 3
        spots = np.round(centre + GROUP_GAP * np.c_[np.cos(turns), np.sin(turns)])
        rest = where[flat != label]
        ok = (
            sides.valid(spots, side, 3) & ~near(spots, cities, 13) & ~near(spots, enemy_cities, 60)
            & ~near(spots, rest, 30) & ~near(spots, enemy, 60) & ~near(spots, pack, 20)
        )
        free = spots[ok]
        if len(free) < 2:
            continue
        for spot in free[:2]:
            kind, index = movers.pop(0)
            units[side][kind][index] = spot
            labels[kind][index] = label
        where = np.vstack(units[side])
        flat = np.concatenate(labels)
        done += 1
    return done


def balance_regions(sides, cities, enemy_cities, units, packs, rng, encode):
    """Moves units until every supply region holds exactly five units a city: whole packs
    from the regions with more (farthest from the enemy first) to new packs near the
    cities of the regions with fewer. Each moved unit keeps its type."""
    for attempt in range(12):
        regions = supply_regions(encode(units))
        moved = 0
        for s in (0, 1):
            first_unit = 0 if s == 0 else len(units[0][0]) + len(units[0][1])
            first_city = 0 if s == 0 else CITIES
            count = len(units[s][0])
            where = lambda uid: (0, uid - first_unit) if uid - first_unit < count else (1, uid - first_unit - count)
            over, under = [], []
            for region in regions[s]:
                n, c = len(region["units"]), len(region["cities"])
                if n > 5 * c:
                    over.append((region, n - 5 * c))
                elif n < 5 * c:
                    under.append((region, 5 * c - n))
            if not over and not under:
                continue
            enemy = cKDTree(np.vstack(units[1 - s]))
            movers = []
            distance = lambda m: enemy.query(units[s][m[0]][m[1]])[0]
            for region, extra in over:
                movers += take([where(uid) for uid in region["units"]], extra, packs[s], distance)
            # Tanks with tanks: the movers in type order, so that most packs are of one kind.
            movers.sort(key=lambda m: m[0])
            next_pack = max(int(packs[s][k].max(initial=-1)) for k in (0, 1)) + 1
            pool = sides.candidates(s, 6, rng, 60000)
            taken = np.vstack(units[s])
            for region, missing in under:
                if not movers:
                    break
                missing = min(missing, len(movers))
                homes = cities[s][[c - first_city for c in region["cities"]]]
                for reach in (150, 300, 600):
                    local = pool[near(pool, homes, reach)]
                    if len(local) >= 20:
                        break
                # Pairs that turn packs of three into fives, where new packs alone would
                # not add up.
                pairs = next(k for k in range(4) if 2 * k <= missing and whole(missing - 2 * k)) if missing != 1 else 0
                if pairs:
                    region_members = [where(uid) for uid in region["units"]]
                    added = top_up(sides, s, cities[s], enemy_cities[s], units, packs, region_members, movers, pairs, np.vstack(units[1 - s]))
                    moved += 2 * added
                    missing -= 2 * added
                    taken = np.vstack(units[s])
                if not missing:
                    continue
                sizes = pack_sizes(missing, rng)
                placed = groups(sides, s, cities[s], enemy_cities[s], taken, np.vstack(units[1 - s]), sizes, rng, pool=local)
                for pack in placed:
                    for spot in pack:
                        kind, index = movers.pop(0)
                        units[s][kind][index] = spot
                        packs[s][kind][index] = next_pack
                        moved += 1
                    next_pack += 1
                taken = np.vstack(units[s])
        if not moved:
            return attempt
        hold_cities(sides, cities, units, packs)
    raise RuntimeError("The supply regions did not settle at five units a city")


def check(cities, units):
    """Every city starts with its own side (the engine gives each city to its nearest unit),
    friends are at least 24 pixels apart and enemies out of reach."""
    everyone = np.vstack([np.vstack(units[0]), np.vstack(units[1])])
    owner = np.array([0] * sum(len(u) for u in units[0]) + [1] * sum(len(u) for u in units[1]))
    tree = cKDTree(everyone)
    for s in (0, 1):
        assert sum(len(u) for u in units[s]) == UNITS and len(units[s][1]) == TANKS
        nearest = owner[tree.query(cities[s])[1]]
        assert (nearest == s).all(), f"A city of side {s} starts with the other side"
        mine = everyone[owner == s]
        gaps = cKDTree(mine).query(mine, k=2)[0][:, 1]
        assert gaps.min() >= 24, f"Side {s} has units {gaps.min():.1f} apart"
    enemy = cKDTree(everyone[owner == 1]).query(everyone[owner == 0])[0].min()
    assert enemy >= 38, f"Enemies start {enemy:.1f} apart"
    return enemy


def picture(path, sides, cities, capitals, units):
    """The layout at 960x540: each side's land tinted, units as dots, cities in yellow."""
    field = sides.field
    width, height = 960, 540
    scale = width / field.W
    terrain = np.array(field.surface.resize((width, height), Image.NEAREST), float)
    side = np.array(Image.fromarray(sides.side_pix.astype(np.uint8)).resize((width, height), Image.NEAREST))
    land = np.array(Image.fromarray((field.terrain != WATER).astype(np.uint8)).resize((width, height), Image.NEAREST)) > 0
    tint = np.where(side[..., None] == 0, [70, 110, 255], [255, 90, 70])
    terrain[land] = terrain[land] * 0.6 + tint[land] * 0.4
    image = Image.fromarray(terrain.astype(np.uint8))
    draw = ImageDraw.Draw(image)
    colors = [(0, 0, 150), (160, 0, 0)]
    for s in (0, 1):
        for kind in units[s]:
            for x, y in kind:
                draw.rectangle((x * scale - 1, y * scale - 1, x * scale, y * scale), fill=colors[s])
        for i, (x, y) in enumerate(cities[s]):
            r = 5 if i == capitals[s] else 1.5
            draw.ellipse((x * scale - r, y * scale - r, x * scale + r, y * scale + r), fill=(255, 255, 0), outline=(0, 0, 0))
    image.save(path, "WEBP", quality=85, method=6)


def build(layout, field, spec):
    rng = np.random.default_rng(layout["seed"])
    side = province_split(field, layout["provinces"], rng)
    sides = Sides(field, side)
    cities = place_cities(sides, rng)
    capitals = pick_capitals(sides, cities)
    units, packs, shape = [], [], []
    for s in (0, 1):
        enemy = np.vstack(units[0]) if s == 1 else np.zeros((0, 2))
        infantry, tanks, pack_of, line, group_count = place_units(sides, cities[s], cities[1 - s], s, enemy, rng)
        units.append((infantry, tanks))
        packs.append(pack_of)
        shape.append((line, group_count))
    hold_cities(sides, cities, units, packs)
    png = io.BytesIO()
    field.surface.quantize(palette=palette_image(), dither=Image.Dither.NONE).save(png, "PNG", optimize=True, bits=8)
    surface = base64.b64encode(png.getvalue()).decode()
    as_list = lambda points: [[int(x), int(y)] for x, y in points]

    def encode(units):
        root = {
            "version": "1.4.1",
            "mode": "1v1",
            "map": {
                "map_surface": surface,
                "size": list(spec["size"]),
                "infantry": [as_list(units[s][0]) for s in (0, 1)],
                "tanks": [as_list(units[s][1]) for s in (0, 1)],
                "cities": as_list(np.vstack(cities)),
                "capitals": [capitals[0], CITIES + capitals[1]],
                "bridges": [],
            },
            "end": 0,
            "player_usernames": [["Blue"], ["Red"]],
        }
        return gzip.compress(json.dumps(root, separators=(",", ":")).encode(), mtime=0)

    passes = balance_regions(sides, cities, [cities[1], cities[0]], units, packs, rng, encode)
    regions = supply_regions(encode(units))
    for s in (0, 1):
        counts = [(len(r["units"]), len(r["cities"])) for r in regions[s] if r["units"] or r["cities"]]
        assert all(n == 5 * c for n, c in counts), f"Side {s} has regions {counts}"
    gap = check(cities, units)

    print(f"  supply regions (units, cities) after {passes} passes: " + "; ".join(
        str(sorted(((len(r["units"]), len(r["cities"])) for r in regions[s] if r["units"] or r["cities"]), reverse=True)) for s in (0, 1)))
    for s in (0, 1):
        labels = np.concatenate(packs[s])
        sizes = np.bincount(labels[labels >= 0])
        counts = {int(k): int(n) for k, n in zip(*np.unique(sizes[sizes > 0], return_counts=True))}
        print(f"  side {s}: {int((labels < 0).sum())} units in lines, packs by size {counts}")
    print(f"{layout['id']}: closest enemies {gap:.0f} px, line units and groups {shape}, capital depth "
          f"{[round(sides.depth(cities[s][capitals[s]])) for s in (0, 1)]}")
    for s in (0, 1):
        mine = side == s
        print(f"  side {s}: land {(field.land & mine).sum() * field.cell ** 2:>9}  cities by depth {band_counts(sides, cities[s]).tolist()}"
              f"  terrain {' '.join(f'{n} {m:.2f}' for n, m in zip(NAMES, field.mix(mine)) if m >= 0.005)}")

    data = encode(units)
    assert len(data) <= 1 << 20, f"The replay is {len(data)} bytes, more than a match room takes"
    (OUT / f"{layout['id']}.rep").write_bytes(data)
    picture(OUT / f"{layout['id']}.webp", sides, cities, capitals, units)
    print(f"  replay {len(data) // 1024} KB")


def palette_image():
    """A palette image of the terrain colours, for an 8-bit paletted picture (the engine
    reads 8-bit PNGs only)."""
    palette = Image.new("P", (1, 1))
    palette.putpalette([c for color in COLORS for c in color] + [0] * (768 - 3 * len(COLORS)))
    return palette


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--game", default=r"C:\Program Files (x86)\Steam\steamapps\common\War of Dots")
    parser.add_argument("--only")
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    loaded = {}
    for layout in LAYOUTS:
        if args.only and layout["id"] != args.only:
            continue
        if layout["map"] not in loaded:
            loaded[layout["map"]] = Field(Path(args.game), MAPS[layout["map"]])
        build(layout, loaded[layout["map"]], MAPS[layout["map"]])
    index = [
        {"id": spec_id, "name": spec["name"], "layouts": [
            {"id": l["id"], "name": l["name"], "about": l["about"]} for l in LAYOUTS if l["map"] == spec_id
        ]}
        for spec_id, spec in MAPS.items()
    ]
    (OUT / "index.json").write_text(json.dumps(index, indent=2) + "\n")


if __name__ == "__main__":
    main()
