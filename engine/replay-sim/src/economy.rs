use crate::geom::Vec2;
use crate::num::{numpy_round, python_round};
use crate::replay::{Production, Replay, Unit, UnitType};
use crate::sim::Random;
use crate::territory::Territory;

pub struct Economy {
    pub funds: Vec<f64>,
    pub production_rates: Vec<f64>,
    pub production_types: Vec<UnitType>,
    pub industrial_zones: Vec<Vec<i32>>,
    pub capitals: Vec<i32>,
    pub city_count: Vec<i32>,
    pub winner: Option<usize>,
    pub dot_groups: Vec<Vec<Vec<usize>>>,
    pub city_groups: Vec<Vec<Vec<i32>>>,
    pub balances: Vec<Vec<f64>>,
    pub has_paid: bool,
    pub production_queue: Vec<UnitType>,
    pub production_ratios: Vec<Option<f64>>,
}

impl Economy {
    pub fn new(replay: &Replay, territory: &Territory) -> Economy {
        let sides = replay.side_count();
        let mut funds = vec![0.0; sides];
        // Game scene setup: in avalanche every second color (1, 3) starts with 15000.
        if replay.avalanche() {
            for side in (1..sides).step_by(2) {
                funds[side] = 15000.0;
            }
        }
        let mut industrial_zones = vec![Vec::new(); sides];
        for (i, &color) in territory.city_colors.iter().enumerate() {
            industrial_zones[color].push(i as i32);
        }
        let city_count = territory.city_colors.len();
        let is_city = |index: i32| index >= 0 && (index as usize) < city_count;
        let mut capitals = replay.map.capitals.clone();
        // Avalanche maps drop cities but keep the original capital indices, which then
        // name no city: such a capital is never connected and never owned.
        for side in 0..capitals.len() {
            if !is_city(capitals[side]) || territory.city_colors[capitals[side] as usize] != side {
                capitals[side] = replay
                    .map
                    .capitals
                    .iter()
                    .copied()
                    .find(|&city| is_city(city) && territory.city_colors[city as usize] == side)
                    .unwrap_or_else(|| industrial_zones.get(side).and_then(|zone| zone.first().copied()).unwrap_or(-1));
            }
        }
        Economy {
            funds,
            production_rates: vec![0.7; sides],
            production_types: vec![UnitType::Infantry; sides],
            industrial_zones,
            capitals,
            city_count: vec![0; sides],
            winner: None,
            dot_groups: vec![Vec::new(); sides],
            city_groups: vec![Vec::new(); sides],
            balances: vec![vec![0.0]; sides],
            has_paid: false,
            production_queue: vec![UnitType::Infantry; sides],
            production_ratios: vec![if replay.legacy_production { Some(0.5) } else { None }; sides],
        }
    }

    pub fn is_city(&self, index: i32, territory: &Territory) -> bool {
        index >= 0 && (index as usize) < territory.city_colors.len()
    }

    pub fn set_production(&mut self, command: &Production, rng: &mut dyn Random) {
        if let Some(zone) = &command.zone {
            let mut distinct = Vec::new();
            for &city in zone {
                if !distinct.contains(&city) {
                    distinct.push(city);
                }
            }
            self.industrial_zones[command.slot] = distinct;
            return;
        }
        self.production_rates[command.slot] = command.rate;
        self.production_ratios[command.slot] = command.ratio;
        if let Some(ratio) = command.ratio {
            // Native update_production rerolls the queue on every slider
            // command, including unchanged ratios and the certain endpoints.
            let kind = choose_legacy_type(ratio, rng);
            self.production_types[command.slot] = kind;
            self.production_queue[command.slot] = kind;
            return;
        }
        self.production_queue[command.slot] = command.kind;
        self.production_types[command.slot] = command.kind;
    }

