//! H.264/AAC MP4 encoding with Windows Media Foundation, which ships with Windows.
//! A dedicated thread owns the COM objects, so rendering and encoding overlap
//! and the encoder never crosses threads.
use std::{
    io::Read,
    path::{Path, PathBuf},
    sync::mpsc::{self, Receiver, Sender, SyncSender},
    thread::JoinHandle,
};

pub const FRAME_RATE: u64 = 30;
pub const AUDIO_RATE: u64 = crate::audio::RATE as u64;

enum Packet {
    Video(Vec<u8>),
    // Interleaved 16-bit stereo at AUDIO_RATE.
    Audio(Vec<i16>),
}

pub struct VideoEncoder {
    path: PathBuf,
    frames: Option<SyncSender<Packet>>,
    worker: Option<JoinHandle<Result<u64, String>>>,
}

/// Sends audio to an encoder from another thread.
#[derive(Clone)]
pub struct AudioInput(SyncSender<Packet>);

impl AudioInput {
    pub fn push(&self, samples: Vec<i16>) -> Result<(), String> {
        self.0.send(Packet::Audio(samples)).map_err(|_| "The video encoder stopped.".to_string())
    }
}

impl VideoEncoder {
    /// Starts an MP4 file at `path` that accepts top-down RGB24 frames and, with
    /// `audio`, a stereo soundtrack.
    pub fn start(path: &Path, width: u32, height: u32, bitrate: u32, audio: bool) -> Result<Self, String> {
        if width % 2 != 0 || height % 2 != 0 {
            return Err("Video dimensions must be even.".into());
        }
        // A few frames of slack keep the renderer busy while one is being encoded.
        let (frames, receiver) = mpsc::sync_channel::<Packet>(3);
        let (ready, started) = mpsc::channel();
        let worker = std::thread::spawn({
            let path = path.to_path_buf();
            move || encode(path, width, height, bitrate, audio, receiver, ready)
        });
        match started.recv() {
            Ok(Ok(())) => Ok(Self {
                path: path.to_path_buf(),
                frames: Some(frames),
                worker: Some(worker),
            }),
            Ok(Err(error)) => {
                let _ = worker.join();
                Err(error)
            }
            Err(_) => Err(join(worker).err().unwrap_or_else(|| "The video encoder stopped.".into())),
        }
    }

    pub fn audio_input(&self) -> Option<AudioInput> {
        self.frames.clone().map(AudioInput)
    }

    pub fn push(&mut self, rgb: Vec<u8>) -> Result<(), String> {
        let sent = self
            .frames
            .as_ref()
            .ok_or("The video encoder stopped.")?
            .send(Packet::Video(rgb));
        if sent.is_err() {
            // The worker only drops its receiver when it fails; report why.
            self.frames.take();
            return Err(self
                .worker
                .take()
                .map(join)
                .and_then(Result::err)
                .unwrap_or_else(|| "The video encoder stopped.".into()));
        }
        Ok(())
    }

    /// Writes the remaining frames and closes the file. Returns the frame count.
    pub fn finish(mut self) -> Result<u64, String> {
        self.frames.take();
        let frames = self
            .worker
            .take()
            .map(join)
            .unwrap_or_else(|| Err("The video encoder stopped.".into()))?;
        faststart(&self.path).map_err(|e| format!("Could not finish the video: {e}"))?;
        Ok(frames)
    }
}

