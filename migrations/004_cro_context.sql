ALTER TABLE cro_events ADD COLUMN country_code TEXT;
ALTER TABLE cro_events ADD COLUMN browser TEXT;
ALTER TABLE cro_events ADD COLUMN operating_system TEXT;
ALTER TABLE cro_events ADD COLUMN language TEXT;
ALTER TABLE cro_events ADD COLUMN timezone TEXT;
ALTER TABLE cro_events ADD COLUMN screen_size TEXT;

CREATE INDEX IF NOT EXISTS cro_events_site_country_idx ON cro_events(site_id, country_code);
