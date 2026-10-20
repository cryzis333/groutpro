-- The already-deployed schema restricts orders.status via a CHECK constraint.
-- This codebase uses 'pending_payment' as its initial order status, which
-- isn't in that list. Widen the constraint so inserts don't fail.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_valid;
ALTER TABLE orders ADD CONSTRAINT orders_status_valid
    CHECK (status IN ('pending', 'pending_payment', 'awaiting_payment', 'paid', 'expired', 'cancelled', 'refunded')) NOT VALID;
ALTER TABLE orders VALIDATE CONSTRAINT orders_status_valid;
