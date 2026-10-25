//! H.264/AAC MP4 encoding with OpenH264 and FDK AAC, compiled into the app so
//! every platform encodes the same way. A dedicated thread owns the encoders,
//! so rendering and encoding overlap.
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
/// start playing before it has fully downloaded. The MP4 writer puts the index
/// last, once every sample is known.
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

/// Converts top-down RGB24 to planar I420 with BT.709 limited-range coefficients,
/// averaging each 2×2 block for chroma. Bands of rows convert in parallel.
pub fn rgb_to_i420(rgb: &[u8], width: usize, height: usize, i420: &mut [u8]) {
    let threads = std::thread::available_parallelism().map_or(1, |n| n.get()).min(8);
    let rows = (height / 2).div_ceil(threads).max(1) * 2;
    let (luma, chroma) = i420.split_at_mut(width * height);
    let (blue, red) = chroma.split_at_mut(width * height / 4);
    std::thread::scope(|scope| {
        for (((rgb, luma), blue), red) in rgb
            .chunks(rows * width * 3)
            .zip(luma.chunks_mut(rows * width))
            .zip(blue.chunks_mut(rows / 2 * width / 2))
            .zip(red.chunks_mut(rows / 2 * width / 2))
        {
            scope.spawn(move || convert_band(rgb, width, luma, blue, red));
        }
    });
}

fn convert_band(rgb: &[u8], width: usize, luma: &mut [u8], blue: &mut [u8], red: &mut [u8]) {
    let height = luma.len() / width;
    for y in 0..height {
        let row = &rgb[y * width * 3..(y + 1) * width * 3];
        let out = &mut luma[y * width..(y + 1) * width];
        for x in 0..width {
            let (r, g, b) = (row[x * 3] as i32, row[x * 3 + 1] as i32, row[x * 3 + 2] as i32);
            out[x] = (((47 * r + 157 * g + 16 * b + 128) >> 8) + 16) as u8;
        }
    }
    let half = width / 2;
    for y in (0..height).step_by(2) {
        let (top, bottom) = (&rgb[y * width * 3..], &rgb[(y + 1) * width * 3..]);
        let (u, v) = (&mut blue[(y / 2) * half..(y / 2 + 1) * half], &mut red[(y / 2) * half..(y / 2 + 1) * half]);
        for x in 0..half {
            let a = x * 6;
            let sum = |k: usize| top[a + k] as i32 + top[a + 3 + k] as i32 + bottom[a + k] as i32 + bottom[a + 3 + k] as i32;
            let (r, g, b) = ((sum(0) + 2) / 4, (sum(1) + 2) / 4, (sum(2) + 2) / 4);
            u[x] = (((-26 * r - 86 * g + 112 * b + 128) >> 8) + 128).clamp(16, 240) as u8;
            v[x] = (((112 * r - 102 * g - 10 * b + 128) >> 8) + 128).clamp(16, 240) as u8;
        }
    }
}

/// Video sample times count thousandths of a frame.
const VIDEO_TIMESCALE: u32 = FRAME_RATE as u32 * 1000;
/// A keyframe every five seconds keeps seeking quick in players.
const KEYFRAME_INTERVAL: u32 = FRAME_RATE as u32 * 5;
const AUDIO_BITRATE: u32 = 192_000;
const AAC_FRAME: usize = 1024;

type Mp4File = mp4::Mp4Writer<std::io::BufWriter<std::fs::File>>;

/// The MP4 file opens once the first frame gives the H.264 parameter sets its
/// header needs; soundtrack frames encoded before then wait in `queued`.
struct Muxer {
    file: Option<Mp4File>,
    path: PathBuf,
    width: u32,
    height: u32,
    audio: bool,
    queued: Vec<Vec<u8>>,
}

