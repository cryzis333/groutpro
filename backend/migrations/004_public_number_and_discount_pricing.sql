-- Additive migration: adds public order numbers and per-line discount pricing
-- on top of the integrity/contacts work already applied as migrations 001-003.

ALTER TABLE products
    ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS is_published BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS public_number TEXT;

ALTER TABLE order_items
    ADD COLUMN IF NOT EXISTS product_title TEXT,
    ADD COLUMN IF NOT EXISTS original_unit_price BIGINT,
    ADD COLUMN IF NOT EXISTS final_unit_price BIGINT,
    ADD COLUMN IF NOT EXISTS discount_percent_bps INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS discount_source TEXT;

WITH numbered_orders AS (
    SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS row_number
    FROM orders
    WHERE public_number IS NULL
)
UPDATE orders o
SET public_number = 'GP-' || LPAD(numbered_orders.row_number::TEXT, 8, '0')
FROM numbered_orders
WHERE o.id = numbered_orders.id;

UPDATE order_items oi
SET product_title = COALESCE(oi.product_title, p.title, 'Товар'),
    original_unit_price = COALESCE(oi.original_unit_price, oi.price),
    final_unit_price = COALESCE(oi.final_unit_price, oi.price)
FROM products p
WHERE oi.product_id = p.id
  AND (oi.product_title IS NULL OR oi.original_unit_price IS NULL OR oi.final_unit_price IS NULL);

UPDATE order_items
SET product_title = COALESCE(product_title, 'Товар'),
    original_unit_price = COALESCE(original_unit_price, price),
    final_unit_price = COALESCE(final_unit_price, price);

ALTER TABLE orders
    ALTER COLUMN public_number SET NOT NULL;

ALTER TABLE order_items
    ALTER COLUMN product_title SET NOT NULL,
    ALTER COLUMN original_unit_price SET NOT NULL,
    ALTER COLUMN final_unit_price SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS orders_public_number_key ON orders(public_number);
CREATE INDEX IF NOT EXISTS orders_status_created_at_idx ON orders(status, created_at DESC);
CREATE INDEX IF NOT EXISTS products_public_catalog_idx ON products(category, created_at DESC)
    WHERE archived_at IS NULL AND is_published = TRUE;
