//! Replay compatibility checks: schema and mode handling, the deployment catalog,
//! and simulation steps pinned to values recorded from the original game builds.

use flate2::read::DeflateDecoder;
use replay_sim::deployments;
use replay_sim::economy::{choose_legacy_type, Economy};
use replay_sim::geom::Vec2;
use replay_sim::movement::{self, mountain_projection, Scratch};
use replay_sim::num::{native_masked_matrix_sum, python_hypot};
use replay_sim::output;
use replay_sim::replay::{Production, Replay, Unit, UnitType};
use replay_sim::sim::{damage_for, RunOptions, Simulator};
use replay_sim::surface::{MapFiles, Terrain};
use replay_sim::territory::Territory;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

fn maps() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../maps").canonicalize().unwrap()
}

fn fixture() -> Value {
    json!({
        "version": "1.3.4", "end": 0,
        "player_usernames": [["Alice [Friend]"], ["Боб"]],
        "map": {
            "path": maps().join("map1.png").to_string_lossy(),
            "infantry": [[[100, 450]], [[1500, 450]]],
            "cities": [[200, 450], [1400, 450]], "capitals": [0, 1]
        }
    })
}

fn files() -> MapFiles {
    MapFiles { bundled: Some(maps()), ..Default::default() }
}

fn try_read_with(root: &Value, files: &mut MapFiles) -> Result<Replay, String> {
    Replay::from_json(root, &std::env::temp_dir(), files)
}

fn try_read(root: &Value) -> Result<Replay, String> {
    try_read_with(root, &mut files())
}

fn read(root: &Value) -> Replay {
    try_read(root).unwrap()
}

fn v(x: f64, y: f64) -> Vec2 {
    Vec2::new(x, y)
}

fn speed(value: f64) -> impl Fn(&Unit, &replay_sim::surface::MapSurface) -> f64 {
    move |_, _| value
}

fn step(replay: &mut Replay, speed: &dyn Fn(&Unit, &replay_sim::surface::MapSurface) -> f64, random: &mut dyn FnMut() -> f64) {
    movement::step(replay, speed, &mut || random(), &mut Scratch::default());
}

fn no_draws() -> f64 {
    panic!("Undamaged tick consumed RNG")
}

fn economy(replay: &Replay) -> (Territory, Economy) {
    let territory = Territory::new(replay.map.width, replay.map.height, replay.side_count(), &replay.units, &replay.map.cities);
    let economy = Economy::new(replay, &territory);
    (territory, economy)
}

fn economy_fields(replay: Replay) -> Value {
    let sim = Simulator::new(replay);
    let mut text = String::new();
    output::economy_json(&sim, &mut text);
    serde_json::from_str::<Value>(&text).unwrap()["fields"].clone()
}

fn production(slot: usize, kind: UnitType, rate: f64, zone: Option<Vec<i32>>, ratio: Option<f64>) -> Production {
    Production { slot, kind, rate, zone, ratio }
}

fn temporary_folder(prefix: &str) -> PathBuf {
    let folder = std::env::temp_dir().join(format!("{prefix}{}-{:?}", std::process::id(), std::thread::current().id()).replace(['(', ')'], ""));
    let _ = std::fs::remove_dir_all(&folder);
    std::fs::create_dir_all(&folder).unwrap();
    folder
}

#[test]
fn legacy_custom_map_nested_mode_and_string_labels() {
    let mut root = fixture();
    root["version"] = json!("1.2.18.3");
    root["custom_map"] = root["map"].clone();
    root["map"] = json!("custom");
    root["custom_map"]["mode"] = json!("v4");
    root["0"] = json!({"production0": {"color": 0, "rate": 0.6, "ratio": 0.35}, "message": {"text": "hello"}});
    let folder = temporary_folder("replay-sim-gzip-");
    let path = folder.join("replay.rep");
    let mut gzip = flate2::write::GzEncoder::new(std::fs::File::create(&path).unwrap(), flate2::Compression::fast());
    gzip.write_all(root.to_string().as_bytes()).unwrap();
    gzip.finish().unwrap();
    let replay = Replay::read(&path, &mut files()).unwrap();
    std::fs::remove_dir_all(folder).unwrap();
    assert!(replay.mode == "classic" && replay.source_mode == "v4" && replay.legacy_production, "Legacy schema/rules not recognized");
    assert!(replay.player_names[0] == "Alice [Friend]" && replay.player_labels[1][0] == "Боб", "String labels lost");
    let command = &replay.productions[&0][0];
    assert!(command.rate == 0.6 && command.ratio == Some(0.35), "Fractional production lost");
}

#[test]
fn future_version_and_unfamiliar_mode_get_a_playback_attempt() {
    let mut root = fixture();
    root["version"] = json!("99.3-preview");
    root["mode"] = json!("future-mode");
    let replay = read(&root);
    assert!(replay.mode == "classic" && replay.approximate_rules() && replay.version == "99.3-preview", "Version gate or missing provenance");
}

#[test]
fn flat_and_absent_player_metadata_do_not_block_playback() {
    let mut root = fixture();
    root["player_usernames"] = json!(["Alice", {"username": "Bob", "title": "General"}]);
    let replay = read(&root);
    assert!(replay.player_labels[0][0] == "Alice" && replay.player_labels[1][0] == "Bob [General]", "Flat names lost");
    root["player_usernames"] = Value::Null;
    assert_eq!(read(&root).units.len(), 2, "Optional metadata blocked replay");
}

