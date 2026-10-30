//! Map images: PNG decoding, map file lookup and the terrain raster.

use crate::geom::{trunc_i32, Vec2};
use base64::Engine as _;
use flate2::read::ZlibDecoder;
use flate2::write::ZlibEncoder;
use flate2::Compression;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Terrain {
    Plains = 0,
    Forest = 1,
    Sand = 2,
    Hill = 3,
    Snow = 4,
    Mud = 5,
    Water = 6,
    Mountain = 7,
    Bridge = 8,
    City = 9,
}

impl Terrain {
    fn from_id(id: u8) -> Terrain {
        match id {
            1 => Terrain::Forest,
            2 => Terrain::Sand,
            3 => Terrain::Hill,
            4 => Terrain::Snow,
            5 => Terrain::Mud,
            6 => Terrain::Water,
            7 => Terrain::Mountain,
            8 => Terrain::Bridge,
            9 => Terrain::City,
            _ => Terrain::Plains,
        }
    }

    /// The column in the speed and damage tables. It equals the raster id.
    pub fn index(self) -> usize {
        self as usize
    }

    /// The name the state records use.
    pub fn name(self) -> &'static str {
        match self {
            Terrain::Plains => "plain",
            Terrain::Forest => "forest",
            Terrain::Sand => "sand",
            Terrain::Hill => "hill",
            Terrain::Snow => "snow",
            Terrain::Mud => "mud",
            Terrain::Water => "river",
            Terrain::Mountain => "mountain",
            Terrain::Bridge => "bridge",
            Terrain::City => "city",
        }
    }

    /// The terrain code of binary frames (docs/replay-frames.md).
    pub fn frame_code(self) -> u8 {
        match self {
            Terrain::Plains => 0,
            Terrain::Forest => 1,
            Terrain::Sand => 2,
            Terrain::Water => 3,
            Terrain::Mountain => 4,
            Terrain::Bridge => 5,
            Terrain::Hill => 6,
            Terrain::Snow => 7,
            Terrain::Mud => 8,
            Terrain::City => 9,
        }
    }
}

/// An RGB map image, and after rasterizing, its terrain ids.
pub struct MapSurface {
    pub width: usize,
    pub height: usize,
    pub pixels: Vec<u8>,
    terrain: Option<Vec<u8>>,
}

/// Where map files are found: the installed game, the player's replay folders
/// and the maps bundled with the engine. The browser supplies maps in memory.
#[derive(Default)]
pub struct MapFiles {
    pub game_dirs: Vec<PathBuf>,
    pub replay_dirs: Vec<PathBuf>,
    pub bundled: Option<PathBuf>,
    /// Browser maps by lowercase virtual path; when set, the disk is not used.
    pub memory: Option<HashMap<String, Vec<u8>>>,
    /// The last map file that was not found, so a host can supply it and retry.
    pub unresolved: Option<String>,
}

const BUNDLED_VIRTUAL: &str = "maps";

impl MapFiles {
    /// Resolves a map path recorded in a replay to the file's bytes.
    pub fn resolve(&mut self, recorded: Option<&str>, replay_dir: &Path) -> Option<Vec<u8>> {
        let recorded = recorded.filter(|path| !path.trim().is_empty())?;
        let normalized = recorded.replace('\\', "/");
        let file_name = normalized.rsplit('/').next().unwrap_or("").to_string();
        let rooted = is_rooted(recorded);
        if let Some(bytes) = self.read_exact(recorded, rooted, replay_dir, &normalized) {
            return Some(bytes);
        }
        if !rooted {
            if let Some(bytes) = self.find(Root::Replay(replay_dir), &normalized) {
                return Some(bytes);
            }
        }
        if let Some(bytes) = self.find(Root::Replay(replay_dir), &format!("maps/{file_name}")) {
            return Some(bytes);
        }
        let lower = normalized.to_lowercase();
        // Official maps (fahero, zolamare, eronion) come from the installed game when it is available.
        if lower.starts_with("assets/") && !normalized.contains("..") {
            for directory in self.game_dirs.clone() {
                if let Some(bytes) = self.find(Root::Disk(&directory), &normalized) {
                    return Some(bytes);
                }
            }
            // Keep each author's asset directory. Their numbered PNG filenames
            // can collide even though the native catalog paths differ.
            if let Some(bytes) = self.find(Root::Bundled, &normalized) {
                return Some(bytes);
            }
        }
        if lower == file_name.to_lowercase()
            || lower.starts_with("assets/fahero_maps/")
            || lower.starts_with("assets/zolamare_maps/")
            || lower.starts_with("assets/eronion_maps/")
        {
            if let Some(bytes) = self.find(Root::Bundled, &file_name) {
                return Some(bytes);
            }
        }
        self.unresolved = Some(normalized);
        None
    }

