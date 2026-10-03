//! Replay card thumbnails. Map images are 960 × 540; a grid of small cards
//! decoding (and keeping) full-size images is what made scrolling stutter, so
//! small cards get a box-filtered copy at most `SMALL_WIDTH` pixels wide.
use std::fs;
use std::io::Cursor;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};

pub(crate) const SMALL_WIDTH: u32 = 480;
const MAX_DECODE_BYTES: usize = 128 * 1024 * 1024;

/// Writes the small variant of the PNG file `source` to `destination`.
pub(crate) fn write_small_variant(source: &Path, destination: &Path) -> Result<(), String> {
    let png = fs::read(source).map_err(|error| format!("Could not open {}: {error}", source.display()))?;
    write_small_png(&png, destination)
}

/// Writes the small variant of an encoded PNG to `destination` (atomically,
/// so a half-written file is never served).
pub(crate) fn write_small_png(png: &[u8], destination: &Path) -> Result<(), String> {
    let mut decoder = png::Decoder::new(Cursor::new(png));
    decoder.set_transformations(png::Transformations::normalize_to_color8());
    decoder.set_limits(png::Limits { bytes: MAX_DECODE_BYTES });
    let mut reader = decoder
        .read_info()
        .map_err(|error| format!("Thumbnail for {} is damaged: {error}", destination.display()))?;
    let mut pixels = vec![0; reader.output_buffer_size()];
    let info = reader
        .next_frame(&mut pixels)
        .map_err(|error| format!("Thumbnail for {} is damaged: {error}", destination.display()))?;
    let (width, height) = (info.width, info.height);
    let factor = width.div_ceil(SMALL_WIDTH).max(1);
    if factor == 1 {
        return write_atomically(png, destination);
    }
    let channels = match info.color_type {
        png::ColorType::Grayscale => 1,
        png::ColorType::GrayscaleAlpha => 2,
        png::ColorType::Rgb => 3,
        png::ColorType::Rgba => 4,
        png::ColorType::Indexed => return Err("Indexed thumbnails are not expanded.".into()),
    };
    let (small_width, small_height, rgba) =
        downscale(&pixels[..info.buffer_size()], width, height, info.line_size, channels, factor);

    let mut encoded = Vec::new();
    let mut encoder = png::Encoder::new(&mut encoded, small_width, small_height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.set_compression(png::Compression::Fast);
    encoder
        .write_header()
        .and_then(|mut writer| writer.write_image_data(&rgba))
        .map_err(|error| format!("Could not encode {}: {error}", destination.display()))?;
    write_atomically(&encoded, destination)
}

/// Writes through a temporary file unique to this writer, since two requests
/// can produce the same thumbnail at once.
pub(crate) fn write_atomically(bytes: &[u8], destination: &Path) -> Result<(), String> {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let temporary = destination.with_extension(format!(
        "{}.{}.tmp",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::write(&temporary, bytes).map_err(|error| format!("Could not write {}: {error}", temporary.display()))?;
    if fs::rename(&temporary, destination).is_err() {
        let _ = fs::remove_file(&temporary);
        if !destination.is_file() {
            return Err(format!("Could not write {}", destination.display()));
        }
    }
    Ok(())
}

/// Averages `factor` × `factor` blocks (alpha-weighted, so transparent pixels
/// do not darken edges) into RGBA.
fn downscale(
    pixels: &[u8],
    width: u32,
    height: u32,
    line_size: usize,
    channels: usize,
    factor: u32,
) -> (u32, u32, Vec<u8>) {
    let small_width = width.div_ceil(factor);
    let small_height = height.div_ceil(factor);
    let mut rgba = Vec::with_capacity(small_width as usize * small_height as usize * 4);
    for block_y in 0..small_height {
        let rows = (block_y * factor)..((block_y + 1) * factor).min(height);
        for block_x in 0..small_width {
            let columns = (block_x * factor)..((block_x + 1) * factor).min(width);
            let (mut red, mut green, mut blue, mut alpha, mut count) = (0u64, 0u64, 0u64, 0u64, 0u64);
            for y in rows.clone() {
                let row = &pixels[y as usize * line_size..];
                for x in columns.clone() {
                    let pixel = &row[x as usize * channels..x as usize * channels + channels];
                    let (r, g, b, a) = match channels {
                        1 => (pixel[0], pixel[0], pixel[0], 255),
                        2 => (pixel[0], pixel[0], pixel[0], pixel[1]),
                        3 => (pixel[0], pixel[1], pixel[2], 255),
                        _ => (pixel[0], pixel[1], pixel[2], pixel[3]),
                    };
                    let a = u64::from(a);
                    red += u64::from(r) * a;
                    green += u64::from(g) * a;
                    blue += u64::from(b) * a;
                    alpha += a;
                    count += 1;
                }
            }
            if alpha == 0 {
                rgba.extend_from_slice(&[0, 0, 0, 0]);
            } else {
                rgba.extend_from_slice(&[
                    ((red + alpha / 2) / alpha) as u8,
                    ((green + alpha / 2) / alpha) as u8,
                    ((blue + alpha / 2) / alpha) as u8,
                    ((alpha + count / 2) / count) as u8,
                ]);
            }
        }
    }
    (small_width, small_height, rgba)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::io::BufWriter;

    fn write_png(path: &Path, width: u32, height: u32, pixel: [u8; 3]) {
        let file = File::create(path).unwrap();
        let mut encoder = png::Encoder::new(BufWriter::new(file), width, height);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        let data = pixel.repeat((width * height) as usize);
        encoder.write_header().unwrap().write_image_data(&data).unwrap();
    }

    #[test]
    fn map_sized_images_shrink_to_half_and_keep_their_colour() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("map.png");
        let small = root.path().join("small.png");
        write_png(&source, 960, 540, [10, 120, 240]);
        write_small_variant(&source, &small).unwrap();
        let mut reader = png::Decoder::new(Cursor::new(fs::read(&small).unwrap())).read_info().unwrap();
        let mut pixels = vec![0; reader.output_buffer_size()];
        let info = reader.next_frame(&mut pixels).unwrap();
        assert_eq!((info.width, info.height), (480, 270));
        assert_eq!(&pixels[..4], &[10, 120, 240, 255]);
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 2, "no temporary files are left");
    }

    #[test]
    fn small_images_are_copied_unchanged() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("map.png");
        let small = root.path().join("small.png");
        write_png(&source, 300, 200, [1, 2, 3]);
        write_small_variant(&source, &small).unwrap();
        assert_eq!(fs::read(&source).unwrap(), fs::read(&small).unwrap());
    }

    #[test]
    fn odd_sizes_average_partial_blocks() {
        let pixels = [0u8, 0, 0, 255, 255, 255, 200, 200, 200];
        let (width, height, rgba) = downscale(&pixels, 3, 1, 9, 3, 2);
        assert_eq!((width, height), (2, 1));
        assert_eq!(rgba, vec![128, 128, 128, 255, 200, 200, 200, 255]);
    }
}
