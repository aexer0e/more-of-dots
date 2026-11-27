-- Players and maps kept in a form the database can count and filter by an index, and
-- their totals, kept by triggers as replays are shared, described and removed, so no
-- code has to remember to update them.

-- The map a replay is played on, as More of Dots identifies it:
--   vanilla:<the image the replay names, lower case, with forward slashes>
--   custom:<SHA-256 of the embedded image's PNG bytes>
-- Filled in when a replay is shared or described (src/listing.js, scripts/describe.mjs).
ALTER TABLE replays ADD COLUMN map_key TEXT;
CREATE INDEX IF NOT EXISTS replays_map_key ON replays (map_key);

-- One row per player of a replay; teammates are one row, "a & b", as the list shows them.
-- A player is known by their name without the title some replays add, as in
-- "aexer0e [Champion]", so their replays count together.
CREATE TABLE IF NOT EXISTS replay_players (
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  PRIMARY KEY (id, name_key)
);
CREATE INDEX IF NOT EXISTS replay_players_name ON replay_players (name_key);

-- How many replays each player and each map has, and the latest one.
CREATE TABLE IF NOT EXISTS player_stats (
  name_key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  replays INTEGER NOT NULL,
  latest INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS map_stats (
  map_key TEXT PRIMARY KEY,
  replays INTEGER NOT NULL,
  latest INTEGER NOT NULL
);

-- A replay's players follow its players column.
CREATE TRIGGER IF NOT EXISTS replays_players_added AFTER INSERT ON replays WHEN NEW.players IS NOT NULL BEGIN
  INSERT OR IGNORE INTO replay_players (id, name, name_key)
    SELECT NEW.id, trim(CASE WHEN value LIKE '%]' AND instr(value, ' [') > 0 THEN substr(value, 1, instr(value, ' [') - 1) ELSE value END), lower(trim(CASE WHEN value LIKE '%]' AND instr(value, ' [') > 0 THEN substr(value, 1, instr(value, ' [') - 1) ELSE value END)) FROM json_each(NEW.players) WHERE value <> '';
END;
CREATE TRIGGER IF NOT EXISTS replays_players_changed AFTER UPDATE OF players ON replays BEGIN
  DELETE FROM replay_players WHERE id = OLD.id;
  INSERT OR IGNORE INTO replay_players (id, name, name_key)
    SELECT NEW.id, trim(CASE WHEN value LIKE '%]' AND instr(value, ' [') > 0 THEN substr(value, 1, instr(value, ' [') - 1) ELSE value END), lower(trim(CASE WHEN value LIKE '%]' AND instr(value, ' [') > 0 THEN substr(value, 1, instr(value, ' [') - 1) ELSE value END)) FROM json_each(coalesce(NEW.players, '[]')) WHERE value <> '';
END;
CREATE TRIGGER IF NOT EXISTS replays_players_removed AFTER DELETE ON replays BEGIN
  DELETE FROM replay_players WHERE id = OLD.id;
END;

-- Each player's total follows their rows.
CREATE TRIGGER IF NOT EXISTS player_stats_added AFTER INSERT ON replay_players BEGIN
  INSERT INTO player_stats (name_key, name, replays, latest)
    VALUES (NEW.name_key, NEW.name, 1, coalesce((SELECT created FROM replays WHERE id = NEW.id), 0))
    ON CONFLICT (name_key) DO UPDATE SET replays = replays + 1, latest = max(latest, excluded.latest), name = excluded.name;
END;
CREATE TRIGGER IF NOT EXISTS player_stats_removed AFTER DELETE ON replay_players BEGIN
  UPDATE player_stats SET replays = replays - 1,
    latest = coalesce((SELECT max(r.created) FROM replay_players AS p JOIN replays AS r ON r.id = p.id WHERE p.name_key = OLD.name_key), 0)
    WHERE name_key = OLD.name_key;
  DELETE FROM player_stats WHERE name_key = OLD.name_key AND replays <= 0;
END;

-- Each map's total follows the replays played on it.
CREATE TRIGGER IF NOT EXISTS map_stats_added AFTER INSERT ON replays WHEN NEW.map_key IS NOT NULL BEGIN
  INSERT INTO map_stats (map_key, replays, latest) VALUES (NEW.map_key, 1, NEW.created)
    ON CONFLICT (map_key) DO UPDATE SET replays = replays + 1, latest = max(latest, excluded.latest);
END;
CREATE TRIGGER IF NOT EXISTS map_stats_changed AFTER UPDATE OF map_key ON replays WHEN OLD.map_key IS NOT NEW.map_key BEGIN
  UPDATE map_stats SET replays = replays - 1,
    latest = coalesce((SELECT max(created) FROM replays WHERE map_key = OLD.map_key), 0)
    WHERE map_key = OLD.map_key;
  DELETE FROM map_stats WHERE map_key = OLD.map_key AND replays <= 0;
  INSERT INTO map_stats (map_key, replays, latest) SELECT NEW.map_key, 1, NEW.created WHERE NEW.map_key IS NOT NULL
    ON CONFLICT (map_key) DO UPDATE SET replays = replays + 1, latest = max(latest, excluded.latest);
END;
CREATE TRIGGER IF NOT EXISTS map_stats_removed AFTER DELETE ON replays WHEN OLD.map_key IS NOT NULL BEGIN
  UPDATE map_stats SET replays = replays - 1,
    latest = coalesce((SELECT max(created) FROM replays WHERE map_key = OLD.map_key), 0)
    WHERE map_key = OLD.map_key;
  DELETE FROM map_stats WHERE map_key = OLD.map_key AND replays <= 0;
END;

-- The players of replays shared before now. Their maps are keyed by scripts/describe.mjs,
-- which reads each replay, and the triggers above count them as it does.
INSERT OR IGNORE INTO replay_players (id, name, name_key)
  SELECT replays.id, trim(CASE WHEN j.value LIKE '%]' AND instr(j.value, ' [') > 0 THEN substr(j.value, 1, instr(j.value, ' [') - 1) ELSE j.value END), lower(trim(CASE WHEN j.value LIKE '%]' AND instr(j.value, ' [') > 0 THEN substr(j.value, 1, instr(j.value, ' [') - 1) ELSE j.value END)) FROM replays, json_each(replays.players) AS j
  WHERE replays.players IS NOT NULL AND j.value <> '';