impl Drop for VideoEncoder {
    fn drop(&mut self) {
        self.frames.take();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

/// Moves the MP4 index (`moov`) in front of the media (`mdat`) so a video can
/// start playing before it has fully downloaded. Media Foundation writes the
/// index last; its own option for this produced unreadable files.
pub fn faststart(path: &Path) -> std::io::Result<()> {
    use std::io::{Error, ErrorKind, Seek, SeekFrom, Write};
    let mut file = std::fs::File::open(path)?;
    let length = file.metadata()?.len();
    let mut boxes = Vec::new();
    let mut offset = 0;
    while offset + 8 <= length {
        let mut header = [0u8; 16];
        file.seek(SeekFrom::Start(offset))?;
        file.read_exact(&mut header[..8])?;
        let mut size = u32::from_be_bytes(header[..4].try_into().unwrap()) as u64;
        if size == 1 {
            file.read_exact(&mut header[8..])?;
            size = u64::from_be_bytes(header[8..].try_into().unwrap());
        } else if size == 0 {
            size = length - offset;
        }
        if size < 8 || offset + size > length {
            return Err(Error::new(ErrorKind::InvalidData, "malformed MP4 box"));
        }
        boxes.push((offset, size, [header[4], header[5], header[6], header[7]]));
        offset += size;
    }
    let position = |name: &[u8; 4]| boxes.iter().position(|(_, _, kind)| kind == name);
    let (Some(moov), Some(mdat)) = (position(b"moov"), position(b"mdat")) else {
        return Err(Error::new(ErrorKind::InvalidData, "MP4 has no index or media"));
    };
    if moov < mdat {
        return Ok(());
    }
    let (moov_offset, moov_size, _) = boxes[moov];
    let mut index = vec![0u8; moov_size as usize];
    file.seek(SeekFrom::Start(moov_offset))?;
    file.read_exact(&mut index)?;
    shift_chunk_offsets(&mut index[8..], moov_size)?;
    let temporary = path.with_extension("faststart.tmp");
    let result = (|| {
        let mut output = std::io::BufWriter::with_capacity(1 << 20, std::fs::File::create(&temporary)?);
        for (number, &(start, size, _)) in boxes.iter().enumerate() {
            if number == moov {
                continue;
            }
            if number == mdat {
                output.write_all(&index)?;
            }
            file.seek(SeekFrom::Start(start))?;
            std::io::copy(&mut (&mut file).take(size), &mut output)?;
        }
        output.flush()?;
        drop(file);
        std::fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

// Every chunk offset moves forward by the size of the relocated index.
fn shift_chunk_offsets(data: &mut [u8], shift: u64) -> std::io::Result<()> {
    use std::io::{Error, ErrorKind};
    let invalid = || Error::new(ErrorKind::InvalidData, "malformed MP4 index");
    let mut offset = 0;
    while offset + 8 <= data.len() {
        let size = u32::from_be_bytes(data[offset..offset + 4].try_into().unwrap()) as usize;
        if size < 8 || offset + size > data.len() {
            return Err(invalid());
        }
        let kind: [u8; 4] = data[offset + 4..offset + 8].try_into().unwrap();
        let body = &mut data[offset + 8..offset + size];
        match &kind {
            b"trak" | b"mdia" | b"minf" | b"stbl" => shift_chunk_offsets(body, shift)?,
            b"stco" | b"co64" => {
                let wide = &kind == b"co64";
                let count = u32::from_be_bytes(body.get(4..8).ok_or_else(invalid)?.try_into().unwrap()) as usize;
                let width = if wide { 8 } else { 4 };
                let entries = body.get_mut(8..8 + count * width).ok_or_else(invalid)?;
                for entry in entries.chunks_mut(width) {
                    if wide {
                        let value = u64::from_be_bytes(entry.try_into().unwrap()) + shift;
                        entry.copy_from_slice(&value.to_be_bytes());
                    } else {
                        let value = u32::from_be_bytes(entry.try_into().unwrap()) as u64 + shift;
                        let value = u32::try_from(value).map_err(|_| Error::new(ErrorKind::InvalidData, "video too large for fast start"))?;
                        entry.copy_from_slice(&value.to_be_bytes());
                    }
                }
            }
            _ => {}
        }
        offset += size;
    }
    Ok(())
}

fn join(worker: JoinHandle<Result<u64, String>>) -> Result<u64, String> {
    worker
        .join()
        .unwrap_or_else(|_| Err("The video encoder stopped unexpectedly.".into()))
}

/// Converts top-down RGB24 to NV12 with BT.709 limited-range coefficients,
/// averaging each 2×2 block for chroma. Bands of rows convert in parallel.
pub fn rgb_to_nv12(rgb: &[u8], width: usize, height: usize, nv12: &mut [u8]) {
    let threads = std::thread::available_parallelism().map_or(1, |n| n.get()).min(8);
    let rows = (height / 2).div_ceil(threads).max(1) * 2;
    let (luma, chroma) = nv12.split_at_mut(width * height);
    std::thread::scope(|scope| {
        for ((rgb, luma), chroma) in rgb
            .chunks(rows * width * 3)
            .zip(luma.chunks_mut(rows * width))
            .zip(chroma.chunks_mut(rows / 2 * width))
        {
            scope.spawn(move || convert_band(rgb, width, luma, chroma));
        }
    });
}

fn convert_band(rgb: &[u8], width: usize, luma: &mut [u8], chroma: &mut [u8]) {
    let height = luma.len() / width;
    for y in 0..height {
        let row = &rgb[y * width * 3..(y + 1) * width * 3];
        let out = &mut luma[y * width..(y + 1) * width];
        for x in 0..width {
            let (r, g, b) = (row[x * 3] as i32, row[x * 3 + 1] as i32, row[x * 3 + 2] as i32);
            out[x] = (((47 * r + 157 * g + 16 * b + 128) >> 8) + 16) as u8;
        }
    }
    for y in (0..height).step_by(2) {
        let (top, bottom) = (&rgb[y * width * 3..], &rgb[(y + 1) * width * 3..]);
        let out = &mut chroma[(y / 2) * width..(y / 2 + 1) * width];
        for x in (0..width).step_by(2) {
            let (a, c) = (x * 3, x * 3);
            let sum = |k: usize| top[a + k] as i32 + top[a + 3 + k] as i32 + bottom[c + k] as i32 + bottom[c + 3 + k] as i32;
            let (r, g, b) = ((sum(0) + 2) / 4, (sum(1) + 2) / 4, (sum(2) + 2) / 4);
            out[x] = (((-26 * r - 86 * g + 112 * b + 128) >> 8) + 128).clamp(16, 240) as u8;
            out[x + 1] = (((112 * r - 102 * g - 10 * b + 128) >> 8) + 128).clamp(16, 240) as u8;
        }
    }
}

#[cfg(windows)]
fn encode(
    path: PathBuf,
    width: u32,
    height: u32,
    bitrate: u32,
    audio: bool,
    packets: Receiver<Packet>,
    ready: Sender<Result<(), String>>,
) -> Result<u64, String> {
    use windows::Win32::Media::MediaFoundation::*;
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

    unsafe {
        let com = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
        if let Err(error) = MFStartup(MF_VERSION, MFSTARTUP_NOSOCKET) {
            let message = format!(
                "Windows video encoding is unavailable ({error}). On Windows N editions, install the Media Feature Pack."
            );
            let _ = ready.send(Err(message.clone()));
            if com {
                CoUninitialize();
            }
            return Err(message);
        }
        let result = (|| {
            let writer = match open_writer(&path, width, height, bitrate, audio) {
                Ok(writer) => writer,
                Err(error) => {
                    let message = format!("Could not start the H.264 encoder: {error}");
                    let _ = ready.send(Err(message.clone()));
                    return Err(message);
                }
            };
            let _ = ready.send(Ok(()));
            let (w, h) = (width as usize, height as usize);
            let mut nv12 = vec![0u8; w * h * 3 / 2];
            let (mut count, mut audio_frames) = (0u64, 0u64);
            for packet in packets {
                match packet {
                    Packet::Video(rgb) => {
                        if rgb.len() != w * h * 3 {
                            return Err("A recorded frame has the wrong size.".to_string());
                        }
                        rgb_to_nv12(&rgb, w, h, &mut nv12);
                        let (start, end) = (count * 10_000_000 / FRAME_RATE, (count + 1) * 10_000_000 / FRAME_RATE);
                        write_sample(&writer, 0, &nv12, start, end).map_err(|e| format!("Video encoding failed: {e}"))?;
                        count += 1;
                    }
                    Packet::Audio(samples) if audio && !samples.is_empty() => {
                        let bytes: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
                        let start = audio_frames * 10_000_000 / AUDIO_RATE;
                        audio_frames += samples.len() as u64 / 2;
                        let end = audio_frames * 10_000_000 / AUDIO_RATE;
                        write_sample(&writer, 1, &bytes, start, end).map_err(|e| format!("Audio encoding failed: {e}"))?;
                    }
                    Packet::Audio(_) => {}
                }
            }
            if count > 0 {
                writer.Finalize().map_err(|e| format!("Could not finish the video: {e}"))?;
            }
            Ok(count)
        })();
        let _ = MFShutdown();
        if com {
            CoUninitialize();
        }
        result
    }
}

#[cfg(windows)]
unsafe fn open_writer(
    path: &Path,
    width: u32,
    height: u32,
    bitrate: u32,
    audio: bool,
) -> windows::core::Result<windows::Win32::Media::MediaFoundation::IMFSinkWriter> {
    use windows::core::HSTRING;
    use windows::Win32::Media::MediaFoundation::*;

    let size = ((width as u64) << 32) | height as u64;
    let rate = (FRAME_RATE << 32) | 1;
    let video_type = |subtype: &windows::core::GUID| -> windows::core::Result<IMFMediaType> {
        let media = MFCreateMediaType()?;
        media.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
        media.SetGUID(&MF_MT_SUBTYPE, subtype)?;
        media.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
        media.SetUINT64(&MF_MT_FRAME_SIZE, size)?;
        media.SetUINT64(&MF_MT_FRAME_RATE, rate)?;
        media.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, (1 << 32) | 1)?;
        media.SetUINT32(&MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709.0 as u32)?;
        media.SetUINT32(&MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709.0 as u32)?;
        media.SetUINT32(&MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709.0 as u32)?;
        media.SetUINT32(&MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235.0 as u32)?;
        Ok(media)
    };
    let output = video_type(&MFVideoFormat_H264)?;
    output.SetUINT32(&MF_MT_AVG_BITRATE, bitrate)?;
    output.SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_High.0 as u32)?;
    let input = video_type(&MFVideoFormat_NV12)?;
    input.SetUINT32(&MF_MT_DEFAULT_STRIDE, width)?;

    let mut attributes = None;
    MFCreateAttributes(&mut attributes, 2)?;
    let attributes = attributes.ok_or_else(windows::core::Error::empty)?;
    attributes.SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1)?;
    // Offline encoding: write as fast as frames arrive rather than in real time.
    attributes.SetUINT32(&MF_SINK_WRITER_DISABLE_THROTTLING, 1)?;
    let writer = MFCreateSinkWriterFromURL(&HSTRING::from(path.as_os_str()), None, &attributes)?;
    let stream = writer.AddStream(&output)?;
    writer.SetInputMediaType(stream, &input, None)?;
    if audio {
        let audio_type = |subtype: &windows::core::GUID| -> windows::core::Result<IMFMediaType> {
            let media = MFCreateMediaType()?;
            media.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)?;
            media.SetGUID(&MF_MT_SUBTYPE, subtype)?;
            media.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)?;
            media.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, AUDIO_RATE as u32)?;
            media.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, 2)?;
            Ok(media)
        };
        // 192 kbit/s, the highest rate the Windows AAC encoder offers.
        let output = audio_type(&MFAudioFormat_AAC)?;
        output.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 24_000)?;
        let input = audio_type(&MFAudioFormat_PCM)?;
        input.SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, 4)?;
        input.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, AUDIO_RATE as u32 * 4)?;
        let stream = writer.AddStream(&output)?;
        writer.SetInputMediaType(stream, &input, None)?;
    }
    writer.BeginWriting()?;
    Ok(writer)
}

