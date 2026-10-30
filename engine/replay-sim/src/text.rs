//! Player names and stats text, rasterized from the system's Arial Narrow (Arial
//! where it is missing), the font the player asks the browser for.

use crate::surface::encode_png;
use base64::Engine as _;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::OnceLock;
use tiny_skia::{FillRule, Paint, PathBuilder, Pixmap, Transform};

const COLORS: [[i32; 3]; 4] = [[0, 0, 255], [255, 0, 0], [156, 0, 187], [255, 140, 57]];

/// Straight-alpha RGBA rows, top first.
pub struct Raster {
    pub rgba: Vec<u8>,
    pub width: usize,
    pub height: usize,
}

fn candidates() -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = Vec::new();
    if let Some(path) = std::env::var_os("REPLAY_SIM_FONT") {
        paths.push(path.into());
    }
    // macOS lists Arial Narrow as a family of its own; Windows keeps it beside Arial.
    let windows = std::env::var_os("WINDIR").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("C:\\Windows")).join("Fonts");
    for name in ["ARIALN.TTF", "arial.ttf"] {
        paths.push(windows.join(name));
    }
    for directory in ["/System/Library/Fonts/Supplemental", "/Library/Fonts", "/System/Library/Fonts"] {
        for name in ["Arial Narrow.ttf", "Arial.ttf"] {
            paths.push(PathBuf::from(directory).join(name));
        }
    }
    paths
}

/// Fonts commonly installed on Linux, in order of preference.
const LINUX_FONTS: [&str; 6] = ["arialn.ttf", "arial.ttf", "liberationsansnarrow-regular.ttf", "liberationsans-regular.ttf", "dejavusans.ttf", "notosans-regular.ttf"];

fn find_linux_font() -> Option<PathBuf> {
    let mut found: Vec<(usize, PathBuf)> = Vec::new();
    let mut stack: Vec<PathBuf> = ["/usr/share/fonts", "/usr/local/share/fonts"].iter().map(PathBuf::from).collect();
    if let Some(home) = std::env::var_os("HOME") {
        stack.push(PathBuf::from(home).join(".local/share/fonts"));
    }
    while let Some(directory) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&directory) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if let Some(rank) = LINUX_FONTS.iter().position(|name| path.file_name().is_some_and(|f| f.to_string_lossy().to_lowercase() == *name)) {
                found.push((rank, path));
            }
        }
    }
    found.into_iter().min_by_key(|(rank, _)| *rank).map(|(_, path)| path)
}

fn font() -> Option<&'static [u8]> {
    static FONT: OnceLock<Option<Vec<u8>>> = OnceLock::new();
    FONT.get_or_init(|| {
        let mut paths = candidates();
        paths.extend(find_linux_font());
        paths.into_iter().find_map(|path| std::fs::read(path).ok().filter(|data| ttf_parser::Face::parse(data, 0).is_ok()))
    })
    .as_deref()
}

struct Outline(PathBuilder, f32, f32, f32);

impl ttf_parser::OutlineBuilder for Outline {
    fn move_to(&mut self, x: f32, y: f32) {
        self.0.move_to(self.1 + x * self.3, self.2 - y * self.3);
    }
    fn line_to(&mut self, x: f32, y: f32) {
        self.0.line_to(self.1 + x * self.3, self.2 - y * self.3);
    }
    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        self.0.quad_to(self.1 + x1 * self.3, self.2 - y1 * self.3, self.1 + x * self.3, self.2 - y * self.3);
    }
    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        self.0.cubic_to(self.1 + x1 * self.3, self.2 - y1 * self.3, self.1 + x2 * self.3, self.2 - y2 * self.3, self.1 + x * self.3, self.2 - y * self.3);
    }
    fn close(&mut self) {
        self.0.close();
    }
}