impl Muxer {
    fn open(&mut self, sps: &[u8], pps: &[u8]) -> Result<(), String> {
        use mp4::{AacConfig, AvcConfig, ChannelConfig, MediaConfig, Mp4Config, SampleFreqIndex, TrackConfig, TrackType};
        let failed = |e: mp4::Error| format!("Could not start the video file: {e}");
        let output = std::fs::File::create(&self.path).map_err(|e| format!("Could not start the video file: {e}"))?;
        let brand = |name: &str| name.parse().expect("a four-letter brand");
        let mut file = mp4::Mp4Writer::write_start(
            std::io::BufWriter::with_capacity(1 << 20, output),
            &Mp4Config {
                major_brand: brand("isom"),
                minor_version: 512,
                compatible_brands: vec![brand("isom"), brand("iso2"), brand("avc1"), brand("mp41")],
                timescale: 1000,
            },
        )
        .map_err(failed)?;
        file.add_track(&TrackConfig {
            track_type: TrackType::Video,
            timescale: VIDEO_TIMESCALE,
            language: "und".into(),
            media_conf: MediaConfig::AvcConfig(AvcConfig {
                width: self.width as u16,
                height: self.height as u16,
                seq_param_set: sps.to_vec(),
                pic_param_set: pps.to_vec(),
            }),
        })
        .map_err(failed)?;
        if self.audio {
            file.add_track(&TrackConfig {
                track_type: TrackType::Audio,
                timescale: AUDIO_RATE as u32,
                language: "und".into(),
                media_conf: MediaConfig::AacConfig(AacConfig {
                    bitrate: AUDIO_BITRATE,
                    profile: mp4::AudioObjectType::AacLowComplexity,
                    freq_index: SampleFreqIndex::Freq48000,
                    chan_conf: ChannelConfig::Stereo,
                }),
            })
            .map_err(failed)?;
        }
        self.file = Some(file);
        for frame in std::mem::take(&mut self.queued) {
            self.audio_frame(frame)?;
        }
        Ok(())
    }

    fn sample(&mut self, track: u32, bytes: Vec<u8>, duration: u32, is_sync: bool) -> Result<(), String> {
        let file = self.file.as_mut().ok_or("The video file is not open.")?;
        file.write_sample(track, &mp4::Mp4Sample { start_time: 0, duration, rendering_offset: 0, is_sync, bytes: bytes.into() })
            .map_err(|e| format!("Could not write the video: {e}"))
    }

    fn audio_frame(&mut self, frame: Vec<u8>) -> Result<(), String> {
        if self.file.is_none() {
            self.queued.push(frame);
            return Ok(());
        }
        self.sample(2, frame, AAC_FRAME as u32, true)
    }
}

/// AAC-LC at 192 kbit/s in 1024-sample frames. The encoder's priming frames are
/// dropped so the soundtrack starts with the first video frame.
struct Soundtrack {
    encoder: fdk_aac::enc::Encoder,
    pcm: Vec<i16>,
    output: Vec<u8>,
    skip: usize,
    delay: usize,
}

impl Soundtrack {
    fn new() -> Result<Self, String> {
        use fdk_aac::enc::{AudioObjectType, BitRate, ChannelMode, Encoder, EncoderParams, Transport};
        let encoder = Encoder::new(EncoderParams {
            bit_rate: BitRate::Cbr(AUDIO_BITRATE),
            sample_rate: AUDIO_RATE as u32,
            transport: Transport::Raw,
            channels: ChannelMode::Stereo,
            audio_object_type: AudioObjectType::Mpeg4LowComplexity,
        })
        .map_err(|e| format!("Could not start the AAC encoder: {e:?}"))?;
        let info = encoder.info().map_err(|e| format!("Could not start the AAC encoder: {e:?}"))?;
        let delay = info.nDelay as usize;
        Ok(Self { encoder, pcm: Vec::new(), output: vec![0; (info.maxOutBufBytes as usize).max(8192)], skip: (delay + AAC_FRAME / 2) / AAC_FRAME, delay })
    }

    /// Encodes whole frames of interleaved stereo and hands each one to `emit`.
    fn push(&mut self, samples: &[i16], emit: &mut impl FnMut(Vec<u8>) -> Result<(), String>) -> Result<(), String> {
        self.pcm.extend_from_slice(samples);
        let frame = AAC_FRAME * 2;
        let mut start = 0;
        while self.pcm.len() - start >= frame {
            let info = self
                .encoder
                .encode(&self.pcm[start..start + frame], &mut self.output)
                .map_err(|e| format!("Audio encoding failed: {e:?}"))?;
            if info.input_consumed == 0 && info.output_size == 0 {
                return Err("The AAC encoder stopped accepting audio.".into());
            }
            start += info.input_consumed;
            if info.output_size > 0 {
                if self.skip > 0 {
                    self.skip -= 1;
                } else {
                    emit(self.output[..info.output_size].to_vec())?;
                }
            }
        }
        self.pcm.drain(..start);
        Ok(())
    }

