# Third-party software

More of Dots includes the following libraries. Their licence texts are in this folder.

| Library | Used for | Licence | Source |
|---|---|---|---|
| tiny-skia | Drawing video frames and reference snapshots | BSD-3-Clause | https://github.com/RazrFalcon/tiny-skia |
| ttf-parser | Reading the system font for player names and stats | MIT (chosen from MIT or Apache-2.0) | https://github.com/harfbuzz/ttf-parser |
| OpenH264 | H.264 video in exported MP4 files | BSD-2-Clause | https://github.com/cisco/openh264 |
| Fraunhofer FDK AAC | AAC audio in exported MP4 files | Software License for the Fraunhofer FDK AAC Codec Library for Android | https://github.com/mstorsjo/fdk-aac |

The FDK AAC library is used unmodified, as packaged by the `fdk-aac-sys` Rust crate. Its complete source code is available free of charge at the address above and in that crate. The FDK AAC licence grants no patent rights.

Player names and stats are drawn with Arial Narrow or Arial from the system's fonts; no font is bundled.

No music or sound effects are bundled. Replays and exported videos play War of Dots' own sounds (`assets/music/won.wav` and `assets/sound_effects/*.wav`) from the installed game, in place.
