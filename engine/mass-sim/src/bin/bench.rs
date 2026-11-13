//! Times the engine on a replay: every unit is ordered two thirds of the way to the
//! enemy capital at tick 15, then the match runs for the given ticks.
//!   mass-bench <replay.rep> [ticks] [groups]   (groups: 400 units a side ordered each turn)
use mass_sim::geom::Vec2;
use mass_sim::replay::{parse_replay_bytes, Order, Replay};
use mass_sim::sim::{Simulator, PHASES};
use mass_sim::surface::MapFiles;
use std::path::Path;

fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    let path = args.get(1).ok_or("Usage: mass-bench <replay.rep> [ticks] [groups]")?;
    let ticks: i32 = args.get(2).map(|t| t.parse().unwrap_or(900)).unwrap_or(900);
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let started = std::time::Instant::now();
    let root = parse_replay_bytes(&bytes)?;
    let replay = Replay::from_json(&root, Path::new(""), &mut MapFiles::default())?;
    let capitals: Vec<Vec2> = replay.map.capitals.iter().map(|&c| replay.map.cities[c as usize]).collect();
    let mut sim = Simulator::new(replay);
    println!("loaded in {:.0} ms, {} units", started.elapsed().as_secs_f64() * 1000.0, sim.replay.units.len());
    let started = std::time::Instant::now();
    // "groups": each turn both sides order 400 units 150 pixels towards the enemy
    // capital, as in a match; otherwise every unit marches at tick 15.
    let groups = args.get(3).map(|m| m == "groups").unwrap_or(false);
    for tick in 0..ticks {
        if groups && tick % 15 == 0 && tick > 0 {
            let per_side = sim.replay.units.len() / 2;
            let start = (tick as usize * 977) % per_side;
            let orders: Vec<Order> = sim
                .replay
                .units
                .iter()
                .filter(|u| u.alive() && (u.id % per_side + per_side - start) % per_side < 400)
                .map(|u| {
                    let target = capitals[1 - u.owner];
                    let delta = target - u.position;
                    let step = delta * (150.0 / delta.length().max(1.0));
                    Order { unit_id: u.id as i32, points: vec![u.position, u.position + step] }
                })
                .collect();
            for order in orders {
                sim.queue_order(tick, order);
            }
        }
        if !groups && tick == 15 {
            let orders: Vec<Order> = sim
                .replay
                .units
                .iter()
                .map(|u| {
                    let target = capitals[1 - u.owner];
                    let via = (u.position * 2.0 + target) * (1.0 / 3.0);
                    Order { unit_id: u.id as i32, points: vec![u.position, via, target] }
                })
                .collect();
            for order in orders {
                sim.queue_order(tick, order);
            }
        }
        sim.live_tick(tick);
    }
    let total = started.elapsed().as_secs_f64() * 1000.0;
    println!("{:.2} ms a tick over {} ticks", total / ticks as f64, ticks);
    for (name, ms) in PHASES.iter().zip(sim.timings) {
        println!("  {:<10} {:.2} ms a tick", name, ms / ticks as f64);
    }
    let regions = sim.territory.regions.clone().unwrap();
    let started = std::time::Instant::now();
    for side in 0..2u8 {
        mass_sim::contours::extract(&regions, side, sim.territory.width, sim.territory.height);
    }
    println!("  contours   {:.2} ms for both sides", started.elapsed().as_secs_f64() * 1000.0);
    let alive = sim.replay.units.iter().filter(|u| u.active).count();
    println!("{} units alive, territory version {}", alive, sim.territory.version);
    Ok(())
}
