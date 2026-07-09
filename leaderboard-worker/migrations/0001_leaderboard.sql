CREATE TABLE IF NOT EXISTS players (
  normalized_username TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  token_verifier TEXT NOT NULL,
  score INTEGER NOT NULL,
  official_rank INTEGER,
  games INTEGER,
  wins INTEGER,
  losses INTEGER,
  region TEXT,
  source TEXT,
  first_seen INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  normalized_username TEXT NOT NULL,
  username TEXT NOT NULL,
  score INTEGER NOT NULL,
  official_rank INTEGER,
  games INTEGER,
  wins INTEGER,
  losses INTEGER,
  region TEXT,
  source TEXT,
  fetched_at INTEGER NOT NULL,
  submitted_at INTEGER NOT NULL,
  client_version TEXT,
  FOREIGN KEY (normalized_username) REFERENCES players(normalized_username)
);

CREATE INDEX IF NOT EXISTS idx_players_score ON players(score DESC, updated_at ASC);
CREATE INDEX IF NOT EXISTS idx_snapshots_player ON snapshots(normalized_username, submitted_at DESC);