    /// Pads the soundtrack with silence until the encoder has returned every sample.
    fn finish(&mut self, emit: &mut impl FnMut(Vec<u8>) -> Result<(), String>) -> Result<(), String> {
        let frames = (self.pcm.len() / 2).div_ceil(AAC_FRAME) + self.delay.div_ceil(AAC_FRAME);
        let padding = frames * AAC_FRAME * 2 - self.pcm.len();
        self.push(&vec![0; padding], emit)
    }
}

/// Splits Annex B output into NAL units without their start codes.
fn nal_units(data: &[u8]) -> impl Iterator<Item = &[u8]> {
    let mut starts = Vec::new();
    let mut i = 0;
    while i + 3 <= data.len() {
        if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
            starts.push(i + 3);
            i += 3;
        } else {
            i += 1;
        }
    }
    let ends: Vec<usize> = starts
        .iter()
        .skip(1)
        .map(|&next| {
            let mut end = next - 3;
            while end > 0 && data[end - 1] == 0 {
                end -= 1;
            }
            end
        })
        .chain(std::iter::once(data.len()))
        .collect();
    starts.into_iter().zip(ends).map(move |(start, end)| &data[start..end.max(start)])
}

fn encode(
    path: PathBuf,
    width: u32,
    height: u32,
    bitrate: u32,
    audio: bool,
    packets: Receiver<Packet>,
    ready: Sender<Result<(), String>>,
) -> Result<u64, String> {
    use openh264::encoder::{BitRate, Complexity, Encoder, EncoderConfig, FrameRate, IntraFramePeriod, Profile, RateControlMode, UsageType, VuiConfig};
    use openh264::OpenH264API;

    let config = EncoderConfig::new()
        .bitrate(BitRate::from_bps(bitrate))
        .max_frame_rate(FrameRate::from_hz(FRAME_RATE as f32))
        // OpenH264 rejects its non-real-time usages; this one still encodes every frame.
        .usage_type(UsageType::CameraVideoRealTime)
        .rate_control_mode(RateControlMode::Bitrate)
        .profile(Profile::High)
        .complexity(Complexity::Medium)
        .intra_frame_period(IntraFramePeriod::from_num_frames(KEYFRAME_INTERVAL))
        .skip_frames(false)
        // One thread per video is fastest; several videos convert at once instead.
        .num_threads(1)
        .vui(VuiConfig::bt709());
    let started = Encoder::with_api_config(OpenH264API::from_source(), config)
        .map_err(|e| format!("Could not start the H.264 encoder: {e}"))
        .and_then(|encoder| Ok((encoder, if audio { Some(Soundtrack::new()?) } else { None })));
    let (mut encoder, mut soundtrack) = match started {
        Ok(started) => started,
        Err(message) => {
            let _ = ready.send(Err(message.clone()));
            return Err(message);
        }
    };
    let _ = ready.send(Ok(()));

    let (w, h) = (width as usize, height as usize);
    // Colour conversion runs on its own thread, so the encoder never waits for it.
    // Video packets leave it as I420; spare buffers come back for reuse.
    let (converted, frames) = mpsc::sync_channel::<Packet>(2);
    let (recycle, spare) = mpsc::channel::<Vec<u8>>();
    let converter = std::thread::spawn(move || -> Result<(), String> {
        for packet in packets {
            let packet = match packet {
                Packet::Video(rgb) => {
                    if rgb.len() != w * h * 3 {
                        return Err("A recorded frame has the wrong size.".to_string());
                    }
                    let mut i420 = spare.try_recv().unwrap_or_else(|_| vec![0u8; w * h * 3 / 2]);
                    rgb_to_i420(&rgb, w, h, &mut i420);
                    Packet::Video(i420)
                }
                audio => audio,
            };
            if converted.send(packet).is_err() {
                break;
            }
        }
        Ok(())
    });
    let encoded = encode_packets(&mut encoder, soundtrack.as_mut(), frames, recycle, Muxer { file: None, path, width, height, audio, queued: Vec::new() });
    // An encoder error stops the converter at its next frame.
    let conversion = converter.join().unwrap_or_else(|_| Err("The video converter stopped unexpectedly.".into()));
    let count = encoded?;
    conversion?;
    Ok(count)
}