    pub fn produce(&mut self, replay: &mut Replay, territory: &Territory, rng: &mut dyn Random) {
        let roll_before_block = replay.roll_production_before_block();
        for side in 0..replay.side_count() {
            for group in self.city_groups[side].clone() {
                let kind = self.production_types[side];
                let price = if kind == UnitType::Infantry { 200.0 } else { 400.0 };
                if !(self.funds[side] > python_round(price / self.production_rates[side], 3)) {
                    continue;
                }
                let candidates: Vec<i32> = group.iter().copied().filter(|city| self.industrial_zones[side].contains(city)).collect();
                if candidates.is_empty() {
                    continue;
                }
                let city = candidates[(rng.next() * candidates.len() as f64) as usize];
                // From 1.3 the native core reserves its next-type roll before the
                // collision check, but only commits that queue after a birth.
                let next_type = match (roll_before_block, self.production_ratios[side]) {
                    (true, Some(ratio)) => Some(choose_legacy_type(ratio, rng)),
                    _ => None,
                };
                let point: Vec2 = replay.map.cities[city as usize];
                let own = (24.0 * 1.1) * (24.0 * 1.1);
                let enemy = (36.0 * 1.1) * (36.0 * 1.1);
                let blocked = replay.units.iter().any(|u| {
                    (u.active || territory.influence_units.get(u.id).copied().unwrap_or(false))
                        && numpy_round((u.position - point).length_squared(), 3) < if u.owner == side { own } else { enemy }
                });
                if blocked {
                    continue;
                }
                self.funds[side] -= price;
                if let Some(ratio) = self.production_ratios[side] {
                    self.production_queue[side] = next_type.unwrap_or_else(|| choose_legacy_type(ratio, rng));
                }
                self.production_types[side] = self.production_queue[side];
                let id = replay.units.len();
                let mut unit = Unit::new(id, side, kind, point, if kind == UnitType::Tank { 200.0 } else { 100.0 });
                unit.health = 4.0;
                unit.in_city = true;
                replay.units.push(unit);
            }
        }
    }

    pub fn pay(&mut self, replay: &mut Replay, territory: &mut Territory) {
        self.has_paid = true;
        let (dots, cities) = territory.grid_groups(&replay.units, &replay.map.cities);
        self.dot_groups = dots;
        self.city_groups = cities;
        let sides = replay.side_count();
        self.balances = vec![Vec::new(); sides];
        let city_total = territory.city_colors.len();
        let is_city = |index: i32| index >= 0 && (index as usize) < city_total;
        for side in 0..sides {
            self.industrial_zones[side].retain(|&city| territory.city_colors[city as usize] == side);
            let mut capital_found = false;
            let mut capital_group: i32 = -1;
            // A capital that names no city (avalanche) leaves the side's largest group
            // drawing on its funds; this matches the orders recorded in avalanche replays.
            let has_capital = self.capitals.len() > side && is_city(self.capitals[side]);
            let funded_group: i32 = if self.capitals.len() <= side || has_capital || self.dot_groups[side].is_empty() {
                -1
            } else {
                let mut best = 0;
                for (i, group) in self.dot_groups[side].iter().enumerate() {
                    if group.len() > self.dot_groups[side][best].len() {
                        best = i;
                    }
                }
                best as i32
            };
            for group in 0..self.dot_groups[side].len() {
                let paid: Vec<usize> = self.dot_groups[side][group].iter().copied().filter(|&id| !replay.units[id].in_city && !replay.units[id].ship).collect();
                let income = (self.city_groups[side][group].len() * 5) as f64 - paid.len() as f64;
                let connected = if has_capital { self.city_groups[side][group].contains(&self.capitals[side]) } else { group as i32 == funded_group };
                capital_found |= connected;
                if connected {
                    capital_group = group as i32;
                }
                let balance = income + if connected { self.funds[side] } else { 0.0 };
                if connected {
                    self.funds[side] = balance.max(0.0);
                }
                if balance < 0.0 && !paid.is_empty() {
                    let unit = &mut replay.units[*paid.last().unwrap()];
                    unit.health += balance * 3.0;
                    if unit.health <= 0.0 {
                        unit.active = false;
                        unit.destroyed = true;
                    }
                }
                self.balances[side].push(if connected && balance < 0.0 { balance } else { income });
            }
            if !capital_found {
                // Native economy still reports [0] after a side loses every
                // supply region; an empty group list does not erase that slot.
                if self.balances[side].is_empty() {
                    self.balances[side].push(0.0);
                } else {
                    self.balances[side][0] = 0.0;
                }
            }
            if capital_group > 0 {
                let g = capital_group as usize;
                self.dot_groups[side].swap(0, g);
                self.city_groups[side].swap(0, g);
                self.balances[side].swap(0, g);
            }
        }
        self.city_count = (0..sides).map(|side| territory.city_colors.iter().filter(|&&c| c == side).count() as i32).collect();
        let total: i32 = self.city_count.iter().sum();
        for side in 0..sides {
            if (total as f64) * 0.8 < self.city_count[side] as f64 && self.capitals.iter().all(|&city| is_city(city) && territory.city_colors[city as usize] == side) {
                self.winner = Some(side);
            }
        }
    }
}

pub fn choose_legacy_type(infantry_ratio: f64, rng: &mut dyn Random) -> UnitType {
    if rng.next() < infantry_ratio {
        UnitType::Infantry
    } else {
        UnitType::Tank
    }
}
