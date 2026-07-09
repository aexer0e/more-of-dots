import { CANVAS_HEIGHT, CANVAS_WIDTH, TERRAIN_PALETTE } from './constants';
import type { Bridge, Point } from './types';

export function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

export function rgbToHex(red: number, green: number, blue: number) {
  return `#${[red, green, blue].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

export function nearestTerrainHex(hex: string) {
  const [red, green, blue] = hexToRgb(hex);
  let best = TERRAIN_PALETTE[0];
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const terrain of TERRAIN_PALETTE) {
    const [terrainRed, terrainGreen, terrainBlue] = hexToRgb(terrain);
    const distance =
      (red - terrainRed) * (red - terrainRed) +
      (green - terrainGreen) * (green - terrainGreen) +
      (blue - terrainBlue) * (blue - terrainBlue);

    if (distance < bestDistance) {
      best = terrain;
      bestDistance = distance;
    }
  }

  return best;
}

export function quantizeCanvasContext(context: CanvasRenderingContext2D, width = CANVAS_WIDTH, height = CANVAS_HEIGHT) {
  const image = context.getImageData(0, 0, width, height);
  const { data } = image;

  for (let index = 0; index < data.length; index += 4) {
    const snapped = hexToRgb(nearestTerrainHex(rgbToHex(data[index], data[index + 1], data[index + 2])));
    data[index] = snapped[0];
    data[index + 1] = snapped[1];
    data[index + 2] = snapped[2];
    data[index + 3] = 255;
  }

  context.putImageData(image, 0, 0);
}

export function floodFillContext(context: CanvasRenderingContext2D, sx: number, sy: number, hex: string) {
  const image = context.getImageData(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  const { data } = image;
  const startIndex = (sy * CANVAS_WIDTH + sx) * 4;
  const target = [data[startIndex], data[startIndex + 1], data[startIndex + 2], data[startIndex + 3]];
  const fill = hexToRgb(nearestTerrainHex(hex));

  if (target[0] === fill[0] && target[1] === fill[1] && target[2] === fill[2] && target[3] === 255) {
    return false;
  }

  const stack: Point[] = [[sx, sy]];

  while (stack.length > 0) {
    const [x, y] = stack.pop() as Point;
    if (x < 0 || y < 0 || x >= CANVAS_WIDTH || y >= CANVAS_HEIGHT) {
      continue;
    }

    const index = (y * CANVAS_WIDTH + x) * 4;
    if (
      data[index] !== target[0] ||
      data[index + 1] !== target[1] ||
      data[index + 2] !== target[2] ||
      data[index + 3] !== target[3]
    ) {
      continue;
    }

    data[index] = fill[0];
    data[index + 1] = fill[1];
    data[index + 2] = fill[2];
    data[index + 3] = 255;

    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }

  context.putImageData(image, 0, 0);
  return true;
}

export function drawDot(context: CanvasRenderingContext2D, point: { x: number; y: number }, size: number, color: string) {
  const diameter = Math.max(1, Math.round(size));
  const left = Math.round(point.x - diameter / 2);
  const top = Math.round(point.y - diameter / 2);
  const radius = diameter / 2;
  const radiusSquared = radius * radius;
  context.fillStyle = color;

  for (let y = 0; y < diameter; y += 1) {
    for (let x = 0; x < diameter; x += 1) {
      const dx = x + 0.5 - radius;
      const dy = y + 0.5 - radius;
      if (dx * dx + dy * dy <= radiusSquared) {
        context.fillRect(left + x, top + y, 1, 1);
      }
    }
  }
}

export function drawCircleOutline(context: CanvasRenderingContext2D, point: { x: number; y: number }, size: number, color: string) {
  const diameter = Math.max(1, Math.round(size));
  const left = Math.round(point.x - diameter / 2);
  const top = Math.round(point.y - diameter / 2);
  const radius = diameter / 2;
  const outerRadiusSquared = radius * radius;
  const innerRadius = Math.max(0, radius - 1);
  const innerRadiusSquared = innerRadius * innerRadius;

  context.fillStyle = color;

  for (let y = 0; y < diameter; y += 1) {
    for (let x = 0; x < diameter; x += 1) {
      const dx = x + 0.5 - radius;
      const dy = y + 0.5 - radius;
      const distanceSquared = dx * dx + dy * dy;

      if (distanceSquared <= outerRadiusSquared && distanceSquared >= innerRadiusSquared) {
        context.fillRect(left + x, top + y, 1, 1);
      }
    }
  }
}

export function drawSegment(
  context: CanvasRenderingContext2D,
  start: { x: number; y: number },
  end: { x: number; y: number },
  size: number,
  color: string,
) {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const steps = Math.max(Math.abs(deltaX), Math.abs(deltaY), 1);

  for (let index = 0; index <= steps; index += 1) {
    const t = index / steps;
    drawDot(
      context,
      {
        x: Math.round(start.x + deltaX * t),
        y: Math.round(start.y + deltaY * t),
      },
      size,
      color,
    );
  }
}

export function drawRect(
  context: CanvasRenderingContext2D,
  start: { x: number; y: number },
  end: { x: number; y: number },
  color: string,
  filled = true,
) {
  const x = Math.min(Math.round(start.x), Math.round(end.x));
  const y = Math.min(Math.round(start.y), Math.round(end.y));
  const width = Math.abs(Math.round(end.x) - Math.round(start.x)) + 1;
  const height = Math.abs(Math.round(end.y) - Math.round(start.y)) + 1;

  context.fillStyle = color;

  if (filled) {
    context.fillRect(x, y, width, height);
    return;
  }

  for (let currentX = x; currentX < x + width; currentX += 1) {
    context.fillRect(currentX, y, 1, 1);
    context.fillRect(currentX, y + height - 1, 1, 1);
  }

  for (let currentY = y; currentY < y + height; currentY += 1) {
    context.fillRect(x, currentY, 1, 1);
    context.fillRect(x + width - 1, currentY, 1, 1);
  }
}

function cubicAt(start: number, controlA: number, controlB: number, end: number, t: number) {
  const inverse = 1 - t;
  return (
    inverse * inverse * inverse * start +
    3 * inverse * inverse * t * controlA +
    3 * inverse * t * t * controlB +
    t * t * t * end
  );
}

export function sampleClosedBezierShape(points: Point[], samplesPerSegment = 18) {
  if (points.length < 3) {
    return [...points];
  }

  const sampled: Point[] = [];

  for (let index = 0; index < points.length; index += 1) {
    const p0 = points[(index - 1 + points.length) % points.length];
    const p1 = points[index];
    const p2 = points[(index + 1) % points.length];
    const p3 = points[(index + 2) % points.length];

    const controlA: Point = [
      p1[0] + (p2[0] - p0[0]) / 6,
      p1[1] + (p2[1] - p0[1]) / 6,
    ];
    const controlB: Point = [
      p2[0] - (p3[0] - p1[0]) / 6,
      p2[1] - (p3[1] - p1[1]) / 6,
    ];

    for (let sample = 0; sample < samplesPerSegment; sample += 1) {
      const t = sample / samplesPerSegment;
      sampled.push([
        Math.round(cubicAt(p1[0], controlA[0], controlB[0], p2[0], t)),
        Math.round(cubicAt(p1[1], controlA[1], controlB[1], p2[1], t)),
      ]);
    }
  }

  return sampled;
}

export function fillPolygonPixels(context: CanvasRenderingContext2D, points: Point[], color: string) {
  if (points.length < 3) {
    return;
  }

  const minY = Math.max(0, Math.floor(Math.min(...points.map((point) => point[1]))));
  const maxY = Math.min(CANVAS_HEIGHT - 1, Math.ceil(Math.max(...points.map((point) => point[1]))));

  context.fillStyle = color;

  for (let y = minY; y <= maxY; y += 1) {
    const scanY = y + 0.5;
    const intersections: number[] = [];

    for (let index = 0; index < points.length; index += 1) {
      const start = points[index];
      const end = points[(index + 1) % points.length];

      if ((start[1] <= scanY && end[1] > scanY) || (end[1] <= scanY && start[1] > scanY)) {
        const ratio = (scanY - start[1]) / (end[1] - start[1]);
        intersections.push(start[0] + (end[0] - start[0]) * ratio);
      }
    }

    intersections.sort((left, right) => left - right);

    for (let index = 0; index < intersections.length - 1; index += 2) {
      const x1 = Math.max(0, Math.ceil(intersections[index]));
      const x2 = Math.min(CANVAS_WIDTH - 1, Math.floor(intersections[index + 1]));
      if (x2 >= x1) {
        context.fillRect(x1, y, x2 - x1 + 1, 1);
      }
    }
  }
}

export function strokePolygonPixels(context: CanvasRenderingContext2D, points: Point[], color: string, size = 1) {
  if (points.length < 2) {
    return;
  }

  for (let index = 0; index < points.length; index += 1) {
    const start = points[index];
    const end = points[(index + 1) % points.length];
    drawSegment(
      context,
      { x: start[0], y: start[1] },
      { x: end[0], y: end[1] },
      size,
      color,
    );
  }
}

export function canvasPointFromEvent(canvas: HTMLCanvasElement, event: { clientX: number; clientY: number }) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: Math.round((event.clientX - rect.left) * (canvas.width / rect.width)),
    y: Math.round((event.clientY - rect.top) * (canvas.height / rect.height)),
  };
}

export function pointToSegmentDistance(px: number, py: number, x1: number, y1: number, x2: number, y2: number) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy || 1;
  let t = ((px - x1) * dx + (py - y1) * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

export function bridgeEndpoints(bridge: Bridge) {
  return bridge;
}

export async function loadImageFromFile(file: File) {
  const objectUrl = URL.createObjectURL(file);

  try {
    const image = new Image();
    image.src = objectUrl;
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('Unable to read the image file.'));
    });
    return image;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export async function loadImageFromBase64(base64: string) {
  const image = new Image();
  image.src = `data:image/png;base64,${base64}`;
  await new Promise<void>((resolve) => {
    image.onload = () => resolve();
    image.onerror = () => resolve();
  });
  return image;
}