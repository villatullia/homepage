ALTER TABLE payments ADD COLUMN purpose TEXT NOT NULL DEFAULT 'INITIAL'
  CHECK (purpose IN ('INITIAL', 'BALANCE'));
ALTER TABLE payments ADD COLUMN due_date TEXT;

UPDATE payments
SET due_date = (SELECT payment_deadline FROM bookings WHERE bookings.id = payments.booking_id)
WHERE due_date IS NULL;

CREATE INDEX IF NOT EXISTS payments_booking_purpose_idx
  ON payments(booking_id, purpose, created_at DESC);