#[test]
fn modern_commands_keep_explicit_unit_selection() {
    let mut root = fixture();
    root["version"] = json!("1.4.1");
    root["mode"] = json!("experiment");
    root["0"] = json!({"production": {"color": 1, "production_rate": 0.8, "production_type": "motorised"}});
    let replay = read(&root);
    let (_, mut economy) = economy(&replay);
    economy.set_production(&replay.productions[&0][0], &mut || -> f64 { panic!("Modern command consumed RNG") });
    assert!(!replay.legacy_production && economy.production_types[1] == UnitType::Motorised && economy.production_ratios[1].is_none(), "Modern production changed");
    let fields = economy_fields(replay);
    assert!(fields.get("production_ratio").is_none(), "Legacy ratio diagnostics leaked into native modern economy fields");
}

#[test]
fn legacy_economy_preserves_native_initial_ratio_and_field_names() {
    let replay = read(&fixture());
    let (_, economy) = economy(&replay);
    assert!(economy.production_ratios.iter().all(|&ratio| ratio == Some(0.5)), "Native legacy default is a half infantry/tank mixture");
    let fields = economy_fields(replay);
    assert!(fields.get("production_ratio").is_some() && fields.get("production_type").is_none() && fields.get("available_units").is_none(), "Modern-only fields leaked into legacy native state");
    assert_eq!(fields["price"].as_object().unwrap().len(), 2, "Motorised price leaked into legacy native state");
}

#[test]
fn map_ids_still_explain_the_missing_deployment() {
    let mut root = fixture();
    root["map"] = json!(999);
    let error = try_read(&root).err().expect("Accepted a missing deployment");
    assert!(error.contains("map number (999)") && error.contains("starting units"), "Unhelpful map error");
}

#[test]
fn numbered_fahero_24_uses_the_classic_unit_types_and_original_ids() {
    let mut root = fixture();
    root["map"] = json!(24);
    root["mode"] = json!("1v1");
    root["version"] = json!("1.4.1");
    let replay = read(&root);
    assert!(replay.mode == "classic" && replay.units.len() == 50, "Wrong classic profile/deployment");
    assert!(replay.map.infantry.iter().all(|side| side.len() == 18) && replay.map.motorised.iter().all(Vec::is_empty), "Experimental roster leaked into classic");
    for (id, x, y, kind) in [(2, 609, 552, UnitType::Infantry), (17, 533, 413, UnitType::Infantry), (18, 663, 476, UnitType::Tank), (25, 608, 300, UnitType::Infantry), (42, 775, 309, UnitType::Infantry), (49, 801, 447, UnitType::Tank)] {
        assert!(replay.units[id].kind == kind && replay.units[id].position == v(x as f64, y as f64), "Wrong classic unit {id}");
    }
    assert!(replay.map.cities.len() == 10 && replay.map.capitals == [2, 5], "Map geometry missing");
}

#[test]
fn string_map_id_24_resolves_experimental_separately() {
    let mut root = fixture();
    root["map"] = json!("24");
    root["mode"] = json!("experiment");
    root["version"] = json!("1.4.1");
    let replay = read(&root);
    assert!(replay.experimental() && replay.units.len() == 50, "Experimental map not resolved");
    assert!(replay.units[21].kind == UnitType::Motorised && replay.units[21].position == v(533.0, 413.0), "Wrong experimental unit IDs");
    assert!(replay.map.infantry.iter().all(|side| side.len() == 14), "Classic roster leaked into experimental");
}

#[test]
fn numbered_map_recovery_also_covers_other_roster_sizes() {
    for (id, count) in [(1, 60), (16, 40), (32, 38)] {
        let mut root = fixture();
        root["map"] = json!(id);
        root["mode"] = json!("1v1");
        let replay = read(&root);
        assert!(replay.units.len() == count && !replay.experimental(), "Wrong classic layout for map {id}");
    }
}

fn catalog() -> Value {
    serde_json::from_str(&std::fs::read_to_string(maps().join("deployments.json")).unwrap()).unwrap()
}

#[test]
fn each_modes_layout_converts_exactly_into_the_other() {
    let mut both = 0;
    for (name, entry) in catalog().as_object().unwrap() {
        let (Some(classic), Some(experimental)) = (entry.get("classic"), entry.get("experiment")) else { continue };
        both += 1;
        for (profile, expected) in [("classic", classic), ("experiment", experimental)] {
            let stored: serde_json::Map<String, Value> = entry.as_object().unwrap().iter().filter(|(mode, _)| *mode != profile).map(|(k, v)| (k.clone(), v.clone())).collect();
            let converted = deployments::try_convert(&Value::Object(stored), profile).unwrap_or_else(|| panic!("Map {name} did not convert to {profile}"));
            // A layout may leave out an empty motorised list.
            let field = |layout: &Value, field: &str| {
                layout.get(field).filter(|value| !(field == "motorised" && value.as_array().unwrap().iter().all(|side| side.as_array().unwrap().is_empty()))).cloned()
            };
            for field_name in ["infantry", "motorised", "tanks", "cities", "capitals", "bridges"] {
                assert_eq!(field(&converted, field_name), field(expected, field_name), "Map {name} {profile} {field_name} differs after conversion");
            }
        }
    }
    assert_eq!(both, 33, "Expected 33 maps in both modes, found {both}");
}

