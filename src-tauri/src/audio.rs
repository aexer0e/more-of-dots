//! The game's replay sounds, mixed offline for video export. The sounds are read
//! from the installed game; nothing is bundled. The rules follow War of Dots'
//! SoundManager:
//! - music: a match plays `won.wav` on repeat at the music volume and pauses when the game ends;
//! - fighting: each tick reports how many units are in combat. Every frame that
//!   count is smoothed (s += 0.03 × (n − s)); the loop starts at 0.2 × sfx once s
//!   is non-zero and then plays at min(1, √s / 5) / 3 × sfx;
//! - a side that produced units plays `produce_unit` at the sfx volume;
//! - at the end the loop stops and victory (any result but 0) or defeat plays at
//!   half the sfx volume;
//! - the mixer has eight channels; a sound with no free channel is dropped.
use std::{
    fs::File,
    io::{BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::Arc,
};

pub const RATE: u32 = 48_000;
const CHANNELS: usize = 8;
const TICKS_PER_SECOND: f64 = 30.0;

/// The game's sound files, relative to its `assets` folder.
pub const GAME_SOUNDS: [(&str, &str); 5] = [
    ("music", "music/won.wav"),
    ("fighting", "sound_effects/fighting.wav"),
    ("produce_unit", "sound_effects/produce_unit.wav"),
    ("victory", "sound_effects/victory.wav"),
    ("defeat", "sound_effects/defeat.wav"),
];

/// The `assets` folder of the first installed game that has every sound.
pub fn game_assets(game_dirs: &[PathBuf]) -> Option<PathBuf> {
    game_dirs
        .iter()
        .map(|root| root.join("assets"))
        .find(|assets| GAME_SOUNDS.iter().all(|(_, file)| assets.join(file).is_file()))
}

fn sound_path(assets: &Path, name: &str) -> PathBuf {
    let (_, file) = GAME_SOUNDS.iter().find(|(sound, _)| *sound == name).unwrap();
    assets.join(file)
}

trait Source: Read + Seek + Send {}
impl<T: Read + Seek + Send> Source for T {}

/// The sample layout of a WAV file.
#[derive(Clone, Copy)]
struct Format {
    channels: usize,
    rate: u32,
    bits: usize,
    float: bool,
}

impl Format {
    fn frame_bytes(&self) -> usize {
        self.channels * self.bits / 8
    }

    /// One frame as stereo; mono plays on both sides.
    fn decode(&self, frame: &[u8]) -> (f32, f32) {
        let sample = |channel: usize| -> f32 {
            let b = &frame[channel * self.bits / 8..];
            match (self.float, self.bits) {
                (true, 32) => f32::from_le_bytes([b[0], b[1], b[2], b[3]]),
                (true, _) => f64::from_le_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]) as f32,
                (false, 8) => (b[0] as f32 - 128.0) / 128.0,
                (false, 16) => i16::from_le_bytes([b[0], b[1]]) as f32 / 32_768.0,
                (false, 24) => (i32::from_le_bytes([0, b[0], b[1], b[2]]) >> 8) as f32 / 8_388_608.0,
                (false, _) => i32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f32 / 2_147_483_648.0,
            }
        };
        let left = sample(0);
        (left, if self.channels > 1 { sample(1) } else { left })
    }
}

