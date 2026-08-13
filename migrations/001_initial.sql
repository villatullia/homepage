PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS properties (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  legal_name TEXT NOT NULL,
  address TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Europe/Rome',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS administrators (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id TEXT PRIMARY KEY,
  administrator_id TEXT NOT NULL REFERENCES administrators(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  ip_hash TEXT,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS admin_sessions_expiry_idx ON admin_sessions(expires_at);

CREATE TABLE IF NOT EXISTS enquiries (
  id TEXT PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'ENQUIRY_NEW' CHECK (status IN ('ENQUIRY_NEW','ENQUIRY_APPROVED','CONVERTED','DECLINED','SPAM')),
  full_name TEXT NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE,
  phone TEXT,
  requested_check_in TEXT,
  requested_check_out TEXT,
  guests_count INTEGER CHECK (guests_count IS NULL OR guests_count BETWEEN 1 AND 8),
  message TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'WEBSITE',
  privacy_notice_version TEXT NOT NULL,
  ip_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS enquiries_status_created_idx ON enquiries(status, created_at DESC);

CREATE TABLE IF NOT EXISTS guests (
  id TEXT PRIMARY KEY,
  legal_name TEXT NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE,
  phone TEXT NOT NULL,
  address_line1 TEXT NOT NULL,
  address_line2 TEXT,
  postal_code TEXT NOT NULL,
  city TEXT NOT NULL,
  region TEXT,
  country TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS booking_reference_sequences (
  year INTEGER PRIMARY KEY,
  next_value INTEGER NOT NULL CHECK (next_value > 0)
);

CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  property_id TEXT NOT NULL REFERENCES properties(id),
  enquiry_id TEXT UNIQUE REFERENCES enquiries(id),
  primary_guest_id TEXT NOT NULL REFERENCES guests(id),
  status TEXT NOT NULL DEFAULT 'AGREEMENT_DRAFT' CHECK (status IN (
    'AGREEMENT_DRAFT','AWAITING_OWNER_SIGNATURE','AWAITING_GUEST_SIGNATURE','AGREEMENT_SIGNED',
    'AWAITING_PAYMENT','PAYMENT_PROCESSING','CONFIRMED','PAYMENT_FAILED','EXPIRED','CANCELLED','REFUNDED'
  )),
  check_in TEXT NOT NULL,
  check_out TEXT NOT NULL,
  guests_count INTEGER NOT NULL CHECK (guests_count BETWEEN 1 AND 8),
  currency TEXT NOT NULL DEFAULT 'EUR' CHECK (length(currency) = 3),
  rental_price_minor INTEGER NOT NULL CHECK (rental_price_minor >= 0),
  amount_due_minor INTEGER NOT NULL CHECK (amount_due_minor >= 0),
  remaining_balance_minor INTEGER NOT NULL CHECK (remaining_balance_minor >= 0),
  security_deposit_minor INTEGER NOT NULL CHECK (security_deposit_minor >= 0),
  tourist_tax_minor INTEGER NOT NULL CHECK (tourist_tax_minor >= 0),
  payment_deadline TEXT NOT NULL,
  cancellation_terms TEXT NOT NULL,
  special_conditions TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  confirmed_at TEXT,
  cancelled_at TEXT,
  CHECK (check_out > check_in),
  CHECK (amount_due_minor + remaining_balance_minor <= rental_price_minor + security_deposit_minor + tourist_tax_minor)
);

CREATE INDEX IF NOT EXISTS bookings_status_dates_idx ON bookings(status, check_in, check_out);

CREATE TABLE IF NOT EXISTS booking_guests (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  position INTEGER NOT NULL,
  UNIQUE (booking_id, position)
);

CREATE TABLE IF NOT EXISTS date_blocks (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id),
  booking_id TEXT NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
  check_in TEXT NOT NULL,
  check_out TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('HOLD','CONFIRMED')),
  expires_at INTEGER,
  released_at TEXT,
  release_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (check_out > check_in),
  CHECK ((kind = 'CONFIRMED' AND expires_at IS NULL) OR kind = 'HOLD')
);

CREATE INDEX IF NOT EXISTS date_blocks_active_idx ON date_blocks(property_id, check_in, check_out) WHERE released_at IS NULL;

CREATE TRIGGER IF NOT EXISTS date_blocks_no_overlap_insert
BEFORE INSERT ON date_blocks
WHEN NEW.released_at IS NULL
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM date_blocks existing
    WHERE existing.property_id = NEW.property_id
      AND existing.released_at IS NULL
      AND (existing.expires_at IS NULL OR existing.expires_at > unixepoch())
      AND NEW.check_in < existing.check_out
      AND NEW.check_out > existing.check_in
  ) THEN RAISE(ABORT, 'date_overlap') END;
