ALTER TABLE payments ADD COLUMN payment_method TEXT
  CHECK (payment_method IS NULL OR payment_method IN ('CARD', 'BANK_TRANSFER'));
ALTER TABLE payments ADD COLUMN bank_transfer_selected_at TEXT;
ALTER TABLE payments ADD COLUMN bank_transfer_confirmed_at TEXT;
