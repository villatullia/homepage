CREATE TABLE IF NOT EXISTS manual_week_blocks (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id),
  check_in TEXT NOT NULL,
  check_out TEXT NOT NULL,
  note TEXT,
  created_by TEXT REFERENCES administrators(id),
  released_at TEXT,
  released_by TEXT REFERENCES administrators(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (check_out > check_in)
);

CREATE INDEX IF NOT EXISTS manual_week_blocks_active_idx
  ON manual_week_blocks(property_id, check_in, check_out)
  WHERE released_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS manual_week_blocks_active_week_idx
  ON manual_week_blocks(property_id, check_in, check_out)
  WHERE released_at IS NULL;

