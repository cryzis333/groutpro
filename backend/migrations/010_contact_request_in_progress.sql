-- Leads get a fourth state: новая → в обработке → обработана (or спам).
ALTER TABLE contact_requests DROP CONSTRAINT IF EXISTS contact_requests_status_check;
ALTER TABLE contact_requests ADD CONSTRAINT contact_requests_status_check
    CHECK (status IN ('new', 'in_progress', 'processed', 'spam'));
