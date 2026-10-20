-- Владелец задаёт порядок позиций в каталоге; у остальных — значение по умолчанию.
ALTER TABLE products ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 1000;
CREATE INDEX IF NOT EXISTS products_sort_idx ON products(sort_order, created_at DESC);
