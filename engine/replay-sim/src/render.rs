//! The presentation renderer, drawn on the CPU so every platform produces the same
//! pixels without a window or GPU. It accepts artwork and drawing primitives; no
//! game binary or modules exist here. The render worker and the video exporter
//! share it, so both produce identical frames.

use crate::text;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, Write};
use tiny_skia::{
    BlendMode, FillRule, FilterQuality, LineCap, LineJoin, Mask, Paint, PathBuilder, Pixmap, PixmapPaint, Rect, Stroke, Transform,
};

#[derive(Clone, Debug)]
pub enum Draw {
    Image { name: String, position: [f64; 2], size: [f64; 2], alpha: f64, direction: [f64; 2], screen: bool, flip_y: bool },
    Text { name: String, text: String, position: [f64; 2], color: [i32; 3], fix: String, font_size: i32, outline: f64 },
    Circle { position: [f64; 2], radius: f64, color: [f64; 4] },
    Polygon { points: Vec<[f64; 2]>, color: [f64; 4] },
    Line { points: Vec<[f64; 2]>, color: [f64; 4], width: f64 },
}

pub struct Request {
    pub width: usize,
    pub height: usize,
    pub map_size: [f64; 2],
    pub draws: Vec<Draw>,
}

struct View {
    width: usize,
    height: usize,
    view_width: i32,
    view_height: i32,
    scale: f64,
    map: [f64; 2],
    world: Transform,
    clip: Mask,
}

impl View {
    fn new(width: usize, height: usize, map: [f64; 2]) -> View {
        let scale = (width as f64 / map[0]).min(height as f64 / map[1]);
        let view_width = (map[0] * scale) as i32;
        let view_height = (map[1] * scale) as i32;
        // The viewport is centred as OpenGL placed it: offsets round towards the left and bottom.
        let left = (width as i32 - view_width) / 2;
        let top = height as i32 - view_height - (height as i32 - view_height) / 2;
        let world = Transform::from_row((view_width as f64 / map[0]) as f32, 0.0, 0.0, (view_height as f64 / map[1]) as f32, left as f32, top as f32);
        let mut clip = Mask::new(width as u32, height as u32).expect("a non-empty frame");
        if let Some(rect) = Rect::from_xywh(left as f32, top as f32, view_width as f32, view_height as f32) {
            clip.fill_path(&PathBuilder::from_rect(rect), FillRule::Winding, false, Transform::identity());
        }
        View { width, height, view_width, view_height, scale, map, world, clip }
    }
}

pub struct Surface {
    pixmap: Pixmap,
    textures: HashMap<String, Pixmap>,
    text_cache: HashMap<String, (String, usize, usize)>,
    background: Option<(String, Vec<u8>)>,
    map_version: u64,
    view: Option<View>,
    rgb: Vec<u8>,
}

fn color(value: [f64; 4]) -> tiny_skia::Color {
    let channel = |v: f64| ((v as f32) * 255.0).round_ties_even().clamp(0.0, 255.0) as u8;
    tiny_skia::Color::from_rgba8(channel(value[0]), channel(value[1]), channel(value[2]), channel(value[3]))
}

impl Surface {
    pub fn new(width: usize, height: usize) -> Surface {
        Surface {
            pixmap: Pixmap::new(width as u32, height as u32).expect("a non-empty frame"),
            textures: HashMap::new(),
            text_cache: HashMap::new(),
            background: None,
            map_version: 0,
            view: None,
            rgb: Vec::new(),
        }
    }

    pub fn width(&self) -> usize {
        self.pixmap.width() as usize
    }

    pub fn height(&self) -> usize {
        self.pixmap.height() as usize
    }

    pub fn texture(&mut self, name: &str, png: &[u8]) -> Result<(), String> {
        let pixmap = Pixmap::decode_png(png).map_err(|_| "Cannot decode artwork".to_string())?;
        self.set_texture(name, pixmap);
        Ok(())
    }

    pub fn set_texture(&mut self, name: &str, pixmap: Pixmap) {
        if name == "map" {
            self.map_version += 1;
        }
        self.textures.insert(name.to_string(), pixmap);
    }