#[test]
fn every_official_map_plays_in_every_match_format() {
    let mut opened = 0;
    for (name, entry) in catalog().as_object().unwrap() {
        let layout = entry.as_object().unwrap().iter().find(|(mode, _)| *mode != "avalanche").unwrap().1;
        let colors = layout["infantry"].as_array().unwrap().len();
        let formats: Vec<&str> = if colors == 2 { vec!["1v1", "2v2", "experiment"] } else { vec![if colors == 3 { "v3" } else { "v4" }, "ffa", "experiment"] };
        let mut units = None;
        for format in formats {
            let mut root = fixture();
            root["map"] = json!(name.parse::<i32>().unwrap());
            root["mode"] = json!(format);
            root["version"] = json!("1.4.1");
            let replay = match try_read(&root) {
                Ok(replay) => replay,
                // Images outside the bundled set come from the installed game.
                Err(error) if error.starts_with("Cannot decode terrain map") => break,
                Err(error) => panic!("Map {name} in {format}: {error}"),
            };
            assert_eq!(replay.experimental(), format == "experiment", "Map {name} in {format} used the wrong rules");
            assert!(units.is_none() || units == Some(replay.units.len()), "Map {name} has a different army in {format}");
            units = Some(replay.units.len());
            opened += 1;
        }
    }
    assert!(opened >= 60, "Only {opened} map and format combinations opened");
}

#[test]
fn a_map_the_catalog_lacks_takes_its_layout_from_a_replay_of_it_in_another_mode() {
    let folder = temporary_folder("replay-sim-layouts-");
    std::fs::create_dir_all(folder.join("assets/fahero_maps")).unwrap();
    std::fs::copy(maps().join("map1.png"), folder.join("assets/fahero_maps/map999.png")).unwrap();
    let units = |x: i32| (0..5).map(|i| json!([x, 100 + 50 * i])).collect::<Vec<_>>();
    let mut source = fixture();
    source["mode"] = json!("experiment");
    source["version"] = json!("1.4.1");
    source["map"] = json!({
        "path": "assets/fahero_maps/map999.png", "infantry": [units(100), units(1500)],
        "motorised": [[[150, 400]], [[1450, 400]]],
        "cities": [[200, 450], [1400, 450]], "capitals": [0, 1]
    });
    std::fs::write(folder.join("source.rep"), source.to_string()).unwrap();
    let mut files = MapFiles { game_dirs: vec![folder.clone()], replay_dirs: vec![folder.clone()], bundled: Some(maps()), ..Default::default() };
    for mode in ["1v1", "2v2", "experiment"] {
        let mut root = fixture();
        root["map"] = json!(999);
        root["mode"] = json!(mode);
        root["version"] = json!("1.4.1");
        let replay = try_read_with(&root, &mut files).unwrap();
        assert!(replay.units.len() == 12 && replay.experimental() == (mode == "experiment"), "Map 999 in {mode} did not take the recorded layout");
    }
    std::fs::remove_dir_all(folder).unwrap();
}

#[test]
fn maps_known_in_one_mode_play_in_the_other() {
    for id in [29, 46, 47, 49, 50] {
        let mut root = fixture();
        root["map"] = json!(id);
        root["mode"] = json!("1v1");
        root["version"] = json!("1.4.1");
        let classic = read(&root);
        root["mode"] = json!("experiment");
        let experimental = read(&root);
        assert!(classic.mode == "classic" && classic.map.motorised.iter().all(Vec::is_empty), "Map {id} classic kept motorised units");
        assert_eq!(classic.units.len(), experimental.units.len(), "Map {id} changed its unit count");
        let positions = |replay: &Replay, kinds: &[UnitType]| {
            let mut points: Vec<(f64, f64)> = replay.units.iter().filter(|u| kinds.contains(&u.kind)).map(|u| (u.position.x, u.position.y)).collect();
            points.sort_by(|a, b| a.partial_cmp(b).unwrap());
            points
        };
        assert!(
            positions(&experimental, &[UnitType::Infantry, UnitType::Motorised]) == positions(&classic, &[UnitType::Infantry]) && positions(&experimental, &[UnitType::Tank]) == positions(&classic, &[UnitType::Tank]),
            "Map {id} layouts differ between modes"
        );
    }
    let mut zolamare = fixture();
    zolamare["map"] = json!(42);
    zolamare["mode"] = json!("experiment");
    assert!(read(&zolamare).map.motorised.iter().all(|side| !side.is_empty()), "Classic-only map not converted to experimental");
}

#[test]
fn native_zolamare_maps_preserve_starting_ids_and_capital_indices() {
    let cases: [(i32, usize, [i32; 2], Vec<(usize, f64, f64, UnitType)>); 2] = [
        (42, 40, [1, 4], vec![(0, 733.0, 295.0, UnitType::Infantry), (16, 792.0, 466.0, UnitType::Tank), (20, 843.0, 418.0, UnitType::Infantry), (39, 807.0, 307.0, UnitType::Tank)]),
        (35, 50, [7, 9], vec![(0, 830.0, 263.0, UnitType::Infantry), (20, 598.0, 648.0, UnitType::Infantry), (24, 700.0, 797.0, UnitType::Tank), (25, 902.0, 274.0, UnitType::Infantry), (49, 877.0, 286.0, UnitType::Tank)]),
    ];
    for (number, count, capitals, samples) in cases {
        let mut root = fixture();
        root["version"] = json!("1.2.23");
        root["map"] = json!(number);
        root["mode"] = json!("1v1");
        let replay = read(&root);
        assert!(replay.units.len() == count && replay.map.capitals == capitals, "Wrong map {number} roster/capitals");
        for (id, x, y, kind) in samples {
            assert!(replay.units[id].position == v(x, y) && replay.units[id].kind == kind, "Wrong map {number} unit {id}");
        }
    }
}

