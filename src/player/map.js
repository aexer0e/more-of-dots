export function prepareMap(source, size, cities, alreadyRendered) {
  const canvas = new OffscreenCanvas(...size);
  [canvas.width, canvas.height] = size;
  const context = canvas.getContext("2d");
  context.imageSmoothingEnabled = false;
  context.drawImage(source, 0, 0, ...size);
  if (!alreadyRendered) {
    const half = [2, 4, 6, 7, 7, 8, 8, 9, 9, 9, 9, 8, 8, 7, 7, 6, 4, 2];
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
