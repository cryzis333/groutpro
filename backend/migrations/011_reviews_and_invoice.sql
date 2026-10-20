-- Счёт для юрлиц: заказ можно оформить без онлайн-оплаты.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS company_name TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS company_inn TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method TEXT NOT NULL DEFAULT 'sbp';

-- Отзывы и предложения: публикуются только после модерации в админке.
CREATE TABLE IF NOT EXISTS reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind TEXT NOT NULL DEFAULT 'review' CHECK (kind IN ('review', 'suggestion')),
    author_name TEXT NOT NULL CHECK (char_length(author_name) BETWEEN 2 AND 120),
    rating INT CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
    message TEXT NOT NULL CHECK (char_length(message) BETWEEN 5 AND 3000),
    contact TEXT CHECK (contact IS NULL OR char_length(contact) <= 254),
    status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'published', 'rejected')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS reviews_status_created_idx ON reviews(status, created_at DESC);