#[test]
fn bridge_raster_follows_the_games_pygame_generation() {
    let mut root = fixture();
    root["map"] = json!(26);
    root["mode"] = json!("1v1");
    root["version"] = json!("1.2.23");
    assert_eq!(read(&root).map.surface.at(v(675.0, 313.0)), Terrain::Bridge, "Classic pygame bridge endpoint");
    root["version"] = json!("1.4.1");
    assert_eq!(read(&root).map.surface.at(v(675.0, 313.0)), Terrain::Plains, "Pygame CE native bridge endpoint");
}

#[test]
fn explicit_custom_deployment_wins_over_a_known_numeric_id() {
    let mut root = fixture();
    root["custom_map"] = root["map"].clone();
    root["map"] = json!(24);
    assert_eq!(read(&root).units.len(), 2, "Catalog replaced a custom deployment");
}

#[test]
fn team_format_shares_classic_deployments_across_the_catalog_without_losing_teammates() {
    for id in (1..=32).filter(|&id| id != 29) {
        let mut root = fixture();
        root["map"] = json!(id);
        root["mode"] = json!("1v1");
        let classic = read(&root);
        root["mode"] = json!("experiment");
        let experimental = read(&root);
        root["mode"] = json!("2v2");
        root["player_usernames"] = json!([["Alice", "Friend"], ["Bob", "Teammate"]]);
        let team = read(&root);
        root["mode"] = json!("1v1");
        let again = read(&root);
        assert!(team.mode == "classic" && team.source_mode == "2v2" && team.side_count() == 2, "Team format rejected for map {id}");
        assert!(team.player_labels[0].len() == 2 && team.player_labels[1].len() == 2, "Teammates were lost");
        let roster = |replay: &Replay| replay.units.iter().map(|u| (u.id, u.kind, u.position.x, u.position.y)).collect::<Vec<_>>();
        assert!(roster(&team) == roster(&classic) && roster(&again) == roster(&classic), "Mode lookup changed classic IDs on map {id}");
        assert!(experimental.experimental(), "Experimental profile lost on map {id}");
    }
}

#[test]
fn map_and_mode_formatting_does_not_change_deployment_or_rules() {
    let mut root = fixture();
    root["map"] = json!(" 013 ");
    root["mode"] = json!(" 2V2 ");
    assert!(read(&root).units.len() == 60 && read(&root).mode == "classic", "Formatted team mode rejected");
    root["mode"] = json!(" Experiment ");
    assert!(read(&root).experimental(), "Mode normalization differs between lookup and simulation");
}

#[test]
fn two_side_catalog_is_not_silently_reused_for_four_color_mode() {
    let mut root = fixture();
    root["map"] = json!(24);
    root["mode"] = json!("v4");
    let error = try_read(&root).err().expect("Applied a two-side deployment to four colors");
    assert!(error.contains("map and mode"), "Missing mode-specific explanation");
}

#[test]
fn invalid_zone_indices_do_not_prevent_playback() {
    let mut root = fixture();
    root["0"] = json!({"production": {"color": 0, "zone": [0, -1, 99, 0]}});
    assert_eq!(read(&root).productions[&0][0].zone, Some(vec![0]), "Zone was not normalized");
}

#[test]
fn legacy_slider_extremes_and_fractional_mixture() {
    let mut draws = 0;
    let mut draw = || {
        draws += 1;
        0.7
    };
    assert_eq!(choose_legacy_type(1.0, &mut draw), UnitType::Infantry, "Light endpoint");
    assert_eq!(choose_legacy_type(0.0, &mut draw), UnitType::Tank, "Heavy endpoint");
    assert_eq!(draws, 2, "Native endpoint choices each consume RNG");
    assert_eq!(choose_legacy_type(0.35, &mut || 0.2), UnitType::Infantry, "Fractional infantry");
    assert_eq!(choose_legacy_type(0.35, &mut || 0.4), UnitType::Tank, "Fractional tank");
}

#[test]
fn legacy_production_commands_reroll_unchanged_ratios_zones_preserve_rng() {
    let replay = read(&fixture());
    let (_, mut economy) = economy(&replay);
    let draws = std::cell::Cell::new(0);
    let mut draw = || {
        draws.set(draws.get() + 1);
        if draws.get() == 1 {
            0.2
        } else {
            0.7
        }
    };
    economy.set_production(&production(0, UnitType::Infantry, 1.0, None, Some(0.35)), &mut draw);
    assert_eq!(economy.production_queue[0], UnitType::Infantry, "First slider selection");
    economy.set_production(&production(0, UnitType::Infantry, 0.7, None, Some(0.35)), &mut draw);
    assert!(economy.production_queue[0] == UnitType::Tank && draws.get() == 2, "Unchanged ratio did not reroll the queue");
    economy.set_production(&production(0, UnitType::Infantry, 0.0, Some(vec![0]), None), &mut draw);
    assert!(economy.production_queue[0] == UnitType::Tank && draws.get() == 2, "Zone command changed queue or consumed RNG");
}

#[test]
fn legacy_damage_activates_rng_draws_for_all_living_units() {
    let mut root = fixture();
    root["version"] = json!("1.2.23");
    let mut replay = read(&root);
    replay.units.push(Unit::new(2, 0, UnitType::Infantry, v(800.0, 450.0), 100.0));
    replay.units[0].damage_received = 0.08;
    let mut draws = 0;
    step(&mut replay, &speed(0.5), &mut || {
        draws += 1;
        0.9
    });
    assert_eq!(draws, 3, "Historical RNG draws were restricted to damaged units");
    replay.units[0].damage_received = 0.0;
    step(&mut replay, &speed(0.5), &mut || {
        draws += 1;
        0.9
    });
    assert_eq!(draws, 3, "Damage-free historical frame consumed RNG");
}