/// Reads a WAV header and leaves `reader` at the first sample. Returns the
/// format and the number of frames.
fn read_header(reader: &mut impl Source) -> Result<(Format, u64), String> {
    let invalid = |message: &str| format!("Invalid sound file: {message}");
    let io = |error: std::io::Error| invalid(&error.to_string());
    let mut riff = [0u8; 12];
    reader.read_exact(&mut riff).map_err(io)?;
    if !matches!(&riff[0..4], b"RIFF" | b"RF64") || &riff[8..12] != b"WAVE" {
        return Err(invalid("not a WAV file"));
    }
    let mut format = None;
    loop {
        let mut chunk = [0u8; 8];
        reader.read_exact(&mut chunk).map_err(|_| invalid("no samples"))?;
        let size = u32::from_le_bytes([chunk[4], chunk[5], chunk[6], chunk[7]]) as u64;
        match &chunk[0..4] {
            b"fmt " => {
                let mut body = vec![0u8; size as usize];
                reader.read_exact(&mut body).map_err(io)?;
                if body.len() < 16 {
                    return Err(invalid("short format"));
                }
                let word = |at: usize| u16::from_le_bytes([body[at], body[at + 1]]);
                // WAVE_FORMAT_EXTENSIBLE keeps the real format in its subformat GUID.
                let tag = if word(0) == 0xFFFE && body.len() >= 26 { word(24) } else { word(0) };
                let parsed = Format {
                    channels: word(2) as usize,
                    rate: u32::from_le_bytes([body[4], body[5], body[6], body[7]]),
                    bits: word(14) as usize,
                    float: tag == 3,
                };
                let supported = match tag {
                    1 => matches!(parsed.bits, 8 | 16 | 24 | 32),
                    3 => matches!(parsed.bits, 32 | 64),
                    _ => false,
                };
                if !supported || parsed.channels == 0 || parsed.rate == 0 {
                    return Err(invalid("unsupported sample format"));
                }
                format = Some(parsed);
                reader.seek(SeekFrom::Current((size & 1) as i64)).map_err(io)?;
            }
            b"data" => {
                let format = format.ok_or_else(|| invalid("samples before the format"))?;
                // Streamed or 64-bit files may not state the real size.
                let start = reader.stream_position().map_err(io)?;
                let end = reader.seek(SeekFrom::End(0)).map_err(io)?;
                reader.seek(SeekFrom::Start(start)).map_err(io)?;
                let bytes = size.min(end - start);
                return Ok((format, bytes / format.frame_bytes() as u64));
            }
            _ => {
                reader.seek(SeekFrom::Current((size + (size & 1)) as i64)).map_err(io)?;
            }
        }
    }
}

/// Linear interpolation between two stereo frames.
fn mix(a: (f32, f32), b: (f32, f32), t: f32) -> (f32, f32) {
    (a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t)
}

/// Interleaved stereo samples at 48 kHz.
pub struct Clip(Vec<f32>);

impl Clip {
    fn frames(&self) -> usize {
        self.0.len() / 2
    }
    fn frame(&self, index: usize) -> (f32, f32) {
        (self.0[index * 2], self.0[index * 2 + 1])
    }

    fn read(mut reader: impl Source) -> Result<Self, String> {
        let (format, frames) = read_header(&mut reader)?;
        let mut bytes = vec![0u8; frames as usize * format.frame_bytes()];
        reader.read_exact(&mut bytes).map_err(|e| format!("Invalid sound file: {e}"))?;
        let source: Vec<_> = bytes.chunks_exact(format.frame_bytes()).map(|frame| format.decode(frame)).collect();
        let length = (source.len() as u64 * RATE as u64).div_ceil(format.rate as u64) as usize;
        let step = format.rate as f64 / RATE as f64;
        let mut samples = Vec::with_capacity(length * 2);
        for index in 0..length {
            let position = index as f64 * step;
            let at = position as usize;
            let next = source[(at + 1).min(source.len() - 1)];
            let (left, right) = mix(source[at], next, position.fract() as f32);
            samples.extend([left, right]);
        }
        Ok(Self(samples))
    }
}

/// The music, read from disk as it plays: the game's track is too long to decode whole.
struct Music {
    reader: Box<dyn Source>,
    format: Format,
    start: u64,
    frames: u64,
    next: u64,
    buffer: Vec<(f32, f32)>,
    // Position in `buffer`, in source frames.
    position: f64,
    step: f64,
}

impl Music {
    fn open(mut reader: Box<dyn Source>) -> Result<Self, String> {
        let (format, frames) = read_header(&mut reader)?;
        if frames == 0 {
            return Err("The music has no samples.".into());
        }
        let start = reader.stream_position().map_err(|e| e.to_string())?;
        Ok(Self {
            reader,
            format,
            start,
            frames,
            next: 0,
            buffer: Vec::new(),
            position: 0.0,
            step: format.rate as f64 / RATE as f64,
        })
    }

    fn frame(&mut self) -> (f32, f32) {
        while self.position as usize + 1 >= self.buffer.len() {
            self.refill();
        }
        let at = self.position as usize;
        let frame = mix(self.buffer[at], self.buffer[at + 1], self.position.fract() as f32);
        self.position += self.step;
        frame
    }