    fn read_exact(&self, recorded: &str, rooted: bool, replay_dir: &Path, normalized: &str) -> Option<Vec<u8>> {
        if let Some(memory) = &self.memory {
            return if rooted { None } else { memory.get(&normalized.to_lowercase()).cloned() };
        }
        let supplied = if rooted { PathBuf::from(recorded) } else { replay_dir.join(normalized.replace('/', std::path::MAIN_SEPARATOR_STR)) };
        if supplied.is_file() {
            std::fs::read(supplied).ok()
        } else {
            None
        }
    }

    fn find(&self, root: Root, relative: &str) -> Option<Vec<u8>> {
        let parts: Vec<&str> = relative.split(['/', '\\']).filter(|part| !part.is_empty()).collect();
        if parts.is_empty() || parts.iter().any(|part| *part == "." || *part == "..") {
            return None;
        }
        if let Some(memory) = &self.memory {
            let prefix = match root {
                Root::Replay(_) => String::new(),
                Root::Bundled => format!("{BUNDLED_VIRTUAL}/"),
                Root::Disk(_) => return None,
            };
            return memory.get(&format!("{prefix}{}", parts.join("/")).to_lowercase()).cloned();
        }
        let base = match root {
            Root::Replay(path) | Root::Disk(path) => path.to_path_buf(),
            Root::Bundled => self.bundled.clone()?,
        };
        find_file(&base, &parts).and_then(|path| std::fs::read(path).ok())
    }

    /// Stores a browser-supplied map where bundled maps are looked up.
    pub fn add_memory(&mut self, path: &str, bytes: Vec<u8>) {
        let key = format!("{BUNDLED_VIRTUAL}/{}", path.replace('\\', "/")).to_lowercase();
        self.memory.get_or_insert_with(HashMap::new).insert(key, bytes);
    }
}