END;

CREATE TRIGGER IF NOT EXISTS date_blocks_no_overlap_update
BEFORE UPDATE OF property_id, check_in, check_out, released_at, expires_at ON date_blocks
WHEN NEW.released_at IS NULL
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM date_blocks existing
    WHERE existing.id <> NEW.id
      AND existing.property_id = NEW.property_id
      AND existing.released_at IS NULL
      AND (existing.expires_at IS NULL OR existing.expires_at > unixepoch())
      AND NEW.check_in < existing.check_out
      AND NEW.check_out > existing.check_in
  ) THEN RAISE(ABORT, 'date_overlap') END;
END;

CREATE TABLE IF NOT EXISTS agreement_templates (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  body_template TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agreements (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  template_id TEXT NOT NULL REFERENCES agreement_templates(id),
  template_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('DRAFT','SENT','OWNER_SIGNED','COMPLETED','INVALIDATED','CANCELLED','DECLINED','EXPIRED')),
  generated_at TEXT NOT NULL,
  rendered_html TEXT NOT NULL,
  template_data_json TEXT NOT NULL,
  page_count INTEGER NOT NULL CHECK (page_count > 0),
  document_hash TEXT NOT NULL,
  unsigned_pdf_path TEXT NOT NULL UNIQUE,
  signed_pdf_path TEXT UNIQUE,
  signed_document_hash TEXT,
  provider TEXT NOT NULL,
  provider_document_id TEXT UNIQUE,
  owner_signed_at TEXT,
  guest_signed_at TEXT,
  completed_at TEXT,
  invalidated_at TEXT,
  invalidated_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (booking_id, version)
);

CREATE INDEX IF NOT EXISTS agreements_booking_version_idx ON agreements(booking_id, version DESC);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  agreement_id TEXT NOT NULL REFERENCES agreements(id),
  agreement_version INTEGER NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('CREATED','PENDING','PROCESSING','SUCCEEDED','FAILED','EXPIRED','REFUNDED','PARTIALLY_REFUNDED')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  refunded_minor INTEGER NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0 AND refunded_minor <= amount_minor),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  checkout_session_id TEXT UNIQUE,
  checkout_url TEXT,
  payment_intent_id TEXT UNIQUE,
  charge_id TEXT,
  failure_code TEXT,
  failure_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  paid_at TEXT,
  refunded_at TEXT
);

CREATE INDEX IF NOT EXISTS payments_booking_created_idx ON payments(booking_id, created_at DESC);

CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  processing_error TEXT,
  UNIQUE (provider, provider_event_id)
);

CREATE TABLE IF NOT EXISTS booking_events (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('SYSTEM','ADMIN','GUEST','SIGNATURE_PROVIDER','PAYMENT_PROVIDER')),
  actor_id TEXT,
  event_type TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS booking_events_timeline_idx ON booking_events(booking_id, created_at DESC);

CREATE TABLE IF NOT EXISTS guest_access_tokens (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  token_ciphertext TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'STATUS',
  expires_at INTEGER NOT NULL,
  revoked_at TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS guest_tokens_expiry_idx ON guest_access_tokens(expires_at);

CREATE TABLE IF NOT EXISTS email_deliveries (
  id TEXT PRIMARY KEY,
  booking_id TEXT REFERENCES bookings(id) ON DELETE CASCADE,
  template_key TEXT NOT NULL,
  recipient TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  provider_message_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('QUEUED','SENT','FAILED','PREVIEWED')),
  error_message TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);

CREATE TABLE IF NOT EXISTS scheduled_jobs (
  id TEXT PRIMARY KEY,
  job_type TEXT NOT NULL,
  booking_id TEXT REFERENCES bookings(id) ON DELETE CASCADE,
  run_at INTEGER NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RUNNING','COMPLETED','FAILED','CANCELLED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS scheduled_jobs_due_idx ON scheduled_jobs(status, run_at);