fn encode_packets(
    encoder: &mut openh264::encoder::Encoder,
    mut soundtrack: Option<&mut Soundtrack>,
    frames: Receiver<Packet>,
    recycle: Sender<Vec<u8>>,
    mut muxer: Muxer,
) -> Result<u64, String> {
    use openh264::formats::YUVSlices;
    let (w, h) = (muxer.width as usize, muxer.height as usize);
    let (mut count, mut carried) = (0u64, 0u32);
    for packet in frames {
        match packet {
            Packet::Video(i420) => {
                let (luma, chroma) = i420.split_at(w * h);
                let (blue, red) = chroma.split_at(w * h / 4);
                let yuv = YUVSlices::new((luma, blue, red), (w, h), (w, w / 2, w / 2));
                let stream = encoder.encode(&yuv).map_err(|e| format!("Video encoding failed: {e}"))?;
                let is_sync = matches!(stream.frame_type(), openh264::encoder::FrameType::IDR);
                let (mut sps, mut pps, mut sample) = (None, None, Vec::new());
                for layer in (0..stream.num_layers()).filter_map(|i| stream.layer(i)) {
                    for unit in (0..layer.nal_count()).filter_map(|i| layer.nal_unit(i)).flat_map(nal_units) {
                        match unit.first().map(|byte| byte & 0x1f) {
                            Some(7) => sps = Some(unit.to_vec()),
                            Some(8) => pps = Some(unit.to_vec()),
                            Some(_) => {
                                sample.extend_from_slice(&(unit.len() as u32).to_be_bytes());
                                sample.extend_from_slice(unit);
                            }
                            None => {}
                        }
                    }
                }
                let _ = recycle.send(i420);
                if muxer.file.is_none() {
                    let (Some(sps), Some(pps)) = (sps, pps) else {
                        return Err("The H.264 encoder did not describe its first frame.".to_string());
                    };
                    muxer.open(&sps, &pps)?;
                }
                // A frame the encoder dropped lengthens the next one, so later frames keep their time.
                carried += 1000;
                if !sample.is_empty() {
                    muxer.sample(1, sample, carried, is_sync)?;
                    carried = 0;
                }
                count += 1;
            }
            Packet::Audio(samples) => {
                if let Some(soundtrack) = soundtrack.as_mut() {
                    soundtrack.push(&samples, &mut |frame| muxer.audio_frame(frame))?;
                }
            }
        }
    }
    if count == 0 {
        return Ok(0);
    }
    if let Some(soundtrack) = soundtrack.as_mut() {
        soundtrack.finish(&mut |frame| muxer.audio_frame(frame))?;
    }
    let mut file = muxer.file.take().ok_or("The video file is not open.")?;
    file.write_end().map_err(|e| format!("Could not finish the video: {e}"))?;
    use std::io::Write;
    file.into_writer().flush().map_err(|e| format!("Could not finish the video: {e}"))?;
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn i420_uses_bt709_limited_range() {
        // Two rows of white, black, red and blue pixel pairs.
        let mut rgb = Vec::new();
        for _ in 0..2 {
            for color in [[255, 255, 255], [0, 0, 0], [255, 0, 0], [0, 0, 255]] {
                rgb.extend(color);
                rgb.extend(color);
            }
        }
        let mut i420 = vec![0; 8 * 2 * 3 / 2];
        rgb_to_i420(&rgb, 8, 2, &mut i420);
        assert_eq!(&i420[..8], &[235, 235, 16, 16, 63, 63, 32, 32]);
        // White and black have neutral chroma; red is high Cr, blue high Cb.
        assert_eq!(&i420[16..20], &[128, 128, 102, 240]);
        assert_eq!(&i420[20..], &[128, 128, 240, 118]);
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
