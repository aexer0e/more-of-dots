// The map picture at the battlefield's size, with the cities drawn in. A battlefield
// wider than MAX_WIDTH (the site's big maps) gets a smaller picture, which the
// renderers stretch over it: a canvas of the full 9600x5400 would take 200 MB.
const MAX_WIDTH = 4800;

export function prepareMap(source, size, cities, alreadyRendered) {
  const scale = Math.min(1, MAX_WIDTH / size[0]),
    [width, height] = size.map((side) => Math.round(side * scale));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  context.imageSmoothingEnabled = false;
  context.drawImage(source, 0, 0, width, height);
  if (!alreadyRendered) {
    const half = [2, 4, 6, 7, 7, 8, 8, 9, 9, 9, 9, 8, 8, 7, 7, 6, 4, 2];
    context.scale(scale, scale);
    context.fillStyle = "#ffff00";
    for (const [x, y] of cities)
      for (let row = 0; row < 18; row++)
        context.fillRect(
          Math.trunc(x) - half[row],
          Math.trunc(y) + row - 9,
          half[row] * 2,
          1,
        );
  }
  return canvas;
}