/// A coverage mask of the text, as SDL_ttf's blended mode produced it: the
/// advance width by the font's ascent-to-descent height.
fn coverage(text: &str, size: i32) -> (Vec<u8>, usize, usize) {
    let Some(face) = font().and_then(|data| ttf_parser::Face::parse(data, 0).ok()) else { return (vec![0], 1, 1) };
    let scale = size as f32 / face.units_per_em() as f32;
    let baseline = (face.ascender() as f32 * scale).ceil();
    let descent = (-(face.descender() as f32) * scale).ceil();
    let glyphs: Vec<(ttf_parser::GlyphId, f32)> = text
        .chars()
        .map(|c| {
            let glyph = face.glyph_index(c).unwrap_or(ttf_parser::GlyphId(0));
            (glyph, face.glyph_hor_advance(glyph).unwrap_or(0) as f32 * scale)
        })
        .collect();
    let advance: f32 = glyphs.iter().map(|(_, a)| a).sum();
    let width = (advance.ceil() as usize).max(1);
    let height = ((baseline + descent) as usize).max(1);
    let Some(mut mask) = Pixmap::new(width as u32, height as u32) else { return (vec![0; width * height], width, height) };
    let mut pen = 0f32;
    let mut builder = Outline(PathBuilder::new(), 0.0, baseline, scale);
    for (glyph, advance) in glyphs {
        // Glyphs start on whole pixels, as unhinted text without subpixel positioning does.
        builder.1 = pen.round();
        face.outline_glyph(glyph, &mut builder);
        pen += advance;
    }
    if let Some(path) = builder.0.finish() {
        let mut paint = Paint::default();
        paint.set_color_rgba8(255, 255, 255, 255);
        paint.anti_alias = true;
        mask.fill_path(&path, &paint, FillRule::Winding, Transform::identity(), None);
    }
    (mask.data().chunks_exact(4).map(|p| p[3]).collect(), width, height)
}

pub fn rasterize(text: &str, color: [i32; 3], size: i32, outline: f64) -> Raster {
    let (coverage, content_width, content_height) = coverage(text, size);
    let pad = (outline * 2.0) as usize;
    let (width, height) = (content_width + pad, content_height + pad);
    let mut rgba = vec![0u8; width * height * 4];
    let mut blit = |source: [i32; 3], dx: usize, dy: usize| {
        // pygame's SDL1-compatible straight-alpha blend.
        for y in 0..content_height {
            for x in 0..content_width {
                let sa = coverage[y * content_width + x] as i32;
                if sa == 0 {
                    continue;
                }
                let d = ((y + dy) * width + x + dx) * 4;
                let da = rgba[d + 3] as i32;
                if sa == 255 || da == 0 {
                    for channel in 0..3 {
                        rgba[d + channel] = source[channel] as u8;
                    }
                    rgba[d + 3] = sa as u8;
                } else {
                    for channel in 0..3 {
                        let dc = rgba[d + channel] as i32;
                        rgba[d + channel] = (((dc << 8) + (source[channel] - dc) * sa + source[channel]) >> 8) as u8;
                    }
                    rgba[d + 3] = (sa + da - sa * da / 255) as u8;
                }
            }
        }
    };
    for (dx, dy) in [(-1.0, 0.0), (1.0, 0.0), (0.0, -1.0), (0.0, 1.0), (-1.0, -1.0), (-1.0, 1.0), (1.0, -1.0), (1.0, 1.0)] {
        blit([0, 0, 0], (outline + dx * outline) as usize, (outline + dy * outline) as usize);
    }
    blit(color, outline as usize, outline as usize);
    Raster { rgba, width, height }
}

/// A player name in its side's colour, as the player shows it.
pub fn player_name(text: &str, side: usize) -> Raster {
    rasterize(text, COLORS.get(side).copied().unwrap_or([200, 200, 200]), 60, 1.5)
}

/// A player name for the static record: its text, size and RGBA PNG.
pub fn player_label(text: &str, side: usize) -> Value {
    let raster = player_name(text, side);
    let png = encode_png(&raster.rgba, raster.width, raster.height, 4);
    json!({ "text": text, "size": [raster.width, raster.height], "image": base64::engine::general_purpose::STANDARD.encode(png) })
}
