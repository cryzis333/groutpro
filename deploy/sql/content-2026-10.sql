-- Правки каталога по просьбе заказчика (октябрь 2026).
--
-- Что делает:
--   1. Порядок услуг в магазине и смете на главной (sort_order 10…60):
--        10 Стабилизация грунта
--        20 Подъём (подъем) зданий и сооружений
--        30 Инъектирование ж/б конструкций эпоксидной смолой — цена 0 («по запросу»)
--        40 Отсечная гидроизоляция стены
--        50 Герметизация ввода инженерных коммуникаций
--        60 Гидроизоляция деформационного шва акрилатным гелем
--      Остальные позиции — 1000 (в конце, как у новых товаров по умолчанию).
--   2. «… обмазочная гидроизоляция в два слоя» -> «… обмазочная гидроизоляция» в названиях
--      и описаниях (падеж сохраняется: «обмазочную гидроизоляцию в два слоя» -> «обмазочную
--      гидроизоляцию»).
--
-- Точные названия в БД неизвестны, поэтому позиции ищутся по кускам слов (ILIKE ALL) без
-- первой буквы: так поиск не зависит от регистра даже в базе с LC_CTYPE=C, где ILIKE
-- не сравнивает русские буквы без учёта регистра. Архивные (удалённые) товары не трогаются.
--
-- Всё идёт одной транзакцией; при любой ошибке psql останавливается (ON_ERROR_STOP),
-- и ничего не меняется. Повторный запуск безопасен: результат тот же.
--
-- Запуск (переменные APP и DB — из deploy/DEPLOY.md, раздел «Правки каталога в БД»):
--   1. Предпросмотр: тот же скрипт, но в конце ROLLBACK вместо COMMIT — ничего не сохраняется:
--        sed 's/^COMMIT;$/ROLLBACK;/' "$APP/deploy/sql/content-2026-10.sql" | sudo -u postgres psql -X -d "$DB"
--   2. Проверьте таблицы «Проверка» и «Каталог после правок»; затем применить:
--        sudo -u postgres psql -X -d "$DB" < "$APP/deploy/sql/content-2026-10.sql"
--   Последняя строка вывода — COMMIT (сохранено) или ROLLBACK (предпросмотр).

\set ON_ERROR_STOP on
\set QUIET on
\pset pager off
\set QUIET off

BEGIN;

\echo
\echo '=== 1. Каталог сейчас (без архивных; так он отсортирован в магазине) ==='
SELECT left(id::text, 8) AS id, left(title, 70) AS title, price, sort_order, is_published
FROM products
WHERE archived_at IS NULL
ORDER BY sort_order, created_at DESC;

-- Нужный порядок. В названии должны встретиться ВСЕ куски из patterns.
CREATE TEMP TABLE content_order (
    sort_order integer PRIMARY KEY,
    label      text    NOT NULL,
    patterns   text[]  NOT NULL,
    on_request boolean NOT NULL DEFAULT false
) ON COMMIT DROP;

INSERT INTO content_order (sort_order, label, patterns, on_request) VALUES
    (10, 'Стабилизация грунта',                                ARRAY['%табилизац%', '%грунт%'],   false),
    (20, 'Подъём зданий и сооружений',                         ARRAY['%одъ_м%', '%здани%'],       false),
    (30, 'Инъектирование ж/б конструкций эпоксидной смолой',   ARRAY['%нъектир%', '%поксидн%'],   true),
    (40, 'Отсечная гидроизоляция стены',                       ARRAY['%тсечн%', '%гидроизоляц%'], false),
    (50, 'Герметизация ввода инженерных коммуникаций',         ARRAY['%ерметизац%', '%ввод%'],    false),
    (60, 'Гидроизоляция деформационного шва акрилатным гелем', ARRAY['%еформацион%', '%шв%'],     false);

\echo
\echo '=== 2. Остальные позиции — в конец списка (sort_order = 1000) ==='
WITH moved AS (
    UPDATE products p
    SET sort_order = 1000, updated_at = NOW()
    WHERE p.archived_at IS NULL
      AND p.sort_order <> 1000
      AND NOT EXISTS (SELECT 1 FROM content_order c WHERE p.title ILIKE ALL (c.patterns))
    RETURNING p.id, p.title
)
SELECT left(id::text, 8) AS id, left(title, 70) AS title FROM moved ORDER BY title;

\echo
\echo '=== 3. Шесть позиций по порядку (эпоксидная смола — цена 0 = «по запросу») ==='
-- Если название подошло под два шаблона, берётся меньший sort_order.
WITH matched AS (
    SELECT DISTINCT ON (p.id) p.id, c.sort_order, c.on_request
    FROM products p
    JOIN content_order c ON p.title ILIKE ALL (c.patterns)
    WHERE p.archived_at IS NULL
    ORDER BY p.id, c.sort_order
), placed AS (
    UPDATE products p
    SET sort_order = m.sort_order,
        price = CASE WHEN m.on_request THEN 0 ELSE p.price END,
        updated_at = NOW()
    FROM matched m
    WHERE p.id = m.id
      AND (p.sort_order <> m.sort_order OR (m.on_request AND p.price <> 0))
    RETURNING p.id, p.title, p.sort_order, p.price
)
SELECT sort_order, left(id::text, 8) AS id, left(title, 70) AS title, price
FROM placed
ORDER BY sort_order;

\echo
\echo '=== 4. Убираем «в два слоя» после «обмазочная гидроизоляция» (названия и описания) ==='
WITH re AS (
    SELECT '([Оо]бмазочн[а-яё]*[[:space:]]+гидроизоляци[а-яё]*)[[:space:]]+в[[:space:]]+(два|2)[[:space:]]+слоя'::text AS r
), renamed AS (
    UPDATE products p
    SET title = regexp_replace(p.title, re.r, '\1', 'g'),
        description = regexp_replace(p.description, re.r, '\1', 'g'),
        updated_at = NOW()
    FROM re
    WHERE p.archived_at IS NULL
      AND (p.title ~ re.r OR p.description ~ re.r)
    RETURNING p.id, p.title, p.description
)
SELECT left(id::text, 8) AS id, left(title, 70) AS title, left(description, 100) AS description
FROM renamed;

\echo
\echo '=== 5. Проверка: на каждое место должна найтись ровно одна позиция ==='
SELECT c.sort_order,
       c.label,
       count(p.id) AS found,
       CASE count(p.id)
           WHEN 1 THEN 'ok'
           WHEN 0 THEN 'НЕ НАЙДЕНО — задайте порядок в админке (Товары)'
           ELSE 'НЕСКОЛЬКО — проверьте названия ниже'
       END AS status
FROM content_order c
LEFT JOIN products p ON p.archived_at IS NULL AND p.title ILIKE ALL (c.patterns)
GROUP BY c.sort_order, c.label
ORDER BY c.sort_order;

\echo
\echo '=== 6. Каталог после правок ==='
SELECT sort_order,
       left(title, 70) AS title,
       CASE WHEN price = 0 THEN 'по запросу' ELSE price::text END AS price,
       is_published
FROM products
WHERE archived_at IS NULL
ORDER BY sort_order, created_at DESC;

\echo
\echo '=== 7. Где ещё осталось «два слоя» (ожидается пусто) ==='
SELECT left(id::text, 8) AS id, left(title, 70) AS title
FROM products
WHERE archived_at IS NULL
  AND concat_ws(' ', title, description) ~ '(два|2)[[:space:]]+слоя';

\echo
\echo '=== Конец. Следующая строка — COMMIT (сохранено) или ROLLBACK (предпросмотр) ==='
COMMIT;