    // Reads the next block, wrapping to the start of the track.
    fn refill(&mut self) {
        let consumed = self.position as usize;
        self.buffer.drain(..consumed);
        self.position -= consumed as f64;
        let count = (self.frames - self.next).min(4096) as usize;
        let mut bytes = vec![0u8; count * self.format.frame_bytes()];
        // A read error plays silence rather than stopping the export.
        if self.reader.read_exact(&mut bytes).is_err() {
            bytes.fill(0);
        }
        let format = self.format;
        self.buffer.extend(bytes.chunks_exact(format.frame_bytes()).map(|frame| format.decode(frame)));
        self.next += count as u64;
        if self.next == self.frames {
            self.next = 0;
            let _ = self.reader.seek(SeekFrom::Start(self.start));
        }
    }
}

enum MusicFile {
    Path(PathBuf),
    #[cfg(test)]
    Bytes(Vec<u8>),
}

impl MusicFile {
    fn open(&self) -> Result<Music, String> {
        match self {
            Self::Path(path) => {
                let file = File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
                Music::open(Box::new(BufReader::new(file)))
            }
            #[cfg(test)]
            Self::Bytes(bytes) => Music::open(Box::new(std::io::Cursor::new(bytes.clone()))),
        }
    }
}

pub struct Sounds {
    music: MusicFile,
    fighting: Clip,
    produce: Clip,
    victory: Clip,
    defeat: Clip,
}

impl Sounds {
    /// Reads the sound effects from the game's `assets` folder.
    pub fn load(assets: &Path) -> Result<Self, String> {
        let clip = |name: &str| {
            let path = sound_path(assets, name);
            let file = File::open(&path).map_err(|e| format!("{}: {e}", path.display()))?;
            Clip::read(BufReader::new(file)).map_err(|e| format!("{}: {e}", path.display()))
        };
        let music = MusicFile::Path(sound_path(assets, "music"));
        music.open()?;
        Ok(Self {
            music,
            fighting: clip("fighting")?,
            produce: clip("produce_unit")?,
            victory: clip("victory")?,
            defeat: clip("defeat")?,
        })
    }
}

#[derive(Clone, Copy)]
enum Cue {
    Produce,
    Victory,
    Defeat,
}

struct Voice {
    cue: Cue,
    position: usize,
    gain: f32,
}

pub struct Mixer {
    sounds: Arc<Sounds>,
    music_volume: f32,
    sfx_volume: f32,
    frames_per_tick: f64,
    ticks: u64,
    rendered: u64,
    music: Option<Music>,
    counter: f64,
    // The fighting loop's position and volume once it has started.
    fighting: Option<(usize, f32)>,
    voices: Vec<Voice>,
}

impl Mixer {
    /// `speed` simulated ticks pass per video frame (30 per second at 1×).
    pub fn new(sounds: Arc<Sounds>, music_volume: f32, sfx_volume: f32, speed: u32) -> Result<Self, String> {
        let music = if music_volume > 0.0 { Some(sounds.music.open()?) } else { None };
        Ok(Self {
            sounds,
            music_volume,
            sfx_volume,
            frames_per_tick: RATE as f64 / (TICKS_PER_SECOND * speed.max(1) as f64),
            ticks: 0,
            rendered: 0,
            music,
            counter: 0.0,
            fighting: None,
            voices: Vec::new(),
        })
    }

    fn free_channels(&self) -> usize {
        CHANNELS - self.voices.len() - usize::from(self.fighting.is_some())
    }

    fn play(&mut self, cue: Cue, gain: f32) {
        if self.free_channels() > 0 {
            self.voices.push(Voice { cue, position: 0, gain });
        }
    }

    /// Audio for one simulated tick, as interleaved 16-bit stereo.
    pub fn tick(&mut self, fighting: u32, produced_sides: u32) -> Vec<i16> {
        for _ in 0..produced_sides.count_ones() {
            self.play(Cue::Produce, self.sfx_volume);
        }
        self.counter += 0.03 * (fighting as f64 - self.counter);
        let volume = ((self.counter.sqrt() / 5.0).min(1.0) / 3.0) as f32 * self.sfx_volume;
        if let Some((_, gain)) = &mut self.fighting {
            *gain = volume;
        } else if self.counter != 0.0 && self.free_channels() > 0 {
            self.fighting = Some((0, 0.2 * self.sfx_volume));
        }
        self.ticks += 1;
        let due = (self.ticks as f64 * self.frames_per_tick).round() as u64;
        let frames = due.saturating_sub(self.rendered) as usize;
        self.render(frames)
    }