fn historical_map_31() -> Replay {
    let mut root = fixture();
    root["version"] = json!("1.2.18.3");
    root["map"] = json!(31);
    root["mode"] = json!("1v1");
    let mut replay = read(&root);
    replay.units.clear();
    replay
}

#[test]
fn historical_mountain_slide_keeps_native_perimeter_precision() {
    // Native June replay 0914efce, unit 24, frames 660 -> 661.
    let mut replay = historical_map_31();
    let mut unit = Unit::new(0, 0, UnitType::Tank, v(1152.1141181803848, 50.93785177834481), 200.0);
    unit.path = vec![v(1111.0, 42.0)];
    replay.units.push(unit);
    step(&mut replay, &speed(0.2), &mut no_draws);
    assert_eq!(replay.units[0].position, v(1151.9377339275152, 50.843572430979606), "Mountain push/perimeter lost native precision");
}

#[test]
fn mountain_normal_preserves_numpys_selected_coordinate_reduction() {
    // Native e3a15ea9, infantry 6, frames 7744 -> 7745. Eight selected
    // offsets expose a one-ULP difference from serial vector accumulation.
    let mut root = fixture();
    root["version"] = json!("1.2.18.3");
    root["map"] = json!("19");
    root["mode"] = json!("classic");
    let mut replay = read(&root);
    replay.units.clear();
    let mut unit = Unit::new(0, 0, UnitType::Infantry, v(91.66203097355562, 684.0899014956972), 100.0);
    unit.path = vec![v(137.0, 751.0)];
    replay.units.push(unit);
    step(&mut replay, &speed(0.5), &mut no_draws);
    assert_eq!(replay.units[0].position, v(91.51688863492839, 684.5683716635633), "Native perimeter reduction lost one ULP");
}

#[test]
fn mountain_projection_divides_before_projecting_the_native_scalar_normal() {
    // Native 507f581e, tank 18, frame 9147. Recorded scalar hypot calls
    // expose both the push and projected slide without reconstructing them.
    let (slide, length, _) = mountain_projection(v(-0.2969848480983046, -0.04242640687118637), v(-6.3479060193181285, -1.2626770142061488)).expect("Native mountain projection was skipped");
    assert_eq!(slide, v(-0.0031853712349619867, 0.01601394260660611), "Native projected vector differs");
    assert_eq!(length, 0.016327674289751057, "Native projected scalar hypot differs");
    assert_eq!(v(577.0, 429.0) + slide * (0.3 / length), v(576.9414729033952, 429.294235584121), "Native slide position differs");
}

#[test]
fn mountain_collision_retry_preserves_native_normalized_direction() {
    // Native 5f2a4d69, tank 24, tick 8102. The initial friend check blocks
    // at radius 24, then the radius-22 retry accepts this forward step.
    let (slide, length, direction) = mountain_projection(v(0.16505433159568383, 0.1129471895245473), v(4.381494871788301, -3.5957999134012013)).expect("Native mountain retry projection was skipped");
    assert_eq!(slide, v(0.12181538492155757, 0.1484324759977742), "Native retry slide differs");
    assert_eq!(length, 0.19201871766683853, "Native retry scalar hypot differs");
    assert_eq!(v(823.8573619719496, 127.58317793760237) + direction * 0.2, v(823.9842406287822, 127.73778002827493), "Native collision retry lost one ULP");
}

#[test]
fn historical_retreat_retains_the_native_enemy_centroid() {
    // Native June replay 0914efce, unit 11, frames 2184 -> 2185.
    let mut replay = historical_map_31();
    let mut unit = Unit::new(0, 0, UnitType::Infantry, v(929.0, 60.0), 100.0);
    unit.health = 92.39168244117664;
    unit.morale = 98.7300000000022;
    unit.damage_received = 0.15812198609756645;
    replay.units.push(unit);
    replay.units.push(Unit::new(1, 1, UnitType::Tank, v(963.6498353485159, 53.99324986866003), 200.0));
    step(&mut replay, &speed(0.5), &mut || 0.01);
    assert_eq!(replay.units[0].position, v(928.2610217794175, 60.12810616497579), "Retreat centroid lost native precision");
}

#[test]
fn captured_capital_zeroes_the_first_reported_balance_without_spending_reserve() {
    let mut root = fixture();
    root["version"] = json!("1.2.23");
    root["map"]["cities"] = json!([[200, 450], [1400, 450], [1500, 450]]);
    let mut replay = read(&root);
    let (mut territory, mut economy) = economy(&replay);
    economy.funds[1] = 123.0;
    territory.city_colors[1] = 0;
    territory.update(vec![true; replay.units.len()], &replay.units, &replay.map.cities);
    economy.pay(&mut replay, &mut territory);
    assert!(!economy.city_groups[1][0].is_empty(), "Fixture did not retain a productive region");
    assert!(economy.balances[1][0] == 0.0 && economy.funds[1] == 123.0, "Missing-capital balance or reserve differed from native replay");
}

#[test]
fn historical_city_retreat_compares_the_full_probability() {
    // Native June replay 0914efce, unit 24, frames 3797 -> 3798.
    let mut replay = historical_map_31();
    let mut unit = Unit::new(0, 0, UnitType::Tank, v(847.0, 66.0), 200.0);
    unit.health = 181.98861048961405;
    unit.morale = 61.40000000000201;
    unit.damage_received = 0.021930549076622476;
    replay.units.push(unit);
    replay.units.push(Unit::new(1, 1, UnitType::Tank, v(881.0645024713372, 69.78201673072944), 200.0));
    step(&mut replay, &speed(0.3), &mut || 2.5939662009477615e-6);
    assert_eq!(replay.units[0].position, v(846.5527481016339, 65.95034378782152), "Retreat probability was quantized before comparison");
}

