CREATE TABLE IF NOT EXISTS discounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID REFERENCES products(id) ON DELETE CASCADE,
    category TEXT,
    percent_bps INTEGER NOT NULL CHECK (percent_bps > 0 AND percent_bps < 10000),
    is_registered_only BOOLEAN NOT NULL DEFAULT TRUE,
    starts_at TIMESTAMPTZ,
    ends_at TIMESTAMPTZ,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT discounts_one_scope CHECK ((product_id IS NOT NULL) <> (category IS NOT NULL)),
    CONSTRAINT discounts_valid_period CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS discounts_product_active_idx ON discounts(product_id, is_active, starts_at, ends_at);
CREATE INDEX IF NOT EXISTS discounts_category_active_idx ON discounts(category, is_active, starts_at, ends_at);
