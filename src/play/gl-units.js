// The big maps' units and bars on the GPU, in a canvas of their own stacked between the
// page's other layers. Built to stay light on integrated graphics:
//
// - The units are uploaded only when a new frame arrives, with where the previous frame
//   had them; the shader moves them between the two, so a repaint between frames costs
//   two uniforms and one draw call.
// - Every sprite and bar of a frame is one instance of that single draw call, in the
//   canvas's order, so they overlap as they would on the canvas.
// - A unit whose two passes (the game draws every unit twice) look the same is one
//   instance, drawn twice over in the shader, which composites exactly as two draws.
// - A unit's four bar rectangles are one instance, worked out in the shader with
//   edges smoothed as the canvas smooths them.
// - The sprites are layers of a mipmapped texture array, so a unit a few pixels across
//   reads a few texels; there is no multisampling.

const LAYER = 256; // each sprite fills a layer of LAYER x LAYER pixels
const FLOATS = 16; // an instance: from x, y, to x, y, offset x, y, width, height,
// direction x, y, sprite, flags, alpha, health, morale, unused
export const FLIP = 1,
  DARK = 2,
  TWICE = 4,
  BARS = 8,
  HEALTH = 16,
  MORALE = 32;

const VERTEX = `#version 300 es
in vec2 corner;
in vec4 route;
in vec4 shape;
in vec4 turn;
in vec4 extra;
uniform vec4 view;
uniform vec2 screen;
out vec3 uv;
out vec2 local;
flat out int flags;
flat out vec3 info;
void main() {
  flags = int(turn.w);
  vec2 centre = mix(route.xy, route.zw, view.w) + shape.xy;
  vec2 world;
  if ((flags & ${BARS}) != 0) {
    // The bars span x -14.4 to 14.4 and y -22.8 to -10.8; a pixel of room for the edges.
    vec2 size = vec2(30.0, 14.0) + 2.0 / view.x;
    local = corner * size + vec2(0.0, -17.0);
    world = centre + local;
    uv = vec3(0.0);
  } else {
    vec2 size = shape.zw * vec2(1.0, (flags & ${FLIP}) != 0 ? -1.0 : 1.0);
    vec2 l = corner * size;
    world = centre + vec2(turn.x * l.x - turn.y * l.y, turn.y * l.x + turn.x * l.y);
    uv = vec3(corner + 0.5, turn.z);
    local = vec2(0.0);
  }
  vec2 at = world * view.x + view.yz;
  gl_Position = vec4(at.x / screen.x * 2.0 - 1.0, 1.0 - at.y / screen.y * 2.0, 0.0, 1.0);
  info = extra.xyz;
}`;

const FRAGMENT = `#version 300 es
precision highp float;
uniform mediump sampler2DArray sprites;
in vec3 uv;
in vec2 local;
flat in int flags;
flat in vec3 info;
out vec4 color;
// How much of this pixel the rectangle from r.xy to r.zw covers.
float box(vec2 p, vec4 r, vec2 px) {
  vec2 inside = clamp(min(p - r.xy, r.zw - p) / px + 0.5, 0.0, 1.0);
  vec2 thin = clamp((r.zw - r.xy) / px, 0.0, 1.0);
  return min(inside.x, thin.x) * min(inside.y, thin.y);
}
void main() {
  if ((flags & ${BARS}) != 0) {
    vec2 px = max(fwidth(local), vec2(1e-4));
    bool health = (flags & ${HEALTH}) != 0, morale = (flags & ${MORALE}) != 0;
    float top = health && morale ? -22.8 : -20.8, bottom = health && morale ? -10.8 : -12.8;
    float cover = box(local, vec4(-14.4, top, 14.4, bottom), px);
    vec3 rgb = mix(vec3(0.0), vec3(0.3), box(local, vec4(-12.0, top + 2.0, 12.0, bottom - 2.0), px));
    if (morale)
      rgb = mix(rgb, vec3(0.0, 1.0, 0.94), box(local, vec4(-12.0, bottom - 6.0, -12.0 + 24.0 * max(0.0, info.z) / 100.0, bottom - 2.0), px));
    if (health) {
      float f = info.y;
      vec3 fill = f > 0.5 ? vec3(0.0, 1.0, 0.0) : f > 0.15 ? vec3(1.0, 1.0, 0.0) : vec3(1.0, 0.498, 0.314);
      rgb = mix(rgb, fill, box(local, vec4(-12.0, top + 2.0, -12.0 + 24.0 * f, top + 6.0), px));
    }
    color = vec4(rgb * cover, cover);
    return;
  }
  vec4 texel = texture(sprites, uv);
  if ((flags & ${DARK}) != 0) texel.rgb *= 0.5;
  // Drawn twice over: c + c * (1 - a), premultiplied.
  if ((flags & ${TWICE}) != 0) texel *= 2.0 - texel.a;
  color = texel * info.x;
}`;