    /// Draws a request and returns top-down RGB24 that the next call reuses.
    pub fn render(&mut self, request: &Request) -> &[u8] {
        let (width, height) = (request.width, request.height);
        if width != self.width() || height != self.height() {
            self.pixmap = Pixmap::new(width as u32, height as u32).expect("a non-empty frame");
            self.background = None;
        }
        let stale = !matches!(&self.view, Some(v) if v.width == width && v.height == height && v.map == request.map_size);
        if stale {
            self.view = Some(View::new(width, height, request.map_size));
        }
        let view = self.view.take().unwrap();
        let mut skip = 0;
        // Every frame starts with the same scaled map, so it is drawn once and copied after that.
        if let Some(first @ Draw::Image { name, alpha, screen: false, .. }) = request.draws.first() {
            if name == "map" && *alpha == 1.0 {
                let key = format!("{width}x{height}:{}:{first:?}", self.map_version);
                match &self.background {
                    Some((cached, pixels)) if *cached == key => self.pixmap.data_mut().copy_from_slice(pixels),
                    _ => {
                        self.pixmap.fill(tiny_skia::Color::BLACK);
                        self.draw(first, &view);
                        self.background = Some((key, self.pixmap.data().to_vec()));
                    }
                }
                skip = 1;
            }
        }
        if skip == 0 {
            self.pixmap.fill(tiny_skia::Color::BLACK);
        }
        for draw in &request.draws[skip..] {
            self.draw(draw, &view);
        }
        self.view = Some(view);
        // The canvas is opaque black underneath, so premultiplied colour is the final colour.
        self.rgb.resize(width * height * 3, 0);
        for (rgb, rgba) in self.rgb.chunks_exact_mut(3).zip(self.pixmap.data().chunks_exact(4)) {
            rgb.copy_from_slice(&rgba[..3]);
        }
        &self.rgb
    }

    fn draw(&mut self, draw: &Draw, view: &View) {
        let map = view.map;
        let (width, height) = (view.width as f64, view.height as f64);
        let (vw, vh) = (view.view_width as f64, view.view_height as f64);
        match draw {
            Draw::Image { .. } | Draw::Text { .. } => {
                let (name, mut pos, mut size, alpha, direction, screen, flipped) = match draw {
                    Draw::Image { name, position, size, alpha, direction, screen, flip_y } => (name.as_str(), *position, *size, *alpha, *direction, *screen, *flip_y),
                    Draw::Text { name, text, position, color, fix, font_size, outline } => {
                        let signature = format!("{text}\u{0}{color:?}{font_size}{outline}{position:?}{fix}");
                        let cached = match self.text_cache.get(name.as_str()) {
                            Some(cached) if cached.0 == signature => (cached.1, cached.2),
                            _ => {
                                let raster = text::rasterize(text, *color, *font_size, *outline);
                                let pixmap = straight_to_pixmap(&raster.rgba, raster.width, raster.height);
                                self.textures.insert(name.clone(), pixmap);
                                self.text_cache.insert(name.clone(), (signature, raster.width, raster.height));
                                (raster.width, raster.height)
                            }
                        };
                        let size = [cached.0 as f64 * map[0] / 1920.0, cached.1 as f64 * map[1] / 1080.0];
                        let mut pos = [position[0] * map[0], (1.0 - position[1]) * map[1]];
                        if fix == "left" {
                            pos[0] += size[0] * 0.5;
                        }
                        if fix == "right" {
                            pos[0] -= size[0] * 0.5;
                        }
                        (name.as_str(), pos, size, 1.0, [1.0, 0.0], false, false)
                    }
                    _ => unreachable!(),
                };
                if screen {
                    pos = [(pos[0] - (width - vw) / 2.0) / view.scale, (pos[1] - (height - vh) / 2.0) / view.scale];
                    size = [size[0] * (1.0 / view.scale), size[1] * (1.0 / view.scale)];
                }
                let Some(texture) = self.textures.get(name) else { return };
                let perp = [-direction[1], direction[0]];
                // Flipped images run their rows against the perpendicular, as the player's units do.
                let sign = if flipped { -1.0 } else { 1.0 };
                let (tw, th) = (texture.width() as f64, texture.height() as f64);
                let ux = direction[0] * size[0] / tw;
                let uy = direction[1] * size[0] / tw;
                let vx = perp[0] * sign * size[1] / th;
                let vy = perp[1] * sign * size[1] / th;
                let tx = pos[0] - (direction[0] * size[0] + perp[0] * sign * size[1]) * 0.5;
                let ty = pos[1] - (direction[1] * size[0] + perp[1] * sign * size[1]) * 0.5;
                let placement = Transform::from_row(ux as f32, uy as f32, vx as f32, vy as f32, tx as f32, ty as f32);
                let paint = PixmapPaint {
                    opacity: (alpha * 255.0).round_ties_even().clamp(0.0, 255.0) as f32 / 255.0,
                    blend_mode: BlendMode::SourceOver,
                    // The game's maps are pixel art, so the map is sampled without smoothing.
                    quality: if name == "map" { FilterQuality::Nearest } else { FilterQuality::Bilinear },
                };
                self.pixmap.draw_pixmap(0, 0, texture.as_ref(), &paint, view.world.pre_concat(placement), Some(&view.clip));
            }
            Draw::Circle { position, radius, color: c } => {
                let mut path = PathBuilder::new();
                for i in 0..=32 {
                    let angle = i as f64 * 2.0 * 3.1415926 / 32.0;
                    let (x, y) = ((position[0] + radius * angle.cos()) as f32, (position[1] - radius * angle.sin()) as f32);
                    if i == 0 {
                        path.move_to(x, y);
                    } else {
                        path.line_to(x, y);
                    }
                }
                path.close();
                self.fill(path, *c, view);
            }
            Draw::Polygon { points, color: c } => {
                // Filled shapes in world units, without edge smoothing.
                let Some(first) = points.first() else { return };
                let mut path = PathBuilder::new();
                path.move_to(first[0] as f32, first[1] as f32);
                for p in &points[1..] {
                    path.line_to(p[0] as f32, p[1] as f32);
                }
                path.close();
                self.fill(path, *c, view);
            }
            Draw::Line { points, color: c, width: line_width } => {
                // Line widths are screen pixels whatever the video size, as OpenGL drew them.
                let Some(first) = points.first() else { return };
                let map_point = |p: &[f64; 2]| {
                    let mut point = tiny_skia::Point::from_xy(p[0] as f32, p[1] as f32);
                    view.world.map_point(&mut point);
                    point
                };
                let mut path = PathBuilder::new();
                let start = map_point(first);
                path.move_to(start.x, start.y);
                for p in &points[1..] {
                    let point = map_point(p);
                    path.line_to(point.x, point.y);
                }
                let Some(path) = path.finish() else { return };
                let mut paint = Paint::default();
                paint.set_color(color(*c));
                paint.anti_alias = true;
                let stroke = Stroke { width: (*line_width as f32).max(1.0), line_cap: LineCap::Butt, line_join: LineJoin::Miter, ..Stroke::default() };
                self.pixmap.stroke_path(&path, &paint, &stroke, Transform::identity(), Some(&view.clip));
            }
        }
    }

