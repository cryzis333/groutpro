ALTER TABLE products
    ADD CONSTRAINT products_price_positive CHECK (price > 0) NOT VALID,
    ADD CONSTRAINT products_stock_nonnegative CHECK (stock >= 0) NOT VALID;

ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ,
    ADD CONSTRAINT orders_total_nonnegative CHECK (total_amount >= 0) NOT VALID,
    ADD CONSTRAINT orders_status_valid CHECK (status IN ('pending', 'paid', 'cancelled', 'refunded')) NOT VALID;

ALTER TABLE order_items
    ADD COLUMN IF NOT EXISTS product_title TEXT;
UPDATE order_items oi
SET product_title = p.title
FROM products p
WHERE oi.product_id = p.id AND oi.product_title IS NULL;
ALTER TABLE order_items
    ALTER COLUMN product_title SET NOT NULL,
    ADD CONSTRAINT order_items_quantity_positive CHECK (quantity > 0 AND quantity <= 100) NOT VALID,
    ADD CONSTRAINT order_items_price_positive CHECK (price > 0) NOT VALID;

CREATE UNIQUE INDEX IF NOT EXISTS orders_payment_id_unique
    ON orders(payment_id) WHERE payment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS order_items_order_id_idx ON order_items(order_id);
CREATE INDEX IF NOT EXISTS orders_created_at_idx ON orders(created_at DESC);

ALTER TABLE products VALIDATE CONSTRAINT products_price_positive;
ALTER TABLE products VALIDATE CONSTRAINT products_stock_nonnegative;
ALTER TABLE orders VALIDATE CONSTRAINT orders_total_nonnegative;
ALTER TABLE orders VALIDATE CONSTRAINT orders_status_valid;
ALTER TABLE order_items VALIDATE CONSTRAINT order_items_quantity_positive;
ALTER TABLE order_items VALIDATE CONSTRAINT order_items_price_positive;
