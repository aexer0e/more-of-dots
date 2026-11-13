//! The War of Dots engine for the site's big maps: a copy of replay-sim (the game's
//! rules, matched to its recorded replays) made fast for thousands of units a side.
//! The game's maps keep replay-sim; only replays that name their own battlefield size
//! run here. Changes from replay-sim are marked "mass-sim:".

pub mod contours;
pub mod deployments;
pub mod economy;
pub mod geom;
pub mod grid;
pub mod movement;
pub mod num;
pub mod output;
pub mod replay;
pub mod sim;
pub mod surface;
pub mod territory;
pub mod visual_random;