    fn fill(&mut self, path: PathBuilder, c: [f64; 4], view: &View) {
        let Some(path) = path.finish() else { return };
        let mut paint = Paint::default();
        paint.set_color(color(c));
        paint.anti_alias = false;
        self.pixmap.fill_path(&path, &paint, FillRule::Winding, view.world, Some(&view.clip));
    }
}

/// A premultiplied texture from straight-alpha RGBA rows.
pub fn straight_to_pixmap(rgba: &[u8], width: usize, height: usize) -> Pixmap {
    let mut pixmap = Pixmap::new(width.max(1) as u32, height.max(1) as u32).unwrap();
    for (target, source) in pixmap.pixels_mut().iter_mut().zip(rgba.chunks_exact(4)) {
        *target = tiny_skia::ColorU8::from_rgba(source[0], source[1], source[2], source[3]).premultiply();
    }
    pixmap
}

/// An opaque texture from RGB rows.
pub fn rgb_to_pixmap(rgb: &[u8], width: usize, height: usize) -> Pixmap {
    let mut pixmap = Pixmap::new(width as u32, height as u32).unwrap();
    for (target, source) in pixmap.data_mut().chunks_exact_mut(4).zip(rgb.chunks_exact(3)) {
        target[..3].copy_from_slice(source);
        target[3] = 255;
    }
    pixmap
}

fn pair(value: &Value) -> Result<[f64; 2], String> {
    let items = value.as_array().ok_or("Expected a point")?;
    Ok([items.first().and_then(Value::as_f64).ok_or("Expected a number")?, items.get(1).and_then(Value::as_f64).ok_or("Expected a number")?])
}

fn rgba(value: &Value) -> Result<[f64; 4], String> {
    let items = value.as_array().ok_or("Expected a color")?;
    let channel = |i: usize| items.get(i).and_then(Value::as_f64).ok_or("Expected a number".to_string());
    Ok([channel(0)?, channel(1)?, channel(2)?, channel(3)?])
}

fn field<'a>(value: &'a Value, name: &str) -> Result<&'a Value, String> {
    value.get(name).ok_or_else(|| format!("The given key '{name}' was not present."))
}

fn string(value: &Value, name: &str) -> Result<String, String> {
    field(value, name)?.as_str().map(str::to_string).ok_or_else(|| format!("'{name}' must be text."))
}