#[test]
fn stale_avalanche_capital_falls_back_to_its_sides_first_city() {
    // Original October replay c8113f04 stores capital 7 after its city list shrinks.
    let mut root = fixture();
    root["version"] = json!("1.4.1");
    root["mode"] = json!("avalanche");
    root["map"]["capitals"] = json!([0, 7]);
    let replay = read(&root);
    let (_, economy) = economy(&replay);
    assert_eq!(economy.capitals, [0, 1], "Stale capital did not resolve to an owned city");
    assert_eq!(economy.funds, [0.0, 15000.0], "Avalanche setup funds changed");
}

#[test]
fn three_color_numbered_map_retains_the_native_roster() {
    // Original October replay 0599e04c uses the native map 103 in v3 mode.
    let mut root = fixture();
    root["version"] = json!("1.4.1");
    root["mode"] = json!("v3");
    root["map"] = json!("103");
    let replay = read(&root);
    assert!(replay.side_count() == 3 && replay.units.len() == 55 && replay.map.cities.len() == 12, "Native three-color deployment was rejected or changed");
    assert!(replay.units[17].position == v(226.0, 510.0) && replay.units[37].position == v(964.0, 383.0), "Three-color native unit order changed");
    assert_eq!(replay.map.capitals, [1, 7, 10], "Three-color map capital indices changed");
}

#[test]
fn numbered_experimental_map_45_preserves_native_motorised_ids() {
    // Original September replay 1e2f0ff9 has a separate experimental roster.
    let mut root = fixture();
    root["version"] = json!("1.4.1");
    root["mode"] = json!("experiment");
    root["map"] = json!("45");
    let replay = read(&root);
    assert!(replay.experimental() && replay.units.len() == 46, "Experimental map roster changed");
    assert!(
        replay.units[20].kind == UnitType::Motorised && replay.units[20].position == v(762.0, 257.0) && replay.units[43].kind == UnitType::Motorised && replay.units[43].position == v(960.0, 440.0),
        "Native motorised unit order changed"
    );
}

#[test]
fn boundary_rejection_consumes_the_native_attempted_waypoint() {
    // Original October 0599e04c, frame 3096 -> 3097, plus native probes
    // of the same rule in the July 1.2.23 and 1.3.3 cores.
    let mut root = fixture();
    root["version"] = json!("1.4.1");
    root["map"] = json!("103");
    root["mode"] = json!("classic");
    for next_leg in [false, true] {
        let mut replay = read(&root);
        replay.units.clear();
        let mut unit = Unit::new(0, 0, UnitType::Infantry, v(161.62, 12.03), 100.0);
        unit.health = 72.954;
        unit.morale = 99.01;
        unit.path = vec![v(150.0, 5.0)];
        if next_leg {
            unit.path.push(v(200.0, 200.0));
        }
        replay.units.push(unit);
        step(&mut replay, &speed(0.5), &mut || 0.5);
        let unit = &replay.units[0];
        assert!(unit.position == v(161.62, 12.03) && unit.path_index == 1 && unit.stuck_timer == 1, "Boundary rejection moved the unit or retained its attempted waypoint");
    }
}

#[test]
fn eliminated_side_retains_the_native_zero_balance_slot() {
    // Native June replay 442c34df loses its last red region at tick 34532.
    let mut root = fixture();
    root["version"] = json!("1.2.18.3");
    let mut replay = read(&root);
    let (mut territory, mut economy) = economy(&replay);
    economy.funds[1] = 137.0;
    replay.units[1].health = 0.0;
    replay.units[1].active = false;
    territory.city_colors[1] = 0;
    territory.update(vec![true, false], &replay.units, &replay.map.cities);
    economy.pay(&mut replay, &mut territory);
    assert!(economy.dot_groups[1].is_empty() && economy.city_groups[1].is_empty(), "Fixture retained an eliminated side's supply region");
    assert!(economy.balances[1] == [0.0] && economy.funds[1] == 137.0, "Eliminated side lost its native zero balance slot or reserve");
}

#[test]
fn historical_retreat_divides_before_scaling_its_escape_waypoint() {
    // Native June replay 0914efce, unit 35, frames 5555 -> 5556.
    let mut replay = historical_map_31();
    let mut unit = Unit::new(0, 1, UnitType::Infantry, v(930.6590227863416, 391.05379563563827), 100.0);
    unit.health = 51.37959618663149;
    unit.morale = 0.05000000000127364;
    unit.damage_received = 0.012659315166848435;
    replay.units.push(unit);
    replay.units.push(Unit::new(1, 0, UnitType::Infantry, v(908.5989727606478, 364.81722645375044), 100.0));
    step(&mut replay, &speed(0.5), &mut || 0.01);
    assert_eq!(replay.units[0].position, v(931.1416904456801, 391.6278443536306), "Escape waypoint operation order changed a native position");
}

#[test]
fn nearby_mountain_with_no_perimeter_push_keeps_the_forward_proposal() {
    // Native June replay 0914efce, unit 30, frames 6797 -> 6798.
    let mut replay = historical_map_31();
    let mut unit = Unit::new(0, 1, UnitType::Infantry, v(1101.1371279620544, 511.64073121173806), 100.0);
    unit.path = vec![v(1104.0, 528.0)];
    replay.units.push(unit);
    step(&mut replay, &speed(0.5), &mut no_draws);
    assert!(replay.units[0].position == v(1101.2233181279305, 512.1332464453159) && replay.units[0].stuck_timer == 0, "Empty perimeter push blocked forward movement");
}

