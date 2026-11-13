// Front lines for the big maps, off the page's thread: with thousands of units they take
// tens of milliseconds, which would stall the battlefield every time the territory's
// outlines change. The page sends the outlines and the units (position, side, health,
// ship) as typed arrays; the lines come back with the request's number.
import { frontLines } from "../player/frontline.js";

self.onmessage = ({ data }) => {
  const { id, contours, mapSize, positions, sides, health, ships } = data;
  const dots = Array.from({ length: sides.length }, (_, i) => ({
    position: [positions[2 * i], positions[2 * i + 1]],
    color: sides[i],
    health: health[i],
    ship: !!ships[i],
  }));
  postMessage({ id, lines: frontLines(contours, dots, mapSize) });
};