/// Parses a draw request of the render worker protocol.
pub fn parse_draw(draw: &Value) -> Result<Draw, String> {
    let kind = string(draw, "type")?;
    Ok(match kind.as_str() {
        "image" => Draw::Image {
            name: string(draw, "name")?,
            position: pair(field(draw, "position")?)?,
            size: pair(field(draw, "size")?)?,
            alpha: draw.get("alpha").and_then(Value::as_f64).unwrap_or(1.0),
            direction: match draw.get("direction") {
                Some(d) => pair(d)?,
                None => [1.0, 0.0],
            },
            screen: draw.get("screen").and_then(Value::as_bool).unwrap_or(false),
            flip_y: draw.get("flipY").and_then(Value::as_bool).unwrap_or(false),
        },
        "text" => {
            let color = field(draw, "color")?.as_array().ok_or("Expected a color")?;
            let channel = |i: usize| color.get(i).and_then(Value::as_i64).unwrap_or(0) as i32;
            Draw::Text {
                name: string(draw, "name")?,
                text: string(draw, "text")?,
                position: pair(field(draw, "position")?)?,
                color: [channel(0), channel(1), channel(2)],
                fix: string(draw, "fix")?,
                font_size: field(draw, "fontSize")?.as_i64().ok_or("fontSize must be a number")? as i32,
                outline: field(draw, "outline")?.as_f64().ok_or("outline must be a number")?,
            }
        }
        "circle" => Draw::Circle { position: pair(field(draw, "position")?)?, radius: field(draw, "radius")?.as_f64().ok_or("radius must be a number")?, color: rgba(field(draw, "color")?)? },
        "polygon" => Draw::Polygon { points: field(draw, "points")?.as_array().ok_or("Expected points")?.iter().map(pair).collect::<Result<_, _>>()?, color: rgba(field(draw, "color")?)? },
        _ => Draw::Line {
            points: field(draw, "points")?.as_array().ok_or("Expected points")?.iter().map(pair).collect::<Result<_, _>>()?,
            color: rgba(field(draw, "color")?)?,
            width: draw.get("width").and_then(Value::as_f64).map(|w| w as f32 as f64).unwrap_or(1.0),
        },
    })
}

pub fn parse_request(request: &Value) -> Result<Request, String> {
    let dimension = |name: &str| field(request, name).and_then(|v| v.as_u64().filter(|&n| n > 0 && n <= 16384).map(|n| n as usize).ok_or_else(|| format!("'{name}' must be a positive size.")));
    Ok(Request {
        width: dimension("width")?,
        height: dimension("height")?,
        map_size: pair(field(request, "mapSize")?)?,
        draws: field(request, "draws")?.as_array().ok_or("Expected draws")?.iter().map(parse_draw).collect::<Result<_, _>>()?,
    })
}

/// The render worker: one JSON request per stdin line, one JSON reply per stdout
/// line, raw RGB after a reply that announces it.
pub fn run_worker() -> i32 {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let mut surface = Surface::new(1920, 1200);
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let reply = (|| -> Result<Option<Vec<u8>>, String> {
            let request: Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
            let kind = string(&request, "kind")?;
            if kind == "texture" {
                let name = string(&request, "name")?;
                let encoded = match request.get("path").and_then(Value::as_str) {
                    Some(path) => std::fs::read(path).map_err(|e| e.to_string())?,
                    None => base64::Engine::decode(&base64::engine::general_purpose::STANDARD, string(&request, "png")?).map_err(|e| e.to_string())?,
                };
                surface.texture(&name, &encoded)?;
                writeln!(out, "{{\"ok\":true}}").map_err(|e| e.to_string())?;
                return Ok(None);
            }
            if kind != "render" {
                return Err("Unknown render request".into());
            }
            let parsed = parse_request(&request)?;
            let rgb = surface.render(&parsed);
            if request.get("transport").and_then(Value::as_str) == Some("rgb") {
                writeln!(out, "{{\"ok\":true,\"bytes\":{}}}", rgb.len()).map_err(|e| e.to_string())?;
                Ok(Some(rgb.to_vec()))
            } else {
                let png = crate::surface::encode_png(rgb, parsed.width, parsed.height, 3);
                let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, png);
                writeln!(out, "{}", serde_json::json!({ "ok": true, "png": encoded })).map_err(|e| e.to_string())?;
                Ok(None)
            }
        })();
        let written = match reply {
            Ok(Some(bytes)) => out.flush().and_then(|_| out.write_all(&bytes)),
            Ok(None) => Ok(()),
            Err(error) => writeln!(out, "{}", serde_json::json!({ "ok": false, "error": error })),
        };
        if written.and_then(|_| out.flush()).is_err() {
            return 2;
        }
    }
    0
}