#[cfg(windows)]
// Times are in Media Foundation's 100 ns units.
unsafe fn write_sample(
    writer: &windows::Win32::Media::MediaFoundation::IMFSinkWriter,
    stream: u32,
    bytes: &[u8],
    start: u64,
    end: u64,
) -> windows::core::Result<()> {
    use windows::Win32::Media::MediaFoundation::*;

    let buffer = MFCreateMemoryBuffer(bytes.len() as u32)?;
    let mut data = std::ptr::null_mut();
    buffer.Lock(&mut data, None, None)?;
    std::ptr::copy_nonoverlapping(bytes.as_ptr(), data, bytes.len());
    buffer.Unlock()?;
    buffer.SetCurrentLength(bytes.len() as u32)?;
    let sample = MFCreateSample()?;
    sample.AddBuffer(&buffer)?;
    sample.SetSampleTime(start as i64)?;
    sample.SetSampleDuration((end - start) as i64)?;
    writer.WriteSample(stream, &sample)
}

#[cfg(not(windows))]
fn encode(
    _: PathBuf,
    _: u32,
    _: u32,
    _: u32,
    _: bool,
    _: Receiver<Packet>,
    ready: Sender<Result<(), String>>,
) -> Result<u64, String> {
    let message = "Video recording requires Windows.".to_string();
    let _ = ready.send(Err(message.clone()));
    Err(message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nv12_uses_bt709_limited_range() {
        // Two rows of white, black, red and blue pixel pairs.
        let mut rgb = Vec::new();
        for _ in 0..2 {
            for color in [[255, 255, 255], [0, 0, 0], [255, 0, 0], [0, 0, 255]] {
                rgb.extend(color);
                rgb.extend(color);
            }
        }
        let mut nv12 = vec![0; 8 * 2 * 3 / 2];
        rgb_to_nv12(&rgb, 8, 2, &mut nv12);
        assert_eq!(&nv12[..8], &[235, 235, 16, 16, 63, 63, 32, 32]);
        // White and black have neutral chroma; red is high Cr, blue high Cb.
        assert_eq!(&nv12[16..], &[128, 128, 128, 128, 102, 240, 240, 118]);
    }

    #[test]
    fn encodes_a_short_mp4() {
        let directory = tempfile::tempdir().unwrap();
        // Recording reserves an empty temporary file before the encoder opens it.
        let path = directory.path().join("clip.mp4");
        std::fs::write(&path, b"").unwrap();
        let mut encoder = VideoEncoder::start(&path, 320, 180, 1_000_000, true).unwrap();
        let audio = encoder.audio_input().unwrap();
        for frame in 0..30u32 {
            let shade = (frame * 8) as u8;
            encoder.push(vec![shade; 320 * 180 * 3]).unwrap();
            // A 440 Hz tone, one video frame long.
            audio.push((0..1600).flat_map(|i| {
                let t = (frame * 1600 + i) as f32 / AUDIO_RATE as f32;
                let s = ((t * 440.0 * std::f32::consts::TAU).sin() * 8000.0) as i16;
                [s, s]
            }).collect()).unwrap();
        }
        drop(audio);
        assert_eq!(encoder.finish().unwrap(), 30);
        let bytes = std::fs::read(&path).unwrap();
        assert!(bytes.len() > 1000);
        assert_eq!(&bytes[4..8], b"ftyp");
        let find = |tag: &[u8]| bytes.windows(4).position(|window| window == tag).unwrap();
        assert!(find(b"moov") < find(b"mdat"), "the index must precede the media for fast start");
        assert!(bytes.windows(4).any(|window| window == b"mp4a"), "the soundtrack is AAC");
    }
}
