//! Offline War of Dots replay simulator. It reads .rep files, simulates them by the
//! game's rules and writes the states the player and the video exporter draw.

pub mod contours;
pub mod deployments;
pub mod economy;
#[cfg(feature = "render")]
pub mod frame_draws;
pub mod geom;
pub mod grid;
pub mod movement;
pub mod num;
pub mod output;
#[cfg(feature = "render")]
pub mod render;
pub mod replay;
pub mod sim;
pub mod surface;
pub mod territory;
#[cfg(feature = "render")]
pub mod text;
#[cfg(feature = "render")]
pub mod video;
pub mod visual_random;