#[test]
fn historical_collision_retry_uses_the_native_hypot_result() {
    // Native June replay 68170f63, unit 33, frames 470 -> 471.
    let mut replay = historical_map_31();
    let mut infantry = Unit::new(0, 1, UnitType::Infantry, v(1361.415886968264, 171.63543043944676), 100.0);
    infantry.path = vec![v(1358.0, 200.0)];
    let mut tank = Unit::new(1, 1, UnitType::Tank, v(1355.2555645771342, 192.98012740510404), 200.0);
    tank.path = vec![v(1357.0, 195.0)];
    replay.units.push(infantry);
    replay.units.push(tank);
    step(&mut replay, &|unit, _| if unit.kind == UnitType::Tank { 0.3 } else { 0.5 }, &mut no_draws);
    assert_eq!(replay.units[0].position, v(1361.8962795904022, 171.77407721580775), "Scalar tangent normalization lost native precision");
}

#[test]
fn scalar_hypot_matches_native_results_on_both_sides_of_platform_rounding() {
    assert_eq!(python_hypot(21.344696965657278, 6.160322391129739), 22.21588756989901, "Native 68170f63 tangent length");
    assert_eq!(python_hypot(-20.89165037058467, -7.0565664831734125), 22.05121733007493, "Native f3bf6bf8 tangent length");
    assert!(python_hypot(3.0, 4.0) == 5.0 && python_hypot(0.0, 0.0) == 0.0, "Exact scalar norm cases");
}

#[test]
fn retreat_centroid_preserves_the_native_multi_enemy_reduction() {
    // Native June replay 5e2f47a6, unit 29, frame 5821.
    let (mut x, mut y) = (vec![0.0; 52], vec![0.0; 52]);
    x[2] = 726.2299298378151;
    x[13] = 760.7106953022144;
    x[14] = 739.4864827873632;
    y[2] = 278.70041086975687;
    y[13] = 253.5656656872756;
    y[14] = 261.04606777662775;
    assert_eq!(native_masked_matrix_sum(&x, 29) / 3.0, 742.1423693091309, "Three-enemy native x centroid");
    assert_eq!(native_masked_matrix_sum(&y, 29) / 3.0, 264.4373814445534, "Three-enemy native y centroid");
    // Native 258a1e8d, frame 8993. A compensated sum rounds this down.
    let mut x = vec![0.0; 43];
    x[6] = 702.9703021223644;
    x[13] = 689.973435877384;
    x[16] = 690.0857650660766;
    assert_eq!(native_masked_matrix_sum(&x, 32) / 3.0, 694.3431676886084, "Four-row matrix reduction");
    assert_eq!(native_masked_matrix_sum(&x, 42) / 3.0, 694.3431676886083, "Remaining-row matrix reduction");
}

#[test]
fn historical_naval_damage_uses_the_authenticated_june_constants() {
    for (version, inf_land, tank_land, inf_sea, tank_sea) in [("1.2.18.3", 0.02, 0.1, 0.2, 0.05), ("1.2.23", 0.04, 0.16, 0.3, 0.1)] {
        let mut root = fixture();
        root["version"] = json!(version);
        let mut replay = read(&root);
        let full_precision = replay.full_precision_positions();
        replay.units[0].ship = true;
        replay.units[0].target_id = 1;
        let mut tank = Unit::new(2, 0, UnitType::Tank, replay.units[0].position, 200.0);
        tank.ship = true;
        tank.target_id = 1;
        replay.units.push(tank);
        let damage = |replay: &Replay, id: usize| damage_for(&replay.units[id], &replay.units, &replay.map.surface, full_precision);
        assert!(damage(&replay, 0) == inf_land && damage(&replay, 2) == tank_land, "Ship-to-land damage profile");
        replay.units[1].ship = true;
        assert!(damage(&replay, 0) == inf_sea && damage(&replay, 2) == tank_sea, "Ship-to-ship damage profile");
    }
}

#[test]
fn rounded_position_cores_still_compare_retreat_probability_without_quantizing() {
    // Native July replay 15b57632, unit 49, frames 6911 -> 6912.
    let mut root = fixture();
    root["version"] = json!("1.2.23");
    let mut replay = read(&root);
    replay.units.clear();
    let mut unit = Unit::new(0, 1, UnitType::Tank, v(567.15, 694.42), 200.0);
    unit.health = 159.505;
    unit.morale = 62.23;
    unit.damage_received = 0.138;
    replay.units.push(unit);
    replay.units.push(Unit::new(1, 0, UnitType::Infantry, v(533.95, 702.71), 100.0));
    replay.units.push(Unit::new(2, 0, UnitType::Tank, v(567.63, 728.31), 200.0));
    step(&mut replay, &speed(0.3), &mut || 0.0959036978892982);
    assert!(replay.units[0].retreating && replay.units[0].had_objective, "Rounding a valid retreat into a probability tie suppressed it");
}

#[test]
fn retreat_probability_and_roll_round_to_a_strict_tie_in_1_3() {
    // Original August core, d0d37247, unit 46, frames 4360 -> 4361.
    // Both native arrays round to .088901; the unit must stay in place.
    for version in ["1.3.3", "1.3.4"] {
        let mut root = fixture();
        root["version"] = json!(version);
        let mut replay = read(&root);
        replay.units.clear();
        let mut unit = Unit::new(0, 1, UnitType::Tank, v(960.52, 593.51), 200.0);
        unit.health = 135.395;
        unit.morale = 0.08;
        unit.damage_received = 0.069;
        replay.units.push(unit);
        replay.units.push(Unit::new(1, 0, UnitType::Tank, v(932.77, 573.46), 200.0));
        step(&mut replay, &speed(0.3), &mut || 0.08890081406570971);
        assert!(!replay.units[0].retreating && replay.units[0].position == v(960.52, 593.51), "Native rounded retreat tie incorrectly moved the unit");
    }
}