enum Root<'a> {
    Replay(&'a Path),
    Disk(&'a Path),
    Bundled,
}

fn is_rooted(path: &str) -> bool {
    let bytes = path.as_bytes();
    path.starts_with('/') || path.starts_with('\\') || (bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic())
}

/// A file under `root` named by relative parts, matching each part without
/// regard to case as Windows and macOS do, so Linux finds the same files.
fn find_file(root: &Path, parts: &[&str]) -> Option<PathBuf> {
    let mut exact = root.to_path_buf();
    for part in parts {
        exact.push(part);
    }
    if exact.is_file() {
        return Some(exact);
    }
    let mut current = root.to_path_buf();
    for (i, part) in parts.iter().enumerate() {
        if !current.is_dir() {
            return None;
        }
        let last = i == parts.len() - 1;
        let wanted = part.to_lowercase();
        // Names first: replay folders can hold thousands of files, and the listing
        // already knows each entry's type, so only links need another look.
        let found = std::fs::read_dir(&current).ok()?.filter_map(|entry| entry.ok()).find(|entry| {
            entry.file_name().to_string_lossy().to_lowercase() == wanted
                && entry.file_type().is_ok_and(|kind| {
                    let path = || entry.path();
                    if last {
                        kind.is_file() || kind.is_symlink() && path().is_file()
                    } else {
                        kind.is_dir() || kind.is_symlink() && path().is_dir()
                    }
                })
        })?;
        current = found.path();
    }
    Some(current)
}

fn read_u32(data: &[u8], index: usize) -> i32 {
    i32::from_be_bytes([data[index], data[index + 1], data[index + 2], data[index + 3]])
}

fn paeth(a: u8, b: u8, c: u8) -> u8 {
    let (a16, b16, c16) = (a as i32, b as i32, c as i32);
    let p = a16 + b16 - c16;
    let (pa, pb, pc) = ((p - a16).abs(), (p - b16).abs(), (p - c16).abs());
    if pa <= pb && pa <= pc {
        a
    } else if pb <= pc {
        b
    } else {
        c
    }
}

impl MapSurface {
    pub fn decode_base64(encoded: &str) -> Option<MapSurface> {
        if encoded.trim().is_empty() {
            return None;
        }
        let compact: String = encoded.chars().filter(|c| !c.is_ascii_whitespace()).collect();
        let png = base64::engine::general_purpose::STANDARD.decode(compact).ok()?;
        MapSurface::decode(&png)
    }

    /// Decodes an 8-bit, non-interlaced PNG to RGB, dropping alpha.
    pub fn decode(png: &[u8]) -> Option<MapSurface> {
        if png.len() < 33 || png[0] != 137 || png[1] != 80 || png[2] != 78 || png[3] != 71 {
            return None;
        }
        let width = read_u32(png, 16);
        let height = read_u32(png, 20);
        let (bit_depth, color_type) = (png[24], png[25]);
        let channels = match color_type {
            0 => 1,
            2 => 3,
            3 => 1,
            4 => 2,
            6 => 4,
            _ => 0,
        };
        if width <= 0 || height <= 0 || bit_depth != 8 || channels == 0 || png[28] != 0 {
            return None;
        }
        let (width, height) = (width as usize, height as usize);
        let mut palette: Option<&[u8]> = None;
        let mut compressed = Vec::new();
        let mut offset = 8usize;
        while offset + 8 <= png.len() {
            let length = read_u32(png, offset);
            if length < 0 || offset as u64 + 12 + length as u64 > png.len() as u64 {
                return None;
            }
            let length = length as usize;
            let kind = &png[offset + 4..offset + 8];
            if kind == b"IDAT" {
                compressed.extend_from_slice(&png[offset + 8..offset + 8 + length]);
            }
            if kind == b"PLTE" {
                palette = Some(&png[offset + 8..offset + 8 + length]);
            }
            offset += 12 + length;
            if kind == b"IEND" {
                break;
            }
        }
        let stride = width.checked_mul(channels)?;
        let total = (stride + 1).checked_mul(height)?;
        let mut filtered = vec![0u8; total];
        let mut zlib = ZlibDecoder::new(&compressed[..]);
        let mut read = 0;
        while read < total {
            match zlib.read(&mut filtered[read..]) {
                Ok(0) => break,
                Ok(n) => read += n,
                Err(_) => break,
            }
        }
        if read != total {
            return None;
        }
        let mut scan = vec![0u8; width.checked_mul(height)?.checked_mul(3)?];
        let mut prior = vec![0u8; stride];
        let mut current = vec![0u8; stride];
        for y in 0..height {
            let filter = filtered[y * (stride + 1)];
            current.copy_from_slice(&filtered[y * (stride + 1) + 1..(y + 1) * (stride + 1)]);
            for i in 0..stride {
                let left = if i >= channels { current[i - channels] } else { 0 };
                let up = prior[i];
                let up_left = if i >= channels { prior[i - channels] } else { 0 };
                current[i] = match filter {
                    0 => current[i],
                    1 => current[i].wrapping_add(left),
                    2 => current[i].wrapping_add(up),
                    3 => current[i].wrapping_add(((left as u16 + up as u16) / 2) as u8),
                    4 => current[i].wrapping_add(paeth(left, up, up_left)),
                    _ => return None,
                };
            }
            for x in 0..width {
                let source = x * channels;
                let destination = (y * width + x) * 3;
                if color_type == 3 {
                    let index = current[source] as usize * 3;
                    let palette = palette?;
                    if index + 2 >= palette.len() {
                        return None;
                    }
                    scan[destination..destination + 3].copy_from_slice(&palette[index..index + 3]);
                } else if color_type == 0 || color_type == 4 {
                    scan[destination..destination + 3].fill(current[source]);
                } else {
                    scan[destination..destination + 3].copy_from_slice(&current[source..source + 3]);
                }
            }
            std::mem::swap(&mut prior, &mut current);
        }
        Some(MapSurface { width, height, pixels: scan, terrain: None })
    }

    /// The native surface is scaled before lookup. Quantize world coordinates
    /// only after scaling the complete RGB raster, then apply replay geometry.
    pub fn rasterize(&self, cities: &[Vec2], bridges: &[Vec<Vec2>], width: usize, height: usize, pygame_ce_fill: bool) -> Result<MapSurface, String> {
        let mut ids = vec![0u8; width * height];
        let mut raster = vec![0u8; width * height * 3];
        let (w, h) = (self.width, self.height);
        for y in 0..height {
            for x in 0..width {
                let index = ((y * h / height) * w + x * w / width) * 3;
                // The presentation map samples pixel centers. Terrain lookup uses
                // the separate corner-aligned raster above.
                let ry = (((y as f64 + 0.5) * h as f64 / height as f64) as usize).min(h - 1);
                let rx = (((x as f64 + 0.5) * w as f64 / width as f64) as usize).min(w - 1);
                let render_index = (ry * w + rx) * 3;
                raster[(y * width + x) * 3..(y * width + x) * 3 + 3].copy_from_slice(&self.pixels[render_index..render_index + 3]);
                ids[y * width + x] = match (self.pixels[index], self.pixels[index + 1], self.pixels[index + 2]) {
                    (56, 131, 54) => 1,
                    (238, 227, 176) => 2,
                    (136, 138, 135) => 3,
                    (227, 242, 242) => 4,
                    (120, 75, 35) => 5,
                    (39, 155, 255) => 6,
                    (109, 107, 111) => 7,
                    (100, 60, 10) => 8,
                    (255, 255, 0) => 9,
                    _ => 0,
                };
            }
        }
        for bridge in bridges {
            if bridge.len() != 2 {
                return Err("A bridge must have two endpoints.".into());
            }
            let delta = bridge[1] - bridge[0];
            if delta.length() == 0.0 {
                continue;
            }
            let offset = Vec2::new(-delta.y, delta.x) * 7.5 * (1.0 / (delta.length() + 0.01));
            let vertices = [bridge[0] + offset, bridge[0] - offset, bridge[1] - offset, bridge[1] + offset].map(Vec2::truncate);
            fill_polygon(&mut ids, &vertices, 8, width, height, pygame_ce_fill);
        }
        // Native pygame radius-nine circle raster, relative to its center.
        // This fixed stencil has 240 pixels and asymmetric pixel endpoints.
        const HALF_WIDTHS: [i32; 18] = [2, 4, 6, 7, 7, 8, 8, 9, 9, 9, 9, 8, 8, 7, 7, 6, 4, 2];
        for city in cities {
            let (cx, cy) = (trunc_i32(city.x), trunc_i32(city.y));
            for (row, half) in HALF_WIDTHS.iter().enumerate() {
                span(&mut ids, cy + row as i32 - 9, cx - half, cx + half - 1, 9, width, height);
            }
        }
        for (i, id) in ids.iter().enumerate() {
            if *id == 9 {
                raster[i * 3..i * 3 + 3].copy_from_slice(&[255, 255, 0]);
            } else if *id == 8 {
                raster[i * 3..i * 3 + 3].copy_from_slice(&[100, 60, 10]);
            }
        }
        Ok(MapSurface { width, height, pixels: raster, terrain: Some(ids) })
    }

    pub fn terrain_ids(&self) -> Option<&[u8]> {
        self.terrain.as_deref()
    }

    pub fn at(&self, world: Vec2) -> Terrain {
        let x = world.x.floor().clamp(0.0, (self.width - 1) as f64);
        let y = world.y.floor().clamp(0.0, (self.height - 1) as f64);
        let (x, y) = (if x.is_nan() { 0 } else { x as usize }, if y.is_nan() { 0 } else { y as usize });
        match &self.terrain {
            Some(ids) => Terrain::from_id(ids[y * self.width + x]),
            None => Terrain::Plains,
        }
    }

    pub fn png_base64(&self) -> String {
        base64::engine::general_purpose::STANDARD.encode(encode_png(&self.pixels, self.width, self.height, 3))
    }
}

fn fill_polygon(ids: &mut [u8], vertices: &[Vec2], kind: u8, width: usize, height: usize, pygame_ce_fill: bool) {
    let bottom = trunc_i32(vertices.iter().map(|p| p.y).fold(f64::NEG_INFINITY, f64::max));
    let top = trunc_i32(vertices.iter().map(|p| p.y).fold(f64::INFINITY, f64::min));
    let mut y = top.max(0);
    while y <= bottom.min(height as i32 - 1) {
        let mut crossings: Vec<i32> = Vec::with_capacity(vertices.len());
        let yf = y as f64;
        for edge in 0..vertices.len() {
            let mut a = vertices[(edge + vertices.len() - 1) % vertices.len()];
            let mut b = vertices[edge];
            if a.y == b.y {
                if a.y == yf {
                    span(ids, y, trunc_i32(a.x.min(b.x)), trunc_i32(a.x.max(b.x)), kind, width, height);
                }
                continue;
            }
            if a.y > b.y {
                std::mem::swap(&mut a, &mut b);
            }
            if (yf >= a.y && yf < b.y) || (y == bottom && b.y == bottom as f64) {
                if pygame_ce_fill {
                    // Pygame CE rounds the float32 edge offset by encounter
                    // parity, then adds the origin and sorts intersections.
                    let offset = ((yf - a.y) * (b.x - a.x)) as f32 / (b.y - a.y) as f32;
                    let rounded = if crossings.len() % 2 == 0 { offset.floor() } else { offset.ceil() };
                    crossings.push(rounded as i32 + trunc_i32(a.x));
                } else {
                    let crossing = (yf - a.y) * (b.x - a.x) / (b.y - a.y) + a.x;
                    crossings.push(trunc_i32(crossing));
                }
            }
        }
        crossings.sort_unstable();
        let mut i = 0;
        while i + 1 < crossings.len() {
            span(ids, y, crossings[i], crossings[i + 1], kind, width, height);
            i += 2;
        }
        y += 1;
    }
}

fn span(ids: &mut [u8], y: i32, left: i32, right: i32, kind: u8, width: usize, height: usize) {
    if y < 0 || y >= height as i32 || right < 0 || left >= width as i32 {
        return;
    }
    let start = left.max(0) as usize;
    let end = right.min(width as i32 - 1);
    if end < start as i32 {
        return;
    }
    let row = y as usize * width;
    ids[row + start..=row + end as usize].fill(kind);
}

/// An unfiltered PNG with RGB or RGBA rows.
pub fn encode_png(pixels: &[u8], width: usize, height: usize, channels: usize) -> Vec<u8> {
    let mut output = vec![137, 80, 78, 71, 13, 10, 26, 10];
    fn chunk(output: &mut Vec<u8>, name: &[u8; 4], data: &[u8]) {
        output.extend_from_slice(&(data.len() as u32).to_be_bytes());
        output.extend_from_slice(name);
        output.extend_from_slice(data);
        let mut crc = 0xffff_ffffu32;
        for &value in name.iter().chain(data) {
            crc ^= value as u32;
            for _ in 0..8 {
                crc = (crc >> 1) ^ if crc & 1 != 0 { 0xedb8_8320 } else { 0 };
            }
        }
        output.extend_from_slice(&(!crc).to_be_bytes());
    }
    let mut header = [0u8; 13];
    header[0..4].copy_from_slice(&(width as u32).to_be_bytes());
    header[4..8].copy_from_slice(&(height as u32).to_be_bytes());
    header[8] = 8;
    header[9] = if channels == 4 { 6 } else { 2 };
    chunk(&mut output, b"IHDR", &header);
    let mut zipper = ZlibEncoder::new(Vec::new(), Compression::new(6));
    let row = width * channels;
    for y in 0..height {
        zipper.write_all(&[0]).unwrap();
        zipper.write_all(&pixels[y * row..(y + 1) * row]).unwrap();
    }
    let compressed = zipper.finish().unwrap();
    chunk(&mut output, b"IDAT", &compressed);
    chunk(&mut output, b"IEND", &[]);
    output
}
