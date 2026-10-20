-- Заявки бывают двух видов: обычный вопрос с формы контактов и запрос замера по смете.
ALTER TABLE contact_requests ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'contact';
ALTER TABLE contact_requests ADD COLUMN IF NOT EXISTS estimate_items TEXT;
ALTER TABLE contact_requests ADD COLUMN IF NOT EXISTS estimate_total BIGINT;
ALTER TABLE contact_requests DROP CONSTRAINT IF EXISTS contact_requests_source_check;
ALTER TABLE contact_requests ADD CONSTRAINT contact_requests_source_check
    CHECK (source IN ('contact', 'estimate'));
