-- Подрядные работы считаются за пог. м, м², ввод или объект, а не «за штуку».
ALTER TABLE products ADD COLUMN IF NOT EXISTS unit TEXT;
