// Translation is measured in fitted map widths/heights. Keep the map covering
// its original viewport and preserve the point under the pointer when zooming.
export function zoomView(view, anchor, factor) {
  const zoom = Math.max(1, Math.min(6, view.zoom * factor));
  const ratio = zoom / view.zoom;
  const shift = (offset, point) => Math.max(1 - zoom, Math.min(0, point - (point - offset) * ratio));
  return { zoom, x: shift(view.x, anchor[0]), y: shift(view.y, anchor[1]) };
}
