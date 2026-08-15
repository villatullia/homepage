CREATE TABLE IF NOT EXISTS cro_sites (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

INSERT INTO cro_sites (id, name, created_at)
VALUES ('villa-tullia', 'Villa Tullia', datetime('now'))
ON CONFLICT(id) DO NOTHING;

CREATE TABLE IF NOT EXISTS cro_events (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES cro_sites(id),
  visitor_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  event_name TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  page TEXT NOT NULL,
  referrer TEXT,
  device_type TEXT NOT NULL CHECK (device_type IN ('mobile','tablet','desktop')),
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_term TEXT,
  utm_content TEXT,
  properties_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS cro_events_site_time_idx ON cro_events(site_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS cro_events_site_event_idx ON cro_events(site_id, event_name, occurred_at DESC);
CREATE INDEX IF NOT EXISTS cro_events_site_visitor_idx ON cro_events(site_id, visitor_id);
CREATE INDEX IF NOT EXISTS cro_events_site_session_idx ON cro_events(site_id, session_id);