#[test]
fn mixed_production_retains_its_queue_while_blocked_and_spends_the_spawned_types_price() {
    let mut root = fixture();
    root["version"] = json!("1.2.23");
    let mut replay = read(&root);
    let (territory, mut economy) = economy(&replay);
    economy.city_groups[0].push(vec![0]);
    economy.funds[0] = 1000.0;
    economy.set_production(&production(0, UnitType::Infantry, 1.0, None, Some(0.35)), &mut || 0.2);
    let initial = replay.units.len();
    let draws = std::cell::Cell::new(0);
    let mut draw = || {
        draws.set(draws.get() + 1);
        0.7
    };
    // First queued unit is infantry; the successful birth selects a tank next.
    economy.produce(&mut replay, &territory, &mut draw);
    assert!(replay.units.len() == initial + 1 && replay.units.last().unwrap().kind == UnitType::Infantry, "Wrong queued birth");
    assert!(economy.funds[0] == 800.0 && economy.production_types[0] == UnitType::Tank, "Wrong price/next type");
    economy.produce(&mut replay, &territory, &mut draw);
    assert!(replay.units.len() == initial + 1 && economy.funds[0] == 800.0 && draws.get() == 3, "Blocked attempt spent funds or rerolled type");
    replay.units.last_mut().unwrap().position = v(300.0, 450.0);
    economy.produce(&mut replay, &territory, &mut draw);
    assert!(replay.units.last().unwrap().kind == UnitType::Tank && economy.funds[0] == 400.0, "Tank queue not preserved");
}

#[test]
fn blocked_production_consumes_the_reserved_next_type_roll_in_1_3() {
    let mut replay = read(&fixture());
    let (territory, mut economy) = economy(&replay);
    economy.city_groups[0].push(vec![0]);
    economy.funds[0] = 1000.0;
    economy.set_production(&production(0, UnitType::Infantry, 1.0, None, Some(0.35)), &mut || 0.2);
    let draws = std::cell::Cell::new(0);
    let mut draw = || {
        draws.set(draws.get() + 1);
        0.7
    };
    economy.produce(&mut replay, &territory, &mut draw);
    assert!(draws.get() == 2 && economy.production_queue[0] == UnitType::Tank, "Successful birth queue selection");
    economy.produce(&mut replay, &territory, &mut draw);
    assert!(draws.get() == 4 && economy.production_queue[0] == UnitType::Tank && economy.funds[0] == 800.0, "Blocked attempt skipped its roll or committed/spent production");
}

#[test]
fn missing_unit_orders_defer_latest_order_wins_no_invented_unit() {
    let mut root = fixture();
    root["0"] = json!({"2": [[200, 450], [400, 450]]});
    root["1"] = json!({"2": [[200, 450], [500, 450]]});
    root["end"] = json!(3);
    let mut sim = Simulator::new(read(&root));
    let options = RunOptions { max_frame: None, sample_every: 1, no_combat: true, render_state: false };
    sim.run(&options, |sim, frame| {
        if frame == 2 {
            assert!(sim.replay.units.len() == 2 && sim.deferred_order_count == 2, "Orders created units or stopped playback");
            sim.replay.units.push(Unit::new(2, 0, UnitType::Infantry, v(200.0, 450.0), 100.0));
        }
        Ok::<(), ()>(())
    })
    .unwrap();
    assert!(sim.pending_order_count() == 0 && sim.replay.units[2].path.last().unwrap().x == 500.0, "Deferred latest order not applied");
}

#[test]
fn binary_chunks_send_the_first_frame_alone_then_up_to_60_frames_from_a_complete_one() {
    let mut root = fixture();
    root["end"] = json!(125);
    let mut sim = Simulator::new(read(&root));
    let mut bytes = Vec::new();
    let options = RunOptions { max_frame: None, sample_every: 1, no_combat: false, render_state: true };
    let frames = output::write_chunks(&mut sim, &options, &|text, _| json!({ "text": text }), &mut bytes).unwrap();
    assert_eq!(&bytes[..8], output::FRAME_MAGIC, "Missing chunk stream marker");
    let u32_at = |data: &[u8], at: usize| u32::from_le_bytes(data[at..at + 4].try_into().unwrap()) as usize;
    let (mut counts, mut next, mut metadata) = (Vec::new(), 0, None);
    let mut at = 8;
    while at < bytes.len() {
        let length = u32_at(&bytes, at + 1);
        let payload = &bytes[at + 5..at + 5 + length];
        if bytes[at] == output::STATIC_RECORD {
            metadata = Some(serde_json::from_slice::<Value>(payload).unwrap());
        } else {
            let count = u32_at(payload, 1);
            for i in 0..count {
                assert_eq!(u32_at(payload, 5 + 4 * i), next, "Chunk frames out of order");
                next += 1;
            }
            let mut raw = Vec::new();
            DeflateDecoder::new(&payload[5 + 12 * count..]).read_to_end(&mut raw).unwrap();
            assert_eq!(u32_at(&raw, 0), next - count, "Chunk does not start with its first frame");
            counts.push(count);
        }
        at += 5 + length;
    }
    assert!(metadata.unwrap().get("rendered_map_surface").is_some(), "Static record lacks the rendered map");
    assert!(frames == 126 && counts == [1, 60, 60, 5], "Unexpected chunks {counts:?}");
}
