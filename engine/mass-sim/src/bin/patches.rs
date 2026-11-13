//! Each side's supply regions at the first payment (tick 1), as JSON: for every region,
//! its units outside a city, its cities and its balance (5 per city minus 1 per unit).
//! scripts/big-maps.py uses it to give every region one city per five units.
//!   mass-patches <replay.rep> [ticks]   (units' health after that many idle ticks)
use mass_sim::replay::{parse_replay_bytes, Replay};
use mass_sim::sim::Simulator;
use mass_sim::surface::MapFiles;
use std::path::Path;

fn main() -> Result<(), String> {
    let path = std::env::args().nth(1).ok_or("Usage: mass-patches <replay.rep> [ticks]")?;
    let ticks: i32 = std::env::args().nth(2).and_then(|t| t.parse().ok()).unwrap_or(2);
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let root = parse_replay_bytes(&bytes)?;
    let replay = Replay::from_json(&root, Path::new(""), &mut MapFiles::default())?;
    let mut sim = Simulator::new(replay);
    sim.live_tick(0);
    sim.live_tick(1);
    let economy = sim.economy.clone_groups();
    for tick in 2..ticks {
        sim.live_tick(tick);
    }
    let economy = &economy;
    let mut sides = Vec::new();
    for side in 0..economy.dot_groups.len() {
        let mut regions = Vec::new();
        for (group, dots) in economy.dot_groups[side].iter().enumerate() {
            let paid: Vec<usize> = dots.iter().copied().filter(|&id| !sim.replay.units[id].in_city && !sim.replay.units[id].ship).collect();
            let cities = &economy.city_groups[side][group];
            regions.push(serde_json::json!({ "units": paid, "cities": cities }));
        }
        sides.push(regions);
    }
    let units: Vec<serde_json::Value> = sim.replay.units.iter().map(|u| serde_json::json!([u.owner, u.health, u.active])).collect();
    println!("{}", serde_json::json!({ "sides": sides, "units": units }));
    Ok(())
}
