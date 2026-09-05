CREATE TABLE IF NOT EXISTS contact_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
    phone TEXT NOT NULL CHECK (char_length(phone) BETWEEN 5 AND 32),
    email TEXT CHECK (email IS NULL OR char_length(email) <= 254),
    message TEXT NOT NULL CHECK (char_length(message) BETWEEN 1 AND 3000),
    status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'processed', 'spam')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS contact_requests_created_at_idx ON contact_requests(created_at DESC);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS reservation_expires_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS stock_released_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_valid;
ALTER TABLE orders ADD CONSTRAINT orders_status_valid
    CHECK (status IN ('pending', 'awaiting_payment', 'paid', 'expired', 'cancelled', 'refunded')) NOT VALID;
ALTER TABLE orders VALIDATE CONSTRAINT orders_status_valid;
CREATE INDEX IF NOT EXISTS orders_expiring_reservations_idx
    ON orders(reservation_expires_at) WHERE status = 'awaiting_payment' AND stock_released_at IS NULL;