export class UnitLayer {
  /** A layer drawing into `canvas`, for the sprites `names`; null where WebGL 2 is
   * missing. */
  static create(canvas, names) {
    try {
      const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, alpha: true, antialias: false, depth: false, stencil: false });
      return gl ? new UnitLayer(canvas, gl, names) : null;
    } catch {
      return null;
    }
  }

  constructor(canvas, gl, names) {
    this.canvas = canvas;
    this.gl = gl;
    this.names = names;
    this.data = new Float32Array(FLOATS * 8192);
    this.n = 0;
    this.uploaded = 0;
    this.done = new Set();
    const shader = (type, source) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, source);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const program = gl.createProgram();
    gl.attachShader(program, shader(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    this.program = program;
    this.view = gl.getUniformLocation(program, "view");
    this.screen = gl.getUniformLocation(program, "screen");
    gl.uniform1i(gl.getUniformLocation(program, "sprites"), 0);

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]), gl.STATIC_DRAW);
    const corner = gl.getAttribLocation(program, "corner");
    gl.enableVertexAttribArray(corner);
    gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);
    this.instances = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instances);
    ["route", "shape", "turn", "extra"].forEach((name, k) => {
      const location = gl.getAttribLocation(program, name);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, 4, gl.FLOAT, false, FLOATS * 4, k * 16);
      gl.vertexAttribDivisor(location, 1);
    });

    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.texture);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, Math.log2(LAYER) + 1, gl.RGBA8, LAYER, LAYER, names.length);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  /** Starts a new set of instances. */
  begin() {
    this.n = 0;
  }

  push(fx, fy, tx, ty, ox, oy, width, height, dx, dy, sprite, flags, alpha, health, morale) {
    if ((this.n + 1) * FLOATS > this.data.length) {
      const grown = new Float32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    const d = this.data,
      i = this.n++ * FLOATS;
    d[i] = fx;
    d[i + 1] = fy;
    d[i + 2] = tx;
    d[i + 3] = ty;
    d[i + 4] = ox;
    d[i + 5] = oy;
    d[i + 6] = width;
    d[i + 7] = height;
    d[i + 8] = dx;
    d[i + 9] = dy;
    d[i + 10] = sprite;
    d[i + 11] = flags;
    d[i + 12] = alpha;
    d[i + 13] = health;
    d[i + 14] = morale;
  }

  /** A sprite (an index into `names`) moving from `from` to `to`, moved by `offset`. */
  sprite(sprite, from, to, offset, [width, height], direction, flags, alpha = 1) {
    if (sprite < 0) return;
    this.push(from[0], from[1], to[0], to[1], offset[0], offset[1], width, height, direction[0], direction[1], sprite, flags, alpha, 0, 0);
  }

  /** A unit's bars (see barRects in overlays.js): `flags` holds HEALTH and MORALE. */
  bars(from, to, health, morale, flags) {
    this.push(from[0], from[1], to[0], to[1], 0, 0, 0, 0, 1, 0, 0, BARS | flags, 1, health, morale);
  }

  /** Sends the instances to the GPU. */
  end() {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instances);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.subarray(0, this.n * FLOATS), gl.DYNAMIC_DRAW);
    this.uploaded = this.n;
  }

  /** Uploads the sprites among `sources` (a Map of name to image) not uploaded yet. */
  load(sources) {
    if (this.done.size === this.names.length) return;
    const gl = this.gl;
    let added = 0;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    this.names.forEach((name, index) => {
      const source = sources.get(name);
      if (!source || this.done.has(name)) return;
      // Each sprite fills its square layer; the quad gives it its own proportions back.
      const square = new OffscreenCanvas(LAYER, LAYER),
        context = square.getContext("2d");
      context.imageSmoothingQuality = "high";
      context.drawImage(source, 0, 0, LAYER, LAYER);
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, index, LAYER, LAYER, 1, gl.RGBA, gl.UNSIGNED_BYTE, square);
      this.done.add(name);
      added++;
    });
    if (added) gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
  }

  /** Draws the instances, `between` of the way from where they were to where they are,
   * where a map point x, y lands at x * scale + left, y * scale + top of the canvas,
   * inside the rectangle `clip` ([x, y, width, height] from the canvas's top left). */
  draw(sources, scale, left, top, between, clip) {
    const gl = this.gl,
      { width, height } = this.canvas;
    this.load(sources);
    gl.viewport(0, 0, width, height);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(clip[0], height - clip[1] - clip[3], clip[2], clip[3]);
    if (!this.uploaded) return;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.texture);
    gl.uniform4f(this.view, scale, left, top, between);
    gl.uniform2f(this.screen, width, height);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.uploaded);
  }
}