    /// The end of the game, followed by `tail` seconds for the end sound.
    pub fn finish(&mut self, result: Option<f64>, tail: f64) -> Vec<i16> {
        self.fighting = None;
        self.music = None;
        match result {
            Some(result) if result == 0.0 => self.play(Cue::Defeat, 0.5 * self.sfx_volume),
            Some(_) => self.play(Cue::Victory, 0.5 * self.sfx_volume),
            None => {}
        }
        self.render((tail * RATE as f64).round() as usize)
    }

    fn render(&mut self, frames: usize) -> Vec<i16> {
        let mut output = Vec::with_capacity(frames * 2);
        let sounds = self.sounds.clone();
        for _ in 0..frames {
            let (mut left, mut right) = (0.0f32, 0.0f32);
            if let Some(music) = &mut self.music {
                let (l, r) = music.frame();
                left += l * self.music_volume;
                right += r * self.music_volume;
            }
            if let Some((position, gain)) = &mut self.fighting {
                let (l, r) = sounds.fighting.frame(*position);
                left += l * *gain;
                right += r * *gain;
                *position = (*position + 1) % sounds.fighting.frames();
            }
            for voice in &mut self.voices {
                let clip = match voice.cue {
                    Cue::Produce => &sounds.produce,
                    Cue::Victory => &sounds.victory,
                    Cue::Defeat => &sounds.defeat,
                };
                if voice.position < clip.frames() {
                    let (l, r) = clip.frame(voice.position);
                    left += l * voice.gain;
                    right += r * voice.gain;
                    voice.position += 1;
                }
            }
            output.push((left.clamp(-1.0, 1.0) * 32767.0) as i16);
            output.push((right.clamp(-1.0, 1.0) * 32767.0) as i16);
        }
        self.voices.retain(|voice| {
            let length = match voice.cue {
                Cue::Produce => sounds.produce.frames(),
                Cue::Victory => sounds.victory.frames(),
                Cue::Defeat => sounds.defeat.frames(),
            };
            voice.position < length
        });
        self.rendered += frames as u64;
        output
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    /// A WAV file with a JUNK chunk before the format, like the game's music.
    fn wav(tag: u16, bits: u16, channels: u16, rate: u32, samples: &[u8]) -> Vec<u8> {
        let mut bytes = b"RIFF\0\0\0\0WAVEJUNK\x04\0\0\0\0\0\0\0fmt \x10\0\0\0".to_vec();
        let align = channels * bits / 8;
        bytes.extend(tag.to_le_bytes());
        bytes.extend(channels.to_le_bytes());
        bytes.extend(rate.to_le_bytes());
        bytes.extend((rate * align as u32).to_le_bytes());
        bytes.extend(align.to_le_bytes());
        bytes.extend(bits.to_le_bytes());
        bytes.extend(b"data");
        bytes.extend((samples.len() as u32).to_le_bytes());
        bytes.extend(samples);
        bytes
    }

    fn constant(frames: usize, value: f32) -> Clip {
        Clip(vec![value; frames * 2])
    }

    fn sounds() -> Arc<Sounds> {
        Arc::new(Sounds {
            music: MusicFile::Bytes(wav(1, 16, 2, RATE, &[0; 40])),
            fighting: constant(10, 1.0),
            produce: constant(48_000, 0.01),
            victory: constant(10, 1.0),
            defeat: constant(10, -1.0),
        })
    }

    #[test]
    fn game_formats_decode_to_48_khz_stereo() {
        // 16-bit mono at 24 kHz: each frame doubles, mono plays on both sides.
        let mono = Clip::read(Cursor::new(wav(1, 16, 1, 24_000, &[0, 0x40, 0, 0xC0]))).unwrap();
        assert_eq!(mono.frames(), 4);
        assert_eq!(mono.frame(0), (0.5, 0.5));
        assert_eq!(mono.frame(1), (0.0, 0.0), "halfway between 0.5 and -0.5");
        // 32-bit float stereo, like fighting.wav.
        let samples: Vec<u8> = [0.25f32, -0.75].iter().flat_map(|s| s.to_le_bytes()).collect();
        let float = Clip::read(Cursor::new(wav(3, 32, 2, RATE, &samples))).unwrap();
        assert_eq!(float.frame(0), (0.25, -0.75));
        // 24-bit stereo, like the music; the stream wraps to the start.
        let mut music = Music::open(Box::new(Cursor::new(wav(1, 24, 2, RATE, &[0, 0, 0x40, 0, 0, 0xC0, 0, 0, 0x20, 0, 0, 0x20])))).unwrap();
        let frames: Vec<_> = (0..3).map(|_| music.frame()).collect();
        assert_eq!(frames, [(0.5, -0.5), (0.25, 0.25), (0.5, -0.5)]);
        assert!(Clip::read(Cursor::new(wav(2, 4, 2, RATE, &[0; 4]))).is_err(), "ADPCM is not supported");
    }

    #[test]
    fn fighting_follows_the_smoothed_combat_count() {
        let mut mixer = Mixer::new(sounds(), 0.0, 0.6, 1).unwrap();
        // One tick at 1× lasts 1/30 s.
        assert_eq!(mixer.tick(0, 0).len(), 1600 * 2);
        assert!(mixer.fighting.is_none());
        // The loop starts at 0.2 × sfx, then follows min(1, √s / 5) / 3 × sfx.
        let first = mixer.tick(100, 0);
        assert_eq!(first[0], (0.2 * 0.6 * 32767.0) as i16);
        mixer.tick(100, 0);
        let smoothed: f64 = 0.03 * 100.0 + 0.03 * (100.0 - 3.0);
        let expected = ((smoothed.sqrt() / 5.0).min(1.0) / 3.0 * 0.6) as f32;
        assert!((mixer.fighting.unwrap().1 - expected).abs() < 1e-6);
        for _ in 0..500 {
            mixer.tick(100, 0);
        }
        assert!((mixer.fighting.unwrap().1 - 0.2).abs() < 1e-6, "loudest is a third of sfx");
    }

    #[test]
    fn production_shares_eight_channels_and_the_end_sound_uses_the_result() {
        let mut mixer = Mixer::new(sounds(), 0.0, 1.0, 30).unwrap();
        mixer.tick(0, 0b1111);
        mixer.tick(0, 0b1111);
        mixer.tick(0, 0b1);
        assert_eq!(mixer.voices.len(), CHANNELS, "extra sounds are dropped");
        let mut mixer = Mixer::new(sounds(), 0.0, 1.0, 1).unwrap();
        assert_eq!(mixer.finish(Some(0.0), 0.001)[0], (-0.5 * 32767.0) as i16);
        let mut mixer = Mixer::new(sounds(), 0.0, 1.0, 1).unwrap();
        assert_eq!(mixer.finish(Some(-1.0), 0.001)[0], (0.5 * 32767.0) as i16);
    }

    #[test]
    fn faster_playback_shortens_each_tick() {
        let mut mixer = Mixer::new(sounds(), 1.0, 1.0, 4).unwrap();
        let total: usize = (0..120).map(|_| mixer.tick(0, 0).len() / 2).sum();
        assert_eq!(total, 48_000, "120 ticks at 4× are one second");
    }

    /// Decodes the installed game's sounds.
    #[test]
    #[ignore]
    fn installed_game_sounds_decode() {
        let assets = game_assets(&crate::installed_game_dirs()).expect("War of Dots is installed");
        let sounds = Sounds::load(&assets).unwrap();
        let seconds = |clip: &Clip| clip.frames() as f64 / RATE as f64;
        assert!((seconds(&sounds.fighting) - 55.08).abs() < 0.01);
        assert!((seconds(&sounds.produce) - 0.871).abs() < 0.01);
        assert!((seconds(&sounds.victory) - 1.809).abs() < 0.01);
        let mut music = sounds.music.open().unwrap();
        let loud = (0..RATE * 30).map(|_| music.frame().0.abs()).fold(0.0f32, f32::max);
        assert!(loud > 0.05 && loud <= 1.0, "music peak {loud}");
    }
}
