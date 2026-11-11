-- Ledung's anonymous check-in (#220): one row per install ID. Days, not times; no IP address, nothing else.
CREATE TABLE IF NOT EXISTS installs (
  id TEXT PRIMARY KEY,
  first_day TEXT NOT NULL,
  last_day TEXT NOT NULL,
  version TEXT NOT NULL,
  channel TEXT NOT NULL,
  os TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS installs_last_day ON installs (last_day);
