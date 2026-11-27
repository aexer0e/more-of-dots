-- What the list of every shared replay filters and sorts by, read from the replay:
-- its match format (1v1, 2v2, 3P, 4P, Experiment, Avalanche), whether it is played on
-- a custom map, the official map it names, and the custom map's picture (PNG).
ALTER TABLE replays ADD COLUMN mode TEXT;
ALTER TABLE replays ADD COLUMN custom INTEGER;
ALTER TABLE replays ADD COLUMN map TEXT;
ALTER TABLE replays ADD COLUMN thumb BLOB;
CREATE INDEX IF NOT EXISTS replays_created ON replays (created);
