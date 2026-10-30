//! The replay simulation: orders, movement, combat, territory and economy per tick.

use crate::economy::Economy;
use crate::geom::{trunc_i32, Vec2};
use crate::grid::{Grid, CELL, HEAL_CELL};
use crate::movement;
use crate::num::python_round;
use crate::replay::{Order, Replay, Unit, UnitType};
use crate::surface::{MapSurface, Terrain};
use crate::territory::Territory;
use crate::visual_random::VisualRandom;
use std::collections::{BTreeMap, HashMap};

const CONTACT: f64 = 36.0;

/// A source of the simulation's random draws: the game's generator, or a fixed
/// sequence in tests.
pub trait Random {
    fn next(&mut self) -> f64;
}

impl<F: FnMut() -> f64> Random for F {
    fn next(&mut self) -> f64 {
        self()
    }
}

/// The game's xorshift32 generator.
pub struct Rng(pub u32);

impl Random for Rng {
    fn next(&mut self) -> f64 {
        Rng::next(self)
    }
}

impl Rng {
    #[allow(clippy::should_implement_trait)]
    pub fn next(&mut self) -> f64 {
        let mut s = self.0;
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        self.0 = s;
        s as f64 / 4294967296.0
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Death {
    pub frame: i32,
    pub position: Vec2,
    pub color: usize,
    pub kind: UnitType,
    pub ship: bool,
}

#[derive(Clone, Copy)]
pub struct RunOptions {
    pub max_frame: Option<i32>,
    pub sample_every: i32,
    pub no_combat: bool,
    pub render_state: bool,
}

pub struct Simulator {
    pub replay: Replay,
    pub territory: Territory,
    pub economy: Economy,
    pub rng: Rng,
    pub strength: Vec<i32>,
    pub troop_casualties: Vec<i32>,
    pub casualties: Vec<i32>,
    pub deaths: Vec<Death>,
    recorded_deaths: Vec<bool>,
    visual_random: VisualRandom,
    pub render_state: bool,
    /// Sound cues for the latest tick: units in combat, and the sides that produced
    /// units since the last written frame (bit per side).
    pub fight_count: i32,
    produced_sides: i32,
    pending_orders: HashMap<i32, Vec<Order>>,
    deferred_orders: BTreeMap<i32, Order>,
    pub deferred_order_count: i32,
    scratch: movement::Scratch,
    damage: Vec<f64>,
    grid: Grid,
    heal_grid: Grid,
    living: Vec<usize>,
    near: Vec<usize>,
}

impl Simulator {
    pub fn new(mut replay: Replay) -> Simulator {
        let sides = replay.side_count();
        let territory = Territory::new(replay.map.width, replay.map.height, sides, &replay.units, &replay.map.cities);
        let economy = Economy::new(&replay, &territory);
        let pending_orders = std::mem::take(&mut replay.orders);
        Simulator {
            replay,
            territory,
            economy,
            rng: Rng(1),
            strength: vec![0; sides],
            troop_casualties: vec![0; sides],
            casualties: vec![0; sides],
            deaths: Vec::new(),
            recorded_deaths: Vec::new(),
            visual_random: VisualRandom::new(1729),
            render_state: false,
            fight_count: 0,
            produced_sides: 0,
            pending_orders,
            deferred_orders: BTreeMap::new(),
            deferred_order_count: 0,
            scratch: movement::Scratch::default(),
            damage: Vec::new(),
            grid: Grid::new(CELL),
            heal_grid: Grid::new(HEAL_CELL),
            living: Vec::new(),
            near: Vec::new(),
        }
    }

    pub fn pending_order_count(&self) -> usize {
        self.deferred_orders.len()
    }

    pub fn take_produced_sides(&mut self) -> i32 {
        std::mem::take(&mut self.produced_sides)
    }

    /// Simulates the replay and calls `frame_ready` for frame 0 and every sampled frame.
    pub fn run<E>(&mut self, options: &RunOptions, mut frame_ready: impl FnMut(&mut Simulator, i32) -> Result<(), E>) -> Result<(), E> {
        self.render_state = options.render_state;
        let max_tick = self.replay.end_tick.min(options.max_frame.unwrap_or(self.replay.end_tick));
        frame_ready(self, 0)?;
        for tick in 0..max_tick {
            self.tick(tick, options.no_combat);
            let frame = tick + 1;
            if frame % options.sample_every == 0 || frame == max_tick {
                frame_ready(self, frame)?;
            }
        }
        Ok(())
    }

    fn tick(&mut self, tick: i32, no_combat: bool) {
        self.apply_orders(tick);
        if let Some(commands) = self.replay.productions.get(&tick) {
            for command in commands.clone() {
                self.economy.set_production(&command, &mut self.rng);
            }
        }
        let mut influence_units = vec![false; self.replay.units.len()];
        for unit in &self.replay.units {
            if unit.active {
                influence_units[unit.id] = true;
            }
        }
        movement::step(&mut self.replay, &speed_for, &mut self.rng, &mut self.scratch);
        if !no_combat {
            self.combat();
        }
        self.territory.update(influence_units, &self.replay.units, &self.replay.map.cities);
        if tick % 30 == 1 {
            self.economy.pay(&mut self.replay, &mut self.territory);
            let before = self.replay.units.len();
            self.economy.produce(&mut self.replay, &self.territory, &mut self.rng);
            for unit in &self.replay.units[before..] {
                self.produced_sides |= 1 << unit.owner;
            }
            let mut next_strength = vec![0i32; self.replay.side_count()];
            for unit in self.replay.units.iter().filter(|u| u.active) {
                next_strength[unit.owner] += trunc_i32(unit.health);
            }
            for side in 0..self.replay.side_count() {
                self.troop_casualties[side] += (self.strength[side] - next_strength[side]).max(0);
            }
            self.strength = next_strength;
        }
        self.record_deaths(tick);
        self.fight_count = self.replay.units.iter().filter(|u| u.active && u.fighting).count() as i32;
        if self.render_state {
            for pass in 0..2 {
                for unit in self.replay.units.iter_mut().filter(|u| u.active) {
                    unit.visual_direction = (unit.visual_direction + unit.facing * 0.2).normalize();
                    let vibration = if unit.fighting { self.visual_random.vibration() as f64 / 1.5 } else { 0.0 };
                    if pass == 0 {
                        unit.first_visual_direction = unit.visual_direction;
                        unit.first_vibration = vibration;
                    } else {
                        unit.second_vibration = vibration;
                    }
                }
            }
        }
    }

    fn record_deaths(&mut self, tick: i32) {
        self.recorded_deaths.resize(self.replay.units.len(), false);
        for unit in self.replay.units.iter().rev() {
            if unit.destroyed && !self.recorded_deaths[unit.id] {
                self.recorded_deaths[unit.id] = true;
                self.deaths.push(Death { frame: tick, position: unit.position, color: unit.owner, kind: unit.kind, ship: unit.ship });
                self.casualties[unit.owner] += 1;
            }
        }
    }

    fn apply_orders(&mut self, tick: i32) {
        // Keep the latest order for a unit that has not spawned in this simulation
        // yet. Never invent a unit, color or type from an order's coordinates.
        let count = self.replay.units.len() as i32;
        let ready_ids: Vec<i32> = self.deferred_orders.keys().copied().filter(|&id| id < count).collect();
        let mut ready: Vec<Order> = ready_ids.iter().map(|id| self.deferred_orders.remove(id).unwrap()).collect();
        if let Some(orders) = self.pending_orders.get(&tick) {
            ready.extend(orders.iter().cloned());
        }
        for order in ready {
            if order.unit_id < 0 {
                continue;
            }
            if order.unit_id >= self.replay.units.len() as i32 {
                self.deferred_orders.insert(order.unit_id, order);
                self.deferred_order_count += 1;
                continue;
            }
            let unit = &mut self.replay.units[order.unit_id as usize];
            if unit.destroyed {
                continue;
            }
            unit.path = if order.points.len() > 1 { order.points[1..].iter().map(|p| p.truncate()).collect() } else { Vec::new() };
            let search = unit.path.len().saturating_sub(1);
            if let Some(close) = unit.path[..search].iter().position(|p| (*p - unit.position).length() < 18.0) {
                unit.path.drain(..=close);
            }
            unit.path_index = 0;
            unit.objective_frame = tick;
        }
    }

    fn combat(&mut self) {
        let replay = &mut self.replay;
        let count = replay.units.len();
        let damage = &mut self.damage;
        damage.clear();
        damage.resize(count, 0.0);
        let full_precision = replay.full_precision_positions();
        let experimental = replay.experimental();
        let surface = &replay.map.surface;
        let units = &mut replay.units;
        let (grid, heal_grid, near, living) = (&mut self.grid, &mut self.heal_grid, &mut self.near, &mut self.living);
        living.clear();
        living.extend(units.iter().filter(|u| u.alive()).map(|u| u.id));
        grid.build(replay.map.width, replay.map.height, living, |id| units[id].contact_position);
        heal_grid.build(replay.map.width, replay.map.height, living, |id| units[id].contact_position);
        // Native target selection retains an in-range living target. Replacement
        // uses the first enemy by global ID, not the closest enemy.
        for i in 0..count {
            if !units[i].alive() {
                continue;
            }
            let (owner, contact) = (units[i].owner, units[i].contact_position);
            grid.near_unordered(contact, 1, near);
            let Some(first_enemy) = near.iter().copied().filter(|&j| units[j].owner != owner && (units[j].contact_position - contact).length_squared() <= CONTACT * CONTACT).min() else {
                continue;
            };
            let mut target = units[i].target_id;
            if target < 0
                || target as usize >= count
                || !units[target as usize].alive()
                || (units[target as usize].previous_position - units[i].previous_position).length_squared() > CONTACT * CONTACT
            {
                target = first_enemy as i32;
            }
            units[i].target_id = target;
            units[i].fighting = true;
        }
        // Morale is updated before outgoing damage is calculated.
        for unit in units.iter_mut() {
            if !unit.alive() {
                continue;
            }
            let drop = if unit.had_objective { 0.15 } else { 0.1 };
            if unit.fighting && unit.morale > drop {
                unit.morale -= drop;
            } else if !unit.fighting && unit.morale < 99.0 {
                unit.morale += 0.04;
            }
        }
        for i in 0..count {
            let attacker = &units[i];
            let target = attacker.target_id;
            if !attacker.alive() || !attacker.fighting || target < 0 {
                continue;
            }
            let terrain_damage = damage_for(attacker, units, surface, full_precision);
            let multiplier = matchup(attacker.kind, units[target as usize].kind);
            let condition = (0.8 * (attacker.morale / 100.0) + 0.2) * (attacker.health / attacker.max_health).max(1e-9).sqrt();
            damage[target as usize] += (terrain_damage * condition) * multiplier;
        }
        // Healing checks the units alive before this tick's damage, all in the grid.
        for i in 0..count {
            let unit = &mut units[i];
            if !unit.active {
                continue;
            }
            let terrain = surface.at(unit.simulation_position);
            unit.in_city = terrain == Terrain::City;
            unit.terrain = terrain.name();
            if unit.retreated {
                damage[i] = 0.0;
            }
            let (owner, contact) = (unit.owner, unit.contact_position);
            heal_grid.near_unordered(contact, 1, near);
            let heal_blocked = near.iter().any(|&j| j != i && units[j].owner != owner && (units[j].contact_position - contact).length_squared() <= 100.0 * 100.0);
            let unit = &mut units[i];
            let mut heal = if !unit.ship && unit.health < unit.max_health && !heal_blocked {
                if terrain == Terrain::City {
                    0.02
                } else {
                    0.01
                }
            } else {
                0.0
            };
            if !experimental && unit.kind == UnitType::Tank {
                heal *= 1.2;
            }
            unit.healing = !unit.ship && unit.health < unit.max_health && !heal_blocked;
            unit.health = unit.health + heal - damage[i];
            if terrain == Terrain::Water && !unit.ship {
                unit.water_timer += 1;
            } else {
                unit.water_timer = 0;
            }
            let all_edges_river = terrain == Terrain::Water
                && [(8.0, 0.0), (5.0, 5.0), (0.0, 8.0), (-5.0, 5.0), (-8.0, 0.0), (-5.0, -5.0), (0.0, -8.0), (5.0, -5.0)]
                    .iter()
                    .all(|&(x, y)| surface.at(unit.simulation_position + Vec2::new(x, y)) == Terrain::Water);
            let ship_tick = !unit.fighting && if unit.ship { unit.ship_land_blocked && unit.had_objective } else { all_edges_river && !unit.had_objective };
            unit.ship_timer = if ship_tick { unit.ship_timer + 1 } else { 0 };
            if unit.ship_timer > 90 {
                unit.ship = !unit.ship;
                unit.ship_timer = 0;
            }
            if unit.water_timer > 0 && unit.ship_timer == 0 {
                unit.health -= (unit.water_timer as f64).sqrt() / 500.0;
            }
            if unit.ship {
                unit.health -= 0.01;
            }
            if !full_precision {
                unit.health = python_round(unit.health, 3);
                unit.morale = python_round(unit.morale, 2);
            }
            unit.damage_received = if full_precision { damage[i] } else { python_round(damage[i], 3) };
            if unit.health <= 0.0 {
                unit.active = false;
                unit.destroyed = true;
            }
        }
    }
}

pub fn speed_for(unit: &Unit, surface: &MapSurface) -> f64 {
    if unit.ship {
        return if unit.kind == UnitType::Tank { 0.3 } else { 0.5 };
    }
    const SPEED: [[f64; 10]; 3] = [
        [0.50, 0.50, 0.30, 0.50, 0.40, 0.20, 0.10, 0.01, 0.50, 0.50],
        [0.30, 0.20, 0.30, 0.20, 0.24, 0.10, 0.08, 0.01, 0.30, 0.30],
        [0.75, 0.75, 0.75, 0.75, 0.60, 0.30, 0.15, 0.01, 0.75, 0.75],
    ];
    SPEED[unit.kind.index()][surface.at(unit.position).index()]
}

pub fn damage_for(unit: &Unit, units: &[Unit], surface: &MapSurface, full_precision: bool) -> f64 {
    if unit.ship && unit.target_id >= 0 {
        let tank = unit.kind == UnitType::Tank;
        let target_ship = units[unit.target_id as usize].ship;
        return if full_precision {
            if target_ship {
                if tank { 0.05 } else { 0.2 }
            } else if tank {
                0.1
            } else {
                0.02
            }
        } else if target_ship {
            if tank { 0.1 } else { 0.3 }
        } else if tank {
            0.16
        } else {
            0.04
        };
    }
    const DAMAGE: [[f64; 10]; 3] = [
        [0.08, 0.08, 0.08, 0.08, 0.06, 0.04, 0.02, 0.00, 0.08, 0.08],
        [0.16, 0.08, 0.16, 0.16, 0.12, 0.08, 0.02, 0.00, 0.16, 0.16],
        [0.08, 0.08, 0.08, 0.08, 0.06, 0.04, 0.02, 0.00, 0.08, 0.08],
    ];
    DAMAGE[unit.kind.index()][surface.at(unit.simulation_position).index()]
}

fn matchup(attacker: UnitType, target: UnitType) -> f64 {
    const MATRIX: [[f64; 3]; 3] = [[1.0, 1.0, 1.5], [1.0, 1.0, 2.0], [3.0, 1.5, 3.0]];
    MATRIX[attacker.index()][target.index()]
}
